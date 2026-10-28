import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { AGENT_TARGETS, PROJECT_SKILL_ROOTS, userSkillRoot, type AgentTarget } from "../agents/index.ts";
import { parseSkillManifest } from "../schemas/manifest.ts";
import { readBounded } from "./fsutil.ts";

export interface InstalledSkill {
  agent: AgentTarget;
  /** Project-relative POSIX directory. */
  path: string;
  directoryName: string;
  manifest: { valid: true; name: string; description: string; nameMatchesDirectory: boolean } | { valid: false; problems: string[] };
  symlink: boolean;
  /** Same-name skills at documented user-level roots, shown with `~` instead of the home path. */
  userLevelSameName: string[];
}

export interface Inventory {
  skills: InstalledSkill[];
  warnings: string[];
}

const MAX_SKILL_MD = 256 * 1024;
const MAX_SKILLS_PER_ROOT = 500;

const exists = (p: string) => lstat(p).then(() => true, () => false);

/** Reads only SKILL.md manifests in both project skill roots; never mutates, never follows symlinks. */
export async function inventorySkills(projectRoot: string, home?: string): Promise<Inventory> {
  const inv: Inventory = { skills: [], warnings: [] };
  for (const agent of AGENT_TARGETS) {
    const relRoot = PROJECT_SKILL_ROOTS[agent];
    let redirected = false;
    for (const ancestor of [path.dirname(relRoot), relRoot]) {
      const st = await lstat(path.join(projectRoot, ancestor)).catch(() => null);
      if (st?.isSymbolicLink()) {
        inv.warnings.push(`${ancestor} is a symlink; ${agent} skills were not inventoried and installs there will be refused.`);
        redirected = true;
      }
    }
    if (redirected) continue;
    const entries = await readdir(path.join(projectRoot, relRoot), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (entries.length > MAX_SKILLS_PER_ROOT) inv.warnings.push(`${relRoot} has more than ${MAX_SKILLS_PER_ROOT} entries; inventory truncated.`);
    for (const entry of entries.slice(0, MAX_SKILLS_PER_ROOT)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const rel = `${relRoot}/${entry.name}`;
      const skill: InstalledSkill = {
        agent, path: rel, directoryName: entry.name, symlink: entry.isSymbolicLink(),
        manifest: { valid: false, problems: ["not inspected: symlinked skill directory"] }, userLevelSameName: [],
      };
      if (!skill.symlink) skill.manifest = await readManifest(path.join(projectRoot, rel, "SKILL.md"), entry.name);
      const name = skill.manifest.valid ? skill.manifest.name : entry.name;
      for (const userAgent of AGENT_TARGETS) {
        if (await exists(path.join(userSkillRoot(userAgent, home), name))) {
          skill.userLevelSameName.push(`~/${PROJECT_SKILL_ROOTS[userAgent]}/${name}`);
        }
      }
      inv.skills.push(skill);
    }
  }
  return inv;
}

async function readManifest(file: string, dirName: string): Promise<InstalledSkill["manifest"]> {
  const st = await lstat(file).catch(() => null);
  if (!st) return { valid: false, problems: ["SKILL.md is missing."] };
  if (!st.isFile()) return { valid: false, problems: ["SKILL.md is not a regular file."] };
  const { bytes, truncated } = await readBounded(file, MAX_SKILL_MD);
  if (truncated) return { valid: false, problems: [`SKILL.md exceeds ${MAX_SKILL_MD} bytes.`] };
  const parsed = parseSkillManifest(bytes.toString("utf8"));
  if (!parsed.ok) return { valid: false, problems: parsed.problems };
  const { name, description } = parsed.manifest;
  return { valid: true, name, description, nameMatchesDirectory: name === dirName };
}
