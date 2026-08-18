import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildGraph,
  type CompiledArtifact,
  createFileRewriteCache,
  loadMacros,
  runPasses,
  serializeArtifact,
} from "@toolc/core";
import type { PassName, ToolcConfig } from "@toolc/shared";
import { makeAnthropicLlm } from "./compile.js";

/** Each ablation condition drops exactly one pass (spec §10). */
const ABLATION_DROP: Record<string, PassName> = {
  "compiled-no-macros": "macro-inline",
  "compiled-no-rewrite": "rewrite",
  "compiled-no-selection": "selection",
};

/** Condition → explicit pass list, for conditions that add passes. */
function conditionPasses(condition: string, base: PassName[]): PassName[] {
  const withConsolidate = (list: PassName[]): PassName[] => {
    if (list.includes("consolidate")) return list;
    // Consolidate runs after rewrite (merges see rewritten descriptions).
    const at = list.indexOf("rewrite");
    const out = [...list];
    out.splice(at === -1 ? 0 : at + 1, 0, "consolidate");
    return out;
  };
  if (condition === "compiled-consolidate") return withConsolidate(base);
  if (condition === "consolidate-no-selection")
    return withConsolidate(base.filter((p) => p !== "selection"));
  const drop = ABLATION_DROP[condition];
  return drop ? base.filter((p) => p !== drop) : base;
}

/**
 * Compile one artifact per non-raw condition from a SINGLE catalog snapshot,
 * so every condition in a run sees identical downstream catalogs. Returns
 * condition → artifact path.
 */
export async function prepareConditionArtifacts(
  config: ToolcConfig,
  warn: (m: string) => void,
): Promise<Map<string, string>> {
  const artifacts = new Map<string, string>();
  const compiledConditions = config.bench.conditions.filter((c) => c !== "raw");
  if (compiledConditions.length === 0) return artifacts;

  const macros = await loadMacros(config.compile.macrosDir, warn);
  const graph = await buildGraph(config.downstream, { onWarn: warn });
  warn(`ablation snapshot: ${graph.tools.length} tools (graph ${graph.version})`);
  const rewriteCache = createFileRewriteCache(config.compile.rewrite.cachePath);
  const llm = makeAnthropicLlm(warn);

  for (const condition of compiledConditions) {
    const passes = conditionPasses(
      condition === "compiled-cross" ? "compiled-consolidate" : condition,
      config.compile.passes,
    );
    const conditionConfig: ToolcConfig = {
      ...config,
      compile: {
        ...config.compile,
        passes,
        consolidate: {
          ...config.compile.consolidate,
          crossServer: condition === "compiled-cross" || config.compile.consolidate.crossServer,
        },
      },
    };
    const { graph: compiled } = await runPasses(graph, conditionConfig, {
      macros,
      rewriteCache,
      llm,
      warn,
    });
    const artifact: CompiledArtifact = {
      artifactVersion: 1,
      project: config.project,
      compiledAt: new Date().toISOString(),
      macroNames: compiled.tools.filter((t) => t.kind === "macro").map((t) => t.name),
      graph: compiled,
    };
    const path =
      condition === "compiled"
        ? config.serve.compiledPath
        : config.serve.compiledPath.replace(/\.json$/, `-${condition}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializeArtifact(artifact));
    artifacts.set(condition, path);
    warn(`prepared ${condition}: ${path} (passes: ${passes.join(", ")})`);
  }
  return artifacts;
}
