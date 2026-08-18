import { parseConfig } from "@toolc/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  consolidatePass,
  createMemoryRewriteCache,
  deadToolPass,
  enforceSummaryLimit,
  type MacroDefinition,
  macroInlinePass,
  matchesGlob,
  type PassContext,
  rewriteCacheKey,
  rewritePass,
  runPasses,
  searchableTools,
  selectionPass,
  servedTools,
  surfaceStats,
} from "../src/index.js";
import { fixtureFederationGraph } from "./fixtures/index.js";

function config(overrides: Record<string, unknown> = {}) {
  return parseConfig(
    JSON.stringify({
      project: "t",
      downstream: [{ id: "finco", transport: { type: "stdio", command: "x" } }],
      ...overrides,
    }),
    {},
  );
}

function ctx(overrides: Partial<PassContext> = {}): PassContext {
  return { macros: [], warn: () => {}, ...overrides };
}

const TEST_MACRO: MacroDefinition<{ ticker: string; topic: string }> = {
  name: "get_latest_earnings_discussion",
  description: "Given a ticker and topic, return what management said on the latest call.",
  inputSchema: z.object({ ticker: z.string(), topic: z.string() }),
  uses: ["finco:find_events", "finco:search_transcripts"],
  provenance: "test",
  steps: async () => "unused in pass tests",
};

describe("matchesGlob", () => {
  it("matches exact ids and * wildcards", () => {
    expect(matchesGlob("finco:ping", "finco:ping")).toBe(true);
    expect(matchesGlob("repohub:*_enterprise_*", "repohub:admin_enterprise_stats")).toBe(true);
    expect(matchesGlob("finco:*", "repohub:list_issues")).toBe(false);
    expect(matchesGlob("*:search_*", "finco:search_transcripts")).toBe(true);
  });
});

describe("dead-tool pass", () => {
  it("auto-hides noise tools and applies exclude globs", async () => {
    const cfg = config({ compile: { deadTool: { exclude: ["repohub:*_enterprise_*"] } } });
    const { graph, diff } = await deadToolPass(fixtureFederationGraph(), cfg, ctx());
    const hidden = graph.tools.filter((t) => t.overlays.hidden).map((t) => t.id);
    expect(hidden).toContain("finco:ping"); // auto-noise
    expect(hidden).toContain("finco:debug_auth"); // auto-noise
    expect(hidden).toContain("repohub:admin_enterprise_stats"); // config-exclude
    expect(hidden).toHaveLength(3);
    expect(diff.hidden).toHaveLength(3);
    const ping = graph.tools.find((t) => t.id === "finco:ping")!;
    expect(ping.overlays.hiddenReason).toBe("auto-noise");
    expect(ping.description).toBe("Ping the API."); // original untouched
  });

  it("include list switches to allowlist mode and overrides auto-noise", async () => {
    const cfg = config({ compile: { deadTool: { include: ["finco:ping", "repohub:*"] } } });
    const { graph } = await deadToolPass(fixtureFederationGraph(), cfg, ctx());
    const visible = graph.tools.filter((t) => !t.overlays.hidden).map((t) => t.id);
    expect(visible).toContain("finco:ping"); // explicitly included beats auto-noise
    expect(visible).not.toContain("finco:find_events");
    expect(visible.filter((id) => id.startsWith("repohub:"))).toHaveLength(6);
  });
});

describe("rewrite pass", () => {
  const llmReturning = (descriptions: Record<string, string>) => async () =>
    Object.entries(descriptions)
      .map(([name, description]) => `<<<TOOL ${name}>>>\n${description}\n<<<END>>>`)
      .join("\n");

  it("generates proposals into the cache but does not apply them in reviewMode", async () => {
    const cache = createMemoryRewriteCache();
    const cfg = config({ compile: { rewrite: { reviewMode: true } } });
    const llm = llmReturning({ find_events: "Find scheduled events for a company." });
    const { graph, diff } = await rewritePass(
      fixtureFederationGraph(),
      cfg,
      ctx({ rewriteCache: cache, llm }),
    );
    expect(diff.rewritten).toHaveLength(0);
    const tool = fixtureFederationGraph().tools.find((t) => t.id === "finco:find_events")!;
    const entry = cache.get(rewriteCacheKey(tool.id, tool.description));
    expect(entry).toBeDefined();
    expect(entry!.approved).toBe(false);
    expect(
      graph.tools.find((t) => t.id === "finco:find_events")!.overlays.description,
    ).toBeUndefined();
  });

  it("applies approved entries as overlays, preserving originals", async () => {
    const base = fixtureFederationGraph();
    const tool = base.tools.find((t) => t.id === "finco:find_events")!;
    const key = rewriteCacheKey(tool.id, tool.description);
    const cache = createMemoryRewriteCache({
      [key]: {
        toolId: tool.id,
        originalDescriptionHash: "x",
        promptVersion: "v1",
        description: "Find scheduled events for a company.",
        approved: true,
      },
    });
    const { graph, diff } = await rewritePass(base, config(), ctx({ rewriteCache: cache }));
    const rewritten = graph.tools.find((t) => t.id === "finco:find_events")!;
    expect(diff.rewritten).toContain("finco:find_events");
    expect(rewritten.overlays.description).toBe("Find scheduled events for a company.");
    expect(rewritten.description).toBe(tool.description);
  });

  it("auto-approves when reviewMode is false", async () => {
    const cache = createMemoryRewriteCache();
    const cfg = config({ compile: { rewrite: { reviewMode: false } } });
    const llm = llmReturning({ get_transcript: "Fetch the full transcript for one event id." });
    const { diff } = await rewritePass(
      fixtureFederationGraph(),
      cfg,
      ctx({ rewriteCache: cache, llm }),
    );
    expect(diff.rewritten).toContain("finco:get_transcript");
  });

  it("is a no-op with a warning when no LLM is available", async () => {
    const warnings: string[] = [];
    const { graph, diff } = await rewritePass(
      fixtureFederationGraph(),
      config(),
      ctx({ rewriteCache: createMemoryRewriteCache(), warn: (m) => warnings.push(m) }),
    );
    expect(diff.rewritten).toHaveLength(0);
    expect(graph.tools.every((t) => t.overlays.description === undefined)).toBe(true);
    expect(warnings.some((w) => w.includes("unavailable"))).toBe(true);
  });

  it("enforceSummaryLimit truncates only long summary lines", () => {
    expect(enforceSummaryLimit("short")).toBe("short");
    const long = `${"word ".repeat(100)}end`;
    const out = enforceSummaryLimit(long);
    expect(out.split("\n")[0]!.length).toBeLessThanOrEqual(320);
    expect(out.endsWith("…")).toBe(true);
    const multi = `${"word ".repeat(100)}end\nbody stays`;
    expect(enforceSummaryLimit(multi).endsWith("\nbody stays")).toBe(true);
  });
});

describe("macro-inline pass", () => {
  it("adds macro nodes with JSON schemas and data edges", async () => {
    const { graph, diff } = await macroInlinePass(
      fixtureFederationGraph(),
      config(),
      ctx({ macros: [TEST_MACRO] }),
    );
    expect(diff.added).toEqual(["toolc:get_latest_earnings_discussion"]);
    const node = graph.tools.find((t) => t.id === "toolc:get_latest_earnings_discussion")!;
    expect(node.kind).toBe("macro");
    expect(node.inputSchema).toHaveProperty("properties.ticker");
    expect(graph.edges).toEqual([
      {
        from: "finco:find_events",
        fromField: "$",
        to: "finco:search_transcripts",
        toField: "$",
        via: "macro",
      },
    ]);
    // constituents stay visible by default
    expect(graph.tools.find((t) => t.id === "finco:find_events")!.overlays.hidden).toBeUndefined();
  });

  it("skips macros whose uses are not in the federation, with a warning", async () => {
    const warnings: string[] = [];
    const bad = { ...TEST_MACRO, name: "bad", uses: ["nope:missing"] };
    const { graph } = await macroInlinePass(
      fixtureFederationGraph(),
      config(),
      ctx({ macros: [bad], warn: (m) => warnings.push(m) }),
    );
    expect(graph.tools.some((t) => t.id === "toolc:bad")).toBe(false);
    expect(warnings[0]).toContain("nope:missing");
  });

  it("hides inlined constituents when configured", async () => {
    const cfg = config({ compile: { macroInline: { hideInlined: true } } });
    const { graph } = await macroInlinePass(
      fixtureFederationGraph(),
      cfg,
      ctx({ macros: [TEST_MACRO] }),
    );
    expect(graph.tools.find((t) => t.id === "finco:find_events")!.overlays.hiddenReason).toBe(
      "macro-inlined",
    );
  });
});

describe("selection pass", () => {
  it("surfaces only meta + macros by default and marks the rest searchable", async () => {
    const withMacros = await macroInlinePass(
      fixtureFederationGraph(),
      config(),
      ctx({ macros: [TEST_MACRO] }),
    );
    const { graph, diff } = await selectionPass(withMacros.graph, config(), ctx());
    const served = servedTools(graph)
      .map((t) => t.id)
      .sort();
    expect(served).toEqual([
      "toolc:call_tool",
      "toolc:get_latest_earnings_discussion",
      "toolc:search_tools",
    ]);
    expect(diff.added).toContain("toolc:search_tools");
    const passthrough = graph.tools.find((t) => t.id === "finco:find_events")!;
    expect(passthrough.overlays.surfaced).toBe(false);
    expect(passthrough.overlays.hidden).toBeUndefined(); // searchable, not hidden
  });

  it("honors alwaysVisible globs", async () => {
    const cfg = config({ compile: { selection: { alwaysVisible: ["finco:search_*"] } } });
    const { graph } = await selectionPass(fixtureFederationGraph(), cfg, ctx());
    expect(graph.tools.find((t) => t.id === "finco:search_transcripts")!.overlays.surfaced).toBe(
      true,
    );
    expect(graph.tools.find((t) => t.id === "finco:find_events")!.overlays.surfaced).toBe(false);
  });
});

describe("full pipeline (runPasses)", () => {
  it("runs all passes in order and produces a compact, re-hashed surface", async () => {
    const base = fixtureFederationGraph();
    const { graph, diffs } = await runPasses(
      base,
      config({ compile: { deadTool: { exclude: ["repohub:*_enterprise_*"] } } }),
      ctx({ macros: [TEST_MACRO], rewriteCache: createMemoryRewriteCache() }),
    );
    expect(diffs.map((d) => d.pass)).toEqual(["dead-tool", "rewrite", "macro-inline", "selection"]);
    expect(graph.version).not.toBe(base.version);
    const stats = surfaceStats(graph);
    expect(stats.servedCount).toBe(3); // search_tools + call_tool + macro
    expect(stats.searchableCount).toBe(9); // 12 - 3 hidden
    expect(stats.hiddenCount).toBe(3);
    expect(stats.servedTokens).toBeLessThan(stats.mirrorTokens);
  });
});

describe("consolidatePass", () => {
  const groupBlock = (name: string, members: string, desc: string) =>
    `<<<GROUP ${name}>>>\n<<<MEMBERS>>>\n${members}\n<<<DESCRIPTION>>>\n${desc}\n<<<END>>>`;

  it("synthesizes a facade, hides members, and documents action params", async () => {
    const llm = async () =>
      groupBlock(
        "transcripts",
        "search = search_transcripts\nget = get_transcript",
        "Search or fetch earnings-call transcripts.",
      );
    const { graph, diff } = await consolidatePass(fixtureFederationGraph(), config(), ctx({ llm }));

    const facade = graph.tools.find((t) => t.id === "finco:transcripts")!;
    expect(facade.kind).toBe("facade");
    expect(facade.facade?.actions).toEqual({
      search: "finco:search_transcripts",
      get: "finco:get_transcript",
    });
    const actionProp = (facade.inputSchema.properties as Record<string, { enum?: string[] }>)
      .action;
    expect(actionProp?.enum).toEqual(["search", "get"]);
    expect(facade.description).toContain("Action parameters");
    expect(facade.description).toContain("search(");
    expect(diff.added).toEqual(["finco:transcripts"]);
    expect(diff.hidden.sort()).toEqual(["finco:get_transcript", "finco:search_transcripts"]);
    for (const id of diff.hidden) {
      const member = graph.tools.find((t) => t.id === id)!;
      expect(member.overlays.hidden).toBe(true);
      expect(member.overlays.hiddenReason).toContain("finco:transcripts");
    }
  });

  it("rejects groups with unknown members, collisions, or reused members", async () => {
    const warnings: string[] = [];
    const llm = async () =>
      [
        groupBlock("bogus", "a = does_not_exist\nb = find_events", "Bad members."),
        groupBlock("find_companies", "a = find_events\nb = search_transcripts", "Name collides."),
        groupBlock("events", "find = find_events\nsearch = search_transcripts", "Valid group."),
        groupBlock("again", "x = find_events\ny = find_companies", "Reuses a claimed member."),
      ].join("\n");
    const { graph, diff } = await consolidatePass(
      fixtureFederationGraph(),
      config(),
      ctx({ llm, warn: (m) => warnings.push(m) }),
    );
    expect(diff.added).toEqual(["finco:events"]);
    expect(graph.tools.some((t) => t.id === "finco:bogus")).toBe(false);
    expect(warnings.some((w) => w.includes("does_not_exist"))).toBe(true);
    expect(warnings.some((w) => w.includes("collides"))).toBe(true);
    expect(warnings.some((w) => w.includes("already belongs"))).toBe(true);
  });

  it("is a warning no-op without an LLM", async () => {
    const before = fixtureFederationGraph();
    const { graph, diff } = await consolidatePass(before, config(), ctx());
    expect(graph.tools).toEqual(before.tools);
    expect(diff.notes[0]).toContain("skipped");
  });

  it("facades survive selection as searchable, members do not", async () => {
    const llm = async () =>
      groupBlock(
        "transcripts",
        "search = search_transcripts\nget = get_transcript",
        "Transcripts facade.",
      );
    const cfg = config({ compile: { passes: ["consolidate", "selection"], macrosDir: "/nonexistent" } });
    const { graph } = await runPasses(fixtureFederationGraph(), cfg, {
      ...ctx({ llm }),
      macros: [],
    });
    const searchable = searchableTools(graph).map((t) => t.id);
    expect(searchable).toContain("finco:transcripts");
    expect(searchable).not.toContain("finco:search_transcripts");
  });
});

describe("cross-server consolidation", () => {
  const crossConfig = () =>
    config({
      compile: {
        passes: ["consolidate"],
        macrosDir: "/nonexistent",
        consolidate: { crossServer: true },
      },
    });

  it("merges overlapping capabilities across sources into a toolc facade", async () => {
    const llm = async ({ system }: { system: string }) => {
      if (system.includes("multi-server") || system.includes("OVERLAP ACROSS SERVERS")) {
        return `<<<GROUP code_search>>>
<<<MEMBERS>>>
finco_transcripts = finco:search_transcripts
repohub_code = repohub:search_repositories
<<<DESCRIPTION>>>
Search across content sources.
<<<END>>>`;
      }
      return "<<<NONE>>>";
    };
    const { graph, diff } = await consolidatePass(fixtureFederationGraph(), crossConfig(), ctx({ llm }));
    const facade = graph.tools.find((t) => t.id === "toolc:code_search")!;
    expect(facade.kind).toBe("facade");
    expect(facade.facade?.actions).toEqual({
      finco_transcripts: "finco:search_transcripts",
      repohub_code: "repohub:search_repositories",
    });
    expect(facade.description).toContain("[source: finco]");
    expect(facade.description).toContain("[source: repohub]");
    expect(diff.hidden).toContain("finco:search_transcripts");
    expect(diff.hidden).toContain("repohub:search_repositories");
  });

  it("rejects single-source groups in the cross phase", async () => {
    const warnings: string[] = [];
    const llm = async ({ system }: { system: string }) =>
      system.includes("OVERLAP ACROSS SERVERS")
        ? `<<<GROUP events>>>
<<<MEMBERS>>>
a = finco:find_events
b = finco:find_companies
<<<DESCRIPTION>>>
Same-source group, should be rejected here.
<<<END>>>`
        : "<<<NONE>>>";
    const { graph } = await consolidatePass(
      fixtureFederationGraph(),
      crossConfig(),
      ctx({ llm, warn: (m) => warnings.push(m) }),
    );
    expect(graph.tools.some((t) => t.id === "toolc:events")).toBe(false);
    expect(warnings.some((w) => w.includes("at least two sources"))).toBe(true);
  });
});
