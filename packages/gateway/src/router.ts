import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import {
  type AnyMacroDefinition,
  buildBm25Retriever,
  CALL_TOOL_NAME,
  type CapabilityGraph,
  effectiveDescription,
  isVisible,
  type MacroCallResult,
  type Retriever,
  SEARCH_TOOLS_NAME,
  searchableTools,
  servedTools,
  stableStringify,
  type ToolNode,
} from "@toolc/core";
import { ToolcError } from "@toolc/shared";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { type CompactionOptions, compactResult } from "./compaction.js";
import type { DownstreamPool } from "./downstream.js";
import type { CallSink } from "./log.js";

/**
 * Namespacing separator for served passthrough tool names. Some clients reject
 * ":" in tool names, so downstream ids are joined with "__" (spec §14 default).
 * Synthesized tools (macros, meta) serve their bare name.
 */
export const NS_SEP = "__";

export type ServeMode = "mirror" | "compiled";

export interface RouterContext {
  sessionId: string;
  runId: string | null;
  taskId: string | null;
}

export interface RouterOptions {
  /** Default result count for search_tools (config.compile.selection.topK). */
  searchTopK?: number;
  macros?: AnyMacroDefinition[];
  /**
   * Auto-compact oversized results before serving (config.serve.compaction).
   * Applies to passthrough and macro results only — meta results are the
   * selection surface's own protocol and stay verbatim.
   */
  compaction?: CompactionOptions | null;
}

/**
 * The router owns the served surface: which tool definitions are exposed for
 * the current mode, and how a served tool name dispatches — passthrough to a
 * downstream, meta (search_tools/call_tool), or macro. Every dispatch is
 * logged; child calls (via call_tool or macro steps) carry parent_call_id.
 */
export class Router {
  private byServedName = new Map<string, ToolNode>();
  private byToolId = new Map<string, ToolNode>();
  private macroRegistry = new Map<string, AnyMacroDefinition>();
  private retriever: Retriever | null = null;
  private validators = new Map<string, ValidateFunction>();
  private ajv = new Ajv2020({ strict: false, allErrors: true });
  private searchTopK: number;
  private compaction: CompactionOptions | null;

  constructor(
    private graph: CapabilityGraph,
    private mode: ServeMode,
    private pool: DownstreamPool,
    private log: CallSink,
    private ctx: RouterContext,
    opts: RouterOptions = {},
  ) {
    this.searchTopK = opts.searchTopK ?? 8;
    this.compaction = opts.compaction ?? null;
    for (const tool of this.graph.tools) this.byToolId.set(tool.id, tool);
    for (const tool of this.servedNodes()) this.byServedName.set(servedName(tool), tool);
    for (const macro of opts.macros ?? []) this.macroRegistry.set(macro.name, macro);
    if (mode === "compiled") {
      this.retriever = buildBm25Retriever(searchableTools(graph));
    }
  }

  private servedNodes(): ToolNode[] {
    if (this.mode === "mirror") {
      // Mirror is the benchmark baseline: every passthrough tool, verbatim.
      return this.graph.tools.filter((t) => t.kind === "passthrough");
    }
    return servedTools(this.graph);
  }

  /** Tool definitions to expose via tools/list. */
  servedToolDefs(): Tool[] {
    return [...this.byServedName.entries()].map(([name, node]) => ({
      name,
      // Mirror stays faithful: original description only. Compiled uses overlays.
      description: this.mode === "mirror" ? node.description : effectiveDescription(node),
      inputSchema: node.inputSchema as Tool["inputSchema"],
      ...(node.annotations ? { annotations: node.annotations } : {}),
    }));
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const node = this.byServedName.get(name);
    if (!node) {
      throw new ToolcError(
        `unknown tool: ${name}`,
        `served tools: ${[...this.byServedName.keys()].slice(0, 10).join(", ")}…`,
      );
    }
    return this.dispatchNode(node, args, null);
  }

  /** Execute one node, logging a call row; children reference it via parentId. */
  private async dispatchNode(
    node: ToolNode,
    args: Record<string, unknown>,
    parentId: number | null,
  ): Promise<CallToolResult> {
    const started = performance.now();
    const callId = await this.log.begin({
      ts: new Date().toISOString(),
      sessionId: this.ctx.sessionId,
      runId: this.ctx.runId,
      taskId: this.ctx.taskId,
      surface: this.mode,
      toolId: node.id,
      parentCallId: parentId,
      argsJson: JSON.stringify(args),
    });

    let result: CallToolResult;
    let thrown: string | null = null;
    try {
      result = await this.execute(node, args, callId);
    } catch (err) {
      // Never let one downstream failure crash the gateway: wrap as a tool
      // error with the source identified.
      thrown = err instanceof Error ? err.message : String(err);
      result = { content: [{ type: "text", text: thrown }], isError: true };
    }

    // Auto-compaction (serve-time, opt-in). Meta results are protocol, not data.
    if (this.compaction && node.kind !== "meta" && result.isError !== true) {
      ({ result } = await compactResult(
        result,
        { toolName: node.name, args },
        this.compaction,
      ));
    }

    const isError = result.isError === true;
    await this.log.finish(callId, {
      resultBytes: Buffer.byteLength(JSON.stringify(result.content ?? [])),
      isError,
      errorText: isError ? (thrown ?? firstText(result)) : null,
      latencyMs: Math.round(performance.now() - started),
    });
    return result;
  }

  private async execute(
    node: ToolNode,
    args: Record<string, unknown>,
    callId: number,
  ): Promise<CallToolResult> {
    switch (node.kind) {
      case "passthrough":
        return this.pool.call(node.source, node.name, args);
      case "meta":
        if (node.name === SEARCH_TOOLS_NAME) return this.executeSearchTools(args);
        if (node.name === CALL_TOOL_NAME) return this.executeCallTool(args, callId);
        throw new ToolcError(`unknown meta tool: ${node.name}`);
      case "macro":
        return this.executeMacro(node, args, callId);
    }
  }

  // --- search_tools -----------------------------------------------------------

  private executeSearchTools(args: Record<string, unknown>): CallToolResult {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return errorResult(
        'search_tools requires a "query" string, e.g. {"query": "search code in a repo"}',
      );
    }
    const topK =
      typeof args.top_k === "number" && args.top_k >= 1
        ? Math.min(Math.floor(args.top_k), 25)
        : this.searchTopK;
    const hits = this.retriever?.search(query, topK) ?? [];
    if (hits.length === 0) {
      return textResult(
        `No tools matched "${query}". Try different task words, or conclude the capability is unavailable.`,
      );
    }
    const defs = hits.map(({ tool }) => ({
      name: tool.id,
      description: effectiveDescription(tool),
      inputSchema: tool.inputSchema,
    }));
    return textResult(
      `Top ${defs.length} tools for "${query}". Invoke one with ${CALL_TOOL_NAME}: {"name": "<name>", "arguments": {...}}.\n\n${stableStringify(defs, 2)}`,
    );
  }

  // --- call_tool --------------------------------------------------------------

  private async executeCallTool(
    args: Record<string, unknown>,
    callId: number,
  ): Promise<CallToolResult> {
    const name = args.name;
    const innerArgs = args.arguments;
    if (typeof name !== "string" || innerArgs === null || typeof innerArgs !== "object") {
      return errorResult(
        `call_tool requires {"name": "<tool id>", "arguments": {...}}. Find tool ids via ${SEARCH_TOOLS_NAME}.`,
      );
    }
    const target = this.byToolId.get(name);
    if (target?.kind !== "passthrough" || !isVisible(target)) {
      const suggestions = this.retriever?.search(name.replaceAll(/[_:]/g, " "), 3) ?? [];
      return errorResult(
        `unknown tool "${name}".` +
          (suggestions.length > 0
            ? ` Did you mean: ${suggestions.map((s) => s.tool.id).join(", ")}?`
            : ` Use ${SEARCH_TOOLS_NAME} to find available tools.`),
      );
    }

    const invalid = this.validateArgs(target, innerArgs as Record<string, unknown>);
    if (invalid) return errorResult(invalid);
    return this.dispatchNode(target, innerArgs as Record<string, unknown>, callId);
  }

  /** Returns an actionable error message, or null when args are valid. */
  private validateArgs(target: ToolNode, args: Record<string, unknown>): string | null {
    let validate = this.validators.get(target.id);
    if (!validate) {
      // Downstream schemas arrive in mixed dialects; drop $schema so the 2020
      // validator accepts draft-07-tagged catalogs too.
      const { $schema: _dialect, ...schema } = target.inputSchema;
      try {
        validate = this.ajv.compile(schema);
      } catch {
        return null; // uncompilable downstream schema: let the downstream validate
      }
      this.validators.set(target.id, validate);
    }
    if (validate(args)) return null;
    const issues = (validate.errors ?? [])
      .map((e) => `  - ${e.instancePath || "(root)"} ${e.message}`)
      .join("\n");
    return (
      `invalid arguments for ${target.id}:\n${issues}\n\n` +
      `Expected schema:\n${stableStringify(target.inputSchema, 2)}\n\n` +
      `Corrected call example: {"name": "${target.id}", "arguments": ${exampleArgs(target.inputSchema)}}`
    );
  }

  // --- macros -----------------------------------------------------------------

  private async executeMacro(
    node: ToolNode,
    args: Record<string, unknown>,
    callId: number,
  ): Promise<CallToolResult> {
    const macro = this.macroRegistry.get(node.name);
    if (!macro) {
      throw new ToolcError(
        `macro ${node.name} is in the compiled surface but not loaded`,
        "check the macros directory configured at compile time is available to serve",
      );
    }
    const parsed = macro.inputSchema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"} ${i.message}`)
        .join("\n");
      return errorResult(
        `invalid arguments for ${node.name}:\n${issues}\n\nExpected schema:\n${stableStringify(node.inputSchema, 2)}`,
      );
    }

    const call = async (
      toolId: string,
      stepArgs: Record<string, unknown>,
    ): Promise<MacroCallResult> => {
      const target = this.byToolId.get(toolId);
      if (target?.kind !== "passthrough") {
        throw new ToolcError(`macro ${node.name} called unknown tool ${toolId}`);
      }
      const result = await this.dispatchNode(target, stepArgs, callId);
      return {
        text: allText(result),
        structured: result.structuredContent,
        isError: result.isError === true,
      };
    };

    const out = await macro.steps(parsed.data, call);
    if (typeof out === "string") return textResult(out);
    return {
      content: [{ type: "text", text: out.text }],
      ...(out.structured !== undefined
        ? { structuredContent: out.structured as Record<string, unknown> }
        : {}),
      ...(out.isError ? { isError: true } : {}),
    };
  }
}

export function servedName(tool: ToolNode): string {
  return tool.kind === "passthrough" ? `${tool.source}${NS_SEP}${tool.name}` : tool.name;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function firstText(result: CallToolResult): string | null {
  const item = result.content?.find((c) => c.type === "text");
  return item && "text" in item ? (item.text as string) : null;
}

function allText(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => ("text" in c ? String(c.text) : ""))
    .join("\n");
}

/** Build a minimal plausible arguments example from a JSON Schema. */
function exampleArgs(schema: Record<string, unknown>): string {
  const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const example: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (!required.has(key)) continue;
    example[key] = exampleValue(prop);
  }
  return JSON.stringify(example);
}

function exampleValue(prop: Record<string, unknown>): unknown {
  switch (prop.type) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "…";
  }
}
