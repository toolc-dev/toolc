import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildGraph } from "@toolc/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CallLog, createGateway, DownstreamPool, type Gateway } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = join(HERE, "../../core/test/fixtures/fixture-server.mjs");

const FIXTURE_DOWNSTREAM = {
  id: "fixture",
  transport: { type: "stdio" as const, command: "node", args: [FIXTURE_SERVER] },
  enabled: true,
};

describe("mirror gateway end-to-end (MCP client → gateway → fixture downstream)", () => {
  let gateway: Gateway;
  let client: Client;
  let log: CallLog;

  beforeAll(async () => {
    const graph = await buildGraph([FIXTURE_DOWNSTREAM]);
    log = new CallLog(":memory:");
    gateway = createGateway({
      graph,
      mode: "mirror",
      pool: new DownstreamPool([FIXTURE_DOWNSTREAM], { callTimeoutMs: 10_000 }),
      log,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await gateway.server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await gateway?.close();
  });

  it("lists every downstream tool namespaced with __ and original descriptions", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "fixture__add",
      "fixture__list_notes",
      "fixture__ping",
      "fixture__read_note",
    ]);
    const readNote = tools.find((t) => t.name === "fixture__read_note")!;
    expect(readNote.description).toBe("Read a note by name and return its full text content.");
    expect(readNote.inputSchema).toHaveProperty("properties.name");
  });

  it("round-trips a passthrough tool call", async () => {
    const result = await client.callTool({
      name: "fixture__read_note",
      arguments: { name: "alpha" },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(result.isError ?? false).toBe(false);
    expect(content[0]?.text).toContain("kumquat");
  });

  it("passes through downstream tool errors as isError results", async () => {
    const result = await client.callTool({
      name: "fixture__read_note",
      arguments: { name: "nope" },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects unknown tools with an actionable protocol error", async () => {
    await expect(client.callTool({ name: "fixture__nonexistent", arguments: {} })).rejects.toThrow(
      /unknown tool/i,
    );
  });

  it("logs every dispatched call with surface, tool id, and latency", () => {
    // Two dispatched calls: read_note(alpha) ok + read_note(nope) error.
    // The unknown-tool call is rejected before dispatch and is not logged.
    const rows = log.recent();
    expect(rows.length).toBe(2);
    const ok = rows.find((r) => r.toolId === "fixture:read_note" && !r.isError);
    expect(ok).toBeDefined();
    expect(ok!.surface).toBe("mirror");
    expect(ok!.argsJson).toContain("alpha");
    expect(ok!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(ok!.resultBytes).toBeGreaterThan(0);
    const failed = rows.find((r) => r.toolId === "fixture:read_note" && r.isError);
    expect(failed).toBeDefined();
    expect(failed!.errorText).toContain("no such note");
  });
});

describe("gateway resilience", () => {
  it("returns a tool error (not a crash) when the downstream is unreachable", async () => {
    const broken = {
      id: "broken",
      transport: { type: "stdio" as const, command: "node", args: ["/nonexistent.mjs"] },
      enabled: true,
    };
    // Graph introspected earlier; downstream dies before dispatch.
    const graph = await buildGraph([FIXTURE_DOWNSTREAM]);
    const renamed = {
      ...graph,
      tools: graph.tools.map((t) => ({ ...t, id: `broken:${t.name}`, source: "broken" })),
    };
    const log = new CallLog(":memory:");
    const gateway = createGateway({
      graph: renamed,
      mode: "mirror",
      pool: new DownstreamPool([broken], { callTimeoutMs: 5_000 }),
      log,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await gateway.server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "broken__ping", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("broken");

    const rows = log.recent();
    expect(rows[0]?.isError).toBe(true);

    await client.close().catch(() => {});
    await gateway.close();
  }, 30_000);
});
