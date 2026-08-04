import { createHash } from "node:crypto";
import { type CapabilityGraph, CapabilityGraphSchema } from "./types.js";

/**
 * Deterministic JSON: object keys sorted at every depth, arrays kept in order.
 * This is what makes graph `version` hashes reproducible across runs.
 */
export function stableStringify(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeysDeep(value), null, indent);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

/** Compute the graph's version hash over everything except the version field itself. */
export function graphVersion(graph: Omit<CapabilityGraph, "version">): string {
  return contentHash({ sources: graph.sources, tools: graph.tools, edges: graph.edges });
}

/** Attach a freshly computed version hash. */
export function withVersion(graph: Omit<CapabilityGraph, "version">): CapabilityGraph {
  return { ...graph, version: graphVersion(graph) };
}

export function serializeGraph(graph: CapabilityGraph): string {
  return stableStringify(graph, 2);
}

export function deserializeGraph(json: string): CapabilityGraph {
  return CapabilityGraphSchema.parse(JSON.parse(json));
}
