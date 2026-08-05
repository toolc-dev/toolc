import { isVisible, TOOLC_SOURCE, type ToolNode } from "../ir/types.js";
import { matchesAny } from "./glob.js";
import type { Pass, PassDiff } from "./types.js";

/**
 * Meta-tool definitions. The selection pass adds these as ToolNodes; the
 * gateway router implements their behavior (BM25 search + validated dispatch).
 */
export const SEARCH_TOOLS_NAME = "search_tools";
export const CALL_TOOL_NAME = "call_tool";

export function searchToolsNode(topK: number, searchableCount: number): ToolNode {
  return {
    id: `${TOOLC_SOURCE}:${SEARCH_TOOLS_NAME}`,
    source: TOOLC_SOURCE,
    name: SEARCH_TOOLS_NAME,
    description:
      `Search the ${searchableCount} available tools by capability and return full definitions (name, description, input schema) for the best matches. ` +
      `Call this FIRST whenever no visible tool fits the task, then invoke a result via ${CALL_TOOL_NAME}. ` +
      `Query with task language (e.g. "search code in a repository", "latest earnings call transcript").`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to accomplish, in plain words." },
        top_k: {
          type: "number",
          description: `Max results (default ${topK}).`,
        },
      },
      required: ["query"],
    },
    overlays: { surfaced: true },
    kind: "meta",
  };
}

export function callToolNode(): ToolNode {
  return {
    id: `${TOOLC_SOURCE}:${CALL_TOOL_NAME}`,
    source: TOOLC_SOURCE,
    name: CALL_TOOL_NAME,
    description:
      `Invoke any tool returned by ${SEARCH_TOOLS_NAME} by its full id (e.g. "github:search_code"). ` +
      "Arguments are validated against the tool's input schema; validation errors echo the expected schema with a corrected example.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: `Tool id exactly as returned by ${SEARCH_TOOLS_NAME}.`,
        },
        arguments: {
          type: "object",
          description: "Arguments matching the tool's input schema.",
        },
      },
      required: ["name", "arguments"],
    },
    overlays: { surfaced: true },
    kind: "meta",
  };
}

/**
 * Surface pruning: the served surface becomes pinned meta-tools + macros +
 * alwaysVisible matches. Every other visible tool stays reachable only
 * through search_tools/call_tool (overlays.surfaced = false). Hidden tools
 * are excluded from search entirely.
 */
export const selectionPass: Pass = async (graph, config, _ctx) => {
  const { pinned, alwaysVisible, topK } = config.compile.selection;
  const diff: PassDiff = {
    pass: "selection",
    hidden: [],
    unhidden: [],
    rewritten: [],
    added: [],
    notes: [],
  };

  const searchableCount = graph.tools.filter(
    (t) => t.kind === "passthrough" && isVisible(t),
  ).length;

  const tools: ToolNode[] = graph.tools.map((tool): ToolNode => {
    if (!isVisible(tool)) return tool;
    const surfaced =
      tool.kind === "macro" ||
      (tool.kind === "meta" && pinned.includes(tool.name)) ||
      matchesAny(alwaysVisible, tool.id);
    return { ...tool, overlays: { ...tool.overlays, surfaced } };
  });

  for (const name of pinned) {
    if (name === SEARCH_TOOLS_NAME) {
      tools.push(searchToolsNode(topK, searchableCount));
      diff.added.push(`${TOOLC_SOURCE}:${SEARCH_TOOLS_NAME}`);
    } else if (name === CALL_TOOL_NAME) {
      tools.push(callToolNode());
      diff.added.push(`${TOOLC_SOURCE}:${CALL_TOOL_NAME}`);
    }
  }

  const surfacedCount = tools.filter((t) => isVisible(t) && t.overlays.surfaced).length;
  diff.notes.push(
    `${surfacedCount} definition(s) surfaced; ${searchableCount} tool(s) reachable via ${SEARCH_TOOLS_NAME}`,
  );
  return { graph: { ...graph, tools }, diff };
};
