# toolc

**The optimizing compiler for agent tool surfaces.** Point it at your MCP
servers — or just a REST API's OpenAPI spec, or even a docs page — and get
back one endpoint that serves a smaller, smarter tool surface: cheaper for
every agent that connects, more accurate on every task, with every call
logged.

Connecting N MCP servers dumps every tool definition into the model's
context, degrades tool selection, and forces improvised multi-hop call
chains. toolc compiles the federation instead:

- **Rewrite** — LLM-optimized descriptions with sibling disambiguation
- **Consolidate** — families of near-duplicate tools (`search_x`/`find_x`/`get_x`)
  merge into single facade tools with deterministic routing
- **Selection** — the whole catalog compresses behind two meta-tools
  (`search_tools`/`call_tool`) when you want maximum context savings
- **Compaction** — oversized results are summarized at serve time, preserving
  identifiers and sourcing details
- **Compose** — REST APIs join the pool straight from an OpenAPI spec, or from
  a drafted spec synthesized from their documentation
- **Observe** — every call logged with arguments and results; recurring errors
  cluster into recommended compiler fixes

## Benchmark

131 tools across 5 live servers, 30 tasks × 3 trials, judged answers, same
gateway hop in every condition
([full grid](docs/benchmark-2026-08-09.md) ·
[consolidation run](docs/benchmark-consolidate-2026-08-10.md)):

| condition | success | cost / completed task | tool-def context |
|---|---|---|---|
| raw (all 131 tools) | 96.7% | $0.2631 | ~24,360 tok |
| **compiled + consolidate** | 96.7% | **$0.0411 (6.4× cheaper)** | ~845 tok |
| **consolidate, no selection** | **100.0%** | $0.1335 | ~14,506 tok |

Consolidation dominates both ends of the frontier: the selection surface is
the cost lever, consolidation lifts accuracy everywhere. Every pass is a
config toggle — pick the tradeoff per deployment.

## Quick start

```sh
git clone https://github.com/toolc-dev/toolc && cd toolc
pnpm install && pnpm -r test

# describe your federation
cp toolc.config.example.jsonc toolc.config.jsonc

# introspect it
node packages/cli/bin/toolc.mjs -c toolc.config.jsonc inspect

# compile (set ANTHROPIC_API_KEY for the rewrite/consolidate passes)
node packages/cli/bin/toolc.mjs -c toolc.config.jsonc compile

# serve the compiled surface over stdio (add to Claude as an MCP server)
node packages/cli/bin/toolc.mjs -c toolc.config.jsonc serve --mode compiled
```

A downstream can be an MCP server or a bare REST API:

```jsonc
{
  "downstream": [
    { "id": "gh", "transport": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" } },
    { "id": "nws", "transport": { "type": "openapi", "spec": "https://api.weather.gov/openapi.json" } }
  ]
}
```

See [SELF_HOSTING.md](SELF_HOSTING.md) for Docker deployment.

## Hosted

[toolc.dev](https://toolc.dev) runs this same engine as a managed service:
compiled HTTPS endpoints, a console with a playground and full-payload log
explorer, docs-to-spec drafting, error-driven fix recommendations, and
usage-based billing (free tier included).

## Layout

- `packages/core` — IR (Capability Graph), frontends (MCP, OpenAPI, docs synthesis), passes, emit
- `packages/gateway` — runtime MCP server (mirror + compiled) with call logging and compaction
- `packages/cli` — the `toolc` command
- `packages/harness` — benchmark runner, grading, reports
- `packages/shared` — config schema, errors

## License

The engine (everything in this repository) is Apache-2.0, forever — anyone
can compile and serve their own tool surfaces locally with the exact same
compilation quality as the hosted product. The toolc.dev console and hosted
platform are proprietary.
