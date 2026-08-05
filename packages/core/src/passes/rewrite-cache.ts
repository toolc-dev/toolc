import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { stableStringify } from "../ir/serialize.js";
import type { RewriteCache, RewriteEntry } from "./types.js";

const RewriteFileSchema = z.object({
  _comment: z.string().optional(),
  entries: z.record(
    z.string(),
    z.object({
      toolId: z.string(),
      originalDescriptionHash: z.string(),
      promptVersion: z.string(),
      description: z.string(),
      approved: z.boolean(),
    }),
  ),
});

export function createMemoryRewriteCache(initial: Record<string, RewriteEntry> = {}): RewriteCache {
  const entries = new Map(Object.entries(initial));
  return {
    get: (key) => entries.get(key),
    set: (key, entry) => void entries.set(key, entry),
    flush: () => {},
  };
}

/**
 * File-backed cache (.toolc/rewrites.json) — the human review surface for
 * reviewMode. Diff-friendly: stable key order, one entry per tool.
 */
export function createFileRewriteCache(path: string): RewriteCache {
  let entries: Record<string, RewriteEntry> = {};
  try {
    entries = RewriteFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).entries;
  } catch {
    // Missing or malformed file starts empty; flush() recreates it.
  }
  return {
    get: (key) => entries[key],
    set: (key, entry) => {
      entries[key] = entry;
    },
    flush: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        stableStringify(
          {
            _comment:
              "Proposed tool-description rewrites. In reviewMode, set approved:true to apply an entry on the next compile.",
            entries,
          },
          2,
        ),
      );
    },
  };
}
