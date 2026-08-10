#!/usr/bin/env node
// Re-grade the judge-graded records of a completed bench run with the current
// judge prompt (after a judge-prompt fix), then re-emit the report as
// report-regraded.{json,md}. Programmatic (exact/contains) grades and all
// trial data are untouched — no agent trials are re-run.
//
// Usage: node packages/cli/scripts/regrade.mjs <runDir> [configPath]
import { register } from "tsx/esm/api";
register();

const { readFileSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const harness = await import("@toolc/harness");
const { loadConfig } = await import("@toolc/shared");

const [runDir, configPath = "toolc.config.jsonc"] = process.argv.slice(2);
if (!runDir) {
  console.error("usage: regrade.mjs <runDir> [configPath]");
  process.exit(1);
}

const config = loadConfig(configPath);
const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"));
const tasks = harness.loadTasks(config.bench.tasksDir);
const byId = new Map(tasks.map((t) => [t.id, t]));
const judge = harness.createAnthropicLlm();

let changed = 0;
let total = 0;
for (const record of report.records) {
  const task = byId.get(record.taskId);
  if (!task || task.grading.type !== "judge") continue;
  total++;
  const grade = await harness.gradeAnswer(task, record.finalAnswer, judge, config.bench.judgeModel);
  if (grade.pass !== record.pass) {
    changed++;
    console.error(
      `flip ${record.condition}/${record.taskId} t${record.trial}: ${record.pass} -> ${grade.pass} (${grade.reason.slice(0, 100)})`,
    );
  }
  record.pass = grade.pass;
  record.gradeReason = grade.reason;
}

const metrics = report.methodology.conditions.map((condition) =>
  harness.aggregate(
    condition,
    report.records.filter((r) => r.condition === condition),
  ),
);
report.metrics = metrics;
report.methodology.judgePromptVersion = harness.JUDGE_PROMPT_VERSION;
report.generatedAt = new Date().toISOString();

writeFileSync(join(runDir, "report-regraded.json"), JSON.stringify(report, null, 2));
writeFileSync(join(runDir, "report-regraded.md"), harness.renderMarkdown(report));
console.error(`regraded ${total} judge decisions, ${changed} flipped`);
console.error(`wrote ${join(runDir, "report-regraded.md")}`);
