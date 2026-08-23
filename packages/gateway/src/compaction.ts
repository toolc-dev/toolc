import type { CallToolResult } from "@modelcontextprotocol/server";
import type { LlmComplete } from "@toolc/core";

/**
 * Serve-time auto-compaction (opt-in): oversized tool results are compacted
 * before they reach the agent's context — the runtime counterpart of the
 * compile-time passes. LLM summarization by default (prompt and model are
 * user-configurable), with a deterministic structural fallback when no LLM is
 * available or the call fails. Meta-tool results (search_tools/call_tool
 * protocol surface) are never compacted — see Router.
 */

export interface CompactionOptions {
  /**
   * Results above this size skip the synchronous LLM wait: a structural cut
   * is served immediately while the LLM compaction warms a cache keyed by
   * result content, so repeats get the good version instantly. 0 disables.
   */
  asyncAboveTokens?: number;
  /**
   * Results above this size (estimated tokens, ~4 chars/token) get compacted.
   * There is no enforced output budget: the model compacts as far as it can
   * without dropping task-relevant content.
   */
  triggerTokens: number;
  model: string;
  /** System prompt; null/absent → DEFAULT_COMPACTION_PROMPT. */
  prompt?: string | null;
  llm?: LlmComplete;
}

export const COMPACTION_DEFAULT_MODEL = "claude-haiku-4-5";
export const COMPACTION_DEFAULT_TRIGGER_TOKENS = 10_000;

export const DEFAULT_COMPACTION_PROMPT = `You compact oversized tool results for an AI agent mid-task.
The agent called a tool and the result is too large to keep in context.
Rewrite the result so the agent can still complete its task:
- Preserve every fact relevant to the tool call's arguments: identifiers, names, numbers, dates, URLs, error messages.
- Preserve everything needed to source and cite the response: record and entity IDs, permalinks, document and section references, titles, authors, and timestamps. The agent must be able to attribute every claim and fetch the full record with a follow-up call.
- Preserve overall structure (lists stay lists) but drop boilerplate, repeated fields, markup, and padding.
- Never invent or infer content that is not in the result.
There is no fixed length target: compact as far as you can without losing anything the agent may need, and no further.
Return only the compacted result, no preamble.`;

/** Rough token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Max characters of a result we will feed to the compaction model. */
const MAX_LLM_INPUT_CHARS = 300_000;

export interface CompactionOutcome {
  result: CallToolResult;
  compacted: boolean;
  strategy?: "llm" | "structural";
  originalTokens?: number;
}

/**
 * Compact a tool result if its text content exceeds the configured budget.
 * Error results pass through untouched — the agent needs the real error.
 */
export async function compactResult(
  result: CallToolResult,
  call: { toolName: string; args: Record<string, unknown> },
  opts: CompactionOptions,
): Promise<CompactionOutcome> {
  if (result.isError === true) return { result, compacted: false };
  const blocks = result.content ?? [];
  const text = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const originalTokens = estimateTokens(text);
  if (originalTokens <= opts.triggerTokens) return { result, compacted: false };

  const nonText = blocks.filter((b) => b.type !== "text");
  const asyncAbove = opts.asyncAboveTokens ?? 0;
  if (opts.llm && asyncAbove > 0 && originalTokens > asyncAbove) {
    const key = `${call.toolName}:${hashText(text)}`;
    const cached = asyncCache.get(key);
    if (cached) {
      return {
        result: { ...result, content: [{ type: "text", text: cached }, ...nonText] },
        compacted: true,
        strategy: "llm",
        originalTokens,
      };
    }
    if (!asyncPending.has(key)) {
      asyncPending.add(key);
      void runLlmCompaction(text, call, opts)
        .then((compacted) => {
          if (compacted) putAsyncCache(key, compacted);
        })
        .finally(() => asyncPending.delete(key));
    }
    const structuralNow = structuralCompact(text, opts.triggerTokens);
    return {
      result: {
        ...result,
        content: [
          {
            type: "text",
            text:
              `[toolc auto-compaction: served a structural cut immediately (~${estimateTokens(structuralNow)} tokens); an LLM-compacted version is being prepared for repeat calls]\n` +
              structuralNow,
          },
          ...nonText,
        ],
      },
      compacted: true,
      strategy: "structural",
      originalTokens,
    };
  }

  const marker = (strategy: string, toTokens: number) =>
    `[toolc auto-compaction: result compacted from ~${originalTokens} to ~${toTokens} tokens (${strategy})]\n`;

  if (opts.llm) {
    try {
      const compacted = await runLlmCompaction(text, call, opts);
      if (compacted) {
        const compactedTokens = estimateTokens(compacted);
        if (compactedTokens < originalTokens) {
          return {
            result: {
              ...result,
              content: [
                { type: "text", text: marker("llm", compactedTokens) + compacted },
                ...nonText,
              ],
            },
            compacted: true,
            strategy: "llm",
            originalTokens,
          };
        }
      }
    } catch {
      // fall through to structural compaction — never fail the tool call
    }
  }

  const structural = structuralCompact(text, opts.triggerTokens);
  return {
    result: {
      ...result,
      content: [
        { type: "text", text: marker("structural", estimateTokens(structural)) + structural },
        ...nonText,
      ],
    },
    compacted: true,
    strategy: "structural",
    originalTokens,
  };
}

const ASYNC_CACHE_MAX = 200;
const asyncCache = new Map<string, string>();
const asyncPending = new Set<string>();

function putAsyncCache(key: string, value: string): void {
  if (asyncCache.size >= ASYNC_CACHE_MAX) {
    const oldest = asyncCache.keys().next().value;
    if (oldest !== undefined) asyncCache.delete(oldest);
  }
  asyncCache.set(key, value);
}

function hashText(text: string): string {
  // djb2: cheap content key; collisions only risk a mismatched cache entry
  // for same-tool results, acceptable for a bounded advisory cache.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

/** The raw LLM compaction call; returns trimmed text or null. */
async function runLlmCompaction(
  text: string,
  call: { toolName: string; args: Record<string, unknown> },
  opts: CompactionOptions,
): Promise<string | null> {
  if (!opts.llm) return null;
  const compacted = await opts.llm({
        model: opts.model,
        system: opts.prompt?.trim() || DEFAULT_COMPACTION_PROMPT,
        prompt:
          `Tool: ${call.toolName}\nArguments: ${JSON.stringify(call.args)}\n\n` +
          `Result:\n${text.slice(0, MAX_LLM_INPUT_CHARS)}` +
          (text.length > MAX_LLM_INPUT_CHARS ? "\n…[input truncated before compaction]" : ""),
    maxTokens: Math.min(Math.max(Math.ceil(estimateTokens(text) * 0.8), 4_000), 32_000),
  });
  const trimmed = compacted.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ARRAY_KEEP = 20;
const STRING_CAP = 500;

/**
 * Deterministic fallback: JSON-aware pruning (bounded arrays, capped strings)
 * and, if still over budget or not JSON, head+tail truncation with a marker.
 */
export function structuralCompact(text: string, maxTokens: number): string {
  let out = text;
  try {
    out = JSON.stringify(prune(JSON.parse(text)), null, 1);
  } catch {
    // not JSON — plain truncation below
  }
  const budgetChars = maxTokens * 4;
  if (out.length <= budgetChars) return out;
  const head = Math.floor(budgetChars * 0.8);
  const tail = Math.floor(budgetChars * 0.1);
  return `${out.slice(0, head)}\n…[${out.length - head - tail} characters omitted]…\n${out.slice(-tail)}`;
}

function prune(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > STRING_CAP ? `${value.slice(0, STRING_CAP)}…[truncated]` : value;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, ARRAY_KEEP).map(prune);
    if (value.length > ARRAY_KEEP) kept.push(`…[${value.length - ARRAY_KEEP} more items omitted]`);
    return kept;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, prune(v)]));
  }
  return value;
}
