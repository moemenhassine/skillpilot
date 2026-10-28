import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeProject, resolveProjectRoot } from "../../src/analyzer/index.ts";
import { SkillpilotError } from "../../src/errors.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/projects");
const noHome = path.join(os.tmpdir(), "skillpilot-no-home");
const analyze = async (name: string, opts: Parameters<typeof analyzeProject>[1] = {}) =>
  analyzeProject(await resolveProjectRoot(path.join(FIXTURES, name)), { home: noHome, ...opts });
const tokens = (a: Awaited<ReturnType<typeof analyze>>) => a.effectiveStack;

const temps: string[] = [];
async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skillpilot-test-"));
  temps.push(dir);
  return resolveProjectRoot(dir);
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("stack detection baseline (FR-002, FR-003)", () => {
  it.each([
    ["nextjs-ts", ["nextjs", "react", "web", "typescript", "playwright", "testing"], ["react-native", "swift", "mobile"]],
    ["react-vite", ["react", "vite", "web", "vitest"], ["nextjs", "mobile", "react-native"]],
    ["node-backend", ["node", "backend", "jest", "docker"], ["web"]],
    ["expo-app", ["expo", "react-native", "mobile", "react"], ["ios", "android", "web"]],
    ["swift-package", ["swift"], ["ios"]],
    ["ios-app", ["ios", "xcode"], ["android"]],
    ["android-native", ["android", "gradle", "kotlin"], ["ios"]],
    ["kotlin-jvm", ["kotlin", "gradle"], ["android"]],
    ["python-ds", ["python", "data-science", "jupyter"], ["ml", "ai"]],
    ["python-ml", ["python", "ml", "testing"], ["web"]],
    ["ai-sdk-app", ["ai", "vercel-ai-sdk", "node", "backend"], ["ml"]],
  ])("%s", async (name, expected, absent) => {
    const a = await analyze(name);
    expect(a.stackOrigin).toBe("detected");
    for (const t of expected) expect(tokens(a)).toContain(t);
    for (const t of absent) expect(tokens(a)).not.toContain(t);
    for (const e of a.evidence) {
      expect(e.path).not.toMatch(/^\/|\\/);
      expect(e.key).toBeTruthy();
      expect(["high", "medium", "low"]).toContain(e.confidence);
    }
  });

  it("never reads or evaluates app.config.js, notebook cells, or READMEs", async () => {
    for (const name of ["expo-app", "python-ds", "nextjs-ts"]) {
      const a = await analyze(name);
      expect(a.scan.filesRead.filter((f) => /app\.config|\.ipynb|README/.test(f))).toEqual([]);
    }
  });

  it("is deterministic", async () => {
    expect(await analyze("monorepo")).toEqual(await analyze("monorepo"));
  });
});

describe("monorepo hints (FR-005)", () => {
  it("reports child packages and coexisting stacks", async () => {
    const a = await analyze("monorepo");
    expect(a.monorepo).toEqual({ detected: true, childPackages: ["apps/mobile", "apps/web", "packages/api"] });
    expect(tokens(a)).toEqual(expect.arrayContaining(["nextjs", "expo", "python", "backend"]));
  });
});

describe("declared stack and goal (FR-004)", () => {
  it("records user-declared evidence for an empty project without claiming manifests", async () => {
    const root = await tempProject();
    const a = await analyzeProject(root, { stack: ["Expo", "rn", "ts"], goal: "  Build an offline habit tracker ", home: noHome });
    expect(a.effectiveStack).toEqual(["expo", "react-native", "typescript"]);
    expect(a.stackOrigin).toBe("cli");
    expect(a.goal).toBe("Build an offline habit tracker");
    expect(a.evidence.every((e) => e.origin === "user-declared" && e.path === ".")).toBe(true);
    expect(a.stackNotes.join(" ")).toMatch(/without file evidence/);
  });

  it("replaces detected tokens and notes the conflict", async () => {
    const a = await analyze("nextjs-ts", { stack: ["vue"] });
    expect(a.effectiveStack).toEqual(["vue"]);
    expect(a.detectedStack.map((t) => t.token)).toContain("nextjs");
    expect(a.stackNotes.join(" ")).toMatch(/Detected but not in the cli stack: .*nextjs/);
  });

  it("prefers CLI stack over config stack over detection", async () => {
    const a = await analyze("nextjs-ts", { config: { schemaVersion: 1, stack: ["python"] } });
    expect(a.stackOrigin).toBe("config");
    expect(a.effectiveStack).toEqual(["python"]);
  });

  it("rejects invalid tokens", async () => {
    await expect(analyze("nextjs-ts", { stack: ["../etc"] })).rejects.toBeInstanceOf(SkillpilotError);
  });

  it("reports unknown for an empty project", async () => {
    const a = await analyzeProject(await tempProject(), { home: noHome });
    expect(a.effectiveStack).toEqual([]);
    expect(a.stackOrigin).toBe("none");
    expect(a.scan.inspectedCategories.length).toBeGreaterThan(5);
  });
});

describe("exclusions and secrets (FR-007, NFR-002)", () => {
  it("never opens secret files, dependencies, or ignored output; mandatory exclusions cannot be negated", async () => {
    const a = await analyze("secrets");
    const serialized = JSON.stringify(a);
    expect(serialized).not.toMatch(/CANARY/);
    expect(a.scan.filesRead).not.toContain(".env");
    expect(a.scan.skipped.filter((s) => s.reason === "secret").map((s) => s.path).sort()).toEqual([".env", ".env.local", "config/credentials.json", "deploy/id_rsa"]);
    expect(tokens(a)).not.toContain("nextjs");
    expect(tokens(a)).not.toContain("vue");
    expect(a.scan.ignoredCount).toBe(1);
  });

  it("skips symlinks without following them", async () => {
    const root = await tempProject();
    const outside = await tempProject();
    await writeFile(path.join(outside, "package.json"), JSON.stringify({ dependencies: { next: "1" } }));
    await symlink(outside, path.join(root, "linked"), "dir");
    await symlink(path.join(outside, "package.json"), path.join(root, "package.json"));
    const a = await analyzeProject(root, { home: noHome });
    expect(a.scan.skipped).toEqual([{ path: "linked", reason: "symlink" }, { path: "package.json", reason: "symlink" }]);
    expect(a.effectiveStack).toEqual([]);
  });

  it("reports malformed manifests instead of guessing", async () => {
    const a = await analyze("malformed");
    expect(a.scan.unparsed.map((u) => u.path).sort()).toEqual(["environment.yml", "package.json", "pyproject.toml"]);
    expect(a.effectiveStack).toEqual([]);
  });
});

describe("scan limits", () => {
  it("stops at the entry limit and warns", async () => {
    const root = await tempProject();
    await Promise.all(Array.from({ length: 5100 }, (_, i) => writeFile(path.join(root, `f${i}.txt`), "")));
    const a = await analyzeProject(root, { home: noHome });
    expect(a.scan.entriesVisited).toBe(5000);
    expect(a.scan.limitHits).toContain("maxEntries (5000)");
  });

  it("honours config narrowing of depth and per-file size", async () => {
    const root = await tempProject();
    await mkdir(path.join(root, "a/b"), { recursive: true });
    await writeFile(path.join(root, "a/b/package.json"), JSON.stringify({ dependencies: { next: "1" } }));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ description: "x".repeat(2000) }));
    const a = await analyzeProject(root, { home: noHome, config: { schemaVersion: 1, scan: { maxDepth: 2, maxFileBytes: 1024 } } });
    expect(a.scan.limitHits).toContain("maxDepth (2)");
    expect(a.scan.unparsed).toEqual([{ path: "package.json", reason: "exceeds per-file size limit" }]);
    expect(a.effectiveStack).not.toContain("nextjs");
  });
});

describe("existing skill inventory (FR-006)", () => {
  it("reads manifests in both roots and flags problems", async () => {
    const a = await analyze("existing-skills");
    const byPath = Object.fromEntries(a.inventory.skills.map((s) => [s.path, s]));
    expect(Object.keys(byPath).sort()).toEqual([".agents/skills/broken", ".agents/skills/dupkeys", ".agents/skills/mismatch", ".claude/skills/helper"]);
    expect(byPath[".claude/skills/helper"]!.manifest).toEqual({ valid: true, name: "helper", description: "Local helper skill.", nameMatchesDirectory: true });
    expect(byPath[".agents/skills/broken"]!.manifest.valid).toBe(false);
    expect(byPath[".agents/skills/dupkeys"]!.manifest.valid).toBe(false);
    expect(byPath[".agents/skills/mismatch"]!.manifest).toMatchObject({ valid: true, nameMatchesDirectory: false });
    // Skill directories are inventoried, never used as stack evidence.
    expect(a.scan.filesRead.some((f) => f.startsWith(".claude") || f.startsWith(".agents"))).toBe(false);
  });

  it("reports same-name user-level skills with a home-relative path", async () => {
    const home = await tempProject();
    await mkdir(path.join(home, ".agents/skills/helper"), { recursive: true });
    const a = await analyze("existing-skills", { home });
    expect(a.inventory.skills.find((s) => s.path === ".claude/skills/helper")!.userLevelSameName).toEqual(["~/.agents/skills/helper"]);
    expect(JSON.stringify(a.inventory)).not.toContain(home);
  });

  it("refuses to inventory a symlinked skill root", async () => {
    const root = await tempProject();
    const elsewhere = await tempProject();
    await symlink(elsewhere, path.join(root, ".claude"), "dir");
    const a = await analyzeProject(root, { home: noHome });
    expect(a.inventory.warnings[0]).toMatch(/\.claude is a symlink/);
  });
});

describe("project root resolution (FR-001)", () => {
  it("rejects missing paths and files", async () => {
    await expect(resolveProjectRoot(path.join(FIXTURES, "does-not-exist"))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(resolveProjectRoot(path.join(FIXTURES, "nextjs-ts/package.json"))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
