/** Glob-style tool-id matcher: `*` matches any run of characters. */
export function matchesGlob(pattern: string, toolId: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return regex.test(toolId);
}

export function matchesAny(patterns: string[], toolId: string): boolean {
  return patterns.some((p) => matchesGlob(p, toolId));
}
