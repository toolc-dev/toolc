import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildGraph, createMemoryRewriteCache, runPasses, surfaceStats } from "@toolc/core";
import { parseConfig } from "@toolc/shared";
import { describe, expect, it } from "vitest";
import { CallLog, createGateway, DownstreamPool } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../core/test/fixtures");

const FEDERATION = [
  {
    id: "large",
    transport: {
      type: "stdio" as const,
      command: "node",
      args: [join(FIXTURES, "fixture-server-large.mjs")],
    },
    enabled: true,
  },
  {
    id: "fixture",
    transport: {
      type: "stdio" as const,
      command: "node",
      args: [join(FIXTURES, "fixture-server.mjs")],
    },
    enabled: true,
  },
];

const CONFIG = parseConfig(
  JSON.stringify({
    project: "scale-test",
    downstream: [{ id: "large", transport: { type: "stdio", command: "node" } }],
  }),
  {},
);

describe("M2 exit: 100+-tool federation compiles to a compact surface", () => {
  it("serves ≤ 12 definitions, keeps everything searchable, and slashes context tokens", async () => {
    const raw = await buildGraph(FEDERATION);
    expect(raw.tools.length).toBeGreaterThanOrEqual(120);

    const { graph } = await runPasses(raw, CONFIG, {
      macros: [],
      rewriteCache: createMemoryRewriteCache(),
      warn: () => {},
    });
    const stats = surfaceStats(graph);
    expect(stats.servedCount).toBeLessThanOrEqual(12);
    expect(stats.searchableCount).toBeGreaterThanOrEqual(120); // ping hidden by dead-tool
    expect(stats.servedTokens).toBeLessThan(stats.mirrorTokens * 0.1);

    // Serve it and prove search still reaches the long tail.
    const log = new CallLog(":memory:");
    const gateway = createGateway({
      graph,
      mode: "compiled",
      pool: new DownstreamPool(FEDERATION, { callTimeoutMs: 10_000 }),
      log,
      searchTopK: 5,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await gateway.server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.length).toBeLessThanOrEqual(12);

    const search = await client.callTool({
      name: "search_tools",
      arguments: { query: "archive a support ticket" },
    });
    const text = (search.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(text).toContain("large:archive_tickets");

    const call = await client.callTool({
      name: "call_tool",
      arguments: { name: "large:archive_tickets", arguments: { query: "T-1" } },
    });
    expect((call.content as Array<{ text?: string }>)[0]?.text).toBe("archive_tickets:T-1");

    await client.close().catch(() => {});
    await gateway.close();
  }, 40_000);
});
