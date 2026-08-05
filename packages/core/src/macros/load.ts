import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyMacroDefinition } from "./types.js";

function looksLikeMacro(value: unknown): value is AnyMacroDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AnyMacroDefinition).name === "string" &&
    typeof (value as AnyMacroDefinition).steps === "function" &&
    Array.isArray((value as AnyMacroDefinition).uses)
  );
}

/**
 * Load every macro exported by modules in `dir` (non-recursive; .ts/.mts/.js/.mjs).
 * Requires a TS-capable runtime for .ts files — the CLI runs under tsx.
 * A missing directory is not an error (zero macros is a valid project).
 */
export async function loadMacros(
  dir: string,
  onWarn: (message: string) => void = () => {},
): Promise<AnyMacroDefinition[]> {
  if (!existsSync(dir)) return [];
  const macros: AnyMacroDefinition[] = [];
  const seen = new Set<string>();
  const files = readdirSync(dir)
    .filter((f) => /\.(ts|mts|js|mjs)$/.test(f) && !f.endsWith(".d.ts"))
    .sort();
  for (const file of files) {
    let module_: Record<string, unknown>;
    try {
      module_ = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, unknown>;
    } catch (err) {
      onWarn(`macros: failed to load ${file}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    for (const value of Object.values(module_)) {
      if (!looksLikeMacro(value)) continue;
      if (seen.has(value.name)) {
        onWarn(`macros: duplicate macro name ${value.name} (${file}) ignored`);
        continue;
      }
      seen.add(value.name);
      macros.push(value);
    }
  }
  return macros;
}
