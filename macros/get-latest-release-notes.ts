import { defineMacro } from "@toolc/core";
import { z } from "zod";

/**
 * Provenance: "what changed in the latest release of X" is a common two-step
 * on the GitHub server — search_repositories to resolve the canonical repo,
 * then get_latest_release. Agents frequently skip the resolution step and
 * guess owner/repo. Verified live 2026-08-09.
 */
export const getLatestReleaseNotes = defineMacro({
  name: "get_latest_release_notes",
  description:
    "Given a repository search query (name or owner/name), find the best-matching GitHub repository and return its latest release (tag, name, notes) in one call. " +
    "Replaces the search_repositories → get_latest_release chain.",
  inputSchema: z.object({
    query: z.string().describe("Repository search terms, e.g. 'anthropic sdk python'"),
  }),
  uses: ["github:search_repositories", "github:get_latest_release"],
  steps: async (input, call) => {
    const search = await call("github:search_repositories", {
      query: input.query,
      perPage: 3,
    });
    if (search.isError) return search;

    const fullName = extractFullName(search.structured ?? search.text);
    if (!fullName) {
      return { text: `no repositories matched "${input.query}"`, isError: true };
    }
    const [owner, repo] = fullName.split("/");
    const release = await call("github:get_latest_release", { owner, repo });
    if (release.isError) {
      return { text: `found ${fullName} but it has no published releases`, isError: true };
    }
    return { text: `Repository: ${fullName}\n\n${release.text}`, isError: false };
  },
});

/** Pull the first repo's full_name out of a structured or JSON-ish search payload. */
function extractFullName(payload: unknown): string | null {
  let data = payload;
  if (typeof data === "string") {
    const text = data;
    try {
      data = JSON.parse(text);
    } catch {
      const match = /"full_name"\s*:\s*"([^"]+)"/.exec(text);
      return match?.[1] ?? null;
    }
  }
  const items = Array.isArray(data)
    ? data
    : ((data as { items?: unknown[]; repositories?: unknown[] })?.items ??
      (data as { repositories?: unknown[] })?.repositories);
  const first = Array.isArray(items) ? (items[0] as { full_name?: string }) : undefined;
  return first?.full_name ?? null;
}
