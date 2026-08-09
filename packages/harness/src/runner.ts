import type { Client } from "@modelcontextprotocol/client";
import type {
  AgentLlm,
  LlmMessage,
  LlmToolDef,
  LlmToolResultBlock,
  LlmToolUseBlock,
} from "./llm.js";
import type { Task } from "./task.js";

/**
 * Agent loop for one (task, condition, trial): a standard Anthropic tool-use
 * loop against a gateway the harness talks to ONLY over MCP (spec §5 —
 * measure the real thing, never an in-process shortcut).
 */

/** Held constant and minimal across all conditions (spec §10). */
export const SYSTEM_PROMPT_VERSION = "v1";
export const SYSTEM_PROMPT =
  "You are a capable assistant with access to tools. Use them as needed to answer the user's question accurately. " +
  "When you have the answer, state it directly. If no available tool can answer the question and you cannot answer it reliably from the conversation alone, say so plainly instead of guessing.";

/** Tool results are truncated identically in every condition (fairness). */
const TOOL_RESULT_MAX_CHARS = 50_000;

export interface ToolCallRecord {
  name: string;
  isError: boolean;
}

export interface TrialResult {
  taskId: string;
  condition: string;
  trial: number;
  finalAnswer: string | null;
  turns: number;
  timedOut: boolean;
  fatalError: string | null;
  toolCalls: ToolCallRecord[];
  usage: { inputTokens: number; outputTokens: number };
  /** Estimated tokens of the tools array presented to the model (chars/4). */
  toolsArrayTokensEst: number;
  toolCount: number;
  wallMs: number;
  transcript: LlmMessage[];
}

export interface RunTrialOptions {
  task: Task;
  condition: string;
  trial: number;
  model: string;
  maxTurns: number;
  llm: AgentLlm;
  /** Connected MCP client for the gateway serving this condition. */
  client: Client;
}

export async function runTrial(opts: RunTrialOptions): Promise<TrialResult> {
  const { task, condition, trial, model, llm, client } = opts;
  const started = performance.now();

  const { tools: mcpTools } = await client.listTools();
  const tools: LlmToolDef[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
  }));
  const toolsArrayTokensEst = Math.ceil(JSON.stringify(tools).length / 4);

  const messages: LlmMessage[] = [{ role: "user", content: task.prompt }];
  const toolCalls: ToolCallRecord[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const maxTurns = Math.min(task.timeout_turns, opts.maxTurns);

  let finalAnswer: string | null = null;
  let timedOut = false;
  let fatalError: string | null = null;
  let turns = 0;

  try {
    for (turns = 1; turns <= maxTurns; turns++) {
      const response = await llm.chat({
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools,
        maxTokens: 4096,
      });
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((b): b is LlmToolUseBlock => b.type === "tool_use");
      if (response.stopReason !== "tool_use" || toolUses.length === 0) {
        finalAnswer = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        break;
      }

      const results: LlmToolResultBlock[] = [];
      for (const use of toolUses) {
        results.push(await executeToolCall(client, use, toolCalls));
      }
      messages.push({ role: "user", content: results });
    }
    if (finalAnswer === null) timedOut = true;
  } catch (err) {
    fatalError = err instanceof Error ? err.message : String(err);
  }

  return {
    taskId: task.id,
    condition,
    trial,
    finalAnswer,
    turns: Math.min(turns, maxTurns),
    timedOut,
    fatalError,
    toolCalls,
    usage,
    toolsArrayTokensEst,
    toolCount: tools.length,
    wallMs: Math.round(performance.now() - started),
    transcript: messages,
  };
}

async function executeToolCall(
  client: Client,
  use: LlmToolUseBlock,
  toolCalls: ToolCallRecord[],
): Promise<LlmToolResultBlock> {
  let text: string;
  let isError: boolean;
  try {
    const result = await client.callTool({ name: use.name, arguments: use.input });
    isError = result.isError === true;
    text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  } catch (err) {
    // Protocol-level failure (unknown tool, transport error): surface to the
    // model as an error result rather than killing the trial.
    isError = true;
    text = err instanceof Error ? err.message : String(err);
  }
  toolCalls.push({ name: use.name, isError });
  if (text.length > TOOL_RESULT_MAX_CHARS) {
    text = `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…[truncated by harness]`;
  }
  return {
    type: "tool_result",
    tool_use_id: use.id,
    content: text,
    ...(isError ? { is_error: true } : {}),
  };
}
