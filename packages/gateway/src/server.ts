import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildGraph, type CapabilityGraph } from "@toolc/core";
import type { ToolcConfig } from "@toolc/shared";
import { DownstreamPool } from "./downstream.js";
import { CallLog } from "./log.js";
import { Router, type ServeMode } from "./router.js";

export interface GatewayOptions {
  graph: CapabilityGraph;
  mode: ServeMode;
  pool: DownstreamPool;
  log: CallLog;
  /** Benchmark tagging; null outside harness runs. */
  runId?: string | null;
  taskId?: string | null;
}

export interface Gateway {
  server: Server;
  router: Router;
  close: () => Promise<void>;
}

/** Assemble an MCP server serving the given graph in the given mode. */
export function createGateway(opts: GatewayOptions): Gateway {
  const router = new Router(opts.graph, opts.mode, opts.pool, opts.log, {
    sessionId: randomUUID(),
    runId: opts.runId ?? null,
    taskId: opts.taskId ?? null,
  });

  const server = new Server({ name: "toolc", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: router.servedTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return router.dispatch(req.params.name, req.params.arguments ?? {});
  });

  return {
    server,
    router,
    close: async () => {
      await server.close().catch(() => {});
      await opts.pool.close();
      opts.log.close();
    },
  };
}

/**
 * Full startup path used by `toolc serve`: introspect downstreams, build the
 * graph (mirror) or load the compiled surface (M2), serve over stdio.
 */
export async function serveStdio(config: ToolcConfig): Promise<Gateway> {
  const mode = config.serve.mode;
  if (mode === "compiled") {
    // Compiled surface loading lands with `toolc compile` (M2).
    throw new Error("compiled mode not implemented yet — run with --mode mirror (M1)");
  }

  // Diagnostics must go to stderr: stdout is the MCP transport.
  const graph = await buildGraph(config.downstream, {
    onWarn: (m) => console.error(`[toolc] warn: ${m}`),
  });
  console.error(
    `[toolc] serving ${graph.tools.length} tools from ${graph.sources.length} downstream(s) in ${mode} mode`,
  );

  const pool = new DownstreamPool(config.downstream, {
    callTimeoutMs: config.serve.callTimeoutMs,
  });
  const log = new CallLog(config.serve.logDb);
  const gateway = createGateway({
    graph,
    mode,
    pool,
    log,
    runId: process.env.TOOLC_RUN_ID ?? null,
    taskId: process.env.TOOLC_TASK_ID ?? null,
  });

  await gateway.server.connect(new StdioServerTransport());
  return gateway;
}
