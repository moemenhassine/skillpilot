import path from "node:path";
import { collisionKey, pathProblem } from "../sources/grammar.ts";
import { parseSkillManifest } from "../schemas/manifest.ts";
import { payloadDigest, type CachedPayload, type PayloadFile, type SourceIdentity } from "../storage/payload-cache.ts";
import { assessLicense, type LicenseEvidence } from "./license.ts";
import { classifyPath, imageMatchesExtension, PAYLOAD_POLICY_VERSION } from "./policy.ts";
import { findingId, RULE_SET_VERSION, scanText, type Finding, type Severity } from "./rules.ts";

export const STATIC_LIMITATION = "Static checks can miss harmful behavior. Review the instructions and bundled files before enabling this skill.";

export type Coverage = "complete" | "incomplete";
export type Decision = "eligible" | "requires-acknowledgment" | "blocked";

export interface ReviewResult {
  ruleSet: typeof RULE_SET_VERSION;
  policyVersion: typeof PAYLOAD_POLICY_VERSION;
  source: SourceIdentity;
  name: string | null;
  description: string | null;
  payloadDigest: string;
  files: PayloadFile[];
  coverage: Coverage;
  decision: Decision;
  findings: Finding[];
  acknowledged: string[];
  license: LicenseEvidence;
  disclosures: { scripts: string[]; images: string[]; externalDomains: string[]; targetSpecificFrontmatter: string[]; compatibility: string | null; fileModeNormalization: string };
}

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const CODE = /\.(py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|ps1)$/i;
const ACTIVATION = /^(\.claude-plugin\/|\.codex-plugin\/|\.mcp\.json$|hooks\.json$|hooks\/hooks\.json$)/;
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/;
// Unscoped shell or wildcard tool preapproval.
const BROAD_TOOLS = /(^|[\s,])(Bash|Shell|Exec|\*)(?![(\w])/;

function structural(ruleId: string, severity: Severity, file: string, explanation: string, remediation: string): Finding {
  return { id: findingId(ruleId, file, undefined, explanation), ruleId, severity, confidence: "high", file, occurrences: 1, explanation, remediation, blocking: severity === "high" || severity === "critical" || ruleId.startsWith("STR") || ruleId === "LIC-001" };
}

/** Pure review of a cached payload under the installed rule set. Never executes or renders content. */
export function reviewPayload(cached: CachedPayload, bytes: Map<string, Uint8Array>, acknowledged: string[] = []): ReviewResult {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const { source } = cached;
  const rel = (sourcePath: string) => (source.skillPath === "." ? sourcePath : sourcePath.slice(source.skillPath.length + 1));

  for (const x of cached.excluded) {
    const structuralReasons = ["symlink", "submodule", "special-file", "unsafe-path"];
    if (structuralReasons.includes(x.reason)) add(structural("STR-001", "high", rel(x.sourcePath), `Rejected entry: ${x.reason}.`, "Symlinks, submodules, special files, and unsafe paths cannot be installed."));
    else if (x.reason === "license-collision") add(structural("LIC-001", "high", rel(x.sourcePath), "Upstream license file collides with a payload file name.", "Rename the conflicting file upstream."));
    else add(structural("STR-003", "high", rel(x.sourcePath), x.reason === "unsupported-type" ? `File type is outside ${PAYLOAD_POLICY_VERSION}; it was not fetched or scanned.` : "File exceeds the per-file size cap; it was not fetched.", "Coverage is incomplete; installation is blocked."));
  }
  for (const l of cached.limitsExceeded) add(structural("STR-003", "high", ".", `Payload limit exceeded: ${l}. No files were fetched.`, "Choose a smaller skill; caps are not configurable upward."));

  const keys = new Map<string, string>();
  for (const f of cached.files) {
    const problem = pathProblem(f.path);
    if (problem) add(structural("STR-001", "high", f.path, `Unsafe path: ${problem}.`, "Rename the file upstream."));
    const k = collisionKey(f.path);
    if (keys.has(k)) add(structural("STR-001", "high", f.path, `Path collides with ${keys.get(k)} under case-folding or Unicode normalization.`, "Rename one of the files upstream."));
    keys.set(k, f.path);
    if (ACTIVATION.test(f.path) && f.role === "skill") add(structural("AGT-001", "high", f.path, "Plugin/hook/MCP activation descriptor at the payload root.", "SkillPilot installs inert skills only; remove activation descriptors."));
  }

  const texts = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const images: string[] = [];
  for (const f of cached.files) {
    const b = bytes.get(f.path)!;
    const kind = classifyPath(f.path);
    if (kind === "image") {
      if (!imageMatchesExtension(f.path, b)) add(structural("STR-003", "high", f.path, "Image bytes do not match the claimed format.", "Only genuine PNG, JPEG, GIF, or WebP files are accepted."));
      images.push(f.path);
      continue;
    }
    let text: string;
    try {
      text = decoder.decode(b);
    } catch {
      add(structural("STR-003", "high", f.path, "Not valid UTF-8 text.", "Binary or mis-encoded content cannot be scanned."));
      continue;
    }
    if (text.includes("\u0000")) { add(structural("STR-003", "high", f.path, "Contains NUL bytes; treated as binary.", "Binary content cannot be scanned.")); continue; }
    if (LFS_POINTER.test(text)) { add(structural("STR-001", "high", f.path, "Git LFS pointer; the real content is not in the repository.", "LFS content is unsupported.")); continue; }
    texts.set(f.path, text);
    for (const finding of scanText(f.path, text)) add(finding);
  }

  // Manifest (STR-002, AGT-001, PERM-001).
  let name: string | null = null;
  let description: string | null = null;
  let licenseField: string | null = null;
  let compatibility: string | null = null;
  let extraKeys: string[] = [];
  const skillMd = texts.get("SKILL.md");
  if (skillMd === undefined) add(structural("STR-002", "high", "SKILL.md", "SKILL.md is missing or unreadable.", "A skill needs a SKILL.md at its root."));
  else {
    const m = parseSkillManifest(skillMd);
    if (!m.ok) add(structural("STR-002", "high", "SKILL.md", `Invalid manifest: ${m.problems.slice(0, 3).join("; ")}.`, "Fix the frontmatter upstream; SkillPilot does not repair metadata."));
    else {
      name = m.manifest.name;
      description = m.manifest.description;
      licenseField = m.manifest.license ?? null;
      compatibility = m.manifest.compatibility ?? null;
      extraKeys = m.extraKeys;
      if (source.skillPath !== "." && path.posix.basename(source.skillPath) !== name) {
        add(structural("STR-002", "high", "SKILL.md", `Manifest name ${name} does not match directory ${path.posix.basename(source.skillPath)}.`, "Rename upstream so they agree."));
      }
      const raw = m.manifest as Record<string, unknown>;
      if ("hooks" in raw) add(structural("AGT-001", "high", "SKILL.md", "Frontmatter declares hooks, which execute automatically.", "Remove hooks; SkillPilot installs inert skills."));
      const tools = typeof raw["allowed-tools"] === "string" ? raw["allowed-tools"] : "";
      if (BROAD_TOOLS.test(tools)) add(structural("PERM-001", "high", "SKILL.md", "Frontmatter preapproves unscoped shell or wildcard tools.", "Scope allowed-tools narrowly or remove it."));
      const nonPortable = extraKeys.filter((k) => k !== "hooks");
      if (nonPortable.length) add(structural("AGT-001", "low", "SKILL.md", `Target-specific frontmatter: ${nonPortable.join(", ")}.`, "Other agents may ignore or reject these keys."));
    }
  }

  // License (LIC-001): bundled license texts at the payload root, including mapped upstream files.
  const licenseFiles = cached.files.filter((f) => !f.path.includes("/") && classifyPath(f.path) === "license" && texts.has(f.path)).map((f) => ({ path: f.path, text: texts.get(f.path)! }));
  const license = assessLicense(licenseField, licenseFiles);
  if (license.problem) add(structural("LIC-001", "high", licenseFiles[0]?.path ?? "SKILL.md", license.problem, "Correct license evidence upstream; SkillPilot never relicenses content."));

  // RUN-001 (bundled scripts) and NET-001 (network destinations in code).
  const scripts = cached.files.filter((f) => CODE.test(f.path)).map((f) => f.path);
  if (scripts.length) {
    add({ ...structural("RUN-001", "medium", scripts[0]!, `Bundles ${scripts.length} script(s): ${scripts.slice(0, 5).join(", ")}${scripts.length > 5 ? ", …" : ""}. SkillPilot never runs them; an agent may.`, "Read the scripts before letting an agent run them."), id: findingId("RUN-001", "(scripts)", undefined, scripts.join("\0")), occurrences: scripts.length });
  }
  const domainsOf = (t: string) => [...t.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1]!.toLowerCase());
  const codeDomains = [...new Set(scripts.flatMap((s) => domainsOf(texts.get(s) ?? "")))].sort();
  if (codeDomains.length) {
    add({ ...structural("NET-001", "medium", scripts.find((s) => domainsOf(texts.get(s) ?? "").length)!, `Bundled code contacts: ${codeDomains.slice(0, 10).join(", ")}${codeDomains.length > 10 ? ", …" : ""}.`, "Confirm these destinations are expected."), confidence: "medium" });
  }
  const externalDomains = [...new Set([...texts.values()].flatMap(domainsOf))].sort().slice(0, 30);

  const ack = new Set(acknowledged);
  findings.sort((a, b) => RANK[b.severity] - RANK[a.severity] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.lineStart ?? 0) - (b.lineStart ?? 0) || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0) || (a.id < b.id ? -1 : 1));
  const coverage: Coverage = findings.some((f) => f.ruleId === "STR-003") ? "incomplete" : "complete";
  const decision: Decision = findings.some((f) => f.blocking)
    ? "blocked"
    : findings.some((f) => f.severity === "medium" && !ack.has(f.id)) ? "requires-acknowledgment" : "eligible";

  return {
    ruleSet: RULE_SET_VERSION, policyVersion: PAYLOAD_POLICY_VERSION, source, name, description,
    payloadDigest: payloadDigest(source, cached.files), files: cached.files, coverage, decision, findings,
    acknowledged: [...ack].filter((id) => findings.some((f) => f.id === id && f.severity === "medium")).sort(),
    license,
    disclosures: {
      scripts, images, externalDomains, targetSpecificFrontmatter: extraKeys, compatibility,
      fileModeNormalization: "All files are installed as regular non-executable files (mode 0644).",
    },
  };
}
