import { DownstreamError } from "@toolc/shared";
import { describe, expect, it } from "vitest";
import { buildGraph, introspectSource } from "../src/frontend/mcp.js";
import { FIXTURE_SERVER_PATH } from "./fixtures/index.js";

const FIXTURE_DOWNSTREAM = {
  id: "fixture",
  transport: { type: "stdio" as const, command: "node", args: [FIXTURE_SERVER_PATH] },
  enabled: true,
};

describe("introspectSource (against fixture stdio server)", () => {
  it("normalizes the catalog into ToolNodes with namespaced ids", async () => {
    const { source, tools } = await introspectSource(FIXTURE_DOWNSTREAM, {
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(source.serverName).toBe("fixture-server");
    expect(source.instructions).toContain("deterministic");
    expect(source.toolCount).toBe(4);
    const ids = tools.map((t) => t.id).sort();
    expect(ids).toEqual(["fixture:add", "fixture:list_notes", "fixture:ping", "fixture:read_note"]);
    const readNote = tools.find((t) => t.id === "fixture:read_note")!;
    expect(readNote.kind).toBe("passthrough");
    expect(readNote.description).toContain("Read a note");
    expect(readNote.inputSchema).toHaveProperty("properties");
    expect(readNote.overlays).toEqual({});
  }, 20_000);

  it("produces a stable catalogHash across introspections", async () => {
    const a = await introspectSource(FIXTURE_DOWNSTREAM);
    const b = await introspectSource(FIXTURE_DOWNSTREAM);
    expect(a.source.catalogHash).toBe(b.source.catalogHash);
  }, 20_000);
});

describe("buildGraph", () => {
  it("hard-errors on unavailable downstreams by default", async () => {
    await expect(
      buildGraph([
        {
          id: "broken",
          transport: { type: "stdio" as const, command: "node", args: ["/nonexistent.mjs"] },
          enabled: true,
        },
      ]),
    ).rejects.toThrow(DownstreamError);
  }, 20_000);

  it("skips unavailable downstreams with skipUnavailable, warning", async () => {
    const warnings: string[] = [];
    const graph = await buildGraph(
      [
        FIXTURE_DOWNSTREAM,
        {
          id: "broken",
          transport: { type: "stdio" as const, command: "node", args: ["/nonexistent.mjs"] },
          enabled: true,
        },
      ],
      { skipUnavailable: true, onWarn: (m) => warnings.push(m) },
    );
    expect(graph.sources.map((s) => s.id)).toEqual(["fixture"]);
    expect(graph.tools).toHaveLength(4);
    expect(graph.version).toMatch(/^[0-9a-f]{16}$/);
    expect(warnings.some((w) => w.includes("broken"))).toBe(true);
  }, 20_000);

  it("ignores disabled downstreams", async () => {
    const graph = await buildGraph([{ ...FIXTURE_DOWNSTREAM, enabled: false }]);
    expect(graph.sources).toHaveLength(0);
    expect(graph.tools).toHaveLength(0);
  });
});
