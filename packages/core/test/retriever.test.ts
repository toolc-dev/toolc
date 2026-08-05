import { describe, expect, it } from "vitest";
import { buildBm25Retriever, isVisible } from "../src/index.js";
import { fixtureFederationGraph } from "./fixtures/index.js";

/**
 * M2 exit test: hand-written probe queries must retrieve the right tool.
 * Probes are phrased as task language, not tool names — that is how an agent
 * will query search_tools.
 */
const PROBES: Array<{ query: string; expect: string; within?: number }> = [
  { query: "find upcoming events for a company", expect: "finco:find_events" },
  {
    query: "what did management say on the earnings call",
    expect: "finco:search_transcripts",
    within: 3,
  },
  { query: "full transcript for one event", expect: "finco:get_transcript", within: 2 },
  { query: "look up companies by name", expect: "finco:find_companies" },
  {
    query: "search code repositories by keyword",
    expect: "repohub:search_repositories",
    within: 2,
  },
  {
    query: "all repositories owned by an organization",
    expect: "repohub:list_repositories",
    within: 2,
  },
  { query: "read a file from a repository", expect: "repohub:get_file_contents" },
  { query: "open issues in a repo filtered by state", expect: "repohub:list_issues", within: 2 },
  { query: "search issues across many repositories", expect: "repohub:search_issues", within: 2 },
  {
    query: "transcripts mentioning foundry commitments",
    expect: "finco:search_transcripts",
    within: 2,
  },
];

describe("BM25 retriever (search_tools engine)", () => {
  const graph = fixtureFederationGraph();
  const retriever = buildBm25Retriever(graph.tools.filter((t) => isVisible(t)));

  it.each(PROBES)("retrieves $expect for: $query", ({ query, expect: expected, within = 1 }) => {
    const results = retriever.search(query, 5);
    const ids = results.map((r) => r.tool.id);
    expect(ids.slice(0, within)).toContain(expected);
  });

  it("returns at most topK results with scores descending", () => {
    const results = retriever.search("search", 3);
    expect(results.length).toBeLessThanOrEqual(3);
    const scores = results.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});
