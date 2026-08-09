import { type ToolcConfig, ToolcError } from "@toolc/shared";
import type { GradeResult } from "./grade.js";
import type { TrialResult } from "./runner.js";
import type { Task, TaskCategory } from "./task.js";

export interface TrialRecord extends TrialResult {
  category: TaskCategory;
  pass: boolean;
  gradeReason: string;
  costUsd: number;
}

export function toRecord(
  trial: TrialResult,
  task: Task,
  grade: GradeResult,
  prices: ToolcConfig["bench"]["prices"],
  model: string,
): TrialRecord {
  const price = prices.models[model];
  if (!price) {
    throw new ToolcError(
      `no price entry for model ${model}`,
      `add it to bench.prices.models in the config (per-MTok USD)`,
    );
  }
  return {
    ...trial,
    category: task.category,
    pass: grade.pass,
    gradeReason: grade.reason,
    costUsd:
      (trial.usage.inputTokens * price.inputPerMTok +
        trial.usage.outputTokens * price.outputPerMTok) /
      1_000_000,
  };
}

export interface ConditionMetrics {
  condition: string;
  n: number;
  successes: number;
  successRate: number;
  /** 95% bootstrap CI over trials. */
  successCi95: [number, number];
  totalCostUsd: number;
  costPerCompletedTaskUsd: number | null;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanToolCalls: number;
  meanTurns: number;
  meanWallMs: number;
  /** Heuristic (spec §10): errored tool calls / total tool calls. */
  wrongToolRate: number | null;
  /** Mean estimated tokens of the tools array shown to the model. */
  meanToolsArrayTokens: number;
  meanToolCount: number;
  byCategory: Record<string, { n: number; successes: number; successRate: number }>;
}

export function aggregate(condition: string, records: TrialRecord[]): ConditionMetrics {
  const n = records.length;
  const successes = records.filter((r) => r.pass).length;
  const totalCost = sum(records.map((r) => r.costUsd));
  const totalToolCalls = sum(records.map((r) => r.toolCalls.length));
  const erroredToolCalls = sum(records.map((r) => r.toolCalls.filter((c) => c.isError).length));

  const byCategory: ConditionMetrics["byCategory"] = {};
  for (const r of records) {
    const bucket = (byCategory[r.category] ??= { n: 0, successes: 0, successRate: 0 });
    bucket.n++;
    if (r.pass) bucket.successes++;
  }
  for (const bucket of Object.values(byCategory)) {
    bucket.successRate = bucket.n > 0 ? bucket.successes / bucket.n : 0;
  }

  return {
    condition,
    n,
    successes,
    successRate: n > 0 ? successes / n : 0,
    successCi95: bootstrapCi(records.map((r) => (r.pass ? 1 : 0))),
    totalCostUsd: totalCost,
    costPerCompletedTaskUsd: successes > 0 ? totalCost / successes : null,
    meanInputTokens: mean(records.map((r) => r.usage.inputTokens)),
    meanOutputTokens: mean(records.map((r) => r.usage.outputTokens)),
    meanToolCalls: mean(records.map((r) => r.toolCalls.length)),
    meanTurns: mean(records.map((r) => r.turns)),
    meanWallMs: mean(records.map((r) => r.wallMs)),
    wrongToolRate: totalToolCalls > 0 ? erroredToolCalls / totalToolCalls : null,
    meanToolsArrayTokens: mean(records.map((r) => r.toolsArrayTokensEst)),
    meanToolCount: mean(records.map((r) => r.toolCount)),
    byCategory,
  };
}

/** Percentile bootstrap over trial outcomes; seeded so reports are reproducible. */
export function bootstrapCi(outcomes: number[], iterations = 2000, seed = 42): [number, number] {
  if (outcomes.length === 0) return [0, 0];
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < outcomes.length; j++) {
      total += outcomes[Math.floor(rand() * outcomes.length)]!;
    }
    means.push(total / outcomes.length);
  }
  means.sort((a, b) => a - b);
  return [quantile(means, 0.025), quantile(means, 0.975)];
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx]!;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function mean(xs: number[]): number {
  return xs.length > 0 ? sum(xs) / xs.length : 0;
}
