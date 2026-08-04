// M1 exit smoke: MCP client → `toolc serve --mode mirror` (stdio subprocess)
// → filesystem reference server → SQLite call log.
// Run from anywhere: node packages/gateway/scripts/smoke-m1.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["packages/cli/bin/toolc.mjs", "serve", "--mode", "mirror"],
    cwd: ROOT,
    stderr: "inherit",
  }),
);

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}):`, tools.map((t) => t.name).join(", "));

const result = await client.callTool({
  name: "fs__read_text_file",
  arguments: { path: join(ROOT, "sandbox/inventory.csv") },
});
const text = result.content?.find((c) => c.type === "text")?.text ?? "";
console.log("READ OK:", text.includes("gizmo-gamma"), "| isError:", result.isError ?? false);
console.log("Now check the log: sqlite3 .toolc/calls.db 'SELECT * FROM calls;'");

await client.close();
process.exit(0);
