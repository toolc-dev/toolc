import Anthropic from "@anthropic-ai/sdk";

/**
 * Minimal LLM seam. The harness (and CI) must run with a mocked model, so no
 * Anthropic SDK types leak past this module — the runner and grader depend
 * only on these shapes.
 */

export interface LlmToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmTextBlock {
  type: "text";
  text: string;
}

export interface LlmToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type LlmAssistantBlock = LlmTextBlock | LlmToolUseBlock;

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | Array<LlmAssistantBlock | LlmToolResultBlock>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  content: LlmAssistantBlock[];
  stopReason: string;
  usage: LlmUsage;
}

export interface AgentLlm {
  chat(request: {
    model: string;
    system: string;
    messages: LlmMessage[];
    tools: LlmToolDef[];
    maxTokens: number;
  }): Promise<LlmResponse>;
}

/** Real implementation over the Anthropic API. */
export function createAnthropicLlm(): AgentLlm {
  const client = new Anthropic();
  return {
    async chat({ model, system, messages, tools, maxTokens }) {
      const response = await client.messages.create({
        model,
        system,
        max_tokens: maxTokens,
        messages: messages as Anthropic.MessageParam[],
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
      });
      return {
        content: response.content
          .filter((b): b is Anthropic.TextBlock | Anthropic.ToolUseBlock =>
            ["text", "tool_use"].includes(b.type),
          )
          .map(
            (b): LlmAssistantBlock =>
              b.type === "text"
                ? { type: "text", text: b.text }
                : {
                    type: "tool_use",
                    id: b.id,
                    name: b.name,
                    input: (b.input ?? {}) as Record<string, unknown>,
                  },
          ),
        stopReason: response.stop_reason ?? "end_turn",
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    },
  };
}
