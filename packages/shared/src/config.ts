import { readFileSync } from "node:fs";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { z } from "zod";
import { ConfigError } from "./errors.js";

// --- Transports ---------------------------------------------------------------

export const StdioTransportSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

export const HttpTransportSchema = z.object({
  type: z.literal("http"),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const TransportSchema = z.discriminatedUnion("type", [
  StdioTransportSchema,
  HttpTransportSchema,
]);

// --- Downstream servers -------------------------------------------------------

export const DownstreamSchema = z.object({
  /** Short stable identifier; becomes the tool-id namespace ("id:tool"). */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "downstream id must be lowercase alphanumeric/hyphen"),
  transport: TransportSchema,
  enabled: z.boolean().default(true),
});

// --- Compile ------------------------------------------------------------------

export const PassNameSchema = z.enum([
  "dead-tool",
  "rewrite",
  "consolidate",
  "macro-inline",
  "selection",
]);

export const CompileSchema = z.object({
  passes: z.array(PassNameSchema).default(["dead-tool", "rewrite", "macro-inline", "selection"]),
  /** Directory of hand-authored macro modules (TS files exporting defineMacro results). */
  macrosDir: z.string().default("./macros"),
  deadTool: z
    .object({
      /** Glob-style tool-id patterns ("source:tool", "*" wildcard). */
      exclude: z.array(z.string()).default([]),
      /** When set, ONLY matching tools survive (allowlist mode). */
      include: z.array(z.string()).nullable().default(null),
    })
    .prefault({}),
  rewrite: z
    .object({
      model: z.string().default("claude-sonnet-4-6"),
      cachePath: z.string().default(".toolc/rewrites.json"),
      reviewMode: z.boolean().default(true),
    })
    .prefault({}),
  consolidate: z
    .object({
      model: z.string().default("claude-sonnet-4-6"),
      /** Groups smaller than this are rejected. */
      minGroupSize: z.number().int().min(2).default(2),
      /** Groups larger than this are rejected (over-merging hurts). */
      maxGroupSize: z.number().int().min(2).default(12),
    })
    .prefault({}),
  macroInline: z
    .object({
      /** Hide a macro's constituent tools from the default surface. */
      hideInlined: z.boolean().default(false),
    })
    .prefault({}),
  selection: z
    .object({
      pinned: z.array(z.string()).default(["search_tools", "call_tool"]),
      alwaysVisible: z.array(z.string()).default([]),
      topK: z.number().int().min(1).max(50).default(8),
    })
    .prefault({}),
});

// --- Serve / bench ------------------------------------------------------------

export const ServeSchema = z.object({
  mode: z.enum(["mirror", "compiled"]).default("compiled"),
  transport: z.enum(["stdio", "http"]).default("stdio"),
  port: z.number().int().min(1).max(65535).default(8976),
  logDb: z.string().default(".toolc/calls.db"),
  /** Compiled artifact consumed by `serve --mode compiled` (written by `toolc compile`). */
  compiledPath: z.string().default(".toolc/compiled.json"),
  /** Per-call downstream timeout in milliseconds. */
  callTimeoutMs: z.number().int().min(1000).default(60_000),
  /** Serve-time auto-compaction of oversized tool results (opt-in). */
  compaction: z
    .object({
      enabled: z.boolean().default(false),
      /** Results above this size (estimated tokens) get compacted; no fixed output budget. */
      triggerTokens: z.number().int().min(500).max(200_000).default(10_000),
      model: z.string().default("claude-haiku-4-5"),
      /** Custom system prompt; null serves the built-in default. */
      prompt: z.string().nullable().default(null),
    })
    .prefault({}),
});

export const BenchConditionSchema = z.enum([
  "raw",
  "compiled",
  "compiled-no-macros",
  "compiled-no-rewrite",
  "compiled-no-selection",
  "compiled-consolidate",
  "consolidate-no-selection",
]);

export const BenchSchema = z.object({
  model: z.string().default("claude-sonnet-4-6"),
  judgeModel: z.string().default("claude-opus-4-8"),
  maxTurns: z.number().int().min(1).default(25),
  tasksDir: z.string().default("./tasks"),
  trials: z.number().int().min(1).default(3),
  conditions: z.array(BenchConditionSchema).default(["raw", "compiled"]),
  /** Where transcripts + reports land. */
  outDir: z.string().default(".toolc/bench"),
  /**
   * Cost table: Anthropic list prices in USD per million tokens, with the
   * date they were checked. Reports cite this stamp.
   */
  prices: z
    .object({
      dateStamp: z.string().default("2026-08-04"),
      models: z
        .record(z.string(), z.object({ inputPerMTok: z.number(), outputPerMTok: z.number() }))
        .default({
          "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
          "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
          "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
          "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
          "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
        }),
    })
    .prefault({}),
});

// --- Root ---------------------------------------------------------------------

export const ToolcConfigSchema = z.object({
  project: z.string().min(1),
  downstream: z.array(DownstreamSchema).min(1),
  compile: CompileSchema.prefault({}),
  serve: ServeSchema.prefault({}),
  bench: BenchSchema.prefault({}),
});

export type ToolcConfig = z.infer<typeof ToolcConfigSchema>;
export type DownstreamConfig = z.infer<typeof DownstreamSchema>;
export type TransportConfig = z.infer<typeof TransportSchema>;
export type PassName = z.infer<typeof PassNameSchema>;

// --- Loading ------------------------------------------------------------------

const VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Recursively interpolate `${VAR}` in all string values from `env`.
 * Fails fast with the config path of the offending value.
 */
export function interpolateEnv(
  value: unknown,
  env: Record<string, string | undefined>,
  path = "$",
): unknown {
  if (typeof value === "string") {
    return value.replace(VAR_PATTERN, (_, name: string) => {
      const v = env[name];
      if (v === undefined) {
        throw new ConfigError(
          `missing environment variable ${name} referenced at ${path}`,
          `export ${name}=... or remove the reference`,
        );
      }
      return v;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => interpolateEnv(v, env, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env, `${path}.${k}`)]),
    );
  }
  return value;
}

/** Parse + validate a JSONC config string. */
export function parseConfig(
  jsonc: string,
  env: Record<string, string | undefined> = process.env,
): ToolcConfig {
  const errors: ParseError[] = [];
  const raw = parseJsonc(jsonc, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new ConfigError(
      `config is not valid JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  const interpolated = interpolateEnv(raw, env);
  const result = ToolcConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "$"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`config validation failed:\n${issues}`);
  }
  const ids = result.data.downstream.map((d) => d.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new ConfigError(`duplicate downstream ids: ${[...new Set(dupes)].join(", ")}`);
  }
  return result.data;
}

export function loadConfig(
  filePath: string,
  env: Record<string, string | undefined> = process.env,
): ToolcConfig {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new ConfigError(
      `config file not found: ${filePath}`,
      "copy toolc.config.example.jsonc to toolc.config.jsonc and edit it",
    );
  }
  return parseConfig(text, env);
}
