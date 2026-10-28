import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { catalogCoverage, loadBundledCatalog, validateCatalog } from "../../src/sources/catalog.ts";

const raw = () => JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../catalog/skills.json"), "utf8"));

describe("bundled catalog (FR-015, FR-016)", () => {
  it("validates and meets the coverage gate", () => {
    const cov = catalogCoverage(loadBundledCatalog());
    expect(cov.entries).toBeGreaterThanOrEqual(20);
    expect(cov.categories.length).toBeGreaterThanOrEqual(8);
    expect(cov.publishers.length).toBeGreaterThanOrEqual(4);
    for (const c of Object.values(cov.baseline)) expect(c.candidates).toBeGreaterThan(0);
  });
  it("records provenance, license evidence, and verification date for every entry", () => {
    for (const e of loadBundledCatalog().entries) {
      expect(e.source.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(e.license.spdx).toBeTruthy();
      expect(e.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it.each([
    ["unknown field", (c: { entries: Record<string, unknown>[] }) => { c.entries[0]!.trusted = true; }],
    ["id mismatch", (c: { entries: Record<string, unknown>[] }) => { c.entries[0]!.id = "x/y#z"; }],
    ["abbreviated commit", (c: { entries: { source: { commit: string } }[] }) => { c.entries[0]!.source.commit = "abc123"; }],
    ["path traversal", (c: { entries: { source: { skillPath: string } }[] }) => { c.entries[0]!.source.skillPath = "skills/../etc"; }],
    ["name/dir mismatch", (c: { entries: { name: string }[] }) => { c.entries[0]!.name = "different-name"; }],
    ["unknown task tag", (c: { entries: { tasks: string[] }[] }) => { c.entries[0]!.tasks = ["make-coffee"]; }],
    ["duplicate entry", (c: { entries: unknown[] }) => { c.entries.push(c.entries[0]); }],
  ])("rejects %s", (_n, mutate) => {
    const c = raw();
    mutate(c);
    expect(validateCatalog(c).catalog).toBeNull();
  });
});
