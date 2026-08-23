import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { conditionMode, createAnthropicLlm, runBench } from "@toolc/harness";
import { BenchConditionSchema, type ToolcConfig, ToolcError } from "@toolc/shared";
import { prepareConditionArtifacts } from "./ablation.js";

const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), "../bin/toolc.mjs");

export async function benchCommand(
  config: ToolcConfig,
  configPath: string,
  opts: { tasks?: string; conditions?: string; trials?: string; model?: string; outDir?: string },
): Promise<void> {
  if (opts.tasks) config.bench.tasksDir = opts.tasks;
  if (opts.trials) config.bench.trials = Number.parseInt(opts.trials, 10);
  if (opts.model) config.bench.model = opts.model;
  if (opts.outDir) config.bench.outDir = opts.outDir;
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

  // Fresh artifacts for every compiled-flavor condition, from one catalog
  // snapshot — the run never serves a stale compiled.json.
  const artifacts = await prepareConditionArtifacts(config, (m) => console.error(m));

  const llm = createAnthropicLlm();
  await runBench(config, {
    llm,
    judgeLlm: llm,
    makeTransport: (condition, runId, taskId) => {
      const mode = conditionMode(condition);
      const artifact = artifacts.get(condition);
      return new StdioClientTransport({
        command: process.execPath,
        args: [
          CLI_BIN,
          "-c",
          configPath,
          "serve",
          "--mode",
          mode,
          ...(artifact ? ["--compiled-path", artifact] : []),
        ],
        env: {
          ...(process.env as Record<string, string>),
          TOOLC_RUN_ID: runId,
          TOOLC_TASK_ID: taskId,
        },
        stderr: "ignore",
      });
    },
    log: (m) => console.error(m),
  });
}
