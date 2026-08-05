import { defineMacro } from "@toolc/core";
import { z } from "zod";

/**
 * Provenance: the search-then-read pattern is the most common two-step chain
 * against the filesystem server — an agent rarely knows exact paths up front.
 * Also serves as the deterministic macro for gateway integration tests.
 */
export const findAndReadFile = defineMacro({
  name: "find_and_read_file",
  description:
    "Find a file by name pattern under the sandbox and return its full text content in one call. " +
    "Replaces the search_files → read_text_file chain. Returns an error listing near-matches when nothing matches exactly.",
  inputSchema: z.object({
    pattern: z.string().describe("File name or partial name, e.g. 'inventory' or 'project-log.md'"),
    path: z.string().describe("Directory to search from (absolute)."),
  }),
  uses: ["fs:search_files", "fs:read_text_file"],
  steps: async (input, call) => {
    // search_files takes glob patterns and only recurses with a `**/` prefix —
    // translate a bare file name into the glob an agent would have to guess.
    const glob = input.pattern.includes("*") ? input.pattern : `**/${input.pattern}*`;
    const search = await call("fs:search_files", { path: input.path, pattern: glob });
    if (search.isError) return search;
    const first = search.text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("No matches"));
    if (!first) {
      return {
        text: `no file matching "${input.pattern}" under ${input.path}`,
        isError: true,
      };
    }
    return call("fs:read_text_file", { path: first });
  },
});
