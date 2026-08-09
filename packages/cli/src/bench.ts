import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createAnthropicLlm, runBench } from "@toolc/harness";
import { BenchConditionSchema, type ToolcConfig, ToolcError } from "@toolc/shared";

const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), "../bin/toolc.mjs");

export async function benchCommand(
  config: ToolcConfig,
  configPath: string,
  opts: { tasks?: string; conditions?: string; trials?: string },
): Promise<void> {
  if (opts.tasks) config.bench.tasksDir = opts.tasks;
  if (opts.trials) config.bench.trials = Number.parseInt(opts.trials, 10);
  if (opts.conditions) {
    config.bench.conditions = opts.conditions
      .split(",")
      .map((c) => BenchConditionSchema.parse(c.trim()));
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ToolcError(
      "ANTHROPIC_API_KEY is not set",
      "the benchmark drives a real agent loop; export the key (or source .env) first",
    );
  }
  if (config.bench.conditions.includes("compiled") && !existsSync(config.serve.compiledPath)) {
    throw new ToolcError(
      `compiled artifact not found at ${config.serve.compiledPath}`,
      "run `toolc compile` before benchmarking the compiled condition",
    );
  }

  const llm = createAnthropicLlm();
  await runBench(config, {
    llm,
    judgeLlm: llm,
    makeTransport: (mode, runId, taskId) =>
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI_BIN, "-c", configPath, "serve", "--mode", mode],
        env: {
          ...(process.env as Record<string, string>),
          TOOLC_RUN_ID: runId,
          TOOLC_TASK_ID: taskId,
        },
        stderr: "ignore",
      }),
    log: (m) => console.error(m),
  });
}
