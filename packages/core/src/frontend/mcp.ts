import type { Transport } from "@modelcontextprotocol/client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type DownstreamConfig, DownstreamError, type TransportConfig } from "@toolc/shared";
import { contentHash, withVersion } from "../ir/serialize.js";
import { type CapabilityGraph, type SourceInfo, type ToolNode, toolId } from "../ir/types.js";

export interface IntrospectionResult {
  source: SourceInfo;
  tools: ToolNode[];
}

export interface IntrospectOptions {
  /** Skip downstreams that fail to connect instead of hard-erroring (dev aid). */
  skipUnavailable?: boolean;
  /** Injected clock for deterministic tests. */
  now?: () => Date;
  onWarn?: (message: string) => void;
}

/** Build an MCP client transport from a downstream transport config. */
export function createTransport(config: TransportConfig): Transport {
  if (config.type === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env ? { ...(process.env as Record<string, string>), ...config.env } : undefined,
      stderr: "ignore",
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });
}

/**
 * Connect to one downstream server, fully paginate tools/list, and normalize
 * its catalog into ToolNodes. The client connection is closed before returning.
 */
export async function introspectSource(
  downstream: DownstreamConfig,
  opts: IntrospectOptions = {},
): Promise<IntrospectionResult> {
  const now = opts.now ?? (() => new Date());
  const client = new Client({ name: "toolc-frontend", version: "0.0.1" });
  try {
    await client.connect(createTransport(downstream.transport));
  } catch (err) {
    throw new DownstreamError(
      downstream.id,
      `failed to connect: ${describeError(err)}`,
      downstream.transport.type === "http"
        ? "check the URL and auth headers; run with --skip-unavailable to compile without it"
        : "check the command exists; run with --skip-unavailable to compile without it",
    );
  }

  try {
    const caps = client.getServerCapabilities();
    if (caps?.resources || caps?.prompts) {
      opts.onWarn?.(
        `[${downstream.id}] server exposes resources/prompts; toolc federates tools only (v1)`,
      );
    }

    const rawTools = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      rawTools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    const tools: ToolNode[] = rawTools.map((t) => ({
      id: toolId(downstream.id, t.name),
      source: downstream.id,
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      ...(t.annotations ? { annotations: t.annotations } : {}),
      overlays: {},
      kind: "passthrough" as const,
    }));

    // Catalog hash covers only source-reported data, so drift detection is
    // insensitive to toolc-side normalization changes.
    const catalogHash = contentHash(
      rawTools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema,
      })),
    );

    const serverInfo = client.getServerVersion();
    const source: SourceInfo = {
      id: downstream.id,
      serverName: serverInfo?.name ?? null,
      serverVersion: serverInfo?.version ?? null,
      instructions: client.getInstructions() ?? null,
      catalogHash,
      introspectedAt: now().toISOString(),
      toolCount: tools.length,
    };

    return { source, tools };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Introspect every enabled downstream and assemble the Capability Graph. */
export async function buildGraph(
  downstreams: DownstreamConfig[],
  opts: IntrospectOptions = {},
): Promise<CapabilityGraph> {
  const results: IntrospectionResult[] = [];
  for (const d of downstreams.filter((d) => d.enabled)) {
    try {
      results.push(await introspectSource(d, opts));
    } catch (err) {
      if (opts.skipUnavailable && err instanceof DownstreamError) {
        opts.onWarn?.(`skipping unavailable downstream: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  return withVersion({
    sources: results.map((r) => r.source),
    tools: results.flatMap((r) => r.tools),
    edges: [],
  });
}

/** Include the cause chain — "fetch failed" alone is useless in logs. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cause: unknown = err.cause;
  for (let depth = 0; cause && depth < 3; depth++) {
    parts.push(cause instanceof Error ? cause.message : String(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return parts.join(" ← ");
}
