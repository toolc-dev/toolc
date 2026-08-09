import type { ToolcConfig } from "@toolc/shared";
import { JUDGE_PROMPT_VERSION } from "./grade.js";
import type { ConditionMetrics, TrialRecord } from "./metrics.js";
import { SYSTEM_PROMPT_VERSION } from "./runner.js";
import type { Task } from "./task.js";

export interface BenchReport {
  runId: string;
  generatedAt: string;
  project: string;
  methodology: {
    model: string;
    judgeModel: string;
    trials: number;
    conditions: string[];
    taskCount: number;
    systemPromptVersion: string;
    judgePromptVersion: string;
    priceDateStamp: string;
  };
  metrics: ConditionMetrics[];
  records: TrialRecord[];
}

export function buildReport(args: {
  runId: string;
  generatedAt: string;
  config: ToolcConfig;
  tasks: Task[];
  metrics: ConditionMetrics[];
  records: TrialRecord[];
}): BenchReport {
  return {
    runId: args.runId,
    generatedAt: args.generatedAt,
    project: args.config.project,
    methodology: {
      model: args.config.bench.model,
      judgeModel: args.config.bench.judgeModel,
      trials: args.config.bench.trials,
      conditions: args.metrics.map((m) => m.condition),
      taskCount: args.tasks.length,
      systemPromptVersion: SYSTEM_PROMPT_VERSION,
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      priceDateStamp: args.config.bench.prices.dateStamp,
    },
    metrics: args.metrics,
    records: args.records,
  };
}

export function renderMarkdown(report: BenchReport): string {
  const m = report.methodology;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const usd = (x: number | null) => (x === null ? "—" : `$${x.toFixed(4)}`);
  const lines: string[] = [
    `# toolc benchmark report — ${report.project}`,
    "",
    `Run \`${report.runId}\`, generated ${report.generatedAt}.`,
    "",
    "## Headline",
    "",
    "| condition | success rate | 95% CI | cost / completed task | mean tool-def tokens* | tools shown |",
    "|---|---|---|---|---|---|",
    ...report.metrics.map(
      (c) =>
        `| ${c.condition} | **${pct(c.successRate)}** (${c.successes}/${c.n}) | ${pct(c.successCi95[0])}–${pct(c.successCi95[1])} | ${usd(c.costPerCompletedTaskUsd)} | ~${Math.round(c.meanToolsArrayTokens)} | ${Math.round(c.meanToolCount)} |`,
    ),
    "",
    "*estimated (chars/4) over the serialized tools array presented to the model.",
    "",
    "## Secondary metrics",
    "",
    "| condition | mean in-tokens | mean out-tokens | mean tool calls | wrong-tool rate† | mean turns | mean wall ms | total cost |",
    "|---|---|---|---|---|---|---|---|",
    ...report.metrics.map(
      (c) =>
        `| ${c.condition} | ${Math.round(c.meanInputTokens)} | ${Math.round(c.meanOutputTokens)} | ${c.meanToolCalls.toFixed(1)} | ${c.wrongToolRate === null ? "—" : pct(c.wrongToolRate)} | ${c.meanTurns.toFixed(1)} | ${Math.round(c.meanWallMs)} | ${usd(c.totalCostUsd)} |`,
    ),
    "",
    "†heuristic: errored tool calls / total tool calls (spec §10 also counts abandoned calls; v1 counts errors only).",
    "",
    "## Per-category success",
    "",
  ];

  const categories = [...new Set(report.metrics.flatMap((c) => Object.keys(c.byCategory)))].sort();
  lines.push(
    `| category | ${report.metrics.map((c) => c.condition).join(" | ")} |`,
    `|---|${report.metrics.map(() => "---").join("|")}|`,
    ...categories.map(
      (cat) =>
        `| ${cat} | ${report.metrics
          .map((c) => {
            const bucket = c.byCategory[cat];
            return bucket ? `${pct(bucket.successRate)} (${bucket.successes}/${bucket.n})` : "—";
          })
          .join(" | ")} |`,
    ),
  );

  lines.push(
    "",
    "## Methodology",
    "",
    `- agent model: \`${m.model}\`; judge model: \`${m.judgeModel}\` (judge grades final answers only, never transcripts)`,
    `- ${m.taskCount} tasks × ${m.trials} trial(s) × ${m.conditions.length} condition(s); raw = mirror-mode gateway (verbatim catalogs), compiled = full pass pipeline`,
    `- both conditions traverse the same gateway hop, so transport latency is identical by construction`,
    `- system prompt ${m.systemPromptVersion}; judge prompt ${m.judgePromptVersion}; prices are Anthropic list prices as of ${m.priceDateStamp}`,
    `- full transcripts persisted alongside this report for audit`,
    "",
    "## Limitations (hand-finish before publishing)",
    "",
    "- Judge circularity: grading Claude with Claude (different tier; spot-check protocol in spec §10 required before publishing).",
    "- Live-data drift: tasks against live services must be re-verified before any published run.",
    "- Small-n caution: with few tasks/trials the CIs are wide; treat smoke-suite numbers as plumbing checks, not results.",
    "",
  );

  const failures = report.records.filter((r) => !r.pass);
  if (failures.length > 0) {
    lines.push(
      "## Failed trials",
      "",
      "| condition | task | trial | reason |",
      "|---|---|---|---|",
      ...failures.map(
        (r) => `| ${r.condition} | ${r.taskId} | ${r.trial} | ${r.gradeReason.slice(0, 120)} |`,
      ),
      "",
    );
  }
  return lines.join("\n");
}
