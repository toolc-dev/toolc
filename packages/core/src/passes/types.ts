import type { ToolcConfig } from "@toolc/shared";
import type { CapabilityGraph } from "../ir/types.js";
import type { AnyMacroDefinition } from "../macros/types.js";

/**
 * A rewrite proposal cache entry. The cache file (.toolc/rewrites.json) is the
 * review surface: in reviewMode, only entries a human flipped to approved:true
 * take effect. Keyed by `${toolId}:${originalDescriptionHash}:${promptVersion}`.
 */
export interface RewriteEntry {
  toolId: string;
  originalDescriptionHash: string;
  promptVersion: string;
  /** Proposed replacement description (≤ 320 char summary line first). */
  description: string;
  approved: boolean;
}

export interface RewriteCache {
  get(key: string): RewriteEntry | undefined;
  set(key: string, entry: RewriteEntry): void;
  /** Persist any pending writes. */
  flush(): void;
}

/**
 * One LLM completion call. Injected so `core` stays free of the Anthropic SDK
 * and passes stay unit-testable; the CLI wires the real implementation.
 * Returns the raw text completion.
 */
export type LlmComplete = (args: {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}) => Promise<string>;

/** Everything a pass may reach beyond the graph + config. */
export interface PassContext {
  macros: AnyMacroDefinition[];
  rewriteCache?: RewriteCache;
  llm?: LlmComplete;
  warn: (message: string) => void;
}

/** Summary of what one pass changed — feeds the compile report. */
export interface PassDiff {
  pass: string;
  hidden: string[];
  unhidden: string[];
  rewritten: string[];
  added: string[];
  notes: string[];
}

export interface PassResult {
  graph: CapabilityGraph;
  diff: PassDiff;
}

export type Pass = (
  graph: CapabilityGraph,
  config: ToolcConfig,
  ctx: PassContext,
) => Promise<PassResult>;
