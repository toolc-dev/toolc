#!/usr/bin/env node
// Large deterministic stdio MCP server: 120 generated tools across 6 fake
// domains. Exercises selection/search at benchmark-federation scale.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const DOMAINS = [
  ["crm", "customer relationship records"],
  ["billing", "invoices and payment records"],
  ["tickets", "support ticket queue"],
  ["inventory", "warehouse stock items"],
  ["hr", "employee directory entries"],
  ["wiki", "internal documentation pages"],
  ["calendar", "meeting and scheduling entries"],
  ["assets", "IT asset registry entries"],
  ["contracts", "vendor contract documents"],
  ["metrics", "product analytics dashboards"],
];
const ACTIONS = [
  ["list", "List all"],
  ["get", "Get one"],
  ["search", "Search"],
  ["create", "Create a new"],
  ["update", "Update an existing"],
  ["delete", "Delete"],
  ["export", "Export"],
  ["count", "Count"],
  ["archive", "Archive"],
  ["restore", "Restore"],
  ["tag", "Attach a tag to"],
  ["history", "Show the change history of"],
];

const server = new McpServer({ name: "fixture-large", version: "1.0.0" });

for (const [domain, noun] of DOMAINS) {
  for (const [action, verb] of ACTIONS) {
    server.registerTool(
      `${action}_${domain}`,
      {
        description: `${verb} ${noun}. Part of the ${domain} module.`,
        inputSchema: z.object({ query: z.string().optional() }),
      },
      async ({ query }) => ({
        content: [{ type: "text", text: `${action}_${domain}:${query ?? ""}` }],
      }),
    );
  }
}

await server.connect(new StdioServerTransport());
