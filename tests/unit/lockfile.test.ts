import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readLockfile, serializeLockfile, type LockEntry } from "../../src/storage/lockfile.ts";

const entry = (sourceId: string, agent: "claude-code" | "codex"): LockEntry => ({
  sourceId, agent, name: "x", installPath: `${agent === "codex" ? ".agents" : ".claude"}/skills/x`,
  source: { provider: "github", owner: "a", repository: "b", skillPath: "x", commit: "c".repeat(40) },
  license: { spdx: "MIT", files: ["LICENSE"] }, payloadDigest: `sha256:${"1".repeat(64)}`, files: [], ruleSet: "rules-v1",
  findingsSummary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, acknowledged: [],
  planDigest: `sha256:${"2".repeat(64)}`, installedAt: "2026-10-28T12:00:00.000Z", toolVersion: "0.1.0",
});

async function withLock(content: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sp-lock-"));
  await mkdir(path.join(root, ".skillpilot"));
  await writeFile(path.join(root, ".skillpilot/lock.json"), content);
  return readLockfile(root);
}

describe("lockfile (spec 12.3)", () => {
  it("serializes deterministically, sorted by source ID then target", () => {
    const a = serializeLockfile([entry("b/b#x", "codex"), entry("a/a#x", "codex"), entry("a/a#x", "claude-code")]);
    const b = serializeLockfile([entry("a/a#x", "claude-code"), entry("b/b#x", "codex"), entry("a/a#x", "codex")]);
    expect(a.equals(b)).toBe(true);
    expect(JSON.parse(a.toString()).entries.map((e: LockEntry) => `${e.sourceId}:${e.agent}`)).toEqual(["a/a#x:claude-code", "a/a#x:codex", "b/b#x:codex"]);
  });

  it("round-trips and rejects malformed, unknown-version, and unknown-key lockfiles", async () => {
    const good = serializeLockfile([entry("a/a#x", "codex")]).toString();
    expect(await withLock(good)).toMatchObject({ state: "present", lock: { entries: [{ sourceId: "a/a#x" }] } });
    for (const bad of ["{", JSON.stringify({ schemaVersion: 2, entries: [] }), JSON.stringify({ schemaVersion: 1, entries: [], extra: 1 }), JSON.stringify({ schemaVersion: 1, entries: [{ ...entry("a/a#x", "codex"), installPath: undefined }] })]) {
      await expect(withLock(bad)).rejects.toMatchObject({ code: "INVALID_SCHEMA" });
    }
  });
});
