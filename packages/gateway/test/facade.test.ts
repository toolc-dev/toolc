import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildGraph, createMemoryRewriteCache, runPasses } from "@toolc/core";
import { parseConfig } from "@toolc/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CallLog, createGateway, type Gateway } from "../src/index.js";
import { DownstreamPool } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = join(HERE, "../../core/test/fixtures/fixture-server.mjs");

const FIXTURE_DOWNSTREAM = {
  id: "fixture",
  transport: { type: "stdio" as const, command: "node", args: [FIXTURE_SERVER] },
  enabled: true,
};

/** Deterministic "LLM": merge the two note tools into a `notes` facade. */
const FAKE_LLM = async () =>
  `<<<GROUP notes>>>
<<<MEMBERS>>>
list = list_notes
read = read_note
<<<DESCRIPTION>>>
List available notes or read one by name.
<<<END>>>`;

describe("facade dispatch end-to-end (consolidate → serve → route)", () => {
  let gateway: Gateway;
  let client: Client;
  let log: CallLog;

  beforeAll(async () => {
    const config = parseConfig(
      JSON.stringify({
        project: "facade-test",
        downstream: [{ id: "fixture", transport: { type: "stdio", command: "node" } }],
        compile: { passes: ["consolidate"], macrosDir: "/nonexistent" },
      }),
      {},
    );
    const raw = await buildGraph([FIXTURE_DOWNSTREAM]);
    const { graph } = await runPasses(raw, config, {
      macros: [],
      rewriteCache: createMemoryRewriteCache(),
      llm: FAKE_LLM,
      warn: () => {},
    });
    log = new CallLog(":memory:");
    gateway = createGateway({
      graph,
      mode: "compiled",
      pool: new DownstreamPool([FIXTURE_DOWNSTREAM]),
      log,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([
      gateway.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await gateway.close();
  });

  it("serves the facade instead of its members", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("fixture__notes");
    expect(names).not.toContain("fixture__list_notes");
    expect(names).not.toContain("fixture__read_note");
    // Unmerged tools still served directly (no selection pass in this config).
    expect(names).toContain("fixture__add");
  });

  it("routes actions to members with member-schema validation", async () => {
    const listing = await client.callTool({
      name: "fixture__notes",
      arguments: { action: "list", arguments: {} },
    });
    const listText = (listing.content as Array<{ text: string }>)[0]!.text;
    expect(listText.length).toBeGreaterThan(0);

    const first = listText.split("\n")[0]!.trim();
    const read = await client.callTool({
      name: "fixture__notes",
      arguments: { action: "read", arguments: { name: first } },
    });
    expect(read.isError).toBeFalsy();
    expect((read.content as Array<{ text: string }>)[0]!.text.length).toBeGreaterThan(0);
  });

  it("returns actionable errors for bad actions and bad member args", async () => {
    const badAction = await client.callTool({
      name: "fixture__notes",
      arguments: { action: "delete", arguments: {} },
    });
    expect(badAction.isError).toBe(true);
    expect((badAction.content as Array<{ text: string }>)[0]!.text).toContain("list, read");

    const badArgs = await client.callTool({
      name: "fixture__notes",
      arguments: { action: "read", arguments: { wrong: 1 } },
    });
    expect(badArgs.isError).toBe(true);
  });

  it("logs the facade call with the member as a child call", async () => {
    const rows = log.recent(50) as Array<{ toolId: string; parentCallId: number | null }>;
    const facadeRow = rows.find((r) => r.toolId === "fixture:notes");
    expect(facadeRow).toBeTruthy();
    const childRow = rows.find(
      (r) => r.toolId === "fixture:read_note" && r.parentCallId !== null,
    );
    expect(childRow).toBeTruthy();
  });
});
