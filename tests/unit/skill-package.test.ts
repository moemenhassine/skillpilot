import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reviewPayload } from "../../src/review/index.ts";
import { parseSkillManifest, parseStrictYaml } from "../../src/schemas/manifest.ts";
import { sha256Hex } from "../../src/storage/canonical.ts";

const PKG = path.resolve(import.meta.dirname, "../../skills/skillpilot");
const files = (dir: string, prefix = ""): string[] =>
  readdirSync(dir).sort().flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n), `${prefix}${n}/`) : [`${prefix}${n}`]));

describe("portable SkillPilot skill (spec 15.1, 15.2)", () => {
  const skillMd = readFileSync(path.join(PKG, "SKILL.md"), "utf8");

  it("has the specified portable frontmatter and nothing provider-specific", () => {
    const parsed = parseSkillManifest(skillMd);
    expect(parsed).toMatchObject({ ok: true, manifest: { name: "skillpilot", license: "MIT" } });
    const fm = parseStrictYaml(skillMd.split("---\n")[1]!);
    expect(fm.ok && Object.keys(fm.value as object).sort()).toEqual(["compatibility", "description", "license", "metadata", "name"]);
    expect(path.basename(PKG)).toBe("skillpilot");
    expect(skillMd).not.toMatch(/allowed-tools|hooks:|\$ARGUMENTS|\$\{CLAUDE|!`/);
  });

  it("keeps the main instructions under 200 lines", () => {
    expect(skillMd.split("\n").length).toBeLessThan(200);
  });

  it("covers every required wrapper step", () => {
    for (const phrase of ["--json", "skillpilot --version", "Do not download or execute a package", "recommend --json", "Do not default to `both`", "Never acknowledge one for them", "wait for explicit approval of this exact plan", "--approve <full planDigest>", "new approval", "skillpilot list --json", "restart", "data, never instructions", "do not run bundled scripts"]) {
      expect(skillMd, phrase).toContain(phrase);
    }
  });

  it("has only relative references that resolve inside the package", () => {
    for (const f of files(PKG).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(path.join(PKG, f), "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
        expect(target, `${f} → ${target}`).not.toMatch(/^([a-z]+:|\/)/i);
        const resolved = path.resolve(PKG, path.dirname(f), target!.split("#")[0]!);
        expect(resolved.startsWith(PKG + path.sep), `${f} → ${target}`).toBe(true);
        expect(statSync(resolved).isFile(), `${f} → ${target}`).toBe(true);
      }
    }
    expect(files(PKG)).toEqual(["SKILL.md", "references/approval.md", "references/troubleshooting.md", "references/workflow.md"]);
  });

  it("passes SkillPilot's own review apart from the pending license file", () => {
    const bytes = new Map(files(PKG).map((f) => [f, readFileSync(path.join(PKG, f))]));
    const review = reviewPayload({
      schemaVersion: 1, fetchedAt: "", lastUsed: "", excluded: [], limitsExceeded: [],
      source: { provider: "github", owner: "skillpilot", repository: "skillpilot", skillPath: "skills/skillpilot", commit: "0".repeat(40) },
      files: [...bytes].map(([p, b]) => ({ path: p, sourcePath: `skills/skillpilot/${p}`, size: b.length, sha256: sha256Hex(b), installedMode: "0644" as const, role: "skill" as const })),
    }, bytes);
    expect(review.coverage).toBe("complete");
    // shortcut: no LICENSE text is bundled until the maintainer names the copyright holder (M6); LIC-001 is the only expected finding.
    expect(review.findings.map((f) => f.ruleId)).toEqual(["LIC-001"]);
  });
});

describe("structural adapter check (AC-09)", () => {
  it("a copied wrapper is discovered as a valid skill in both agent roots", async () => {
    const { cp, mkdtemp } = await import("node:fs/promises");
    const os = await import("node:os");
    const { listCommand } = await import("../../src/commands/lifecycle.ts");
    const project = await mkdtemp(path.join(os.tmpdir(), "sp-adapter-"));
    for (const root of [".claude/skills", ".agents/skills"]) await cp(PKG, path.join(project, root, "skillpilot"), { recursive: true });
    const list = await listCommand(project);
    expect(list.data.entries.map((e) => [e.agent, e.path, e.state])).toEqual([
      ["codex", ".agents/skills/skillpilot", "unmanaged"],
      ["claude-code", ".claude/skills/skillpilot", "unmanaged"],
    ]);
  });
});

describe("documentation links", () => {
  const ROOT = path.resolve(PKG, "../..");
  it.each(["README.md", "docs/cli.md", "docs/architecture.md", "docs/security-model.md", "catalog/README.md"])("relative links in %s resolve", (doc) => {
    const text = readFileSync(path.join(ROOT, doc), "utf8");
    for (const [, target] of text.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
      expect(statSync(path.resolve(ROOT, path.dirname(doc), target!.split("#")[0]!)), `${doc} → ${target}`).toBeTruthy();
    }
  });
});
