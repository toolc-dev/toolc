import { contentHash } from "../ir/serialize.js";
import { isVisible, type ToolNode } from "../ir/types.js";
import type { Pass, PassDiff, RewriteEntry } from "./types.js";

/**
 * Bump when the prompt materially changes — invalidates all cached rewrites.
 */
export const PROMPT_VERSION = "v1";

export function rewriteCacheKey(toolId: string, originalDescription: string): string {
  return `${toolId}:${contentHash(originalDescription)}:${PROMPT_VERSION}`;
}

const SYSTEM_PROMPT = `You optimize tool descriptions for LLM agents. You will receive every tool from one server so you can disambiguate siblings. For each tool, write an improved description:
- First line: imperative summary, max 320 characters, stating exactly what the tool does and returns.
- Explicitly disambiguate against sibling tools where confusion is plausible ("Use X instead when ...").
- If the original buries parameter guidance in prose, add a short "Parameters:" section with one line per parameter.
- Never invent capabilities not present in the original description or schema.
Respond with ONLY a JSON array: [{"name": "<tool name>", "description": "<rewritten>"}, ...] covering every tool given.`;

/**
 * Description optimization. Batches tools per source with full sibling
 * context; caches proposals keyed by (toolId, originalDescriptionHash,
 * promptVersion); in reviewMode only human-approved entries take effect.
 * Must be a no-op (originals + warning) when no LLM is available.
 *
 * v1 scope note: parameter guidance lands in the description text, not in
 * schema field descriptions — folding into the schema needs an
 * overlays.inputSchema field (deliberately deferred).
 */
export const rewritePass: Pass = async (graph, config, ctx) => {
  const { reviewMode, model } = config.compile.rewrite;
  const diff: PassDiff = {
    pass: "rewrite",
    hidden: [],
    unhidden: [],
    rewritten: [],
    added: [],
    notes: [],
  };
  const cache = ctx.rewriteCache;
  if (!cache) {
    diff.notes.push("no rewrite cache configured; pass skipped");
    ctx.warn("rewrite: no cache configured, serving original descriptions");
    return { graph, diff };
  }

  const candidates = graph.tools.filter((t) => t.kind === "passthrough" && isVisible(t));
  const missing = candidates.filter((t) => !cache.get(rewriteCacheKey(t.id, t.description)));

  // Generate proposals for tools not yet in the cache, one batch per source.
  if (missing.length > 0) {
    if (!ctx.llm) {
      diff.notes.push(`${missing.length} tool(s) lack cached rewrites and no LLM is available`);
      ctx.warn(
        `rewrite: ${missing.length} tool(s) have no cached rewrite and the Anthropic API is unavailable; serving original descriptions for them`,
      );
    } else {
      for (const sourceId of [...new Set(missing.map((t) => t.source))]) {
        const sourceTools = candidates.filter((t) => t.source === sourceId);
        const sourceMissing = missing.filter((t) => t.source === sourceId);
        try {
          const proposals = await generateForSource(ctx.llm, model, sourceTools, sourceMissing);
          for (const tool of sourceMissing) {
            const proposed = proposals.get(tool.name);
            if (!proposed) {
              ctx.warn(`rewrite: model returned no rewrite for ${tool.id}`);
              continue;
            }
            const entry: RewriteEntry = {
              toolId: tool.id,
              originalDescriptionHash: contentHash(tool.description),
              promptVersion: PROMPT_VERSION,
              description: enforceSummaryLimit(proposed),
              approved: !reviewMode,
            };
            cache.set(rewriteCacheKey(tool.id, tool.description), entry);
          }
        } catch (err) {
          ctx.warn(
            `rewrite: generation failed for source ${sourceId} (${err instanceof Error ? err.message : err}); serving originals`,
          );
        }
      }
      cache.flush();
    }
  }

  // Apply approved entries as overlays.
  const tools = graph.tools.map((tool): ToolNode => {
    if (tool.kind !== "passthrough" || !isVisible(tool)) return tool;
    const entry = cache.get(rewriteCacheKey(tool.id, tool.description));
    if (!entry || !entry.approved) return tool;
    diff.rewritten.push(tool.id);
    return { ...tool, overlays: { ...tool.overlays, description: entry.description } };
  });

  const pending = candidates.length - diff.rewritten.length;
  diff.notes.push(
    `${diff.rewritten.length} description(s) rewritten` +
      (reviewMode && pending > 0
        ? `; ${pending} pending approval in the rewrite cache (set "approved": true)`
        : ""),
  );
  return { graph: { ...graph, tools }, diff };
};

async function generateForSource(
  llm: NonNullable<Parameters<Pass>[2]["llm"]>,
  model: string,
  siblings: ToolNode[],
  targets: ToolNode[],
): Promise<Map<string, string>> {
  const catalog = siblings
    .map((t) => {
      const params = Object.keys(
        (t.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
      );
      return `### ${t.name}\nparams: ${params.join(", ") || "(none)"}\n${t.description || "(no description)"}`;
    })
    .join("\n\n");
  const prompt = `Server catalog (all sibling tools, for disambiguation context):\n\n${catalog}\n\nRewrite descriptions for these tools: ${targets.map((t) => t.name).join(", ")}`;

  const raw = await llm({ model, system: SYSTEM_PROMPT, prompt, maxTokens: 8192 });
  const jsonText = raw.replace(/^[\s\S]*?(\[)/, "$1").replace(/(\])[\s\S]*$/, "$1");
  const parsed = JSON.parse(jsonText) as Array<{ name: string; description: string }>;
  return new Map(parsed.map((p) => [p.name, p.description]));
}

/** Enforce the ≤320-char summary line by truncating at a word boundary. */
export function enforceSummaryLimit(description: string): string {
  const newline = description.indexOf("\n");
  const summary = newline === -1 ? description : description.slice(0, newline);
  if (summary.length <= 320) return description;
  const truncated = `${summary.slice(0, 319 - 1).replace(/\s+\S*$/, "")}…`;
  return newline === -1 ? truncated : truncated + description.slice(newline);
}
