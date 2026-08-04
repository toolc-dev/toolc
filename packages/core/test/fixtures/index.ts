import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, withVersion } from "../../src/ir/serialize.js";
import {
  type CapabilityGraph,
  type SourceInfo,
  type ToolNode,
  toolId,
} from "../../src/ir/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_SERVER_PATH = join(HERE, "fixture-server.mjs");

interface RawCatalogTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Load the checked-in fixture federation as a CapabilityGraph, as if introspected. */
export function fixtureFederationGraph(): CapabilityGraph {
  const raw = JSON.parse(readFileSync(join(HERE, "catalog-federation.json"), "utf8")) as {
    sources: Record<string, RawCatalogTool[]>;
  };
  const sources: SourceInfo[] = [];
  const tools: ToolNode[] = [];
  for (const [sourceId, catalog] of Object.entries(raw.sources)) {
    sources.push({
      id: sourceId,
      serverName: sourceId,
      serverVersion: "1.0.0",
      instructions: null,
      catalogHash: contentHash(catalog),
      introspectedAt: "2026-01-01T00:00:00.000Z",
      toolCount: catalog.length,
    });
    for (const t of catalog) {
      tools.push({
        id: toolId(sourceId, t.name),
        source: sourceId,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        overlays: {},
        kind: "passthrough",
      });
    }
  }
  return withVersion({ sources, tools, edges: [] });
}
