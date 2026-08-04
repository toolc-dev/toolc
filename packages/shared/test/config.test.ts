import { describe, expect, it } from "vitest";
import { ConfigError, interpolateEnv, parseConfig } from "../src/index.js";

const MINIMAL = `{
  // comment to prove JSONC works
  "project": "t",
  "downstream": [
    { "id": "fs", "transport": { "type": "stdio", "command": "npx", "args": ["x"] } },
  ],
}`;

describe("parseConfig", () => {
  it("parses minimal JSONC with comments and trailing commas, applying defaults", () => {
    const cfg = parseConfig(MINIMAL, {});
    expect(cfg.project).toBe("t");
    expect(cfg.serve.mode).toBe("compiled");
    expect(cfg.serve.callTimeoutMs).toBe(60_000);
    expect(cfg.compile.passes).toEqual(["dead-tool", "rewrite", "macro-inline", "selection"]);
    expect(cfg.compile.selection.topK).toBe(8);
    expect(cfg.bench.trials).toBe(3);
  });

  it("interpolates ${VAR} from env", () => {
    const cfg = parseConfig(
      `{
        "project": "t",
        "downstream": [
          { "id": "a", "transport": { "type": "http", "url": "https://x.test", "headers": { "Authorization": "Bearer \${TOK}" } } }
        ]
      }`,
      { TOK: "secret123" },
    );
    const t = cfg.downstream[0]!.transport;
    expect(t.type).toBe("http");
    if (t.type === "http") expect(t.headers?.Authorization).toBe("Bearer secret123");
  });

  it("fails fast on missing env vars with the config path", () => {
    expect(() =>
      parseConfig(
        `{"project":"t","downstream":[{"id":"a","transport":{"type":"http","url":"https://x.test","headers":{"A":"\${NOPE}"}}}]}`,
        {},
      ),
    ).toThrow(/NOPE/);
  });

  it("rejects duplicate downstream ids", () => {
    expect(() =>
      parseConfig(
        `{"project":"t","downstream":[
          {"id":"a","transport":{"type":"stdio","command":"x"}},
          {"id":"a","transport":{"type":"stdio","command":"y"}}
        ]}`,
        {},
      ),
    ).toThrow(/duplicate/);
  });

  it("rejects invalid downstream ids and bad urls", () => {
    expect(() =>
      parseConfig(
        `{"project":"t","downstream":[{"id":"Bad Id","transport":{"type":"stdio","command":"x"}}]}`,
        {},
      ),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig(
        `{"project":"t","downstream":[{"id":"a","transport":{"type":"http","url":"not-a-url"}}]}`,
        {},
      ),
    ).toThrow(ConfigError);
  });

  it("rejects malformed JSONC", () => {
    expect(() => parseConfig("{ nope", {})).toThrow(/JSONC/);
  });
});

describe("interpolateEnv", () => {
  it("walks nested structures and leaves non-strings alone", () => {
    const out = interpolateEnv({ a: ["${X}", 1, null], b: { c: "${X}${X}" } }, { X: "v" });
    expect(out).toEqual({ a: ["v", 1, null], b: { c: "vv" } });
  });
});
