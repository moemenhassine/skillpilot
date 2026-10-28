import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubClient } from "../../src/fetcher/github.ts";
import { loadBundledCatalog } from "../../src/sources/catalog.ts";
import { candidatesFromRepo, discoverRepository, loadSources, readRepoCache } from "../../src/sources/discovery.ts";
import { fixtureTransport, recorded, skillMd, syntheticRepo } from "../helpers/github.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
const noSleep = { sleep: async () => {} };
const tmp = () => mkdtemp(path.join(os.tmpdir(), "skillpilot-cache-"));

describe("repository discovery (FR-011)", () => {
  it("discovers skills from recorded supabase/agent-skills responses", async () => {
    const { transport, urls } = fixtureTransport(recorded("supabase-agent-skills"));
    const repo = await discoverRepository(new GitHubClient(transport, noSleep), "supabase/agent-skills", NOW);
    expect(repo.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.licenseSpdx).toBe("MIT");
    expect(repo.skills.map((s) => s.skillPath)).toEqual(["skills/supabase-postgres-best-practices", "skills/supabase"]);
    expect(repo.invalid).toEqual([]);
    // NFR-001: only the fixed API host and the repository identifier leave the machine.
    for (const u of urls) {
      expect(u.hostname).toBe("api.github.com");
      expect(u.pathname.startsWith("/repos/supabase/agent-skills")).toBe(true);
    }
    const cands = candidatesFromRepo(repo);
    expect(cands.every((c) => c.annotationOrigin === "derived-from-metadata" && c.prerequisites === null)).toBe(true);
    expect(cands.find((c) => c.name === "supabase-postgres-best-practices")!.tasks).toContain("database");
  });

  it("only enumerates supported roots and rejects mismatched names", async () => {
    const responses = syntheticRepo("acme/kit", {
      "skills/good/SKILL.md": skillMd("good"),
      "skills/wrong-dir/SKILL.md": skillMd("other-name"),
      "deep/nested/skills/hidden/SKILL.md": skillMd("hidden"),
      ".claude/skills/local/SKILL.md": skillMd("local"),
      "skills/bad/SKILL.md": "---\nname: bad\nname: bad\ndescription: x\n---\n",
    });
    const repo = await discoverRepository(new GitHubClient(fixtureTransport(responses).transport, noSleep), "acme/kit", NOW);
    expect(repo.skills.map((s) => s.name)).toEqual(["local", "good"]);
    expect(repo.invalid.map((i) => i.skillPath)).toEqual(["skills/bad", "skills/wrong-dir"]);
  });

  it.each([
    ["truncated tree", (r: Record<string, unknown>) => { const k = Object.keys(r).find((x) => x.includes("/git/trees/"))!; (r[k] as { truncated: boolean }).truncated = true; }, "SOURCE_UNAVAILABLE"],
    ["redirect (renamed repo)", (r: Record<string, unknown>) => { r["/repos/acme/kit"] = { status: 301, headers: { location: "https://api.github.com/repositories/1" }, body: Buffer.from("{}") }; }, "SOURCE_UNAVAILABLE"],
    ["canonical identity change", (r: Record<string, unknown>) => { (r["/repos/acme/kit"] as { full_name: string }).full_name = "evil/kit"; }, "SOURCE_UNAVAILABLE"],
    ["private repository", (r: Record<string, unknown>) => { (r["/repos/acme/kit"] as { private: boolean }).private = true; }, "SOURCE_UNAVAILABLE"],
    ["rate limit", (r: Record<string, unknown>) => { r["/repos/acme/kit"] = { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4102444800" }, body: Buffer.from("{}") }; }, "RATE_LIMITED"],
    ["tampered blob", (r: Record<string, unknown>) => { const k = Object.keys(r).find((x) => x.includes("/git/blobs/"))!; (r[k] as { content: string }).content = Buffer.from(skillMd("evil")).toString("base64"); }, "SOURCE_UNAVAILABLE"],
    ["malformed tree", (r: Record<string, unknown>) => { const k = Object.keys(r).find((x) => x.includes("/git/trees/"))!; r[k] = { tree: "nope" }; }, "SOURCE_UNAVAILABLE"],
    ["missing repository", (r: Record<string, unknown>) => { delete r["/repos/acme/kit"]; }, "SOURCE_UNAVAILABLE"],
  ])("fails closed on %s", async (_name, mutate, code) => {
    const responses = syntheticRepo("acme/kit", { "skills/good/SKILL.md": skillMd("good") });
    mutate(responses as Record<string, unknown>);
    await expect(discoverRepository(new GitHubClient(fixtureTransport(responses).transport, noSleep), "acme/kit", NOW)).rejects.toMatchObject({ code });
  });

  it("retries transient failures at most twice", async () => {
    let calls = 0;
    const client = new GitHubClient(async () => { calls++; return { status: 502, headers: {}, body: Buffer.from("") }; }, noSleep);
    await expect(client.getRepository("acme", "kit")).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(calls).toBe(3);
  });

  it("makes zero requests when offline (FR-053)", async () => {
    const { transport, urls } = fixtureTransport({});
    await expect(new GitHubClient(transport, { offline: true }).getRepository("acme", "kit")).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(urls).toEqual([]);
  });
});

describe("source loading, caching, and dedup (FR-013, FR-014)", () => {
  it("refreshes, caches, and dedups against the bundled catalog", async () => {
    const cacheRoot = await tmp();
    const { transport } = fixtureTransport(recorded("supabase-agent-skills"));
    const loaded = await loadSources({ catalog: loadBundledCatalog(), repositories: ["supabase/agent-skills"], refresh: true, cacheRoot, client: new GitHubClient(transport, noSleep), now: NOW });
    expect(loaded.errors).toEqual([]);
    expect(loaded.cacheWrites).toHaveLength(1);
    const pg = loaded.candidates.find((c) => c.id === "supabase/agent-skills#skills/supabase-postgres-best-practices")!;
    expect(pg.annotationOrigin).toBe("curated");
    expect(pg.discoveredVia).toEqual(["bundled", "repository:supabase/agent-skills"]);
    expect(loaded.candidates.filter((c) => c.id === pg.id)).toHaveLength(1);
    expect(loaded.candidates.find((c) => c.id === "supabase/agent-skills#skills/supabase")!.annotationOrigin).toBe("derived-from-metadata");
    const ids = loaded.candidates.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());

    // Offline reuse of the cache makes no requests.
    const offline = await loadSources({ catalog: loadBundledCatalog(), repositories: ["supabase/agent-skills"], refresh: false, cacheRoot, client: null, now: NOW });
    expect(offline.sources[1]).toMatchObject({ state: "cached", skills: 2 });
  });

  it("reports a failed refresh as an error with remaining results", async () => {
    const loaded = await loadSources({ catalog: loadBundledCatalog(), repositories: ["acme/missing"], refresh: true, cacheRoot: await tmp(), client: new GitHubClient(fixtureTransport({}).transport, noSleep), now: NOW });
    expect(loaded.errors[0]).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(loaded.candidates.length).toBe(loadBundledCatalog().entries.length);
  });

  it("ignores corrupt cache files", async () => {
    const cacheRoot = await tmp();
    await mkdir(path.join(cacheRoot, "sources"), { recursive: true });
    await writeFile(path.join(cacheRoot, "sources", "acme__kit.json"), '{"schemaVersion":1,"repository":"acme/kit"');
    expect(await readRepoCache(cacheRoot, "acme/kit")).toBeNull();
    const file = path.join(cacheRoot, "sources", "acme__kit.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 1, repository: "other/repo", commit: "a".repeat(40), fetchedAt: "x", licenseSpdx: null, skills: [], invalid: [], warnings: [] }));
    expect(await readRepoCache(cacheRoot, "acme/kit")).toBeNull();
    expect(JSON.parse(await readFile(file, "utf8")).repository).toBe("other/repo");
  });
});
