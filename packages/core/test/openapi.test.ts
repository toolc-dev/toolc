import { createServer, type Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import { parseOpenApiTools } from "../src/frontend/openapi.js";

const SPEC = {
  openapi: "3.0.0",
  info: { title: "Tiny Notes API", version: "1.0.0" },
  paths: {
    "/notes": {
      get: {
        operationId: "list_notes",
        summary: "List all notes.",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" }, description: "Max notes" },
        ],
      },
      post: {
        operationId: "create_note",
        summary: "Create a note.",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { text: { type: "string" } } },
            },
          },
        },
      },
    },
    "/notes/{id}": {
      get: {
        operationId: "get_note",
        summary: "Fetch one note by id.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      },
    },
  },
};

describe("openapi composition", () => {
  let api: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/spec.json") return res.end(JSON.stringify(SPEC));
      if (req.method === "GET" && url.pathname === "/notes")
        return res.end(JSON.stringify({ notes: ["alpha"], limit: url.searchParams.get("limit") }));
      if (req.method === "GET" && url.pathname.startsWith("/notes/"))
        return res.end(JSON.stringify({ id: url.pathname.split("/")[2], text: "hi" }));
      if (req.method === "POST" && url.pathname === "/notes") {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => res.end(JSON.stringify({ created: JSON.parse(body) })));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => api.listen(0, resolve));
    const address = api.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(() => api.close());

  it("parses operations across methods with params and bodies", () => {
    const tools = parseOpenApiTools(SPEC as unknown as Record<string, unknown>);
    expect(tools.map((t) => t.name).sort()).toEqual(["create_note", "get_note", "list_notes"]);
    const create = tools.find((t) => t.name === "create_note")!;
    expect(create.hasBody).toBe(true);
    expect((create.inputSchema.required as string[])).toContain("body");
  });

  it("introspects an openapi downstream through the normal pipeline and serves calls", async () => {
    const graph = await buildGraph([
      {
        id: "notes",
        transport: { type: "openapi", spec: `${baseUrl}/spec.json`, baseUrl },
        enabled: true,
      },
    ]);
    expect(graph.tools.map((t) => t.id).sort()).toEqual([
      "notes:create_note",
      "notes:get_note",
      "notes:list_notes",
    ]);

    const { DownstreamPool } = await import("../../gateway/src/downstream.js");
    const pool = new DownstreamPool([
      {
        id: "notes",
        transport: { type: "openapi", spec: `${baseUrl}/spec.json`, baseUrl, query: { k: "v" } },
        enabled: true,
      },
    ]);
    const listing = await pool.call("notes", "list_notes", { limit: 2 });
    const listText = (listing.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(listText)).toMatchObject({ notes: ["alpha"], limit: "2" });

    const fetched = await pool.call("notes", "get_note", { id: "n1" });
    expect((fetched.content as Array<{ text: string }>)[0]!.text).toContain('"id":"n1"');

    const created = await pool.call("notes", "create_note", { body: { text: "hello" } });
    expect((created.content as Array<{ text: string }>)[0]!.text).toContain('"text":"hello"');
    await pool.close();
  });
});
