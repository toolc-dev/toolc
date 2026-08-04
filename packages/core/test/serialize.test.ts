import { describe, expect, it } from "vitest";
import {
  contentHash,
  deserializeGraph,
  graphVersion,
  serializeGraph,
  stableStringify,
} from "../src/ir/serialize.js";
import { fixtureFederationGraph } from "./fixtures/index.js";

describe("stableStringify", () => {
  it("is insensitive to key order at any depth", () => {
    const a = { x: 1, y: { b: 2, a: [{ q: 1, p: 2 }] } };
    const b = { y: { a: [{ p: 2, q: 1 }], b: 2 }, x: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array order", () => {
    expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]));
  });
});

describe("graph versioning + round-trip", () => {
  it("produces a stable version hash for identical content", () => {
    const g1 = fixtureFederationGraph();
    const g2 = fixtureFederationGraph();
    expect(g1.version).toBe(g2.version);
    expect(g1.version).toBe(graphVersion(g1));
  });

  it("changes the hash when content changes", () => {
    const g = fixtureFederationGraph();
    const mutated = {
      ...g,
      tools: g.tools.map((t, i) => (i === 0 ? { ...t, overlays: { hidden: true } } : t)),
    };
    expect(graphVersion(mutated)).not.toBe(g.version);
  });

  it("round-trips through serialize/deserialize", () => {
    const g = fixtureFederationGraph();
    const back = deserializeGraph(serializeGraph(g));
    expect(back).toEqual(g);
    expect(serializeGraph(back)).toBe(serializeGraph(g));
  });

  it("contentHash is deterministic", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });
});
