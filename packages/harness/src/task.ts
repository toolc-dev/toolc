import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ToolcError } from "@toolc/shared";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Benchmark task definition (spec §9). One YAML file per task in tasksDir. */

export const TaskCategorySchema = z.enum([
  "single-tool",
  "overlap-selection",
  "ambiguous-selection",
  "cross-server-chain",
  "needle",
  "no-tool-exists",
]);

export const GradingSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("exact"),
    /** Normalized (trimmed, case-insensitive) equality. */
    expected: z.string(),
  }),
  z.object({
    type: z.literal("contains"),
    /** All strings must appear (case-insensitive) in the final answer. */
    expected: z.union([z.string(), z.array(z.string())]),
  }),
  z.object({
    type: z.literal("judge"),
    rubric: z.string(),
    /** Optional gold answer given to the judge as context. */
    reference: z.string().nullable().default(null),
  }),
]);

export const TaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: TaskCategorySchema,
  prompt: z.string().min(1),
  grading: GradingSchema,
  /** Informational, not enforced (spec §9). */
  expected_tools: z.array(z.string()).default([]),
  timeout_turns: z.number().int().min(1).default(25),
});

export type Task = z.infer<typeof TaskSchema>;
export type TaskCategory = z.infer<typeof TaskCategorySchema>;

export function loadTasks(dir: string): Task[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort();
  } catch {
    throw new ToolcError(`tasks directory not found: ${dir}`);
  }
  if (files.length === 0) throw new ToolcError(`no task YAML files in ${dir}`);

  const tasks = files.map((file) => {
    try {
      return TaskSchema.parse(parseYaml(readFileSync(join(dir, file), "utf8")));
    } catch (err) {
      throw new ToolcError(
        `invalid task file ${file}: ${err instanceof Error ? err.message : err}`,
      );
    }
  });
  const ids = tasks.map((t) => t.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0)
    throw new ToolcError(`duplicate task ids: ${[...new Set(dupes)].join(", ")}`);
  return tasks;
}
