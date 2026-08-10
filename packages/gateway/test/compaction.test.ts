import { describe, expect, it } from "vitest";
import {
  compactResult,
  DEFAULT_COMPACTION_PROMPT,
  estimateTokens,
  structuralCompact,
} from "../src/compaction.js";

const big = (n: number) => "x".repeat(n);

describe("compactResult", () => {
  it("passes small results through untouched", async () => {
    const result = { content: [{ type: "text" as const, text: "small" }] };
    const out = await compactResult(result, { toolName: "t", args: {} }, { triggerTokens: 2000, model: "m" });
    expect(out.compacted).toBe(false);
    expect(out.result).toBe(result);
  });

  it("never compacts error results", async () => {
    const result = { content: [{ type: "text" as const, text: big(50_000) }], isError: true };
    const out = await compactResult(result, { toolName: "t", args: {} }, { triggerTokens: 100, model: "m" });
    expect(out.compacted).toBe(false);
  });

  it("uses the LLM with the configured model and prompt", async () => {
    const seen: Record<string, unknown>[] = [];
    const out = await compactResult(
      { content: [{ type: "text" as const, text: big(20_000) }] },
      { toolName: "hf:search", args: { q: "tts" } },
      {
        triggerTokens: 500,
        model: "claude-haiku-4-5",
        prompt: "Custom compaction rules.",
        llm: async (args) => {
          seen.push(args);
          return "compact summary";
        },
      },
    );
    expect(out).toMatchObject({ compacted: true, strategy: "llm" });
    expect(seen[0]!.model).toBe("claude-haiku-4-5");
    expect(seen[0]!.system).toBe("Custom compaction rules.");
    expect(seen[0]!.prompt).toContain("hf:search");
    const text = (out.result.content![0] as { text: string }).text;
    expect(text).toContain("auto-compaction");
    expect(text).toContain("compact summary");
  });

  it("defaults the prompt when none is configured", async () => {
    const seen: Record<string, unknown>[] = [];
    await compactResult(
      { content: [{ type: "text" as const, text: big(20_000) }] },
      { toolName: "t", args: {} },
      { triggerTokens: 500, model: "m", prompt: null, llm: async (a) => (seen.push(a), "ok") },
    );
    expect(seen[0]!.system).toContain(DEFAULT_COMPACTION_PROMPT.slice(0, 40));
    expect(seen[0]!.system).toContain("source and cite");
  });

  it("keeps structural fallback when the LLM output does not shrink the result", async () => {
    const out = await compactResult(
      { content: [{ type: "text" as const, text: big(20_000) }] },
      { toolName: "t", args: {} },
      { triggerTokens: 500, model: "m", llm: async () => big(30_000) },
    );
    expect(out).toMatchObject({ compacted: true, strategy: "structural" });
  });

  it("falls back to structural compaction when the LLM fails", async () => {
    const out = await compactResult(
      { content: [{ type: "text" as const, text: big(20_000) }] },
      { toolName: "t", args: {} },
      {
        triggerTokens: 500,
        model: "m",
        llm: async () => {
          throw new Error("rate limited");
        },
      },
    );
    expect(out).toMatchObject({ compacted: true, strategy: "structural" });
    expect(estimateTokens((out.result.content![0] as { text: string }).text)).toBeLessThan(700);
  });
});

describe("structuralCompact", () => {
  it("bounds long JSON arrays and strings", () => {
    const json = JSON.stringify({
      items: Array.from({ length: 100 }, (_, i) => ({ id: i, blob: big(2_000) })),
    });
    const out = structuralCompact(json, 4_000);
    expect(out).toContain("more items omitted");
    expect(out.length).toBeLessThanOrEqual(4_000 * 4 + 200);
  });

  it("head+tail truncates non-JSON text", () => {
    const out = structuralCompact(big(100_000), 1_000);
    expect(out).toContain("characters omitted");
    expect(out.length).toBeLessThanOrEqual(1_000 * 4 + 100);
  });
});
