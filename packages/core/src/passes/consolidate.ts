import { effectiveDescription, isVisible, type ToolNode, toolId } from "../ir/types.js";
import type { Pass, PassDiff } from "./types.js";

/**
 * Tool consolidation: merge families of closely related tools from one source
 * into a single facade tool with an `action` discriminator. The LLM only
 * PROPOSES clusters and writes the group description; membership is validated
 * and the union schema + routing table are synthesized deterministically, so
 * a bad proposal can produce a rejected group but never a wrong dispatch.
 *
 * Sits between rewrite and selection. Compared to the selection surface this
 * keeps every capability directly visible (no search indirection) while
 * shrinking the definition count; the benchmark measures whether that helps.
 */

const SYSTEM_PROMPT = `You design tool surfaces for LLM agents. You will receive every tool from one MCP server. Identify families of closely related tools that would confuse an agent as separate entries and merge each family into one facade tool.

Rules:
- Only merge tools that operate on the same domain object or capability (e.g. search_research / find_research / get_research; or a swarm of small enum-lookup tools).
- Never merge tools with clashing semantics, side effects, or unrelated result shapes. Read-only lookups and mutating operations never share a facade.
- 2 to MAX_GROUP members per group. A tool appears in at most one group. Leave every tool that has no natural family alone.
- Group name: a short domain noun (e.g. "research", "filings") that is NOT the name of any existing tool. Action names: short verbs or noun_verbs, unique within the group, snake_case.
- Group description: first line states what the facade covers and returns, max 320 characters. Then one line per action: what it does and when to choose it over the siblings. Never invent capabilities.

Respond with one block per group, exactly in this format (no other prose):
<<<GROUP group_name>>>
<<<MEMBERS>>>
action_name = original_tool_name
action_name = original_tool_name
<<<DESCRIPTION>>>
group description (may span multiple lines)
<<<END>>>`;

interface ProposedGroup {
  name: string;
  /** action name → member tool name (unnamespaced, within the source). */
  members: Map<string, string>;
  description: string;
}

export const consolidatePass: Pass = async (graph, config, ctx) => {
  const { model, minGroupSize, maxGroupSize } = config.compile.consolidate;
  const diff: PassDiff = {
    pass: "consolidate",
    hidden: [],
    unhidden: [],
    rewritten: [],
    added: [],
    notes: [],
  };
  if (!ctx.llm) {
    diff.notes.push("no LLM available; pass skipped");
    ctx.warn("consolidate: Anthropic API unavailable, serving tools unmerged");
    return { graph, diff };
  }

  const existingIds = new Set(graph.tools.map((t) => t.id));
  let tools = [...graph.tools];

  for (const source of graph.sources) {
    const candidates = tools.filter(
      (t) => t.source === source.id && t.kind === "passthrough" && isVisible(t),
    );
    if (candidates.length < minGroupSize) continue;

    let proposals: ProposedGroup[];
    try {
      proposals = parseGroups(
        await ctx.llm({
          model,
          system: SYSTEM_PROMPT.replace("MAX_GROUP", String(maxGroupSize)),
          prompt: catalogPrompt(candidates),
          maxTokens: 8192,
        }),
      );
    } catch (err) {
      ctx.warn(
        `consolidate: generation failed for ${source.id} (${err instanceof Error ? err.message : err}); serving tools unmerged`,
      );
      continue;
    }

    const claimed = new Set<string>();
    for (const group of proposals) {
      const problem = validateGroup(group, {
        candidates,
        claimed,
        existingIds,
        sourceId: source.id,
        minGroupSize,
        maxGroupSize,
      });
      if (problem) {
        ctx.warn(`consolidate: rejected group "${group.name}" from ${source.id}: ${problem}`);
        continue;
      }

      const byName = new Map(candidates.map((t) => [t.name, t]));
      const actions: Record<string, string> = {};
      for (const [action, memberName] of group.members) {
        const member = byName.get(memberName);
        if (!member) continue; // validated above; guard for types
        actions[action] = member.id;
        claimed.add(memberName);
      }

      // LLMs naturally name a family after its base tool ("sigmet" facade
      // over sigmet/sigmet_by_atsu). When the collision is with a member
      // being merged away, suffix instead of rejecting.
      let facadeName = group.name;
      if (
        existingIds.has(toolId(source.id, facadeName)) &&
        claimedBy(group, facadeName)
      ) {
        facadeName = `${facadeName}_api`;
      }
      const facadeId = toolId(source.id, facadeName);
      const facade: ToolNode = {
        id: facadeId,
        source: source.id,
        name: facadeName,
        description: buildFacadeDescription(group, byName),
        inputSchema: facadeSchema(Object.keys(actions)),
        overlays: {},
        kind: "facade",
        facade: { actions },
      };
      tools.push(facade);
      existingIds.add(facadeId);
      diff.added.push(facadeId);

      tools = tools.map((t): ToolNode => {
        if (t.source !== source.id || t.kind !== "passthrough" || !claimedBy(group, t.name))
          return t;
        diff.hidden.push(t.id);
        return {
          ...t,
          overlays: { ...t.overlays, hidden: true, hiddenReason: `consolidated into ${facadeId}` },
        };
      });
    }
  }

  diff.notes.push(
    `${diff.added.length} facade(s) synthesized from ${diff.hidden.length} tool(s)`,
  );
  return { graph: { ...graph, tools }, diff };
};

function claimedBy(group: ProposedGroup, toolName: string): boolean {
  return [...group.members.values()].includes(toolName);
}

function catalogPrompt(candidates: ToolNode[]): string {
  const catalog = candidates
    .map((t) => {
      const params = Object.keys(
        (t.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
      );
      return `### ${t.name}\nparams: ${params.join(", ") || "(none)"}\n${effectiveDescription(t) || "(no description)"}`;
    })
    .join("\n\n");
  return `Server catalog (${candidates.length} tools):\n\n${catalog}\n\nPropose facade groups. Tools with no natural family must not appear in any group.`;
}

function parseGroups(raw: string): ProposedGroup[] {
  const groups: ProposedGroup[] = [];
  const blockPattern =
    /<<<GROUP\s+(\S+?)>>>\n<<<MEMBERS>>>\n([\s\S]*?)<<<DESCRIPTION>>>\n([\s\S]*?)<<<END>>>/g;
  for (const match of raw.matchAll(blockPattern)) {
    const members = new Map<string, string>();
    for (const line of match[2]!.split("\n")) {
      const pair = /^\s*([a-z][a-z0-9_]*)\s*=\s*(\S+)\s*$/.exec(line);
      if (pair) members.set(pair[1]!, pair[2]!);
    }
    groups.push({ name: match[1]!, members, description: match[3]!.trim() });
  }
  return groups;
}

function validateGroup(
  group: ProposedGroup,
  ctx: {
    candidates: ToolNode[];
    claimed: Set<string>;
    existingIds: Set<string>;
    sourceId: string;
    minGroupSize: number;
    maxGroupSize: number;
  },
): string | null {
  if (!/^[a-z][a-z0-9_]*$/.test(group.name)) return `invalid group name "${group.name}"`;
  const collides = ctx.existingIds.has(toolId(ctx.sourceId, group.name));
  const namedAfterMember = [...group.members.values()].includes(group.name);
  // Collision with a member being merged away is fine (renamed to <name>_api),
  // unless that fallback is taken too.
  if (collides && !namedAfterMember) return "name collides with existing tool id";
  if (collides && namedAfterMember && ctx.existingIds.has(toolId(ctx.sourceId, `${group.name}_api`)))
    return "name collides and the _api fallback is taken";
  if (group.members.size < ctx.minGroupSize || group.members.size > ctx.maxGroupSize)
    return `${group.members.size} member(s), need ${ctx.minGroupSize}-${ctx.maxGroupSize}`;
  const names = new Set(ctx.candidates.map((t) => t.name));
  for (const [action, member] of group.members) {
    if (!names.has(member)) return `member "${member}" is not a mergeable tool of this source`;
    if (ctx.claimed.has(member)) return `member "${member}" already belongs to another group`;
    if (!/^[a-z][a-z0-9_]*$/.test(action)) return `invalid action name "${action}"`;
  }
  if (group.description.length === 0) return "empty description";
  return null;
}

/**
 * The facade schema stays deliberately small: a required action enum plus an
 * open arguments object. Per-action parameters are documented in the
 * description (generated below from the members' real schemas) and validated
 * against the member's original schema at dispatch time.
 */
export function facadeSchema(actions: string[]): ToolNode["inputSchema"] {
  return {
    type: "object",
    required: ["action", "arguments"],
    properties: {
      action: {
        type: "string",
        enum: actions,
        description: "Which operation to perform; see the tool description for each action.",
      },
      arguments: {
        type: "object",
        description: "Arguments for the chosen action, matching its documented parameters.",
      },
    },
  };
}

function buildFacadeDescription(group: ProposedGroup, byName: Map<string, ToolNode>): string {
  const paramLines = [...group.members.entries()]
    .map(([action, memberName]) => {
      const member = byName.get(memberName);
      if (!member) return null;
      const props =
        (member.inputSchema.properties as Record<
          string,
          { type?: string; enum?: unknown[]; minimum?: number; maximum?: number; default?: unknown }
        >) ?? {};
      const required = new Set((member.inputSchema.required as string[]) ?? []);
      const params = Object.entries(props)
        .map(([name, s]) => {
          let doc = `${name}${required.has(name) ? "" : "?"}: ${s.type ?? "any"}`;
          if (s.enum?.length) {
            const shown = s.enum.slice(0, 8).join("|");
            doc += ` [${shown}${s.enum.length > 8 ? "|…" : ""}]`;
          }
          const bounds = [
            s.minimum !== undefined ? `min ${s.minimum}` : null,
            s.maximum !== undefined ? `max ${s.maximum}` : null,
            s.default !== undefined ? `default ${s.default}` : null,
          ].filter(Boolean);
          if (bounds.length > 0) doc += ` (${bounds.join(", ")})`;
          return doc;
        })
        .join(", ");
      return `- ${action}(${params || ""})`;
    })
    .filter(Boolean)
    .join("\n");
  return `${group.description}\n\nAction parameters ("?" = optional):\n${paramLines}`;
}
