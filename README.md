# toolc

An optimizing compiler for agent tool surfaces: many MCP servers in, one
compiled MCP interface out — smaller, higher-level, better-described, fully
observed.

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
