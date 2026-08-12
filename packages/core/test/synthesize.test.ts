import { createServer, type Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeSpec, synthesizeSpecFromDocs } from "../src/frontend/synthesize.js";

describe("spec synthesis", () => {
  let api: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/notes") return res.end('{"notes":[]}');
      if (url.pathname === "/private") {
        res.statusCode = 401;
        return res.end("{}");
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => api.listen(0, resolve));
    const address = api.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(() => api.close());

  it("drafts a spec via the LLM and validates its shape", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Notes" },
      servers: [{ url: "https://api.example.com" }],
      paths: { "/notes": { get: { operationId: "list_notes", summary: "List notes." } } },
    };
    const result = await synthesizeSpecFromDocs(
      "https://docs.example.com/api",
      async ({ prompt }) => {
        expect(prompt).toContain("GET /notes returns all notes");
        return `<<<SPEC>>>\n${JSON.stringify(spec)}\n<<<END>>>`;
      },
      { docsText: "The Notes API. Base URL https://api.example.com. GET /notes returns all notes. ".repeat(5) },
    );
    expect(Object.keys(result.spec.paths as object)).toEqual(["/notes"]);
  });

  it("rejects drafts without an https base or paths", async () => {
    await expect(
      synthesizeSpecFromDocs("https://d", async () => '<<<SPEC>>>{"paths":{}}<<<END>>>', {
        docsText: "x".repeat(300),
      }),
    ).rejects.toThrow(/https base|no paths/);
  });

  it("probes GET endpoints: exists vs 404 vs auth-gated", async () => {
    const spec = {
      servers: [{ url: baseUrl }],
      paths: {
        "/notes": { get: { operationId: "list_notes" } },
        "/private": { get: { operationId: "private_thing" } },
        "/hallucinated": { get: { operationId: "made_up" } },
        "/notes/{id}": { get: { operationId: "get_note" } },
      },
    };
    const results = await probeSpec(spec as never);
    const byId = Object.fromEntries(results.map((r) => [r.operationId, r]));
    expect(byId.list_notes).toMatchObject({ probed: true, ok: true, status: 200 });
    expect(byId.private_thing).toMatchObject({ probed: true, ok: true, status: 401 });
    expect(byId.made_up).toMatchObject({ probed: true, ok: false, status: 404 });
    expect(byId.get_note).toMatchObject({ probed: false, ok: null });
  });
});
