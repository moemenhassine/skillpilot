import { access, constants, lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_TARGETS, PROJECT_SKILL_ROOTS } from "../agents/index.ts";
import { SkillpilotError, toErrorObject, type ErrorObject } from "../errors.ts";
import { loadConfig } from "../schemas/config.ts";
import { escapeText as e } from "../renderers/escape.ts";
import type { CommandResult } from "../renderers/output.ts";
import { cacheDir, LOCKFILE_PATH, MUTATION_LOCK_PATH, OPERATIONS_DIR } from "../storage/paths.ts";

export interface Check {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface DoctorData {
  projectRoot: string;
  cacheDir: string;
  repositories: string[];
  checks: Check[];
}

export const SUPPORTED_NODE_MAJOR = 24;

export async function doctorCommand(projectRoot: string): Promise<CommandResult<DoctorData>> {
  const checks: Check[] = [];
  const errors: ErrorObject[] = [];
  const add = (id: string, status: Check["status"], message: string) => checks.push({ id, status, message });

  const major = Number(process.versions.node.split(".")[0]);
  add("runtime", major === SUPPORTED_NODE_MAJOR ? "pass" : "warn", `Node.js ${process.versions.node}; supported major is ${SUPPORTED_NODE_MAJOR}.`);
  add("project-root", "pass", `Project root resolved to ${projectRoot}.`);

  let repositories: string[] = [];
  try {
    const config = await loadConfig(projectRoot);
    repositories = config?.repositories ?? [];
    add("config", "pass", config ? ".skillpilot/config.json is valid." : "No project config (optional).");
  } catch (err) {
    errors.push(toErrorObject(err));
    add("config", "fail", err instanceof SkillpilotError ? err.message : "Config could not be read.");
  }
  add("sources", "pass", repositories.length ? `Configured repositories: ${repositories.join(", ")}.` : "No configured repositories; bundled catalog only.");

  for (const agent of AGENT_TARGETS) {
    const rel = PROJECT_SKILL_ROOTS[agent];
    const problems: string[] = [];
    for (const p of [path.dirname(rel), rel]) {
      const st = await lstat(path.join(projectRoot, p)).catch(() => null);
      if (st?.isSymbolicLink()) problems.push(`${p} is a symlink`);
      else if (st && !st.isDirectory()) problems.push(`${p} is not a directory`);
    }
    add(`destination:${agent}`, problems.length ? "fail" : "pass", problems.length ? `${problems.join("; ")}; installs will be refused.` : `${rel} is a valid destination.`);
    if (problems.length) errors.push({ code: "TARGET_CONFLICT", message: `${agent} destination is invalid.`, nextAction: `Replace ${rel} with a regular directory.` });
  }

  const writable = await access(projectRoot, constants.W_OK).then(() => true, () => false);
  add("writable", writable ? "pass" : "fail", writable ? "Project root is writable." : "Project root is not writable.");
  if (!writable) errors.push({ code: "IO_ERROR", message: "Project root is not writable.", nextAction: "Fix directory permissions before installing." });

  const lockRaw = await readFile(path.join(projectRoot, LOCKFILE_PATH), "utf8").catch(() => null);
  if (lockRaw === null) add("lockfile", "pass", "No lockfile; no managed skills recorded.");
  else {
    let version: unknown;
    try {
      version = (JSON.parse(lockRaw) as { schemaVersion?: unknown }).schemaVersion;
    } catch {
      version = undefined;
    }
    if (version === 1) add("lockfile", "pass", "Lockfile is JSON with schemaVersion 1.");
    else {
      add("lockfile", "fail", "Lockfile is malformed or has an unknown schema; mutations are blocked.");
      errors.push({ code: "INVALID_SCHEMA", message: "Malformed or unsupported lockfile.", nextAction: `Restore ${LOCKFILE_PATH} from version control.` });
    }
  }

  const dir = cacheDir();
  const cacheExists = await lstat(dir).then(() => true, () => false);
  add("cache", "pass", cacheExists ? `Cache at ${dir}.` : `Cache location ${dir} (not created yet).`);

  const journals = (await readdir(path.join(projectRoot, OPERATIONS_DIR)).catch(() => [])).filter((f) => f.endsWith(".json"));
  const locked = await lstat(path.join(projectRoot, MUTATION_LOCK_PATH)).then(() => true, () => false);
  if (journals.length || locked) {
    add("recovery", "warn", `Pending operation state found (${journals.length} journal(s)${locked ? ", mutation lock present" : ""}).`);
  } else add("recovery", "pass", "No pending operations.");

  return { data: { projectRoot, cacheDir: dir, repositories, checks }, errors, text: renderDoctor };
}

function renderDoctor(d: DoctorData): string[] {
  return d.checks.map((c) => `${c.status.toUpperCase().padEnd(5)} ${c.id.padEnd(22)} ${e(c.message)}`);
}
