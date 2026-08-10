import type { CallToolResult } from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/client";
import { createTransport } from "@toolc/core";
import { type DownstreamConfig, DownstreamError } from "@toolc/shared";

/**
 * Connection pool to downstream MCP servers: lazy connect on first call,
 * reconnect with backoff after failures. One persistent client per source.
 */
export class DownstreamPool {
  private configs = new Map<string, DownstreamConfig>();
  private clients = new Map<string, Client>();
  private connecting = new Map<string, Promise<Client>>();
  private failedAt = new Map<string, number>();
  private attempts = new Map<string, number>();

  constructor(
    downstreams: DownstreamConfig[],
    private opts: { callTimeoutMs: number; backoffBaseMs?: number } = { callTimeoutMs: 60_000 },
  ) {
    for (const d of downstreams) {
      if (d.enabled) this.configs.set(d.id, d);
    }
  }

  sourceIds(): string[] {
    return [...this.configs.keys()];
  }

  private async getClient(sourceId: string): Promise<Client> {
    const existing = this.clients.get(sourceId);
    if (existing) return existing;

    const inFlight = this.connecting.get(sourceId);
    if (inFlight) return inFlight;

    const config = this.configs.get(sourceId);
    if (!config) {
      throw new DownstreamError(sourceId, "unknown downstream source");
    }

    // Reconnect backoff: exponential from base, capped at 30s.
    const failedAt = this.failedAt.get(sourceId);
    if (failedAt !== undefined) {
      const base = this.opts.backoffBaseMs ?? 1000;
      const wait = Math.min(base * 2 ** (this.attempts.get(sourceId) ?? 0), 30_000);
      const remaining = failedAt + wait - Date.now();
      if (remaining > 0) {
        throw new DownstreamError(
          sourceId,
          `connection failed recently; retrying in ${Math.ceil(remaining / 1000)}s`,
        );
      }
    }

    const promise = (async () => {
      const client = new Client({ name: "toolc-gateway", version: "0.0.1" });
      await client.connect(await createTransport(config.transport));
      return client;
    })();
    this.connecting.set(sourceId, promise);

    try {
      const client = await promise;
      this.clients.set(sourceId, client);
      this.failedAt.delete(sourceId);
      this.attempts.delete(sourceId);
      return client;
    } catch (err) {
      this.failedAt.set(sourceId, Date.now());
      this.attempts.set(sourceId, (this.attempts.get(sourceId) ?? 0) + 1);
      throw new DownstreamError(
        sourceId,
        `failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.connecting.delete(sourceId);
    }
  }

  /** Call a tool on a downstream server, with per-call timeout. */
  async call(
    sourceId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = await this.getClient(sourceId);
    try {
      return (await client.callTool(
        { name: toolName, arguments: args },
        {
          timeout: this.opts.callTimeoutMs,
        },
      )) as CallToolResult;
    } catch (err) {
      // A transport-level failure poisons the cached client; drop it so the
      // next call reconnects instead of erroring forever.
      if (err instanceof Error && /closed|disconnect|ECONNRE/i.test(err.message)) {
        await this.dropClient(sourceId);
      }
      throw new DownstreamError(
        sourceId,
        `tool ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async dropClient(sourceId: string): Promise<void> {
    const client = this.clients.get(sourceId);
    this.clients.delete(sourceId);
    await client?.close().catch(() => {});
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
  }
}
