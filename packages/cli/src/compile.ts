import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildGraph,
  type CapabilityGraph,
  type CompiledArtifact,
  createFileRewriteCache,
  deserializeArtifact,
  type LlmComplete,
  loadMacros,
  type PassDiff,
  runPasses,
  serializeArtifact,
  servedTools,
  surfaceStats,
} from "@toolc/core";
import type { ToolcConfig } from "@toolc/shared";

export interface CompileOptions {
  skipUnavailable: boolean;
  reportPath: string;
}

/** `toolc compile`: introspect → passes → artifact + human-readable report. */
export async function compileCommand(config: ToolcConfig, opts: CompileOptions): Promise<void> {
  const warn = (m: string) => console.error(`warn: ${m}`);

  const macros = await loadMacros(config.compile.macrosDir, warn);
  console.error(`loaded ${macros.length} macro(s) from ${config.compile.macrosDir}`);

  const graph = await buildGraph(config.downstream, {
    skipUnavailable: opts.skipUnavailable,
    onWarn: warn,
  });
  console.error(
    `introspected ${graph.tools.length} tools from ${graph.sources.length} downstream(s)`,
  );
  warnOnCatalogDrift(config.serve.compiledPath, graph, warn);

  const { graph: compiled, diffs } = await runPasses(graph, config, {
    macros,
    rewriteCache: createFileRewriteCache(config.compile.rewrite.cachePath),
    llm: makeAnthropicLlm(warn),
    warn,
  });

  const artifact: CompiledArtifact = {
    artifactVersion: 1,
    project: config.project,
    compiledAt: new Date().toISOString(),
    macroNames: compiled.tools.filter((t) => t.kind === "macro").map((t) => t.name),
    graph: compiled,
  };
  mkdirSync(dirname(config.serve.compiledPath), { recursive: true });
  writeFileSync(config.serve.compiledPath, serializeArtifact(artifact));

  const report = renderReport(config, compiled, diffs);
  writeFileSync(opts.reportPath, report);

  const stats = surfaceStats(compiled);
  console.error(
    `\ncompiled ${config.serve.compiledPath} (graph ${compiled.version})\n` +
      `  surface: ${stats.servedCount} definitions served, ${stats.searchableCount} searchable, ${stats.hiddenCount} hidden\n` +
      `  est. context: ~${stats.servedTokens} tokens vs ~${stats.mirrorTokens} raw (${percentSaved(stats.servedTokens, stats.mirrorTokens)} saved)\n` +
      `  report: ${opts.reportPath}`,
  );
}

/** LLM seam for the rewrite pass; undefined when no API key is configured. */
function makeAnthropicLlm(warn: (m: string) => void): LlmComplete | undefined {
  if (!process.env.ANTHROPIC_API_KEY) {
    warn("ANTHROPIC_API_KEY not set — rewrite pass will serve original descriptions");
    return undefined;
  }
  const client = new Anthropic();
  return async ({ model, system, prompt, maxTokens }) => {
    const response = await client.messages.create({
      model,
      system,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  };
}

function warnOnCatalogDrift(
  artifactPath: string,
  fresh: CapabilityGraph,
  warn: (m: string) => void,
): void {
  if (!existsSync(artifactPath)) return;
  try {
    const previous = deserializeArtifact(readFileSync(artifactPath, "utf8"));
    for (const source of fresh.sources) {
      const before = previous.graph.sources.find((s) => s.id === source.id);
      if (before && before.catalogHash !== source.catalogHash) {
        warn(
          `downstream catalog drift: ${source.id} changed since last compile (${before.toolCount} → ${source.toolCount} tools)`,
        );
      }
    }
  } catch {
    // Unreadable previous artifact: nothing to diff against.
  }
}

function renderReport(config: ToolcConfig, graph: CapabilityGraph, diffs: PassDiff[]): string {
  const stats = surfaceStats(graph);
  const lines: string[] = [
    `# toolc compile report — ${config.project}`,
    "",
    `- compiled: ${new Date().toISOString()}`,
    `- graph version: \`${graph.version}\``,
    `- sources: ${graph.sources.map((s) => `${s.id} (${s.toolCount} tools)`).join(", ")}`,
    "",
    "## Surface",
    "",
    `| | count |`,
    `|---|---|`,
    `| definitions served | ${stats.servedCount} |`,
    `| searchable via search_tools | ${stats.searchableCount} |`,
    `| hidden | ${stats.hiddenCount} |`,
    `| est. served context tokens* | ~${stats.servedTokens} |`,
    `| est. raw catalog tokens* | ~${stats.mirrorTokens} |`,
    "",
    `*chars/4 heuristic over serialized definitions.`,
    "",
    "## Served definitions",
    "",
    "| tool | kind | description |",
    "|---|---|---|",
    ...servedTools(graph).map(
      (t) =>
        `| ${t.id} | ${t.kind} | ${(t.overlays.description ?? t.description).split("\n")[0]!.slice(0, 100)} |`,
    ),
    "",
    "## Passes",
  ];
  for (const diff of diffs) {
    lines.push("", `### ${diff.pass}`, "");
    for (const note of diff.notes) lines.push(`- ${note}`);
    if (diff.hidden.length > 0) lines.push(`- hidden: ${diff.hidden.join(", ")}`);
    if (diff.added.length > 0) lines.push(`- added: ${diff.added.join(", ")}`);
    if (diff.rewritten.length > 0) lines.push(`- rewritten: ${diff.rewritten.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function percentSaved(served: number, mirror: number): string {
  if (mirror === 0) return "0%";
  return `${Math.round((1 - served / mirror) * 100)}%`;
}
