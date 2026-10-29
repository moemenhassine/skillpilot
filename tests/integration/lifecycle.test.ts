import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { doctorCommand } from "../../src/commands/doctor.ts";
import { installCommand, listCommand, removeCommand } from "../../src/commands/lifecycle.ts";
import { planCommand } from "../../src/commands/review.ts";
import { recoverProject, SimulatedCrash, type FaultHook } from "../../src/installer/index.ts";
import { sha256Hex } from "../../src/storage/canonical.ts";
import { payloadDir } from "../../src/storage/payload-cache.ts";
import { fixtureTransport, MIT, PNG, skillMd, syntheticRepo } from "../helpers/github.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
const COMMIT = "c".repeat(40);
const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), `sp-${p}-`));
const exists = (p: string) => lstat(p).then(() => true, () => false);
const FILES: Record<string, string | Buffer> = {
  "SKILL.md": skillMd("good-skill", "Helps write browser tests."),
  "references/guide.md": "# Guide\nUse the page object pattern.\n",
  "assets/icon.png": PNG,
};

async function setup() {
  const project = await tmp("proj");
  const cacheRoot = await tmp("cache");
  const responses = syntheticRepo("acme/kit", {
    LICENSE: MIT,
    ...Object.fromEntries(Object.entries(FILES).map(([k, v]) => [`skills/good-skill/${k}`, v])),
    "skills/med-skill/SKILL.md": skillMd("med-skill"),
    "skills/med-skill/scripts/run.py": "print('hello')\n",
  }, { commit: COMMIT });
  const t = fixtureTransport(responses);
  const opts = { transport: t.transport, cacheRoot, now: NOW };
  let n = 0;
  const plan = async (agent = "both", source = "acme/kit#skills/good-skill", extra: { ack?: string[] } = {}) => {
    const out = path.join(project, `.skillpilot/plans/p${n++}.json`);
    const r = await planCommand(project, [source], { ...opts, agent, out, ...extra });
    return { file: out, digest: r.data.plan.planDigest, plan: r.data.plan };
  };
  const install = (file: string, more: Partial<Parameters<typeof installCommand>[1]> = {}) =>
    installCommand(project, { plan: file, json: true, interactive: false, cacheRoot, now: NOW, ...more });
  const at = (p: string) => path.join(project, p);
  const snapshot = async () => ({
    claude: await exists(at(".claude")), agents: await exists(at(".agents")),
    lock: await readFile(at(".skillpilot/lock.json"), "utf8").catch(() => null),
    ops: await readdir(at(".skillpilot/operations")).catch(() => []), mutex: await exists(at(".skillpilot/mutation.lock")),
  });
  return { project, cacheRoot, t, opts, plan, install, at, snapshot, responses };
}

async function expectInstalled(at: (p: string) => string, dirs: string[]) {
  for (const d of dirs) {
    for (const [rel, content] of Object.entries(FILES)) {
      const bytes = await readFile(at(`${d}/${rel}`));
      expect(sha256Hex(bytes)).toBe(sha256Hex(Buffer.from(content)));
      if (process.platform !== "win32") expect((await stat(at(`${d}/${rel}`))).mode & 0o777).toBe(0o644);
    }
    expect(await readFile(at(`${d}/LICENSE`), "utf8")).toBe(MIT);
  }
}

describe("approved install (AC-03, spec 17.3 #1, #13)", () => {
  it("scan → plan → explicit approval → both-target install → list", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("both");
    const r = await s.install(file, { approve: digest });
    expect(r.data).toMatchObject({ outcome: "installed", lockfile: "created", planDigest: digest });
    expect(r.data.changed).toEqual([{ agent: "claude-code", path: ".claude/skills/good-skill" }, { agent: "codex", path: ".agents/skills/good-skill" }]);
    await expectInstalled(s.at, [".claude/skills/good-skill", ".agents/skills/good-skill"]);
    const lock = JSON.parse(await readFile(s.at(".skillpilot/lock.json"), "utf8"));
    expect(lock.entries.map((e: { agent: string; planDigest: string; installPath: string; source: { commit: string } }) => [e.agent, e.planDigest, e.installPath, e.source.commit])).toEqual([
      ["claude-code", digest, ".claude/skills/good-skill", COMMIT],
      ["codex", digest, ".agents/skills/good-skill", COMMIT],
    ]);
    expect(JSON.stringify(lock)).not.toContain(s.project);
    const snap = await s.snapshot();
    expect(snap.ops).toEqual([]);
    expect(snap.mutex).toBe(false);
    const list = await listCommand(s.project);
    expect(list.data.entries.map((e) => [e.state, e.agent, e.id])).toEqual([
      ["managed", "codex", "acme/kit#skills/good-skill"],
      ["managed", "claude-code", "acme/kit#skills/good-skill"],
    ]);
  });

  it("installs to Codex only without creating Claude directories", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("codex");
    await s.install(file, { approve: digest });
    expect(await exists(s.at(".claude"))).toBe(false);
    await expectInstalled(s.at, [".agents/skills/good-skill"]);
  });

  it("applying the same plan twice is an identical managed no-op that keeps provenance timestamps (#2)", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("both");
    await s.install(file, { approve: digest });
    const before = await readFile(s.at(".skillpilot/lock.json"));
    const again = await s.install(file, { approve: digest, now: new Date(NOW.getTime() + 60_000) });
    expect(again.data.outcome).toBe("no-op");
    expect(await readFile(s.at(".skillpilot/lock.json"))).toEqual(before);
    const fresh = await s.plan("both");
    expect(fresh.plan.preconditions.targets.map((t) => t.state)).toEqual(["managed", "managed"]);
    expect(fresh.plan.lockfileChanges).toEqual([]);
    expect((await s.install(fresh.file, { approve: fresh.digest })).data.outcome).toBe("no-op");
  });

  it("adds a second agent while leaving the identical managed copy untouched", async () => {
    const s = await setup();
    const first = await s.plan("claude-code");
    await s.install(first.file, { approve: first.digest });
    const both = await s.plan("both");
    expect(both.plan.lockfileChanges.map((c) => c.entry.agent)).toEqual(["codex"]);
    const r = await s.install(both.file, { approve: both.digest });
    expect(r.data.changed).toEqual([{ agent: "codex", path: ".agents/skills/good-skill" }]);
    expect(r.data.unchanged).toEqual([{ agent: "claude-code", path: ".claude/skills/good-skill" }]);
    const lock = JSON.parse(await readFile(s.at(".skillpilot/lock.json"), "utf8"));
    expect(lock.entries.map((e: { planDigest: string }) => e.planDigest)).toEqual([first.digest, both.digest]);
  });

  it("an interactive approval must type the exact operation and digest prefix", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("codex");
    const shown: string[] = [];
    const r = await s.install(file, { json: false, interactive: true, prompt: async () => `install ${digest.slice(7, 19)}`, display: (l) => shown.push(...l) });
    expect(r.data.outcome).toBe("installed");
    expect(shown.join("\n")).toContain("INSTALL plan for codex");
    expect(shown.join("\n")).toContain(digest);
    expect(shown.join("\n")).toContain(".agents/skills/good-skill/");
  });
});

describe("no approval leaves agent targets unchanged (FR-040, spec 17.3 #3)", () => {
  it.each([
    ["JSON mode without --approve", { json: true, interactive: true, prompt: async () => "x" }, "APPROVAL_REQUIRED"],
    ["non-TTY without --approve", { json: false, interactive: false }, "APPROVAL_REQUIRED"],
    ["incorrect digest", { approve: `sha256:${"0".repeat(64)}` }, "APPROVAL_MISMATCH"],
    ["short digest", { approve: "install" }, "APPROVAL_MISMATCH"],
    ["declined prompt", { json: false, interactive: true, prompt: async () => "no" }, "APPROVAL_DECLINED"],
    ["EOF at prompt", { json: false, interactive: true, prompt: async () => null }, "APPROVAL_DECLINED"],
    ["removal phrase for an install plan", { json: false, interactive: true, prompt: async (q: string) => q.replace(/.*"install /, "remove ").replace(/".*/, "") }, "APPROVAL_DECLINED"],
  ] as const)("%s", async (_n, more, code) => {
    const s = await setup();
    const { file } = await s.plan("both");
    await expect(s.install(file, more)).rejects.toMatchObject({ code });
    expect(await s.snapshot()).toEqual({ claude: false, agents: false, lock: null, ops: [], mutex: false });
  });

  it("APPROVAL_REQUIRED carries the digest the user must approve", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("codex");
    await expect(s.install(file)).rejects.toMatchObject({ details: { planDigest: digest } });
  });
});

describe("approval cannot drift (AC-04, FR-042, spec 17.3 #4, #5, #14)", () => {
  it("installs from cached pinned bytes with zero network requests after the branch moves", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("codex");
    s.responses["/repos/acme/kit/branches/main"] = { commit: { sha: "e".repeat(40) } };
    const before = s.t.urls.length;
    await s.install(file, { approve: digest });
    expect(s.t.urls.length).toBe(before);
    expect(JSON.parse(await readFile(s.at(".skillpilot/lock.json"), "utf8")).entries[0].source.commit).toBe(COMMIT);
  });

  it("rejects cache bytes changed after approval before any mutation", async () => {
    const s = await setup();
    const { file, digest, plan } = await s.plan("both");
    const blobs = path.join(payloadDir(s.cacheRoot, plan.skills[0]!.source), "blobs");
    await appendFile(path.join(blobs, (await readdir(blobs))[0]!), "tampered");
    await expect(s.install(file, { approve: digest })).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(await s.snapshot()).toMatchObject({ claude: false, agents: false, lock: null });
  });

  it("rejects a target created after planning and preserves it", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("both");
    await mkdir(s.at(".agents/skills/good-skill"), { recursive: true });
    await writeFile(s.at(".agents/skills/good-skill/SKILL.md"), "mine");
    await expect(s.install(file, { approve: digest })).rejects.toMatchObject({ code: "TARGET_CONFLICT" });
    expect(await readFile(s.at(".agents/skills/good-skill/SKILL.md"), "utf8")).toBe("mine");
    expect(await exists(s.at(".claude/skills/good-skill"))).toBe(false);
  });

  it("rejects a lockfile changed after planning", async () => {
    const s = await setup();
    const other = await s.plan("codex");
    const { file, digest } = await s.plan("claude-code");
    await s.install(other.file, { approve: other.digest });
    await expect(s.install(file, { approve: digest })).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(await exists(s.at(".claude"))).toBe(false);
  });

  it("rejects a plan applied from a different project root", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("codex");
    const elsewhere = await tmp("other");
    await expect(installCommand(elsewhere, { plan: file, approve: digest, json: true, interactive: false, cacheRoot: s.cacheRoot, now: NOW })).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(await exists(path.join(elsewhere, ".agents"))).toBe(false);
  });

  it("rejects expired plans before approval", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("codex");
    await expect(s.install(file, { approve: digest, now: new Date(NOW.getTime() + 25 * 3600_000) })).rejects.toMatchObject({ code: "PLAN_EXPIRED" });
  });
});

describe("existing work is preserved (AC-06, FR-044, spec 17.3 #9)", () => {
  it("refuses to plan over a locally modified managed skill, keeping every byte", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("codex");
    await s.install(file, { approve: digest });
    await appendFile(s.at(".agents/skills/good-skill/SKILL.md"), "\nmy edit\n");
    await expect(s.plan("codex")).rejects.toMatchObject({ code: "TARGET_CONFLICT", details: { state: "modified", changed: ["SKILL.md"] } });
    expect(await readFile(s.at(".agents/skills/good-skill/SKILL.md"), "utf8")).toContain("my edit");
  });

  it("blocks mutations on a malformed lockfile without replacing it", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("codex");
    await writeFile(s.at(".skillpilot/lock.json"), "{ not json");
    await expect(s.install(file, { approve: digest })).rejects.toMatchObject({ code: "INVALID_SCHEMA" });
    expect(await readFile(s.at(".skillpilot/lock.json"), "utf8")).toBe("{ not json");
    await writeFile(s.at(".skillpilot/lock.json"), JSON.stringify({ schemaVersion: 2, entries: [] }));
    await expect(s.plan("codex")).rejects.toMatchObject({ code: "INVALID_SCHEMA" });
  });
});

describe("removal (FR-047, spec 13.5, 17.3 #12)", () => {
  async function installed(agent = "both") {
    const s = await setup();
    const { file, digest } = await s.plan(agent);
    await s.install(file, { approve: digest });
    await mkdir(s.at(".claude/skills/unrelated"), { recursive: true });
    await writeFile(s.at(".claude/skills/unrelated/SKILL.md"), skillMd("unrelated"));
    let n = 0;
    const removal = async (a = agent) => (await removeCommand(s.project, "acme/kit#skills/good-skill", { agent: a, out: s.at(`.skillpilot/plans/rm${n++}.json`), now: NOW })).data;
    return { ...s, removal };
  }

  it("deletes only unchanged owned files after approval and keeps unrelated skills", async () => {
    const s = await installed();
    const { plan, path: rel } = await s.removal();
    expect(plan.removals.map((r) => r.path)).toEqual([".claude/skills/good-skill", ".agents/skills/good-skill"]);
    await expect(s.install(s.at(rel))).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const r = await s.install(s.at(rel), { approve: plan.planDigest });
    expect(r.data.outcome).toBe("removed");
    expect(await exists(s.at(".claude/skills/good-skill"))).toBe(false);
    expect(await exists(s.at(".agents/skills/good-skill"))).toBe(false);
    expect(await readFile(s.at(".claude/skills/unrelated/SKILL.md"), "utf8")).toBe(skillMd("unrelated"));
    expect(JSON.parse(await readFile(s.at(".skillpilot/lock.json"), "utf8")).entries).toEqual([]);
    expect((await s.install(s.at(rel), { approve: plan.planDigest })).data.outcome).toBe("no-op");
  });

  it("removal prompt requires the word remove", async () => {
    const s = await installed("codex");
    const { plan, path: rel } = await s.removal();
    const shown: string[] = [];
    await expect(s.install(s.at(rel), { json: false, interactive: true, prompt: async () => `install ${plan.planDigest.slice(7, 19)}` })).rejects.toMatchObject({ code: "APPROVAL_DECLINED" });
    await s.install(s.at(rel), { json: false, interactive: true, display: (l) => shown.push(...l), prompt: async () => `remove ${plan.planDigest.slice(7, 19)}` });
    expect(shown[0]).toMatch(/^REMOVE plan/);
  });

  it.each([
    ["an edited file", (at: (p: string) => string) => appendFile(at(".agents/skills/good-skill/SKILL.md"), "edit")],
    ["an added file", (at: (p: string) => string) => writeFile(at(".agents/skills/good-skill/notes.md"), "mine")],
    ["a missing file", (at: (p: string) => string) => rm(at(".agents/skills/good-skill/references/guide.md"))],
  ])("blocks removal planning with %s", async (_n, mutate) => {
    const s = await installed("codex");
    await mutate(s.at);
    await expect(s.removal()).rejects.toMatchObject({ code: "TARGET_CONFLICT" });
    expect(await exists(s.at(".agents/skills/good-skill/SKILL.md"))).toBe(true);
  });

  it("blocks an approved removal when files change after planning", async () => {
    const s = await installed("codex");
    const { plan, path: rel } = await s.removal();
    await writeFile(s.at(".agents/skills/good-skill/notes.md"), "mine");
    await expect(s.install(s.at(rel), { approve: plan.planDigest })).rejects.toMatchObject({ code: "TARGET_CONFLICT" });
    expect(await readFile(s.at(".agents/skills/good-skill/notes.md"), "utf8")).toBe("mine");
  });

  it("rejects unknown installed IDs", async () => {
    const s = await installed("codex");
    await expect(removeCommand(s.project, "acme/kit#skills/nope", { agent: "codex", out: s.at(".skillpilot/plans/x.json") })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(removeCommand(s.project, "acme/kit#skills/good-skill", { agent: "claude-code", out: s.at(".skillpilot/plans/y.json") })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

const crashAt = (point: string): FaultHook => (p) => { if (p === point) throw new SimulatedCrash(point); };

describe("interrupted operations are honest and recoverable (AC-07, FR-043, spec 17.3 #10)", () => {
  const INSTALL_POINTS = ["locked", "staged", "journaled", "moved:0", "moved:1", "lockfile", "committed", "cleaned"];

  it.each(INSTALL_POINTS)("both-target install crashing after %s recovers to a consistent state", async (point) => {
    const s = await setup();
    const { file, digest } = await s.plan("both");
    await expect(s.install(file, { approve: digest, hooks: crashAt(point) })).rejects.toBeInstanceOf(SimulatedCrash);
    // A new mutation never proceeds over unfinished state.
    await expect(s.install(file, { approve: digest })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const doctor = await doctorCommand(s.project);
    expect(doctor.data.checks.find((c) => c.id === "recovery")?.status).toBe("fail");

    const rec = await recoverProject(s.project);
    expect(rec.staleLockRemoved).toBe(true);
    const committed = point === "committed" || point === "cleaned";
    const snap = await s.snapshot();
    expect(snap.ops).toEqual([]);
    expect(snap.mutex).toBe(false);
    if (committed) {
      await expectInstalled(s.at, [".claude/skills/good-skill", ".agents/skills/good-skill"]);
      expect(JSON.parse(snap.lock!).entries).toHaveLength(2);
      expect((await s.install(file, { approve: digest })).data.outcome).toBe("no-op");
    } else {
      expect(await exists(s.at(".claude/skills/good-skill"))).toBe(false);
      expect(await exists(s.at(".agents/skills/good-skill"))).toBe(false);
      expect(snap.lock).toBeNull();
      expect((await s.install(file, { approve: digest })).data.outcome).toBe("installed");
    }
    expect((await listCommand(s.project)).data.entries.every((e) => e.state === "managed")).toBe(true);
  });

  it.each(["journaled", "moved:0", "moved:1", "lockfile", "committed"])("both-target removal crashing after %s recovers", async (point) => {
    const s = await setup();
    const p = await s.plan("both");
    await s.install(p.file, { approve: p.digest });
    const lockBefore = await readFile(s.at(".skillpilot/lock.json"));
    const { plan, path: rel } = (await removeCommand(s.project, "acme/kit#skills/good-skill", { agent: "both", out: s.at(".skillpilot/plans/rm.json"), now: NOW })).data;
    await expect(s.install(s.at(rel), { approve: plan.planDigest, hooks: crashAt(point) })).rejects.toBeInstanceOf(SimulatedCrash);
    await recoverProject(s.project);
    if (point === "committed") {
      expect(await exists(s.at(".claude/skills/good-skill"))).toBe(false);
      expect(JSON.parse(await readFile(s.at(".skillpilot/lock.json"), "utf8")).entries).toEqual([]);
    } else {
      await expectInstalled(s.at, [".claude/skills/good-skill", ".agents/skills/good-skill"]);
      expect(await readFile(s.at(".skillpilot/lock.json"))).toEqual(lockBefore);
    }
  });

  it("an in-process failure rolls back immediately and releases the lock", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("both");
    await expect(s.install(file, { approve: digest, hooks: (p) => { if (p === "moved:1") throw new Error("disk full"); } })).rejects.toMatchObject({ code: "IO_ERROR" });
    expect(await s.snapshot()).toMatchObject({ lock: null, ops: [], mutex: false });
    expect(await exists(s.at(".claude/skills/good-skill"))).toBe(false);
  });

  it("a target that appears mid-operation is never overwritten and the rest is rolled back", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("both");
    const intrude: FaultHook = async (p) => {
      if (p === "moved:0") { await mkdir(s.at(".agents/skills/good-skill"), { recursive: true }); await writeFile(s.at(".agents/skills/good-skill/x.md"), "racer"); }
    };
    await expect(s.install(file, { approve: digest, hooks: intrude })).rejects.toMatchObject({ code: "TARGET_CONFLICT" });
    expect(await readFile(s.at(".agents/skills/good-skill/x.md"), "utf8")).toBe("racer");
    expect(await exists(s.at(".claude/skills/good-skill"))).toBe(false);
    expect(await s.snapshot()).toMatchObject({ lock: null, ops: [], mutex: false });
  });

  it("an external change after the crash is a preserved conflict, never deleted", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("both");
    await expect(s.install(file, { approve: digest, hooks: crashAt("moved:1") })).rejects.toBeInstanceOf(SimulatedCrash);
    await appendFile(s.at(".claude/skills/good-skill/SKILL.md"), "user edit");
    await expect(recoverProject(s.project)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", details: { conflicts: [expect.stringContaining(".claude/skills/good-skill")] } });
    expect(await readFile(s.at(".claude/skills/good-skill/SKILL.md"), "utf8")).toContain("user edit");
    expect(await exists(s.at(".agents/skills/good-skill/SKILL.md"))).toBe(true);
    expect((await s.snapshot()).ops).toHaveLength(1);
  });

  it("a tampered journal cannot steer recovery outside owned paths", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("codex");
    await expect(s.install(file, { approve: digest, hooks: crashAt("moved:0") })).rejects.toBeInstanceOf(SimulatedCrash);
    const [op] = (await s.snapshot()).ops;
    const jf = s.at(`.skillpilot/operations/${op}/journal.json`);
    const j = JSON.parse(await readFile(jf, "utf8"));
    j.steps[0].from = "../../outside";
    await writeFile(jf, JSON.stringify(j));
    await expect(recoverProject(s.project)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await exists(s.at(".agents/skills/good-skill/SKILL.md"))).toBe(true);
  });

  it("plain doctor never repairs", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("codex");
    await expect(s.install(file, { approve: digest, hooks: crashAt("moved:0") })).rejects.toBeInstanceOf(SimulatedCrash);
    await doctorCommand(s.project);
    expect(await exists(s.at(".agents/skills/good-skill"))).toBe(true);
    const d = await doctorCommand(s.project, { recover: true });
    expect(d.data.recovery?.operations[0]?.action).toBe("rolled-back");
    expect(await exists(s.at(".agents/skills/good-skill"))).toBe(false);
  });
});

describe("mutation lock (spec 13.4 step 1, 17.3 #11)", () => {
  it("two simultaneous mutations: one acquires the lock, the other fails without writes", async () => {
    const s = await setup();
    const a = await s.plan("codex");
    const b = await s.plan("codex");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let lockedResolve!: () => void;
    const locked = new Promise<void>((r) => { lockedResolve = r; });
    const first = s.install(a.file, { approve: a.digest, hooks: async (p) => { if (p === "locked") { lockedResolve(); await gate; } } });
    await locked;
    await expect(s.install(b.file, { approve: b.digest })).rejects.toMatchObject({ code: "MUTATION_LOCKED" });
    await expect(recoverProject(s.project)).rejects.toMatchObject({ code: "MUTATION_LOCKED" });
    release();
    expect((await first).data.outcome).toBe("installed");
  });

  it("a stale lock from a dead process requires explicit recovery; a live or foreign one is never broken", async () => {
    const s = await setup();
    const { file, digest } = await s.plan("codex");
    await mkdir(s.at(".skillpilot"), { recursive: true });
    const lock = (pid: number, hostname = os.hostname()) => writeFile(s.at(".skillpilot/mutation.lock"), JSON.stringify({ pid, hostname, operationId: "x", createdAt: NOW.toISOString() }));
    await lock(2 ** 22 + 12345);
    await expect(s.install(file, { approve: digest })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await recoverProject(s.project)).toEqual({ operations: [], staleLockRemoved: true });
    await lock(process.ppid);
    await expect(s.install(file, { approve: digest })).rejects.toMatchObject({ code: "MUTATION_LOCKED" });
    await expect(recoverProject(s.project)).rejects.toMatchObject({ code: "MUTATION_LOCKED" });
    await lock(1, "another-host.example");
    await expect(recoverProject(s.project)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await exists(s.at(".skillpilot/mutation.lock"))).toBe(true);
    expect(await exists(s.at(".agents"))).toBe(false);
  });
});

describe("list (FR-046)", () => {
  it("distinguishes managed, modified, missing, unmanaged, and agent-incompatible entries", async () => {
    const s = await setup();
    const p = await s.plan("both");
    await s.install(p.file, { approve: p.digest });
    await appendFile(s.at(".claude/skills/good-skill/SKILL.md"), "edit");
    await rm(s.at(".agents/skills/good-skill"), { recursive: true });
    await mkdir(s.at(".agents/skills/handmade"), { recursive: true });
    await writeFile(s.at(".agents/skills/handmade/SKILL.md"), skillMd("handmade"));
    await mkdir(s.at(".agents/skills/broken"), { recursive: true });
    await writeFile(s.at(".agents/skills/broken/SKILL.md"), skillMd("other-name"));
    const list = await listCommand(s.project);
    expect(list.data.entries.map((e) => [e.path, e.state])).toEqual([
      [".agents/skills/broken", "agent-incompatible"],
      [".agents/skills/good-skill", "missing"],
      [".agents/skills/handmade", "unmanaged"],
      [".claude/skills/good-skill", "modified"],
    ]);
    expect(list.data.entries[3]!.details).toMatchObject({ changed: ["SKILL.md"] });
  });
});

describe("medium findings stay bound to the approved plan (AC-05)", () => {
  it("installs a skill with an acknowledged medium finding and records the acknowledgment", async () => {
    const s = await setup();
    const err = await s.plan("codex", "acme/kit#skills/med-skill").catch((e) => e);
    const ids: string[] = err.details.requiresAcknowledgment;
    const { file, digest } = await s.plan("codex", "acme/kit#skills/med-skill", { ack: ids });
    await s.install(file, { approve: digest });
    const lock = JSON.parse(await readFile(s.at(".skillpilot/lock.json"), "utf8"));
    expect(lock.entries[0]).toMatchObject({ acknowledged: ids, findingsSummary: { medium: 1 } });
    expect((await stat(s.at(".agents/skills/med-skill/scripts/run.py"))).mode & 0o111).toBe(0);
  });
});

describe("CLI lifecycle as a subprocess (FR-040, FR-052, spec 13.2)", () => {
  it("non-TTY refuses without hanging; --approve installs; list, remove, and doctor --recover round-trip", async () => {
    const { spawnSync } = await import("node:child_process");
    const { cacheDir } = await import("../../src/storage/paths.ts");
    const home = await tmp("home");
    const project = await realpath(await tmp("cli"));
    const t = fixtureTransport(syntheticRepo("acme/kit", { LICENSE: MIT, ...Object.fromEntries(Object.entries(FILES).map(([k, v]) => [`skills/good-skill/${k}`, v])) }, { commit: COMMIT }));
    // Populate the subprocess's cache in-process; the CLI itself never touches the network here.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local"), NO_COLOR: "1" };
    delete env.XDG_CACHE_HOME;
    const cacheRoot = cacheDir(env, process.platform, home);
    const planned = await planCommand(project, ["acme/kit#skills/good-skill"], { transport: t.transport, cacheRoot, agent: "codex", out: path.join(project, ".skillpilot/plans/i.json") });
    const digest = planned.data.plan.planDigest;
    const cli = (...args: string[]) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../../src/cli.ts"), ...args], { cwd: project, env, encoding: "utf8", input: "", timeout: 20_000 });

    const text = cli("install", "--plan", ".skillpilot/plans/i.json");
    expect(text.status).toBe(5);
    expect(text.stderr).toContain("APPROVAL_REQUIRED");
    const refused = cli("install", "--plan", ".skillpilot/plans/i.json", "--json");
    expect(refused.status).toBe(5);
    expect(JSON.parse(refused.stdout)).toMatchObject({ command: "install", status: "error", errors: [{ code: "APPROVAL_REQUIRED", details: { planDigest: digest } }] });
    expect(await exists(path.join(project, ".agents"))).toBe(false);

    const ok = cli("install", "--plan", ".skillpilot/plans/i.json", "--approve", digest, "--json", "--offline");
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).data).toMatchObject({ outcome: "installed", lockfile: "created" });
    const list = JSON.parse(cli("list", "--json").stdout);
    expect(list.data.entries).toEqual([expect.objectContaining({ id: "acme/kit#skills/good-skill", state: "managed" })]);

    const rm = JSON.parse(cli("remove", "acme/kit#skills/good-skill", "--agent", "codex", "--out", ".skillpilot/plans/r.json", "--json").stdout);
    expect(rm.data.path).toBe(".skillpilot/plans/r.json");
    const removed = cli("install", "--plan", ".skillpilot/plans/r.json", "--approve", rm.data.plan.planDigest, "--json");
    expect(JSON.parse(removed.stdout).data.outcome).toBe("removed");
    expect(await exists(path.join(project, ".agents/skills/good-skill"))).toBe(false);

    const doctor = cli("doctor", "--recover", "--json");
    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout).data.recovery).toEqual({ operations: [], staleLockRemoved: false });
  });
});

describe("recommend excludes exact managed installs (FR-024)", () => {
  it("drops a catalog skill installed byte-identically for every selected agent, and only then", async () => {
    const { recommendCommand } = await import("../../src/commands/recommend.ts");
    const { serializeLockfile } = await import("../../src/storage/lockfile.ts");
    const { chmod } = await import("node:fs/promises");
    const project = await tmp("rec");
    const id = "obra/superpowers#skills/test-driven-development";
    const body = Buffer.from(skillMd("test-driven-development"));
    const file = { path: "SKILL.md", sourcePath: "skills/test-driven-development/SKILL.md", size: body.length, sha256: sha256Hex(body), installedMode: "0644" as const, role: "skill" as const };
    const entry = (agent: "codex" | "claude-code") => ({
      sourceId: id, agent, name: "test-driven-development", installPath: `${agent === "codex" ? ".agents" : ".claude"}/skills/test-driven-development`,
      source: { provider: "github" as const, owner: "obra", repository: "superpowers", skillPath: "skills/test-driven-development", commit: "2ce8aa15d05bd57213e6f746f953aafb7ded7a8b" },
      license: { spdx: "MIT", files: [] }, payloadDigest: `sha256:${"1".repeat(64)}`, files: [file], ruleSet: "rules-v1",
      findingsSummary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, acknowledged: [], planDigest: `sha256:${"2".repeat(64)}`, installedAt: NOW.toISOString(), toolVersion: "0.1.0",
    });
    await mkdir(path.join(project, ".agents/skills/test-driven-development"), { recursive: true });
    await writeFile(path.join(project, ".agents/skills/test-driven-development/SKILL.md"), body);
    await chmod(path.join(project, ".agents/skills/test-driven-development/SKILL.md"), 0o644);
    await mkdir(path.join(project, ".skillpilot"));
    await writeFile(path.join(project, ".skillpilot/lock.json"), serializeLockfile([entry("codex")]));
    const rec = (agent: string) => recommendCommand(project, { goal: "write tests first with TDD", agent, explain: true, offline: true });
    const codex = await rec("codex");
    expect(codex.data.recommendations.map((r) => r.id)).not.toContain(id);
    expect(codex.data.exclusions).toContainEqual({ id, reason: "exact payload already installed and managed" });
    expect(codex.warnings!.join("\n")).not.toContain("same-name unmanaged");
    expect((await rec("both")).data.recommendations.map((r) => r.id)).toContain(id);
  });
});
