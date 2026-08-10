import { z } from "zod";
import { stableStringify } from "../ir/serialize.js";
import {
  type CapabilityGraph,
  CapabilityGraphSchema,
  effectiveDescription,
  isVisible,
  type ToolNode,
} from "../ir/types.js";

/** Tools whose definitions are presented to the client in tools/list. */
export function servedTools(graph: CapabilityGraph): ToolNode[] {
  return graph.tools.filter((t) => isVisible(t) && t.overlays.surfaced !== false);
}

/** Tools reachable through search_tools/call_tool (visible passthrough + facades). */
export function searchableTools(graph: CapabilityGraph): ToolNode[] {
  return graph.tools.filter(
    (t) => (t.kind === "passthrough" || t.kind === "facade") && isVisible(t),
  );
}

/**
 * Rough context cost of a tool definition in tokens (chars/4 heuristic over
 * the serialized definition — documented as an estimate in the report).
 */
export function estimateToolTokens(tool: ToolNode, useOriginalDescription = false): number {
  const def = {
    name: tool.name,
    description: useOriginalDescription ? tool.description : effectiveDescription(tool),
    inputSchema: tool.inputSchema,
  };
  return Math.ceil(stableStringify(def).length / 4);
}

export interface SurfaceStats {
  servedCount: number;
  searchableCount: number;
  hiddenCount: number;
  /** Estimated tokens of the served (compiled) definitions. */
  servedTokens: number;
  /** Estimated tokens of the full raw catalog (mirror baseline). */
  mirrorTokens: number;
}

export function surfaceStats(graph: CapabilityGraph): SurfaceStats {
  const served = servedTools(graph);
  const passthrough = graph.tools.filter((t) => t.kind === "passthrough");
  return {
    servedCount: served.length,
    searchableCount: searchableTools(graph).length,
    hiddenCount: graph.tools.filter((t) => !isVisible(t)).length,
    servedTokens: served.reduce((sum, t) => sum + estimateToolTokens(t), 0),
    mirrorTokens: passthrough.reduce((sum, t) => sum + estimateToolTokens(t, true), 0),
  };
}

// --- Compiled artifact (.toolc/compiled.json) ---------------------------------

export const CompiledArtifactSchema = z.object({
  artifactVersion: z.literal(1),
  project: z.string(),
  compiledAt: z.string(),
  /** Names of macros the serve step must load from the macros dir. */
  macroNames: z.array(z.string()),
  graph: CapabilityGraphSchema,
});
export type CompiledArtifact = z.infer<typeof CompiledArtifactSchema>;

export function serializeArtifact(artifact: CompiledArtifact): string {
  return stableStringify(artifact, 2);
}

export function deserializeArtifact(json: string): CompiledArtifact {
  return CompiledArtifactSchema.parse(JSON.parse(json));
}
