import type { PassName, ToolcConfig } from "@toolc/shared";
import { ToolcError } from "@toolc/shared";
import { withVersion } from "../ir/serialize.js";
import type { CapabilityGraph } from "../ir/types.js";
import { deadToolPass } from "./dead-tool.js";
import { macroInlinePass } from "./macro-inline.js";
import { rewritePass } from "./rewrite.js";
import { selectionPass } from "./selection.js";
import type { Pass, PassContext, PassDiff } from "./types.js";

const PASSES: Record<PassName, Pass> = {
  "dead-tool": deadToolPass,
  rewrite: rewritePass,
  "macro-inline": macroInlinePass,
  selection: selectionPass,
};

export interface CompileResult {
  graph: CapabilityGraph;
  diffs: PassDiff[];
}

/** Run the configured passes in order, re-hashing the graph after each. */
export async function runPasses(
  graph: CapabilityGraph,
  config: ToolcConfig,
  ctx: PassContext,
): Promise<CompileResult> {
  let current = graph;
  const diffs: PassDiff[] = [];
  for (const name of config.compile.passes) {
    const pass = PASSES[name];
    if (!pass) throw new ToolcError(`unknown pass: ${name}`);
    const { graph: next, diff } = await pass(current, config, ctx);
    current = withVersion({ sources: next.sources, tools: next.tools, edges: next.edges });
    diffs.push(diff);
  }
  return { graph: current, diffs };
}
