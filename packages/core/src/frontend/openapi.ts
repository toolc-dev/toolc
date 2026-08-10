import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import type { OpenApiTransportConfig } from "@toolc/shared";

/**
 * REST composition: turn an OpenAPI spec into an in-process MCP server, so a
 * plain REST API can join the pool as a downstream. The generated surface is
 * deliberately mechanical (one tool per operation, spec text verbatim); the
 * compile passes are what turn it into a good surface.
 */

const RESULT_MAX_CHARS = 100_000;
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface OpApiTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  method: string;
  path: string;
  hasBody: boolean;
}

function sanitizeName(raw: string): string {
  return raw.replaceAll(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "op";
}

export async function loadOpenApiSpec(
  config: OpenApiTransportConfig,
): Promise<Record<string, unknown>> {
  if (/^https?:\/\//.test(config.spec)) {
    const response = await fetch(config.spec, {
      headers: { Accept: "application/json, application/yaml;q=0.5", ...config.headers },
    });
    if (!response.ok) throw new Error(`spec fetch failed: HTTP ${response.status}`);
    return JSON.parse(await response.text()) as Record<string, unknown>;
  }
  return JSON.parse(readFileSync(config.spec, "utf8")) as Record<string, unknown>;
}

export function parseOpenApiTools(spec: Record<string, unknown>): OpApiTool[] {
  const resolveRef = (node: unknown): Record<string, unknown> => {
    if (node && typeof node === "object" && "$ref" in node) {
      const path = String((node as { $ref: string }).$ref)
        .replace(/^#\//, "")
        .split("/");
      let target: unknown = spec;
      for (const key of path) target = (target as Record<string, unknown> | undefined)?.[key];
      return (target as Record<string, unknown>) ?? {};
    }
    return (node as Record<string, unknown>) ?? {};
  };

  const tools: OpApiTool[] = [];
  for (const [path, rawItem] of Object.entries(
    (spec.paths as Record<string, unknown>) ?? {},
  )) {
    const item = rawItem as Record<string, Record<string, unknown>>;
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const name = sanitizeName(
        (op.operationId as string) ?? `${method}_${path.replaceAll(/[/{}]/g, "_")}`,
      );
      if (tools.some((t) => t.name === name)) continue;

      const params = [
        ...((item.parameters as unknown as unknown[]) ?? []),
        ...((op.parameters as unknown as unknown[]) ?? []),
      ].map(resolveRef);
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of params) {
        const pName = p.name as string | undefined;
        if (!pName || !["path", "query"].includes(p.in as string)) continue;
        const schema = resolveRef(p.schema);
        properties[pName] = {
          type: typeof schema.type === "string" ? schema.type : "string",
          ...(p.description ? { description: p.description } : {}),
          ...(schema.enum ? { enum: schema.enum } : {}),
        };
        if (p.in === "path" || p.required) required.push(pName);
      }
      const body = resolveRef(
        resolveRef((op.requestBody as Record<string, unknown>)?.content)?.["application/json"],
      );
      const hasBody = method !== "get" && Boolean(body.schema);
      if (hasBody) {
        properties.body = {
          ...resolveRef(body.schema),
          description: "JSON request body for this operation.",
        };
        required.push("body");
      }

      const paramText = params
        .filter((p) => p.name)
        .map((p) => `${p.name}: ${p.description ?? "(no description)"}`)
        .join("; ");
      tools.push({
        name,
        description: [
          `${method.toUpperCase()} ${path}`,
          op.summary,
          op.description,
          paramText ? `Parameters: ${paramText}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        inputSchema: { type: "object", properties, required },
        method,
        path,
        hasBody,
      });
    }
  }
  return tools;
}

/** In-process MCP server serving the composed REST surface. */
export async function createOpenApiServer(config: OpenApiTransportConfig): Promise<Server> {
  const spec = await loadOpenApiSpec(config);
  const baseUrl = (
    config.baseUrl ??
    ((spec.servers as Array<{ url?: string }> | undefined)?.[0]?.url ?? "")
  ).replace(/\/$/, "");
  if (!baseUrl) throw new Error("openapi: no base URL (spec has no servers[0].url)");
  const tools = parseOpenApiTools(spec);
  const info = spec.info as { title?: string; version?: string } | undefined;

  const server = new Server(
    { name: sanitizeName(info?.title ?? "openapi"), version: info?.version ?? "0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: inputSchema as never,
    })),
  }));
  server.setRequestHandler("tools/call", async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    let url = tool.path;
    const query = new URLSearchParams(config.query ?? {});
    for (const [key, value] of Object.entries(args)) {
      if (key === "body" || value === undefined || value === null) continue;
      const encoded = Array.isArray(value) ? value.join(",") : String(value);
      if (url.includes(`{${key}}`)) url = url.replaceAll(`{${key}}`, encodeURIComponent(encoded));
      else query.set(key, encoded);
    }
    const qs = query.toString();
    try {
      const response = await fetch(`${baseUrl}${url}${qs ? `?${qs}` : ""}`, {
        method: tool.method.toUpperCase(),
        headers: {
          "User-Agent": "toolc/0.0.1 (+https://toolc.dev)",
          Accept: "application/json;q=0.9, */*;q=0.5",
          ...(tool.hasBody ? { "Content-Type": "application/json" } : {}),
          ...config.headers,
        },
        ...(tool.hasBody && args.body !== undefined
          ? { body: JSON.stringify(args.body) }
          : {}),
      });
      let text = await response.text();
      if (text.length > RESULT_MAX_CHARS) text = `${text.slice(0, RESULT_MAX_CHARS)}…[truncated]`;
      return { content: [{ type: "text", text }], ...(response.ok ? {} : { isError: true }) };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `request failed: ${err instanceof Error ? err.message : err}` },
        ],
        isError: true,
      };
    }
  });
  return server;
}
