import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/schemas/config.ts";
import { parseSkillManifest, parseStrictYaml } from "../../src/schemas/manifest.ts";
import { escapeText } from "../../src/renderers/escape.ts";

async function withConfig(content: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skillpilot-cfg-"));
  await mkdir(path.join(root, ".skillpilot"));
  await writeFile(path.join(root, ".skillpilot/config.json"), content);
  return loadConfig(root);
}

describe("config schema (FR-050, FR-054)", () => {
  it("accepts the documented example", async () => {
    const cfg = await withConfig(JSON.stringify({
      schemaVersion: 1, defaultLimit: 5, stack: ["typescript"], repositories: ["anthropics/skills", "vercel-labs/agent-skills"],
      excludeSkillIds: [], scan: { maxDepth: 4, maxParsedFiles: 100 },
    }));
    expect(cfg?.repositories).toHaveLength(2);
  });

  it.each([
    [{ schemaVersion: 2 }, "schemaVersion"],
    [{ schemaVersion: 1, approve: true }, "(root)"],
    [{ schemaVersion: 1, scan: { maxDepth: 10 } }, "scan.maxDepth"],
    [{ schemaVersion: 1, scan: { maxFileBytes: 1e9 } }, "scan.maxFileBytes"],
    [{ schemaVersion: 1, repositories: ["https://evil.example/x"] }, "repositories.0"],
    [{ schemaVersion: 1, defaultLimit: 50 }, "defaultLimit"],
  ])("rejects %j with field-level errors", async (cfg, field) => {
    await expect(withConfig(JSON.stringify(cfg))).rejects.toMatchObject({ code: "INVALID_SCHEMA", details: { issues: expect.arrayContaining([expect.objectContaining({ field })]) } });
  });

  it("rejects invalid JSON", async () => {
    await expect(withConfig("{")).rejects.toMatchObject({ code: "INVALID_SCHEMA" });
  });

  it("returns null when absent", async () => {
    expect(await loadConfig(await mkdtemp(path.join(os.tmpdir(), "skillpilot-cfg-")))).toBeNull();
  });
});

describe("skill manifest parsing", () => {
  const md = (fm: string) => `---\n${fm}\n---\nbody`;
  it("accepts a portable manifest and reports extra keys", () => {
    const r = parseSkillManifest(md("name: my-skill\ndescription: Does things.\nlicense: MIT\nhooks: x"));
    expect(r).toMatchObject({ ok: true, manifest: { name: "my-skill" }, extraKeys: ["hooks"] });
  });
  it.each([
    ["name: My_Skill\ndescription: x", "bad charset"],
    ["name: a--b\ndescription: x", "double hyphen"],
    ["name: -a\ndescription: x", "leading hyphen"],
    [`name: ${"a".repeat(65)}\ndescription: x`, "too long"],
    ["name: a\ndescription: ''", "empty description"],
    [`name: a\ndescription: ${"d".repeat(1025)}`, "description too long"],
    ["name: a\nname: a\ndescription: x", "duplicate keys"],
    ["name: &n a\ndescription: *n", "alias"],
    ["name: !!str a\ndescription: x", "tag"],
  ])("rejects %j (%s)", (fm) => {
    expect(parseSkillManifest(md(fm)).ok).toBe(false);
  });
  it("rejects a missing frontmatter block", () => {
    expect(parseSkillManifest("# no frontmatter").ok).toBe(false);
  });
  it("strict YAML rejects custom tags", () => {
    expect(parseStrictYaml("a: !custom 1").ok).toBe(false);
  });
});

describe("terminal escaping (section 11.4)", () => {
  it("neutralizes ANSI, OSC hyperlinks, bidi controls, and newlines", () => {
    const hostile = "a\u001b[31mred\u001b]8;;http://x\u0007link\u202enoisrevni\nnext";
    const out = escapeText(hostile);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(out).toContain("\\u{1b}");
    expect(out).toContain("\\u{202e}");
  });
  it("leaves ordinary text alone", () => {
    expect(escapeText("café → ok")).toBe("café → ok");
  });
});
