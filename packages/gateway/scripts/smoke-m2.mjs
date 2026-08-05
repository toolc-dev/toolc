// M2 exit smoke: MCP client → `toolc serve --mode compiled` (stdio subprocess)
// → search_tools / call_tool / macro against the real filesystem server.
// Run `node packages/cli/bin/toolc.mjs compile` first.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const text = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";

const client = new Client({ name: "smoke-m2", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["packages/cli/bin/toolc.mjs", "serve", "--mode", "compiled"],
    cwd: ROOT,
    stderr: "inherit",
  }),
);

const { tools } = await client.listTools();
console.log(`SURFACE (${tools.length}):`, tools.map((t) => t.name).join(", "));

const search = await client.callTool({
  name: "search_tools",
  arguments: { query: "read the contents of a file" },
});
console.log("SEARCH OK:", text(search).includes("fs:read_text_file"));

const call = await client.callTool({
  name: "call_tool",
  arguments: {
    name: "fs:read_text_file",
    arguments: { path: join(ROOT, "sandbox/inventory.csv") },
  },
});
console.log("CALL_TOOL OK:", text(call).includes("gizmo-gamma"));

const macro = await client.callTool({
  name: "find_and_read_file",
  arguments: { pattern: "project-log", path: join(ROOT, "sandbox") },
});
console.log("MACRO OK:", text(macro).includes("bluejay"), "| isError:", macro.isError ?? false);

await client.close();
process.exit(0);
