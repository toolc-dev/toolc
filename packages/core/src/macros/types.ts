import type { z } from "zod";

/**
 * A macro is a hand-authored, higher-level tool that executes a multi-tool
 * chain in one call. Macros live as TS modules in /macros and are registered
 * at compile time; their steps run through the gateway router at dispatch
 * time so every internal call is logged with a parent_call_id.
 */

/** Invoke a downstream tool by IR tool id ("source:tool"). */
export type MacroCall = (toolId: string, args: Record<string, unknown>) => Promise<MacroCallResult>;

export interface MacroCallResult {
  /** Concatenated text content of the tool result. */
  text: string;
  /** Parsed structuredContent if the downstream provided it. */
  structured?: unknown;
  isError: boolean;
}

export interface MacroDefinition<TInput = Record<string, unknown>> {
  /** Served tool name (snake_case). Must be unique across the surface. */
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  /**
   * IR tool ids this macro composes. Declared (not inferred) so the compile
   * step can validate them against the graph and emit DataEdges.
   */
  uses: string[];
  /** Where this chain was observed — provenance guards against benchmark overfitting. */
  provenance?: string;
  steps: (input: TInput, call: MacroCall) => Promise<MacroCallResult | string>;
}

/**
 * Input-erased macro type for registries and passes, which never call steps
 * with a typed input themselves.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance erasure for heterogeneous registries
export type AnyMacroDefinition = MacroDefinition<any>;

/** Identity helper for authoring macros with inference. */
export function defineMacro<TInput>(def: MacroDefinition<TInput>): MacroDefinition<TInput> {
  return def;
}
