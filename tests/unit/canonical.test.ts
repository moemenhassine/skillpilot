import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, domainDigest } from "../../src/storage/canonical.ts";

const vectors = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../fixtures/golden/canonical-vectors.json"), "utf8")) as { domain: string; value: unknown; canonical: string; digest: string }[];

describe("canonical JSON and digests (spec 12.2, NFR-003)", () => {
  it.each(vectors)("golden vector $canonical", (v) => {
    expect(canonicalJson(v.value)).toBe(v.canonical);
    expect(domainDigest(v.domain, v.value)).toBe(v.digest);
  });
  it("is independent of key order and separates domains", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    expect(domainDigest("skillpilot-plan-v1", { a: 1 })).not.toBe(domainDigest("skillpilot-payload-v1", { a: 1 }));
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson({ n: Infinity })).toThrow();
  });
});
