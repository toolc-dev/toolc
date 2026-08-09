import { defineMacro } from "@toolc/core";
import { z } from "zod";

/**
 * Provenance: the search → resolve-id → read-file chain is the dominant
 * multi-hop pattern on the Hugging Face MCP server — an agent asking "what is
 * model X / how do I use it" must search, pick the right repo id, then cat its
 * README over the hf:// filesystem grammar (a URI scheme agents routinely
 * fumble). Verified against the live server 2026-08-04.
 */
export const findModelReadme = defineMacro({
  name: "find_model_readme",
  description:
    "Given a model search query, find the best-matching Hugging Face model and return its README (model card) in one call. " +
    "Replaces the hub_repo_search → hf_fs chain.",
  inputSchema: z.object({
    query: z.string().describe("Model search terms, e.g. 'tiny random llama'"),
    sort: z
      .enum(["trendingScore", "downloads", "likes", "createdAt", "lastModified"])
      .default("downloads")
      .describe("Ranking for the best match."),
  }),
  uses: ["hf:hub_repo_search", "hf:hf_fs"],
  steps: async (input, call) => {
    const search = await call("hf:hub_repo_search", {
      query: input.query,
      repo_types: ["model"],
      sort: input.sort,
      limit: 3,
    });
    if (search.isError) return search;

    // Results are markdown with one "### author/name" heading per repo.
    const repoId = /^###\s+(\S+\/\S+)\s*$/m.exec(search.text)?.[1];
    if (!repoId) {
      return { text: `no models matched "${input.query}"`, isError: true };
    }
    const readme = await call("hf:hf_fs", {
      cmd: "cat",
      args: [`hf://models/${repoId}/README.md`],
    });
    if (readme.isError) {
      return { text: `found ${repoId} but it has no readable README.md`, isError: true };
    }
    return { text: `Best match: ${repoId}\n\n${readme.text}`, isError: false };
  },
});
