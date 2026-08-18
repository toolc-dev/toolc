# Self-hosting toolc

The engine is Apache-2.0 and runs anywhere Node 22+ does. Two ways to run it:

## Directly

```sh
pnpm install
cp toolc.config.example.jsonc toolc.config.jsonc   # describe your downstreams
export ANTHROPIC_API_KEY=sk-ant-...                # for the rewrite/consolidate passes
node packages/cli/bin/toolc.mjs compile
node packages/cli/bin/toolc.mjs serve --mode compiled
```

`serve` speaks MCP over stdio, so it plugs into Claude Desktop / Claude Code
as a local MCP server:

```json
{
  "mcpServers": {
    "toolc": {
      "command": "node",
      "args": ["/path/to/toolc/packages/cli/bin/toolc.mjs", "-c", "/path/to/toolc.config.jsonc", "serve", "--mode", "compiled"]
    }
  }
}
```

## Docker

```sh
cp toolc.config.example.jsonc toolc.config.jsonc
docker compose run --build toolc compile
docker compose run toolc serve --mode compiled
```

The compose file mounts your config and a `.toolc/` state directory (compiled
artifact, rewrite cache, call log) so recompiles are incremental and logs
persist across runs.

## Configuration

Everything lives in `toolc.config.jsonc` — see the example file for the full
shape. Highlights:

- `downstream[]` — MCP servers (`stdio` or `http` transports) or REST APIs
  (`openapi` transport with a spec URL/path)
- `compile.passes` — which optimizations run; each is independently
  toggleable (`dead-tool`, `rewrite`, `consolidate`, `macro-inline`, `selection`)
- `serve.compaction` — serve-time summarization of oversized results
- `compile.macrosDir` — hand-authored multi-step macros (TypeScript modules)

Environment variables referenced as `${NAME}` in the config are substituted
at load time, so secrets stay out of the file.

## What the hosted product adds

[toolc.dev](https://toolc.dev) runs this exact engine with a managed HTTPS
endpoint per workspace, a console (playground, full-payload log explorer with
live tail, per-tool kill switches), docs-to-spec drafting for APIs without an
OpenAPI file, error-driven fix recommendations, and usage-based billing.
