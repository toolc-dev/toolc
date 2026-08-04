import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { type CapabilityGraph, effectiveDescription, isVisible, type ToolNode } from "@toolc/core";
import { ToolcError } from "@toolc/shared";
import type { DownstreamPool } from "./downstream.js";
import type { CallLog } from "./log.js";

/**
 * Namespacing separator for served tool names. Some clients reject ":" in tool
 * names, so downstream ids are joined with "__" (spec §14 default).
 */
export const NS_SEP = "__";

export type ServeMode = "mirror" | "compiled";

export interface RouterContext {
  sessionId: string;
  runId: string | null;
  taskId: string | null;
}

/**
 * The router owns the served surface: which tool definitions are exposed for
 * the current mode, and how a served tool name dispatches to a downstream
 * call (passthrough), a meta-tool, or a macro. Every dispatch is logged.
 */
export class Router {
  private byServedName = new Map<string, ToolNode>();

  constructor(
    private graph: CapabilityGraph,
    private mode: ServeMode,
    private pool: DownstreamPool,
    private log: CallLog,
    private ctx: RouterContext,
  ) {
    for (const tool of this.servedNodes()) {
      this.byServedName.set(servedName(tool), tool);
    }
  }

  private servedNodes(): ToolNode[] {
    if (this.mode === "mirror") {
      // Mirror is the benchmark baseline: every passthrough tool, verbatim.
      return this.graph.tools.filter((t) => t.kind === "passthrough");
    }
    // Compiled mode serves the post-pass surface (meta/macro dispatch lands in M2).
    return this.graph.tools.filter((t) => isVisible(t) && t.overlays.surfaced !== false);
  }

  /** Tool definitions to expose via tools/list. */
  servedTools(): Tool[] {
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
        `known tools: ${[...this.byServedName.keys()].slice(0, 10).join(", ")}…`,
      );
    }

    const started = performance.now();
    let result: CallToolResult;
    let errorText: string | null = null;
    try {
      result = await this.execute(node, args);
    } catch (err) {
      // Never let one downstream failure crash the gateway: wrap as a tool
      // error with the source identified.
      errorText = err instanceof Error ? err.message : String(err);
      result = { content: [{ type: "text", text: errorText }], isError: true };
    }

    const latencyMs = Math.round(performance.now() - started);
    const isError = result.isError === true;
    this.log.record({
      ts: new Date().toISOString(),
      sessionId: this.ctx.sessionId,
      runId: this.ctx.runId,
      taskId: this.ctx.taskId,
      surface: this.mode,
      toolId: node.id,
      parentCallId: null,
      argsJson: JSON.stringify(args),
      resultBytes: Buffer.byteLength(JSON.stringify(result.content ?? [])),
      isError,
      errorText: isError ? (errorText ?? firstText(result)) : null,
      latencyMs,
    });
    return result;
  }

  private async execute(node: ToolNode, args: Record<string, unknown>): Promise<CallToolResult> {
    switch (node.kind) {
      case "passthrough":
        return this.pool.call(node.source, node.name, args);
      case "meta":
      case "macro":
        // Arrives with the compile pipeline (M2).
        throw new ToolcError(`tool kind ${node.kind} not implemented yet`);
    }
  }
}

export function servedName(tool: ToolNode): string {
  return `${tool.source}${NS_SEP}${tool.name}`;
}

function firstText(result: CallToolResult): string | null {
  const item = result.content?.find((c) => c.type === "text");
  return item && "text" in item ? (item.text as string) : null;
}
