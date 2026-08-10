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
  /** Threshold and target size, in estimated tokens (~4 chars/token). */
  maxResultTokens: number;
  model: string;
  /** System prompt; null/absent → DEFAULT_COMPACTION_PROMPT. */
  prompt?: string | null;
  llm?: LlmComplete;
}

export const COMPACTION_DEFAULT_MODEL = "claude-haiku-4-5";
export const COMPACTION_DEFAULT_MAX_TOKENS = 2_000;

export const DEFAULT_COMPACTION_PROMPT = `You compact oversized tool results for an AI agent mid-task.
The agent called a tool and the result is too large to keep in context.
Rewrite the result so the agent can still complete its task:
- Preserve every fact relevant to the tool call's arguments: identifiers, names, numbers, dates, URLs, error messages.
- Preserve overall structure (lists stay lists) but drop boilerplate, repeated fields, markup, and padding.
- Never invent or infer content that is not in the result.
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
  if (originalTokens <= opts.maxResultTokens) return { result, compacted: false };

  const nonText = blocks.filter((b) => b.type !== "text");
  const marker = (strategy: string) =>
    `[toolc auto-compaction: result compacted from ~${originalTokens} to ≤${opts.maxResultTokens} tokens (${strategy})]\n`;

  if (opts.llm) {
    try {
      const compacted = await opts.llm({
        model: opts.model,
        system: `${opts.prompt?.trim() || DEFAULT_COMPACTION_PROMPT}\n\nStay under ${opts.maxResultTokens} tokens.`,
        prompt:
          `Tool: ${call.toolName}\nArguments: ${JSON.stringify(call.args)}\n\n` +
          `Result:\n${text.slice(0, MAX_LLM_INPUT_CHARS)}` +
          (text.length > MAX_LLM_INPUT_CHARS ? "\n…[input truncated before compaction]" : ""),
        maxTokens: Math.min(opts.maxResultTokens + 500, 32_000),
      });
      if (compacted.trim().length > 0) {
        return {
          result: {
            ...result,
            content: [{ type: "text", text: marker("llm") + compacted.trim() }, ...nonText],
          },
          compacted: true,
          strategy: "llm",
          originalTokens,
        };
      }
    } catch {
      // fall through to structural compaction — never fail the tool call
    }
  }

  return {
    result: {
      ...result,
      content: [
        { type: "text", text: marker("structural") + structuralCompact(text, opts.maxResultTokens) },
        ...nonText,
      ],
    },
    compacted: true,
    strategy: "structural",
    originalTokens,
  };
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
