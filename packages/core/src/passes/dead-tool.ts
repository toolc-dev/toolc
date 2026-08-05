import type { ToolNode } from "../ir/types.js";
import { matchesAny } from "./glob.js";
import type { Pass, PassDiff } from "./types.js";

/** Names that are almost never useful to an agent surface. */
const NOISE_PATTERN = /(^|_)(ping|debug|health)(_|$)|^(ping|debug|health)$/;

/**
 * Dead code elimination, config-driven in v1:
 *  - `include` set → allowlist mode: everything not matching is hidden.
 *  - `exclude` patterns hide matching tools.
 *  - Obvious noise (ping/debug/health) is auto-hidden unless explicitly included.
 * (v2: log-driven — hide tools with zero calls over a traffic window.)
 */
export const deadToolPass: Pass = async (graph, config, _ctx) => {
  const { exclude, include } = config.compile.deadTool;
  const diff: PassDiff = {
    pass: "dead-tool",
    hidden: [],
    unhidden: [],
    rewritten: [],
    added: [],
    notes: [],
  };

  const tools = graph.tools.map((tool): ToolNode => {
    if (tool.source === "toolc") return tool; // never eliminate synthesized tools

    const explicitlyIncluded = include !== null && matchesAny(include, tool.id);
    let reason: string | null = null;
    if (include !== null && !explicitlyIncluded) {
      reason = "config-include-miss";
    } else if (!explicitlyIncluded && matchesAny(exclude, tool.id)) {
      reason = "config-exclude";
    } else if (!explicitlyIncluded && NOISE_PATTERN.test(tool.name)) {
      reason = "auto-noise";
    }

    if (reason === null) return tool;
    diff.hidden.push(tool.id);
    return { ...tool, overlays: { ...tool.overlays, hidden: true, hiddenReason: reason } };
  });

  diff.notes.push(`${diff.hidden.length} tool(s) hidden`);
  return { graph: { ...graph, tools }, diff };
};
