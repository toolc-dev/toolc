import { z } from "zod";

/**
 * The Capability Graph — toolc's IR.
 *
 * Design constraints (spec §6.2):
 *  (a) Original catalog data is immutable; all pass effects live in `overlays`,
 *      so mirror mode and before/after diffing are always possible.
 *  (b) Serializes deterministically (stable key order) so `version` hashes
 *      are reproducible — see serialize.ts.
 *  (c) No MCP SDK types appear here. Frontends adapt in, emit adapts out;
 *      that is what keeps an OpenAPI frontend addable without touching passes.
 */

/** JSON Schema as introspected from a source. Kept opaque: passes must not assume dialect. */
export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

/** Behavior hints per MCP tool annotations; all advisory, all optional. */
export const ToolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .loose();
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

export const SourceInfoSchema = z.object({
  /** Downstream id from config; "toolc" is reserved for synthesized tools. */
  id: z.string(),
  /** Server-reported name/version from the MCP initialize handshake. */
  serverName: z.string().nullable(),
  serverVersion: z.string().nullable(),
  /** Server-provided instructions blob, if any. */
  instructions: z.string().nullable(),
  /** Content hash of this source's introspected catalog, for drift detection. */
  catalogHash: z.string(),
  /** ISO8601 time of introspection. */
  introspectedAt: z.string(),
  toolCount: z.number().int(),
});
export type SourceInfo = z.infer<typeof SourceInfoSchema>;

export const OverlaysSchema = z.object({
  /** Rewritten description (rewrite pass). Original stays in ToolNode.description. */
  description: z.string().optional(),
  /** Hidden from the served surface (dead-tool / selection passes). */
  hidden: z.boolean().optional(),
  hiddenReason: z.string().optional(),
  /**
   * Set by the selection pass: true = definition is surfaced to the client,
   * false = reachable only via search_tools/call_tool. Absent before selection runs.
   */
  surfaced: z.boolean().optional(),
});
export type Overlays = z.infer<typeof OverlaysSchema>;

export const ToolKindSchema = z.enum(["passthrough", "macro", "meta"]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const ToolNodeSchema = z.object({
  /** "sourceId:toolName" — globally unique. */
  id: z.string(),
  /** sourceId; "toolc" for synthesized (macro/meta) tools. */
  source: z.string(),
  /** Name as exposed by the downstream server (unnamespaced). */
  name: z.string(),
  /** ORIGINAL description as introspected. Never mutated by passes. */
  description: z.string(),
  inputSchema: JsonSchemaSchema,
  annotations: ToolAnnotationsSchema.optional(),
  overlays: OverlaysSchema,
  kind: ToolKindSchema,
});
export type ToolNode = z.infer<typeof ToolNodeSchema>;

export const DataEdgeSchema = z.object({
  /** Producing tool id. */
  from: z.string(),
  /** JSONPath into the from-tool's output. */
  fromField: z.string(),
  /** Consuming tool id. */
  to: z.string(),
  toField: z.string(),
  /** "macro" = declared by a hand-authored macro; "mined" reserved for v2 PGO. */
  via: z.enum(["macro", "mined"]),
});
export type DataEdge = z.infer<typeof DataEdgeSchema>;

export const CapabilityGraphSchema = z.object({
  sources: z.array(SourceInfoSchema),
  tools: z.array(ToolNodeSchema),
  /** v1: populated only by macro definitions. */
  edges: z.array(DataEdgeSchema),
  /** Content hash of the graph (computed by serialize.ts), used as cache key. */
  version: z.string(),
});
export type CapabilityGraph = z.infer<typeof CapabilityGraphSchema>;

/** Effective description: rewritten overlay if present, else original. */
export function effectiveDescription(tool: ToolNode): string {
  return tool.overlays.description ?? tool.description;
}

export function isVisible(tool: ToolNode): boolean {
  return tool.overlays.hidden !== true;
}

/** Reserved source id for tools toolc itself synthesizes (macros, meta-tools). */
export const TOOLC_SOURCE = "toolc";

export function toolId(sourceId: string, toolName: string): string {
  return `${sourceId}:${toolName}`;
}
