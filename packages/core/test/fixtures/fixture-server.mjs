#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
// Deterministic stdio MCP server used by core and gateway tests.
// Plain JS so tests can spawn it with `node` — no TS loader needed.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const NOTES = {
  alpha: "The alpha note. Contains the secret word: kumquat.",
  beta: "The beta note. Nothing to see here.",
};

const server = new McpServer(
  { name: "fixture-server", version: "1.0.0" },
  { instructions: "A tiny deterministic server for toolc tests." },
);

server.registerTool(
  "read_note",
  {
    description: "Read a note by name and return its full text content.",
    inputSchema: z.object({ name: z.string().describe("Note name, e.g. 'alpha'") }),
  },
  async ({ name }) => {
    const note = NOTES[name];
    if (!note) {
      return { content: [{ type: "text", text: `no such note: ${name}` }], isError: true };
    }
    return { content: [{ type: "text", text: note }] };
  },
);

server.registerTool(
  "list_notes",
  { description: "List the names of all available notes.", inputSchema: z.object({}) },
  async () => ({ content: [{ type: "text", text: Object.keys(NOTES).join("\n") }] }),
);

server.registerTool(
  "add",
  {
    description: "Add two numbers and return the sum.",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

server.registerTool(
  "ping",
  { description: "Health check. Returns 'pong'.", inputSchema: z.object({}) },
  async () => ({ content: [{ type: "text", text: "pong" }] }),
);

await server.connect(new StdioServerTransport());
