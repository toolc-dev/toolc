# toolc — an optimizing compiler for agent tool surfaces

**Name:** `toolc` (shipping name). **Domain:** toolc.dev (owned). **npm:** `toolc` + `@toolc/*` scope. **GitHub org:** `toolc-dev` or `toolc` (grab whichever is free at build start). **Spec version:** 1.0 (final) — v1 build spec, written to be executable by Claude Code in a fresh repo with minimal clarification.

---

## 1. Thesis

Agents today run against raw, unoptimized tool surfaces. Connecting N MCP servers dumps every tool definition into the model's context, degrades tool selection, burns tokens, and forces multi-hop call chains the agent must improvise. `toolc` sits between agents and their tool sources and **compiles** them: many MCP servers (later: OpenAPI specs) in, one optimized MCP interface out.

The compiled interface is smaller (selection intelligence), higher-level (synthesized macro tools that execute multi-server chains in one call), better-described (rewritten tool descriptions, tested against model behavior), and fully observed (every call logged, enabling profile-guided re-optimization later).

**v1 has two jobs:**
1. **Produce a publishable benchmark proving the lift.** Same agent, same task suite, raw multi-server config vs. compiled interface. Headline metrics: task success rate and cost-per-completed-task. The benchmark report is the launch artifact, the marketing, and the first sales asset.
2. **Ship the hosted console at toolc.dev.** Sign up → add MCP servers to a pool → get back one compiled MCP endpoint with copy-paste setup for Claude, ChatGPT, Claude Code, and Cursor. This is the open-core split made concrete on day one: the compiler and local CLI are open source; the hosted, always-on, credential-holding endpoint is the product.

The two jobs share one engine. The console is a thin tenant-aware shell around exactly the compile pipeline and gateway the benchmark exercises — if the build ever forks "hosted logic" away from "benchmarked logic," that's a design smell to correct.

## 2. Compiler architecture (conceptual map)

| Compiler concept | toolc component | v1 status |
|---|---|---|
| Source language | MCP server catalogs | ✅ v1 |
| Source language #2 | OpenAPI specs | ⏸ v1.5, design for it |
| Frontend | Catalog ingestion via MCP client introspection | ✅ v1 |
| IR | Capability Graph (normalized tools, entities, data deps) | ✅ v1 |
| Optimization passes | dead-tool elimination, description rewrite, selection pruning, macro inlining | ✅ v1 (see §6) |
| Backend | Emitted MCP server (the gateway) | ✅ v1 |
| Profiler | Call log (SQLite) | ✅ v1 (log only) |
| PGO | Log-mined pass tuning / auto-macro proposal | ⏸ v2 |
| Test suite | Benchmark harness + task suite | ✅ v1, first-class |
| Build farm (hosted) | toolc.dev console + hosted gateway | ✅ v1 (§7) |

Two run modes, both served by the same gateway binary:

- **`mirror` mode** — faithful passthrough of all downstream tools, unmodified. This exists *only* to be the benchmark baseline and a debugging aid.
- **`compiled` mode** — the optimized surface produced by the pass pipeline.

### 2.1 Deployment modes (one engine, three deployments)

| Mode | Who | Storage | Auth in | What they get | What they pay |
|---|---|---|---|---|---|
| **Local CLI** | Solo dev, laptop | SQLite | none (localhost/stdio) | Full compiler + gateway, zero signup, `npx toolc` in 30s | Free forever |
| **Hosted** (toolc.dev) | Individuals, small teams | Postgres (ours) | secret URL → OAuth | Always-on endpoint, credential custody, console, zero ops | Paid (free beta) |
| **Self-hosted** | Companies / security teams | Postgres (theirs) | secret URL → OAuth + (v2) SSO | Whole control plane in their VPC | Free now; enterprise features (SSO, RBAC, policy, audit export) commercially licensed when they exist |

Two invariants that hold across all three, forever:

1. **Engine parity.** Local, hosted, and self-hosted run the *same* compiler with the *same* passes producing the *same* surface from the same inputs. Paid tiers differ in operations (uptime, custody, UI, team features) — never in compilation quality. If a change would make the hosted compiler smarter than the local one, it's wrong; put it in the open engine. CI guard: the benchmark harness must be runnable against a hosted-mode gateway and produce statistically identical results to local mode.
2. **Same binary.** There is no hosted fork. `packages/db`'s repository interface (SQLite vs. Postgres drivers) is the *only* place deployment mode is visible; a grep for `process.env.TOOLC_MODE`-style branching anywhere in `core`, `gateway`, or `harness` should return nothing.

Self-hosting is not a concession — it is the enterprise on-ramp. Orgs that insist on running the control plane in their own VPC are exactly the future buyers of policy, audit, and SSO. Ship a `docker-compose.yml` + self-hosting doc as part of M6 so this path exists from day one.

## 3. v1 scope and non-goals

**In scope (v1):**
1. Federate 3–5 downstream MCP servers (stdio and streamable HTTP transports locally; HTTP-only for hosted pools) behind one MCP server.
2. Compile pipeline with four passes (§6), configured declaratively + hand-authored macros.
3. Full call logging (SQLite locally, Postgres hosted).
4. Benchmark harness: task suite runner, agent loop against Anthropic API, programmatic + LLM-judge grading, report generator.
5. CLI: `toolc compile`, `toolc serve`, `toolc bench`, `toolc inspect`.
6. **Hosted console at toolc.dev (§7):** registration, workspace with a downstream-server pool, encrypted credential storage, per-workspace compiled MCP endpoint over streamable HTTP, client setup instructions, minimal call-log view.

**Explicit non-goals (v1) — do not build:**
- OpenAPI frontend (design the IR so it can be added; do not implement).
- OAuth 2.1 **inbound** auth for the hosted endpoint (DCR, authorization server). v1 uses per-workspace secret-URL endpoints (§7.3); OAuth is the first fast-follow. **Outbound** OAuth brokering to downstream servers is also deferred — v1 downstream auth is static headers/bearer tokens supplied by the user.
- Policy enforcement, anomaly detection, rich analytics dashboards (a raw call-log table is in; charts are not), billing/plans (hosted v1 is a free beta behind an invite code).
- Custom macros authored through the web UI (macros remain code; hosted workspaces get the built-in passes only in v1).
- Log-mined automatic macro synthesis (log schema must support it; the miner is v2).
- Per-model backends (emit one surface; record per-model results in the benchmark to justify v2 backends).
- MCP resources/prompts federation. Tools only. (Log a warning when downstream servers expose resources/prompts.)

## 4. Tech stack (decided — do not relitigate in v1)

- **Language:** TypeScript, Node 20+, strict mode. ESM.
- **MCP:** `@modelcontextprotocol/sdk` (official TS SDK) for both the server side (gateway) and client side (downstream connections). Before implementation, fetch and skim the SDK README and the MCP spec pages on transports and tools (`https://modelcontextprotocol.io/sitemap.xml`, fetch pages with `.md` suffix).
- **Monorepo:** pnpm workspaces.
- **Validation:** Zod for all config and IR schemas.
- **Storage (local mode):** `better-sqlite3` for the call log and benchmark results. Single file DB per project dir.
- **Storage (hosted mode):** Postgres via Drizzle ORM — users, workspaces, downstream configs, encrypted credentials, compiled surfaces, call log. The storage layer sits behind one repository interface in `packages/db` with SQLite and Postgres drivers, so gateway/core code never knows which mode it's in.
- **Web app:** Next.js (App Router) in `apps/web`. Auth via Auth.js: GitHub OAuth + email magic link. No passwords stored.
- **Secrets at rest:** downstream credentials encrypted with AES-256-GCM using a master key from env (`TOOLC_KMS_KEY`); ciphertext in Postgres, plaintext only in gateway process memory at dispatch time. Never logged, never returned to the browser after save (write-only fields with a "replace" affordance).
- **Selection index:** BM25 (implement in-package or use `minisearch`) over tool name + description + param names. No embedding service dependency in v1; leave an interface seam (`Retriever`) so an embedding retriever can be swapped in later.
- **LLM calls (rewrite pass, judge):** Anthropic SDK. Model IDs and all prompts live in config, never hardcoded.
- **Testing:** Vitest. Every pass ships with unit tests against fixture catalogs. Hosted: integration test that exercises signup → add server → compile → call through endpoint against a fixture downstream.
- **Lint/format:** Biome.
- **Verified setup notes (from a scaffold trial):** add `"types": ["node"]` + `@types/node` at the workspace root or `NodeJS.ProcessEnv`/`process` references fail typecheck under strict `NodeNext`; declare `vitest` as a devDependency in each package that has tests (workspace hoisting alone is not sufficient for `pnpm -r test`).
- **Deploy:** single-region container host (Fly.io or Railway — pick at build time) running two processes: `apps/web` and the hosted gateway. DNS: `toolc.dev` → console, `mcp.toolc.dev` → hosted gateway endpoints. TLS via host platform.

## 5. Repository layout

```
toolc/
├── package.json                  # pnpm workspace root
├── toolc.config.example.jsonc    # annotated example config
├── apps/
│   └── web/                      # toolc.dev console (Next.js): auth, workspace,
│       └── src/                  #   pool mgmt, endpoint page, call-log view
├── packages/
│   ├── db/                       # repository interface + sqlite & postgres drivers,
│   │                             #   Drizzle schema, credential crypto
│   ├── core/                     # IR, frontends, passes, emit. No I/O side effects.
│   │   └── src/
│   │       ├── ir/               # CapabilityGraph types + (de)serialization
│   │       ├── frontend/mcp.ts   # downstream introspection → IR
│   │       ├── passes/           # one file per pass + pass runner
│   │       ├── emit/             # IR → servable tool surface
│   │       └── macros/           # macro types + registry
│   ├── gateway/                  # runtime MCP server (mirror + compiled modes)
│   │   └── src/
│   │       ├── server.ts         # MCP server entry (stdio + streamable HTTP)
│   │       ├── downstream.ts     # connection pool to downstream servers
│   │       ├── router.ts         # dispatch: passthrough | meta-tool | macro
│   │       └── log.ts            # SQLite call logging
│   ├── harness/                  # benchmark runner + grading + report
│   │   └── src/
│   │       ├── runner.ts         # agent loop (Anthropic tool-use loop)
│   │       ├── grade.ts          # programmatic checks + LLM judge
│   │       ├── metrics.ts        # aggregation
│   │       └── report.ts         # markdown + JSON report emit
│   ├── cli/                      # `toolc` command
│   └── shared/                   # config schema, logging, errors
├── tasks/                        # benchmark task suite (YAML, §9)
├── macros/                       # hand-authored macro definitions (TS)
└── docs/
```

Dependency rule: `core` imports nothing from `gateway`/`harness`. `harness` talks to the gateway only over MCP (spawns it as a subprocess or connects over HTTP) — the harness must measure the real thing, not an in-process shortcut.

## 6. Core components — detailed spec

### 6.1 Config (`toolc.config.jsonc`)

Single source of truth, Zod-validated. Shape (illustrative, finalize in `packages/shared`):

```jsonc
{
  "project": "aiera-bench",
  "downstream": [
    {
      "id": "aiera",
      "transport": { "type": "http", "url": "https://mcp-pub.aiera.com", "headers": { "Authorization": "Bearer ${AIERA_TOKEN}" } }
    },
    {
      "id": "github",
      "transport": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }
    },
    {
      "id": "fs",
      "transport": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "./sandbox"] }
    }
  ],
  "compile": {
    "passes": ["dead-tool", "rewrite", "macro-inline", "selection"],
    "deadTool": { "exclude": ["aiera:debug_auth", "aiera:ping", "github:*_enterprise_*"], "include": null },
    "rewrite": { "model": "claude-sonnet-4-6", "cachePath": ".toolc/rewrites.json", "reviewMode": true },
    "selection": { "pinned": ["search_tools", "call_tool"], "alwaysVisible": [], "topK": 8 }
  },
  "serve": { "mode": "compiled", "transport": "stdio", "logDb": ".toolc/calls.db" },
  "bench": { "model": "claude-sonnet-4-6", "judgeModel": "claude-opus-4-8", "maxTurns": 25, "tasksDir": "./tasks", "trials": 3 }
}
```

`${VAR}` interpolation from environment. Fail fast with actionable errors on missing vars.

### 6.2 IR: the Capability Graph (`packages/core/src/ir`)

Normalized, source-agnostic representation. Everything downstream of the frontend operates only on this.

```ts
interface CapabilityGraph {
  sources: SourceInfo[];              // downstream server metadata + catalog hash
  tools: ToolNode[];
  edges: DataEdge[];                  // v1: populated only by macro definitions
  version: string;                    // content hash of the graph, for cache keys
}

interface ToolNode {
  id: string;                         // "sourceId:toolName", globally unique
  source: string;                     // sourceId; "toolc" for synthesized tools
  name: string;                       // name as exposed downstream
  description: string;                // ORIGINAL description, never mutated
  inputSchema: JsonSchema;            // as introspected
  annotations?: ToolAnnotations;      // readOnly/destructive hints if provided
  overlays: {                         // pass output attaches here, original preserved
    description?: string;             // rewritten description (rewrite pass)
    hidden?: boolean;                 // dead-tool / selection passes
    hiddenReason?: string;
  };
  kind: "passthrough" | "macro" | "meta";
}

interface DataEdge {                  // "output of A feeds input of B"
  from: string; fromField: string;    // JSONPath into from-tool output
  to: string;   toField: string;
  via: "macro" | "mined";            // "mined" reserved for v2 PGO
}
```

Design constraints: (a) original catalog data is immutable — all pass effects are overlays, so `mirror` mode and diffing are always possible; (b) the graph serializes to JSON deterministically (stable key order) so `version` hashes are reproducible; (c) nothing in the IR references MCP SDK types directly — frontends adapt in, emit adapts out. This is what keeps the OpenAPI frontend addable without touching passes.

### 6.3 Frontend: MCP introspection (`packages/core/src/frontend/mcp.ts`)

Connect to each downstream server as an MCP client, call `tools/list` (paginate fully), normalize into `ToolNode`s. Record server info (name, version, instructions if provided) in `SourceInfo`. Handle: duplicate tool names across servers (namespace by `sourceId:`), servers that fail to connect (hard error by default; `--skip-unavailable` flag for dev), and catalog drift (store catalog hash; `toolc compile` warns when downstream catalogs changed since last compile).

### 6.4 Passes (`packages/core/src/passes`)

Passes are pure functions `(graph: CapabilityGraph, config, ctx) => CapabilityGraph` run in configured order by a pass runner that logs a diff summary per pass (tools hidden, descriptions rewritten, macros added). Each pass has unit tests against fixture catalogs in `packages/core/test/fixtures/`.

**Pass 1 — `dead-tool` (dead code elimination).** v1 is config-driven: glob-style include/exclude lists over tool ids. Sets `overlays.hidden = true` with reason `"config-exclude"`. (v2: log-driven — hide tools with zero calls over a traffic window.) Also auto-hide obvious noise: tools matching `ping|debug|health` unless explicitly included.

**Pass 2 — `rewrite` (description optimization).** For each visible tool, generate an improved description via LLM: enforce ≤ 320 chars for the summary line, imperative voice, explicit disambiguation against sibling tools ("use X instead when…"), parameter guidance folded into schema field descriptions where the original relied on prose. Mechanics: batch tools per source into one prompt with the full sibling context; cache results in `rewrites.json` keyed by `(toolId, originalDescriptionHash, promptVersion)` so recompiles are free and diffs are reviewable; when `reviewMode: true`, write proposed rewrites to the cache file and require a human-edited `"approved": true` flag before they take effect. The pass must be a no-op if the Anthropic API is unavailable (fall back to originals, warn).

**Pass 3 — `macro-inline` (synthesis via hand-authored macros).** Macros are TypeScript modules in `/macros`, registered by the compile step:

```ts
export const getLatestEarningsDiscussion = defineMacro({
  name: "get_latest_earnings_discussion",
  description: "Given a stock ticker and a topic, returns what management said about that topic on the company's most recent earnings call. Single call; replaces the find-company → find-events → get-transcript → search chain.",
  inputSchema: z.object({ ticker: z.string().describe("e.g. INTC"), topic: z.string() }),
  steps: async (input, call) => {
    const events = await call("aiera:find_events", { bloomberg_ticker: `${input.ticker}:US`, /* recent window */ });
    const eventId = pickLatest(events);
    return call("aiera:search_transcripts", { event_ids: [eventId], query_text: input.topic });
  },
});
```

`call(toolId, args)` invokes downstream tools through the same router the gateway uses (so macro steps appear in the call log, tagged with the macro invocation id). The pass adds each macro as a `ToolNode{kind:"macro", source:"toolc"}` and hides the chain's constituent tools from the default surface *only if* config says so (`hideInlined: false` by default — comprehensive coverage still matters). v1 ships with 3–5 macros written against the benchmark federation (§8).

**Pass 4 — `selection` (surface pruning via meta-tools).** The compiled surface exposed to the client is: pinned meta-tools + macros + `alwaysVisible` tools. Everything else is reachable only through the meta-tools:

- `search_tools(query: string, top_k?: number)` → BM25 over visible (non-hidden) tools' rewritten name/description/param text. Returns full tool definitions (name, description, input schema) for the top hits, so the model can call them next without another round trip.
- `call_tool(name: string, arguments: object)` → validates args against the target tool's schema (Zod-from-JSON-Schema), dispatches through the router, returns the result. Invalid-args errors must echo the expected schema and a corrected-call example (actionable errors).

This is the token play: a 200-tool federation presents ~6–10 definitions instead of 200. Record in the IR which tools are surfaced vs. searchable so the benchmark can report context-size numbers precisely.

### 6.5 Gateway runtime (`packages/gateway`)

An MCP server (stdio and streamable HTTP; stateless JSON for HTTP) that serves either mode:

- **mirror:** exposes every downstream tool verbatim (namespaced `sourceId__toolName` to avoid collisions — note the benchmark baseline uses this, so keep it faithful: original descriptions, original schemas).
- **compiled:** serves the emitted surface from `.toolc/compiled.json` (output of `toolc compile`).

Router responsibilities: maintain persistent client connections to downstream servers with lazy connect + reconnect-with-backoff; dispatch passthrough/meta/macro calls; enforce a per-call timeout (config, default 60s); never let one downstream failure crash the gateway — return an MCP tool error with the downstream error message wrapped and the source identified.

**Call log (SQLite), one row per tool invocation:**

```sql
CREATE TABLE calls (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,                  -- ISO8601
  session_id TEXT,                   -- gateway process/session
  run_id TEXT,                       -- benchmark run id, null in normal serving
  task_id TEXT,                      -- benchmark task id, null otherwise
  surface TEXT NOT NULL,             -- 'mirror' | 'compiled'
  tool_id TEXT NOT NULL,             -- IR tool id, or 'toolc:search_tools' etc.
  parent_call_id INTEGER,            -- set for macro-internal steps
  args_json TEXT NOT NULL,
  result_bytes INTEGER,
  is_error INTEGER NOT NULL,
  error_text TEXT,
  latency_ms INTEGER NOT NULL
);
```

This schema is the seed of the entire future observability/PGO product — keep it boring and complete.

### 6.6 CLI (`packages/cli`)

- `toolc compile` — introspect downstreams, run passes, write `.toolc/compiled.json` + a human-readable compile report (tools in/out, per-pass diff, estimated context tokens for surfaced definitions).
- `toolc serve --mode mirror|compiled` — run the gateway.
- `toolc inspect` — print the current surface as a table; `--tool <id>` for full detail incl. original vs. rewritten description.
- `toolc bench --tasks ./tasks --conditions raw,compiled --trials 3` — run the benchmark (§9) and emit the report.

## 7. Hosted platform — toolc.dev console

The console is deliberately thin: every capability it exposes is a tenant-scoped invocation of `core` + `gateway`. Web-specific code should be UI, auth, and persistence only.

### 7.1 Tenancy model

`User` → `Workspace` (v1: one per user, auto-created at signup; schema supports many) → `DownstreamServer[]` (the pool) → one `CompiledSurface` → one live endpoint. All Postgres rows carry `workspace_id`; every gateway request resolves to exactly one workspace before anything else happens.

### 7.2 Console pages (complete v1 page list)

1. **Auth** — GitHub OAuth + email magic link (Auth.js). Invite-code gate on signup (env-configured list) so the beta stays controllable.
2. **Dashboard** — pool summary (servers, tool counts, compile status), endpoint card, last-24h call count.
3. **Add / edit server** — fields: display name, URL (streamable HTTP only — the UI must say plainly that stdio servers are local-CLI-only), auth headers (key/value rows; values write-only after save, with a Replace affordance). On save: **Test connection** runs frontend introspection and shows tool count + first N tool names, or an actionable error. A server that fails introspection can be saved as `disabled` but never enters the compiled surface.
4. **Compile settings** — per-pass toggles (dead-tool, rewrite, selection; macro pass hidden in hosted v1), exclude-list editor (tool-id globs with live preview of what gets hidden), `topK` for search_tools. A visible **Recompile** button; compile runs as an async job with status (queued → introspecting → passes → live) and a per-pass diff summary on completion — the compile report from §6.6, rendered.
5. **Endpoint page** — the payoff screen. Shows the endpoint URL, surfaced-tool table (name, one-line description, origin: passthrough/meta), estimated context-token footprint of the surface vs. the raw pool (the "your 143 tools became 9 definitions" moment), and copy-paste setup blocks per client (§7.4). Secret-rotation button (invalidates old URL immediately, confirm dialog).
6. **Logs** — paginated table over `calls` (§6.5): time, tool, latency, ok/error, result size. Filter by tool and error. Raw table only; no charts in v1.
7. **Settings / danger zone** — rename workspace, toggle argument logging (default on, plainly documented), delete workspace (cascades: credentials, surface, logs).

### 7.3 Endpoint provisioning and inbound auth

Per-workspace endpoint: `https://mcp.toolc.dev/w/{workspace_id}/{endpoint_secret}/mcp` — streamable HTTP, stateless JSON, serving the compiled surface only (no hosted mirror mode; mirror stays a local/benchmark concern).

Why a secret-in-URL scheme: several mainstream clients let users paste only a URL for a remote MCP server (no custom headers), so the credential must be URL-carried to be universally connectable — the same pattern established hosted-MCP products use. Mitigations, all required: secrets are 256-bit, URLs are never logged in full by our own infra (log `workspace_id` + secret prefix), rotation is one click, and docs tell users to treat the URL as a credential. Additionally accept `Authorization: Bearer {endpoint_secret}` against a secretless URL form for clients that do support headers.

**OAuth 2.1 is the first fast-follow, not v1** — but reserve for it now: route namespace for `/.well-known/oauth-protected-resource` on `mcp.toolc.dev`, and an `auth_mode` column on workspaces (`secret_url` | `oauth`). Client support for OAuth-only connectors is growing (ChatGPT connectors in particular); do not architect the endpoint handler in a way that assumes secret-URL forever.

### 7.4 Client setup blocks (endpoint page, auto-populated, copy buttons)

- **Claude (web / desktop / mobile):** Settings → Connectors → Add custom connector → paste endpoint URL.
- **Claude Code:** `claude mcp add --transport http toolc {endpoint_url}`
- **ChatGPT:** Settings → Connectors (developer mode) → Add MCP server → paste endpoint URL. Include a note that ChatGPT connector availability varies by plan.
- **Cursor:** `~/.cursor/mcp.json` snippet with `"url": "{endpoint_url}"`.

Verify each snippet against the live client at M6 — client UIs move; the endpoint page is generated from a single `clients.ts` descriptor so updates are one-file.

### 7.5 Hosted compile lifecycle

Compile triggers: pool change (add/remove/edit server), settings change, manual Recompile. Jobs run in-process with a simple queue (one active compile per workspace; latest request wins). The rewrite pass in hosted mode runs with `reviewMode: false` (auto-apply) but the compile report shows original→rewritten diffs per tool; users who distrust it disable the pass. Catalog drift: on each compile, downstream catalog hashes are stored; the dashboard shows a "downstream changed since last compile" badge by re-introspecting lazily (on dashboard load, throttled) rather than polling.

### 7.6 Hosted security requirements (blocking for public beta)

1. **SSRF defense** on user-supplied downstream URLs: resolve DNS, reject private/link-local/metadata ranges (RFC1918, 169.254.0.0/16, ::1, etc.), re-verify at connect time (DNS-rebinding guard), https-only.
2. **Credential handling** per §4: AES-256-GCM at rest, write-only from the browser, decrypt only in gateway memory at dispatch.
3. **Isolation:** downstream requests carry only that workspace's headers; a workspace's compile job and connection pool must be keyed by `workspace_id` end to end. Integration test: two workspaces, same downstream URL, different tokens — assert no bleed.
4. **Limits:** per-workspace rate limit on the endpoint (config, default 60 calls/min), request body cap (1 MB), result-size cap with truncation marker (256 KB), per-call timeout (60 s), max 10 downstream servers per workspace.
5. **Log hygiene:** `args_json` truncated at 8 KB; argument logging toggleable per workspace; endpoint secrets never in any log line.

### 7.7 Open-core and license boundary (write this into the README, verbatim in spirit)

- **The engine is Apache-2.0, forever:** `core`, `gateway`, `cli`, `harness`, and the SQLite driver. Anyone can compile and serve their own tool surfaces locally, free, with no signup, with the exact same compilation quality as the hosted product. This is the trust contract and it is not revisited.
- **The console (`apps/web`, Postgres driver, deployment glue) is open today** and self-hostable via the provided `docker-compose.yml`. The README states plainly: *"toolc's engine is Apache-2.0 forever. The console is open source today; future enterprise features (SSO/SAML, RBAC, policy engine, audit export) will live in a separately licensed `ee/` directory."* Declaring the movable line now — while there is nothing behind it — is what keeps later fencing from feeling like a rug-pull.
- **The `ee/` directory does not exist in v1.** Create it only when the first enterprise feature does, with its own LICENSE file at that time.
- The hosted *service* at toolc.dev monetizes operations, not code: always-on endpoint, credential custody, hosted compile, zero ops. Free invite beta in v1; pricing is a post-benchmark decision.

## 8. Benchmark federation (v1)

Chosen for: one server we control end-to-end and know deeply, one large well-built catalog, one deliberately noisy/mediocre surface (the "we fix bad servers" demo requires a bad server), and one local/deterministic server for stable tasks.

1. **Aiera MCP** (`https://mcp-pub.aiera.com`) — production financial-research server, ~50 tools, real multi-hop chains (find → get → search patterns). The Aiera Lift methodology transfers directly. Use read-only tools in tasks.
2. **GitHub MCP server** — large catalog (dozens of tools), well-known, good stress test for selection; plenty of read-only task material against public repos.
3. **Filesystem reference server** (`@modelcontextprotocol/server-filesystem`) pointed at a fixture directory checked into the repo — fully deterministic tasks, useful for grading stability.
4. **One "bad" server** — pick or build a thin OpenAPI-auto-generated MCP wrapper (e.g., around a public weather or reference-data API) with verbose, undifferentiated tool descriptions. If nothing suitable exists off the shelf, generate one with an existing openapi-to-mcp converter and *do not* hand-tune it: its badness is the point. The rewrite pass's before/after on this server is a headline demo.

Target combined catalog: **120–200 tools** across the federation. If under 120, add a second large public server rather than padding artificially.

## 9. Task suite (`/tasks/*.yaml`)

~30 tasks, 3 trials each per condition. Every task is read-only, independent, and machine-checkable. Format:

```yaml
id: aiera-chain-03
category: cross-server-chain        # see categories below
prompt: >
  What did Intel's management say about foundry customer commitments
  on their most recent earnings call? Answer in 2-3 sentences.
grading:
  type: judge                       # 'exact' | 'contains' | 'judge'
  rubric: >
    Correct iff the answer reflects statements from Intel's latest earnings
    call transcript about foundry/external customer commitments. Reject
    answers based on general knowledge without transcript evidence.
  reference: null                   # optional gold answer for judge context
expected_tools: ["aiera:find_events", "aiera:search_transcripts"]  # informational, not enforced
timeout_turns: 25
```

**Category mix (approximate):**
- `single-tool` (8 tasks) — one obvious tool answers it. Tests that compilation doesn't *hurt* easy cases.
- `ambiguous-selection` (7) — multiple plausible tools exist; the naive catalog invites the wrong one (e.g., find_events vs. search_transcripts vs. find_filings confusions; GitHub search vs. list confusions). This is where the rewrite + selection passes should shine.
- `cross-server-chain` (7) — requires composing 3+ calls, at least 2 spanning servers where sensible. Macro-covered chains and non-macro chains both included (to measure macro lift specifically vs. general lift).
- `needle` (5) — retrieve a specific verifiable fact (filesystem fixtures, specific GitHub repo facts, specific Aiera metadata) — graded `exact`/`contains`.
- `no-tool-exists` (3) — the honest-failure cases: tasks no federated tool can answer. Correct behavior is saying so. Tests whether a big raw catalog induces flailing/hallucinated capability, and whether the compiled surface degrades gracefully.

Authoring protocol (per mcp-builder evaluation guidance): explore the live servers read-only, draft each task, *solve it yourself* to verify the answer is stable and reachable, then freeze. Tasks whose answers drift with live data (e.g., "most recent earnings call") must pin the expectation via rubric wording or a `reference` snapshot date, and get re-verified before each published benchmark run.

## 10. Harness (`packages/harness`)

**Conditions.** A condition = (surface, model). v1 conditions:
- `raw` — agent connects to the gateway in **mirror** mode: all tools, original descriptions. This approximates today's "connect N servers" reality while keeping transport/latency identical between conditions (fair comparison — the gateway hop exists in both).
- `compiled` — full pass pipeline.
- Ablations (run after the headline works): `compiled-no-macros`, `compiled-no-rewrite`, `compiled-no-selection`. Each isolates one pass's contribution — this is the section of the report that makes it a *paper* rather than a pitch.

**Runner.** For each (task, condition, trial): spawn/connect the gateway in the right mode, run a standard Anthropic tool-use loop (system prompt held constant and minimal; tools from `tools/list`; loop until final answer, `timeout_turns`, or hard error), recording per-turn: input/output token counts from API usage fields, tool calls made, wall time. Tag all gateway log rows with `run_id`/`task_id`. Persist full transcripts to `.toolc/bench/<run_id>/` for audit.

**Grading.** `exact`/`contains` graded programmatically. `judge` graded by the judge model with the rubric, the task, and the final answer only (no transcript — judge the answer, not the effort); judge returns `{pass: boolean, reason: string}`. Judge prompts versioned in-repo. Spot-check protocol: human-review 20 random judge decisions before publishing any numbers.

**Metrics (per condition, aggregated over tasks × trials):**
- **Task success rate** (headline #1) with 95% CI (bootstrap).
- **Cost per completed task** (headline #2): total API cost of the condition ÷ successful completions. Price table in config.
- Mean tokens per task (in/out split); mean tool calls per task; wrong-tool rate (tool calls that error or are abandoned — heuristic: error results + calls whose output is never referenced); turns to completion; context overhead of tool definitions (measured: tokens in the tools array); latency added by gateway (from log, compiled passthrough calls only).
- Per-category breakdowns of all of the above.

**Report.** `toolc bench` emits `report.json` (full data) and `report.md`: headline table, per-category table, ablation table, methodology section auto-populated (models, dates, trial counts, federation catalog hashes), and a limitations section stub to be hand-finished. The markdown report is written to be publishable with light editing — Aiera-Lift style.

## 11. Milestones

Sequenced so something runs end-to-end early; each milestone is a working state, not a layer.

- **M0 — Scaffold (day 1):** monorepo, workspaces, config schema + loader, CI (typecheck, lint, test), fixture catalogs for pass tests.
- **M1 — Mirror gateway (days 2–4):** frontend introspection → IR → mirror mode serving over stdio, against filesystem + one HTTP downstream. Call logging live. Verify with MCP Inspector (`npx @modelcontextprotocol/inspector`) and a real Claude session. **Exit test:** Claude completes a filesystem task through the gateway; calls appear in SQLite.
- **M2 — Compile pipeline (days 5–9):** IR overlays, pass runner, all four passes, `toolc compile` + compile report, macro registry with 2 macros. **Exit test:** compiled mode serves ≤ 12 surfaced definitions from a 100+-tool federation; `search_tools` retrieves correct tools for 10 hand-written probe queries; macros round-trip against live Aiera.
- **M3 — Harness (days 10–14):** runner, grading, metrics, report. **Exit test:** 5-task smoke suite runs raw vs. compiled end-to-end and emits a coherent report with plausible numbers.
- **M4 — Full benchmark (days 15–20):** author + verify all ~30 tasks, add remaining macros, run full grid incl. ablations, human-review judge decisions, produce the publishable report. **Exit test:** the report exists, the numbers are defensible, and the repo can be made public without embarrassment.
- **M5 — Hosted console (days 21–27):** `packages/db` (repository interface, Drizzle schema, credential crypto, both drivers), `apps/web` pages 1–7 (§7.2), hosted gateway mode (workspace resolution, secret-URL auth, per-workspace pools), compile job queue, SSRF guard. **Exit test:** the two-workspace isolation test passes; a fresh user can sign up, add the Aiera + GitHub servers, compile, and complete a task from Claude via their endpoint URL with zero shell access.
- **M6 — Deploy + beta (days 28–30):** deploy web + hosted gateway to the chosen host, wire `toolc.dev` / `mcp.toolc.dev` DNS + TLS, verify every §7.4 client snippet against live clients, ship `docker-compose.yml` + `docs/self-hosting.md` (§2.1), invite 5–10 beta users. **Exit test:** an external beta user connects from Claude *and* ChatGPT without help; §7.6 checklist fully green; a clean machine can `docker compose up` the full self-hosted stack from the docs alone.

Sequencing note: M1–M4 before M5 is deliberate — the benchmark validates the engine the console wraps, and the published numbers are what make beta invites land. If calendar pressure forces a cut, cut M4's ablations, never M5's security checklist.

## 12. Definition of done (v1)

1. `toolc serve --mode compiled` runs against the 4-server federation and works as a drop-in MCP server in Claude (desktop config snippet in README).
2. `toolc bench` reproduces the full benchmark from a clean checkout given API keys.
3. The benchmark report shows raw vs. compiled with success rate + cost-per-completed-task headline, per-category and ablation breakdowns, and honest limitations.
4. Every pass has unit tests; harness has a smoke suite in CI (mocked LLM, real gateway).
5. README states the thesis in one paragraph, shows the headline table, and documents the open-core boundary (§7.7).
6. toolc.dev is live: signup → pool → compiled endpoint works end-to-end from Claude and ChatGPT; §7.6 security checklist complete; the two-workspace isolation test runs in CI.
7. `packages/db` is the only module that knows whether it's talking to SQLite or Postgres (§2.1 invariant 2 — grep-clean).
8. Engine-parity CI guard exists: the smoke benchmark runs against local and hosted-mode gateways with statistically identical results (§2.1 invariant 1).
9. `docker compose up` brings up the full self-hosted stack on a clean machine using only `docs/self-hosting.md`.

## 13. Risks & watch items (carry into the report's limitations section)

- **Judge circularity:** grading Claude with Claude. Mitigations: different model tier for judge, programmatic grading wherever possible, published transcripts, human spot-check protocol.
- **Baseline fairness:** mirror mode must be genuinely faithful (original descriptions/schemas). Any deviation invalidates the headline. Diff-test mirror output against direct downstream introspection in CI.
- **Live-data drift:** Aiera/GitHub tasks can rot. Re-verify before publishing; prefer pinned fixtures where possible.
- **Client-native tool search:** model clients are adding native tool-search. The report should measure and argue the parts that survive it (macros, rewrite, cross-server audit) — ablations exist precisely to show where the lift comes from.
- **Credential custody:** the hosted product holds users' downstream tokens — a breach is existential for trust. §7.6 items are release-blocking, and the beta stays invite-gated until they're verified. Self-hosting docs are the pressure valve for security-sensitive users (the OSS gateway runs anywhere).
- **Secret-URL auth is interim:** acceptable for beta; some clients are moving to OAuth-only for remote MCP. The §7.3 reservations exist so the fast-follow is additive, not a rewrite.
- **Overfitting macros to the task suite:** macros must be justified by real workflow patterns (document the provenance of each), and the report separates macro-covered from non-macro chain tasks.

## 14. Open questions (decide during build, defaults given)

- Namespacing separator for mirror mode (`__` default; some clients dislike `:` in tool names — verify against Claude and Inspector early).
- `search_tools` result count default (`top_k=5`) and whether results auto-pin for the session (default: no).
- Whether `no-tool-exists` tasks count toward headline success (default: yes — refusing correctly is success).
- Report cost table source (default: hardcode current Anthropic list prices with a date stamp).
- Hosted compile-job runner: in-process queue vs. separate worker (default: in-process; revisit if compile times exceed ~30 s).
- ~~OSS license~~ — resolved: Apache-2.0 for the engine, console open with declared `ee/` boundary (§7.7).
- Whether the hosted endpoint also exposes `mirror` mode for user A/B curiosity (default: no — keeps the hosted story simple and the surface singular).

## 15. Immediate next actions for Claude Code

1. Read this spec fully. Fetch MCP TS SDK README + MCP spec transport/tools pages.
2. Initialize the repo (git, pnpm workspace per §5), grab the `toolc` GitHub org/npm names if not already claimed, then execute M0. Commit.
3. Execute M1 against filesystem server only; demo through MCP Inspector; then add one HTTP downstream.
4. Pause for human review of the IR types and config schema before starting M2 — these are the two interfaces everything else hangs off.
5. Before starting M5, pause for human review of the Drizzle schema and the §7.3 endpoint/auth design — the second pair of load-bearing interfaces.
