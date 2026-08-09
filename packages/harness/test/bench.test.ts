import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadConfig } from "@toolc/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { type AgentLlm, conditionMode, runBench } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const CLI_BIN = join(HERE, "../../cli/bin/toolc.mjs");
const CONFIG_PATH = join(FIXTURES, "toolc.config.jsonc");

/**
 * Scripted agent: uses the direct namespaced tool when the surface offers it
 * (raw condition), falls back to call_tool (compiled condition), and refuses
 * when the prompt asks for something no tool covers.
 */
const mockAgent: AgentLlm = {
  async chat({ messages, tools }) {
    const usage = { inputTokens: 100, outputTokens: 25 };
    const last = messages[messages.length - 1]!;
    if (Array.isArray(last.content)) {
      const toolResult = last.content.find((b) => b.type === "tool_result");
      if (toolResult && "content" in toolResult) {
        return {
          content: [{ type: "text", text: `Based on the tool output: ${toolResult.content}` }],
          stopReason: "end_turn",
          usage,
        };
      }
    }
    const prompt = typeof messages[0]!.content === "string" ? messages[0]!.content : "";
    if (prompt.includes("weather")) {
      return {
        content: [
          {
            type: "text",
            text: "None of my available tools provide weather data, so I cannot answer this reliably.",
          },
        ],
        stopReason: "end_turn",
        usage,
      };
    }
    if (tools.some((t) => t.name === "fixture__read_note")) {
      return {
        content: [
          { type: "tool_use", id: "tu_1", name: "fixture__read_note", input: { name: "alpha" } },
        ],
        stopReason: "tool_use",
        usage,
      };
    }
    return {
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "call_tool",
          input: { name: "fixture:read_note", arguments: { name: "alpha" } },
        },
      ],
      stopReason: "tool_use",
      usage,
    };
  },
};

/** Scripted judge for the no-tool task. */
const mockJudge: AgentLlm = {
  async chat({ messages }) {
    const prompt = typeof messages[0]!.content === "string" ? messages[0]!.content : "";
    const pass = /cannot answer|no.*tool/i.test(prompt.split("## Agent's final answer")[1] ?? "");
    return {
      content: [{ type: "text", text: `VERDICT: ${pass ? "pass" : "fail"}\nREASON: scripted` }],
      stopReason: "end_turn",
      usage: { inputTokens: 50, outputTokens: 10 },
    };
  },
};

describe("harness smoke suite (mock LLM, real gateway over MCP)", () => {
  beforeAll(() => {
    // Produce the compiled artifact the compiled condition serves.
    execFileSync("node", [CLI_BIN, "-c", "toolc.config.jsonc", "compile"], {
      cwd: FIXTURES,
      stdio: "pipe",
    });
  }, 120_000);

  it("runs raw vs compiled end-to-end and emits a coherent report", async () => {
    const config = loadConfig(CONFIG_PATH, {});
    // Paths in the config are relative to the fixtures dir.
    config.bench.tasksDir = join(FIXTURES, "tasks");
    config.bench.outDir = join(FIXTURES, ".toolc/bench");
    config.serve.compiledPath = join(FIXTURES, ".toolc/compiled.json");

    const { report, markdown, outDir } = await runBench(config, {
      llm: mockAgent,
      judgeLlm: mockJudge,
      makeTransport: (condition, runId, taskId) =>
        new StdioClientTransport({
          command: "node",
          args: [CLI_BIN, "-c", "toolc.config.jsonc", "serve", "--mode", conditionMode(condition)],
          cwd: FIXTURES,
          env: {
            ...(process.env as Record<string, string>),
            TOOLC_RUN_ID: runId,
            TOOLC_TASK_ID: taskId,
          },
          stderr: "ignore",
        }),
    });

    // Both conditions ran every task and passed.
    expect(report.metrics.map((c) => c.condition)).toEqual(["raw", "compiled"]);
    for (const condition of report.metrics) {
      expect(condition.n).toBe(2);
      expect(condition.successRate).toBe(1);
      expect(condition.costPerCompletedTaskUsd).toBeGreaterThan(0);
    }

    // The two surfaces actually differed: raw called the namespaced tool,
    // compiled went through call_tool, and compiled showed fewer definitions.
    const rawNeedle = report.records.find(
      (r) => r.condition === "raw" && r.taskId === "smoke-needle-01",
    )!;
    const compiledNeedle = report.records.find(
      (r) => r.condition === "compiled" && r.taskId === "smoke-needle-01",
    )!;
    expect(rawNeedle.toolCalls.map((c) => c.name)).toEqual(["fixture__read_note"]);
    expect(compiledNeedle.toolCalls.map((c) => c.name)).toEqual(["call_tool"]);
    expect(compiledNeedle.toolCount).toBeLessThan(rawNeedle.toolCount);
    // NOTE: on this 4-tool fixture the meta-tool definitions cost MORE tokens
    // than the raw catalog — the context win only appears at scale (see
    // gateway/test/scale.test.ts). Here we only assert the metric is recorded.
    expect(compiledNeedle.toolsArrayTokensEst).toBeGreaterThan(0);

    // Report artifacts exist and look sane.
    const fs = await import("node:fs");
    expect(fs.existsSync(join(outDir, "report.md"))).toBe(true);
    expect(fs.existsSync(join(outDir, "report.json"))).toBe(true);
    expect(fs.existsSync(join(outDir, "raw-smoke-needle-01-t1.json"))).toBe(true);
    expect(markdown).toContain("## Headline");
    expect(markdown).toContain("| raw |");
    expect(markdown).toContain("| compiled |");
    expect(markdown).toContain("Methodology");
  }, 240_000);
});
