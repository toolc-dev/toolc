import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  type AnyMacroDefinition,
  buildGraph,
  type CapabilityGraph,
  deserializeArtifact,
  loadMacros,
} from "@toolc/core";
import { type ToolcConfig, ToolcError } from "@toolc/shared";
import { DownstreamPool } from "./downstream.js";
import { CallLog } from "./log.js";
import { Router, type ServeMode } from "./router.js";

export interface GatewayOptions {
  graph: CapabilityGraph;
  mode: ServeMode;
  pool: DownstreamPool;
  log: CallLog;
  /** search_tools default result count (compiled mode). */
  searchTopK?: number;
  macros?: AnyMacroDefinition[];
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
  const router = new Router(
    opts.graph,
    opts.mode,
    opts.pool,
    opts.log,
    {
      sessionId: randomUUID(),
      runId: opts.runId ?? null,
      taskId: opts.taskId ?? null,
    },
    { searchTopK: opts.searchTopK, macros: opts.macros },
  );

  const server = new Server({ name: "toolc", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler("tools/list", async () => ({
    tools: router.servedToolDefs(),
  }));

  server.setRequestHandler("tools/call", async (req) => {
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
 * Full startup path used by `toolc serve`: mirror mode introspects downstreams
 * fresh; compiled mode loads the artifact written by `toolc compile` plus the
 * macro modules it references. Serves over stdio.
 */
export async function serveStdio(config: ToolcConfig): Promise<Gateway> {
  const mode = config.serve.mode;
  let graph: CapabilityGraph;
  let macros: AnyMacroDefinition[] = [];

  // Diagnostics must go to stderr: stdout is the MCP transport.
  const warn = (m: string) => console.error(`[toolc] warn: ${m}`);

  if (mode === "compiled") {
    let raw: string;
    try {
      raw = readFileSync(config.serve.compiledPath, "utf8");
    } catch {
      throw new ToolcError(
        `compiled artifact not found at ${config.serve.compiledPath}`,
        "run `toolc compile` first, or serve with --mode mirror",
      );
    }
    const artifact = deserializeArtifact(raw);
    graph = artifact.graph;
    macros = await loadMacros(config.compile.macrosDir, warn);
    const loaded = new Set(macros.map((m) => m.name));
    for (const name of artifact.macroNames) {
      if (!loaded.has(name)) {
        throw new ToolcError(
          `compiled surface includes macro ${name} but it is not present in ${config.compile.macrosDir}`,
          "recompile, or restore the macro module",
        );
      }
    }
  } else {
    graph = await buildGraph(config.downstream, { onWarn: warn });
  }

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
    searchTopK: config.compile.selection.topK,
    macros,
    runId: process.env.TOOLC_RUN_ID ?? null,
    taskId: process.env.TOOLC_TASK_ID ?? null,
  });

  await gateway.server.connect(new StdioServerTransport());
  return gateway;
}
