# toolc

An optimizing compiler for agent tool surfaces: many MCP servers in, one
compiled MCP interface out — smaller, higher-level, better-described, fully
observed.

Connecting N MCP servers dumps every tool definition into the model's context,
degrades tool selection, and forces improvised multi-hop call chains. toolc
compiles the federation instead: dead-tool elimination, LLM-rewritten
descriptions, hand-authored macros that run whole chains in one call, and a
search-based selection surface — served as one drop-in MCP server with every
call logged.

## Benchmark (2026-08-09, full grid)

131 tools across 5 servers, 30 tasks × 3 trials, claude-sonnet-4-6, same
gateway hop in every condition ([full report](docs/benchmark-2026-08-09.md)):

| condition | success | cost / completed task | tool-def context |
|---|---|---|---|
| raw (all 131 tools) | 96.7% | $0.2631 | ~24,360 tok |
| **compiled** | 91.1% | **$0.0497 (5.3× cheaper)** | **~845 tok** |
| compiled, no selection pass | **100.0%** | $0.3026 | ~32,502 tok |

The macro + rewrite passes lift success above raw; the selection pass is the
cost lever. Pick the tradeoff per deployment — it's one config line.

**Status: pre-release, under construction.** See `docs/toolc-spec.md` for the
full v1 spec.

## Layout

- `packages/core` — IR (Capability Graph), frontends, passes, emit
- `packages/gateway` — runtime MCP server (mirror + compiled modes) with call logging
- `packages/harness` — benchmark runner, grading, report (M3)
- `packages/cli` — the `toolc` command
- `packages/shared` — config schema, errors
- `sandbox/` — frozen fixture directory for benchmark filesystem tasks

## Quick start (dev)

```sh
pnpm install
pnpm test
# introspect a federation
node packages/cli/bin/toolc.mjs -c toolc.config.jsonc inspect
# serve mirror mode over stdio (add to Claude/Inspector as a stdio MCP server)
node packages/cli/bin/toolc.mjs -c toolc.config.jsonc serve --mode mirror
```

## License

Engine (`core`, `gateway`, `cli`, `harness`, `shared`, SQLite driver):
Apache-2.0, forever — anyone can compile and serve their own tool surfaces
locally with the exact same compilation quality as the hosted product.
The toolc.dev console and hosted platform are proprietary and live in a
separate private repository. Formal LICENSE files land before this repo
goes public.
