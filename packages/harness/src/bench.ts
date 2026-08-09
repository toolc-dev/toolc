import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/client";
import type { ToolcConfig } from "@toolc/shared";
import { gradeAnswer } from "./grade.js";
import type { AgentLlm } from "./llm.js";
import { aggregate, type TrialRecord, toRecord } from "./metrics.js";
import { type BenchReport, buildReport, renderMarkdown } from "./report.js";
import { runTrial } from "./runner.js";
import { loadTasks } from "./task.js";

/** Condition → gateway serve mode (spec §10). Ablations serve compiled artifacts. */
export function conditionMode(condition: string): "mirror" | "compiled" {
  return condition === "raw" ? "mirror" : "compiled";
}

export interface BenchDeps {
  llm: AgentLlm;
  judgeLlm: AgentLlm;
  /**
   * Produce a fresh MCP transport to a gateway serving `condition`, tagged
   * with run/task ids for the call log. The harness owns connect/close.
   * Ablation conditions map to distinct compiled artifacts (CLI's concern).
   */
  makeTransport: (condition: string, runId: string, taskId: string) => Transport;
  log?: (message: string) => void;
}

export interface BenchRunResult {
  report: BenchReport;
  markdown: string;
  outDir: string;
}

export async function runBench(config: ToolcConfig, deps: BenchDeps): Promise<BenchRunResult> {
  const log = deps.log ?? (() => {});
  const bench = config.bench;
  const tasks = loadTasks(bench.tasksDir);
  const runId = `bench-${new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19)}`;
  const outDir = join(bench.outDir, runId);
  mkdirSync(outDir, { recursive: true });
  log(
    `run ${runId}: ${tasks.length} task(s) × ${bench.trials} trial(s) × ${bench.conditions.length} condition(s)`,
  );

  const records: TrialRecord[] = [];
  for (const condition of bench.conditions) {
    for (const task of tasks) {
      for (let trial = 1; trial <= bench.trials; trial++) {
        const client = new Client({ name: "toolc-harness", version: "0.0.1" });
        try {
          await client.connect(deps.makeTransport(condition, runId, task.id));
          const result = await runTrial({
            task,
            condition,
            trial,
            model: bench.model,
            maxTurns: bench.maxTurns,
            llm: deps.llm,
            client,
          });
          const grade = await gradeAnswer(
            task,
            result.finalAnswer,
            deps.judgeLlm,
            bench.judgeModel,
          );
          const record = toRecord(result, task, grade, bench.prices, bench.model);
          records.push(record);
          writeFileSync(
            join(outDir, `${condition}-${task.id}-t${trial}.json`),
            JSON.stringify(record, null, 2),
          );
          log(
            `  ${condition}/${task.id} t${trial}: ${grade.pass ? "PASS" : "FAIL"} ` +
              `(${result.toolCalls.length} calls, ${result.turns} turns${result.timedOut ? ", TIMEOUT" : ""}${result.fatalError ? `, ERROR: ${result.fatalError.slice(0, 80)}` : ""})`,
          );
        } finally {
          await client.close().catch(() => {});
        }
      }
    }
  }

  const metrics = bench.conditions.map((condition) =>
    aggregate(
      condition,
      records.filter((r) => r.condition === condition),
    ),
  );
  const report = buildReport({
    runId,
    generatedAt: new Date().toISOString(),
    config,
    tasks,
    metrics,
    records,
  });
  const markdown = renderMarkdown(report);
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "report.md"), markdown);
  log(`report written to ${join(outDir, "report.md")}`);
  return { report, markdown, outDir };
}
