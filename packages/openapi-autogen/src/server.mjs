#!/usr/bin/env node
// Deliberately NAIVE OpenAPI → MCP auto-generator (the benchmark's "bad
// server", spec §8). One tool per GET operation; names, descriptions, and
// schemas are lifted verbatim from the spec with zero curation — verbose,
// undifferentiated descriptions are the point. Do not hand-tune.
//
// Usage: node server.mjs <openapi.json path> [baseUrl]
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const [specPath, baseUrlArg] = process.argv.slice(2);
if (!specPath) {
  console.error("usage: openapi-mcp <openapi.json> [baseUrl]");
  process.exit(1);
}
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const baseUrl = (baseUrlArg ?? spec.servers?.[0]?.url ?? "").replace(/\/$/, "");
if (!baseUrl) {
  console.error("no base URL: spec has no servers[0].url and none was passed");
  process.exit(1);
}

const RESULT_MAX_CHARS = 100_000;

function sanitizeName(raw) {
  return raw.replaceAll(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "op";
}

function resolveRef(node) {
  if (node && typeof node === "object" && "$ref" in node) {
    const path = node.$ref.replace(/^#\//, "").split("/");
    let target = spec;
    for (const key of path) target = target?.[key];
    return target ?? {};
  }
  return node ?? {};
}

const tools = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  const op = item.get;
  if (!op) continue; // read-only surface: GET operations only
  const name = sanitizeName(op.operationId ?? `get_${path}`);
  if (tools.some((t) => t.name === name)) continue;

  const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolveRef);
  const properties = {};
  const required = [];
  for (const p of params) {
    if (!p.name || !["path", "query"].includes(p.in)) continue;
    const schema = resolveRef(p.schema);
    properties[p.name] = {
      type: typeof schema.type === "string" ? schema.type : "string",
      ...(p.description ? { description: p.description } : {}),
      ...(schema.enum ? { enum: schema.enum } : {}),
    };
    if (p.in === "path" || p.required) required.push(p.name);
  }

  // Description: raw concatenation of everything the spec says. No editing.
  const paramText = params
    .filter((p) => p.name)
    .map((p) => `${p.name}: ${p.description ?? "(no description)"}`)
    .join("; ");
  const description = [op.summary, op.description, paramText ? `Parameters: ${paramText}` : ""]
    .filter(Boolean)
    .join("\n");

  tools.push({
    name,
    description,
    inputSchema: { type: "object", properties, required },
    path,
    params,
  });
}

const server = new Server(
  { name: sanitizeName(spec.info?.title ?? "openapi"), version: spec.info?.version ?? "0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler("tools/list", async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler("tools/call", async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
  }
  const args = req.params.arguments ?? {};
  let url = tool.path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const encoded = Array.isArray(value) ? value.join(",") : String(value);
    if (url.includes(`{${key}}`)) url = url.replaceAll(`{${key}}`, encodeURIComponent(encoded));
    else query.set(key, encoded);
  }
  const qs = query.toString();
  try {
    const response = await fetch(`${baseUrl}${url}${qs ? `?${qs}` : ""}`, {
      headers: {
        "User-Agent": "toolc-benchmark/0.0.1 (https://toolc.dev)",
        Accept: "application/geo+json, application/ld+json, application/json;q=0.9, */*;q=0.5",
      },
    });
    let text = await response.text();
    if (text.length > RESULT_MAX_CHARS) text = `${text.slice(0, RESULT_MAX_CHARS)}…[truncated]`;
    return {
      content: [{ type: "text", text }],
      ...(response.ok ? {} : { isError: true }),
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `request failed: ${err.message ?? err}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
