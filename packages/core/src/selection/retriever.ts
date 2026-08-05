import MiniSearch from "minisearch";
import { effectiveDescription, type ToolNode } from "../ir/types.js";

/**
 * Retrieval seam for search_tools. v1 ships BM25 (minisearch); an embedding
 * retriever can implement the same interface later without touching passes
 * or the gateway.
 */
export interface RetrievedTool {
  tool: ToolNode;
  score: number;
}

export interface Retriever {
  search(query: string, topK: number): RetrievedTool[];
}

/** Extract indexable parameter text (names + schema descriptions) from a tool. */
function paramText(tool: ToolNode): string {
  const props = (tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {};
  return Object.entries(props)
    .map(([name, schema]) => {
      const desc =
        schema && typeof schema === "object" && "description" in schema
          ? String((schema as { description?: unknown }).description ?? "")
          : "";
      return `${name} ${desc}`.trim();
    })
    .join(" ");
}

/**
 * BM25 index over the given tools' effective name/description/param text.
 * Callers pass the searchable set (visible tools); hidden tools must be
 * filtered out before indexing.
 */
export function buildBm25Retriever(tools: ToolNode[]): Retriever {
  const index = new MiniSearch<{ id: string; name: string; description: string; params: string }>({
    fields: ["name", "description", "params"],
    storeFields: [],
    searchOptions: {
      boost: { name: 3, description: 1.5, params: 1 },
      prefix: true,
      fuzzy: 0.1,
    },
    // Split snake_case / namespaced ids into searchable words.
    tokenize: (text) =>
      text
        .toLowerCase()
        .split(/[\s_:.,;/()[\]{}"'`-]+/)
        .filter(Boolean),
  });
  const byId = new Map(tools.map((t) => [t.id, t]));
  index.addAll(
    tools.map((t) => ({
      id: t.id,
      name: t.name,
      description: effectiveDescription(t),
      params: paramText(t),
    })),
  );
  return {
    search(query, topK) {
      return index
        .search(query)
        .slice(0, topK)
        .map((r) => ({ tool: byId.get(String(r.id))!, score: r.score }));
    },
  };
}
