import { buildGraph, effectiveDescription, isVisible } from "@toolc/core";
import { serveStdio } from "@toolc/gateway";
import { loadConfig, ToolcError } from "@toolc/shared";
import { Command } from "commander";

const program = new Command("toolc")
  .description("toolc — an optimizing compiler for agent tool surfaces")
  .option("-c, --config <path>", "path to toolc config", "toolc.config.jsonc");

program
  .command("serve")
  .description("run the gateway MCP server")
  .option("--mode <mode>", "mirror | compiled (overrides config)")
  .option("--compiled-path <path>", "compiled artifact to serve (overrides config)")
  .action(async (opts: { mode?: string; compiledPath?: string }) => {
    const config = loadConfig(program.opts().config);
    if (opts.mode) {
      if (opts.mode !== "mirror" && opts.mode !== "compiled") {
        fail(`invalid --mode ${opts.mode}: expected mirror or compiled`);
      }
      config.serve.mode = opts.mode as "mirror" | "compiled";
    }
    if (opts.compiledPath) config.serve.compiledPath = opts.compiledPath;
    await serveStdio(config);
    // Keep the process alive; the transport owns stdin.
  });

program
  .command("inspect")
  .description("introspect downstreams and print the current tool surface")
  .option("--tool <id>", "show full detail for one tool id")
  .option("--skip-unavailable", "skip downstreams that fail to connect")
  .action(async (opts: { tool?: string; skipUnavailable?: boolean }) => {
    const config = loadConfig(program.opts().config);
    const graph = await buildGraph(config.downstream, {
      skipUnavailable: opts.skipUnavailable ?? false,
      onWarn: (m) => console.error(`warn: ${m}`),
    });

    if (opts.tool) {
      const tool = graph.tools.find((t) => t.id === opts.tool);
      if (!tool) fail(`no such tool: ${opts.tool}`);
      console.log(JSON.stringify(tool, null, 2));
      return;
    }

    console.log(
      `graph ${graph.version} — ${graph.tools.length} tools from ${graph.sources.length} source(s)\n`,
    );
    const idWidth = Math.max(...graph.tools.map((t) => t.id.length), 4);
    for (const t of graph.tools) {
      const vis = isVisible(t) ? " " : "H";
      const desc = effectiveDescription(t).replaceAll("\n", " ").slice(0, 80);
      console.log(`${vis} ${t.id.padEnd(idWidth)}  ${t.kind.padEnd(11)}  ${desc}`);
    }
  });

program
  .command("compile")
  .description("run the pass pipeline and emit the compiled artifact + report")
  .option("--skip-unavailable", "skip downstreams that fail to connect")
  .option("--report <path>", "compile report output path", ".toolc/compile-report.md")
  .action(async (opts: { skipUnavailable?: boolean; report: string }) => {
    const { compileCommand } = await import("./compile.js");
    await compileCommand(loadConfig(program.opts().config), {
      skipUnavailable: opts.skipUnavailable ?? false,
      reportPath: opts.report,
    });
  });

program
  .command("bench")
  .description("run the benchmark grid and emit a report")
  .option("--tasks <dir>", "task suite directory (overrides config)")
  .option("--conditions <list>", "comma-separated: raw,compiled (overrides config)")
  .option("--trials <n>", "trials per (task, condition) (overrides config)")
  .action(async (opts: { tasks?: string; conditions?: string; trials?: string }) => {
    const { benchCommand } = await import("./bench.js");
    await benchCommand(loadConfig(program.opts().config), program.opts().config, opts);
  });

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof ToolcError) fail(err.message);
  throw err;
}
