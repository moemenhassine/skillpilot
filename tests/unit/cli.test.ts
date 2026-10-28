import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES = path.join(ROOT, "tests/fixtures/projects");
const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, "src/cli.ts"), ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

describe("CLI JSON contract (FR-052)", () => {
  it("scan --json emits exactly one envelope without ANSI", () => {
    const r = cli("scan", path.join(FIXTURES, "nextjs-ts"), "--json");
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("\u001b");
    const env = JSON.parse(r.stdout);
    expect(env).toMatchObject({ schemaVersion: 1, command: "scan", status: "ok", errors: [] });
    expect(env.data.effectiveStack).toContain("nextjs");
  });

  it("maps a missing project to INVALID_ARGUMENT and exit 2", () => {
    const r = cli("scan", path.join(FIXTURES, "nope"), "--json");
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "error", data: null, errors: [{ code: "INVALID_ARGUMENT" }] });
  });

  it("returns a JSON envelope for unknown options", () => {
    const r = cli("scan", "--bogus", "--json");
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).errors[0].code).toBe("INVALID_ARGUMENT");
  });

  it("rejects conflicting positional and --project roots", () => {
    const r = cli("scan", path.join(FIXTURES, "nextjs-ts"), "--project", path.join(FIXTURES, "react-vite"), "--json");
    expect(r.status).toBe(2);
  });

  it("doctor reports checks", () => {
    const r = cli("doctor", path.join(FIXTURES, "nextjs-ts"), "--json");
    expect(r.status).toBe(0);
    const ids = JSON.parse(r.stdout).data.checks.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["runtime", "config", "destination:claude-code", "destination:codex", "lockfile", "cache", "recovery"]));
  });

  it("text scan escapes hostile goal text", () => {
    const r = cli("scan", path.join(FIXTURES, "empty-placeholder-missing"), "--goal", "x");
    expect(r.status).toBe(2);
    const ok = cli("scan", path.join(FIXTURES, "nextjs-ts"), "--goal", "go\u001b[2Jal");
    expect(ok.stdout).not.toContain("\u001b");
    expect(ok.stdout).toContain("Goal: go\\u{1b}[2Jal");
  });
});

describe("discovery commands (FR-010, FR-021, FR-053)", () => {
  it("recommend --json returns ranked, explained results without writing files", async () => {
    const { readdirSync } = await import("node:fs");
    const dir = path.join(FIXTURES, "nextjs-ts");
    const before = readdirSync(dir, { recursive: true }).sort();
    const r = cli("recommend", dir, "--goal", "add browser tests", "--offline", "--json");
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.data.recommendations[0]).toMatchObject({ name: "webapp-testing", rank: 1, reviewState: "not-reviewed" });
    expect(env.data.recommendations[0].score).toHaveProperty("stackFit");
    expect(env.data.scoringVersion).toBe("fit-v1");
    expect(readdirSync(dir, { recursive: true }).sort()).toEqual(before);
  });
  it("returns an honest empty result for an unsupported goal with no stack", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const env = JSON.parse(cli("recommend", mkdtempSync(path.join(tmpdir(), "sp-empty-")), "--goal", "write a game in Unreal Engine", "--json").stdout);
    expect(env.status).toBe("ok");
    expect(env.data.recommendations).toEqual([]);
  });
  it.each([
    [["--limit", "0"]], [["--limit", "21"]], [["--agent", "cursor"]], [["--offline", "--refresh"]], [["--repo", "https://evil.example/x"]],
  ])("rejects %j", (args) => {
    const r = cli("recommend", path.join(FIXTURES, "nextjs-ts"), ...args, "--json");
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).errors[0].code).toBe("INVALID_ARGUMENT");
  });
  it("search and sources list work offline", () => {
    const s = JSON.parse(cli("search", "expo navigation", "--offline", "--json").stdout);
    expect(s.data.results[0].name).toBe("expo-router");
    const l = JSON.parse(cli("sources", "list", "--json").stdout);
    expect(l.data.sources[0]).toMatchObject({ kind: "bundled", state: "loaded" });
  });
});
