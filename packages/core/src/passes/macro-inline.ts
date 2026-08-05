import { z } from "zod";
import { type DataEdge, TOOLC_SOURCE, type ToolNode } from "../ir/types.js";
import type { Pass, PassDiff } from "./types.js";

/**
 * Synthesis via hand-authored macros: each macro becomes a
 * ToolNode{kind:"macro", source:"toolc"}; its `uses` list is validated against
 * the graph and recorded as DataEdges. Constituent tools stay visible unless
 * config.compile.macroInline.hideInlined is set (comprehensive coverage still
 * matters by default).
 */
export const macroInlinePass: Pass = async (graph, config, ctx) => {
  const diff: PassDiff = {
    pass: "macro-inline",
    hidden: [],
    unhidden: [],
    rewritten: [],
    added: [],
    notes: [],
  };
  if (ctx.macros.length === 0) {
    diff.notes.push("no macros registered");
    return { graph, diff };
  }

  const knownIds = new Set(graph.tools.map((t) => t.id));
  const inlined = new Set<string>();
  const macroNodes: ToolNode[] = [];
  const edges: DataEdge[] = [...graph.edges];

  for (const macro of ctx.macros) {
    const missing = macro.uses.filter((id) => !knownIds.has(id));
    if (missing.length > 0) {
      ctx.warn(
        `macro ${macro.name} skipped: uses unknown tool(s) ${missing.join(", ")} — not in the current federation`,
      );
      continue;
    }
    const macroId = `${TOOLC_SOURCE}:${macro.name}`;
    if (knownIds.has(macroId)) {
      ctx.warn(`macro ${macro.name} skipped: duplicate tool id ${macroId}`);
      continue;
    }
    knownIds.add(macroId);
    macroNodes.push({
      id: macroId,
      source: TOOLC_SOURCE,
      name: macro.name,
      description: macro.description,
      inputSchema: z.toJSONSchema(macro.inputSchema) as Record<string, unknown>,
      overlays: {},
      kind: "macro",
    });
    diff.added.push(macroId);
    // v1 edges: chain order as declared. fromField/toField are refined when
    // macros declare real field mappings; "$" marks whole-output dependency.
    for (let i = 0; i < macro.uses.length - 1; i++) {
      edges.push({
        from: macro.uses[i]!,
        fromField: "$",
        to: macro.uses[i + 1]!,
        toField: "$",
        via: "macro",
      });
    }
    for (const used of macro.uses) inlined.add(used);
  }

  let tools = [...graph.tools, ...macroNodes];
  if (config.compile.macroInline.hideInlined) {
    tools = tools.map((t) => {
      if (!inlined.has(t.id) || t.overlays.hidden) return t;
      diff.hidden.push(t.id);
      return { ...t, overlays: { ...t.overlays, hidden: true, hiddenReason: "macro-inlined" } };
    });
  }

  diff.notes.push(`${macroNodes.length} macro(s) added`);
  return { graph: { ...graph, tools, edges }, diff };
};
