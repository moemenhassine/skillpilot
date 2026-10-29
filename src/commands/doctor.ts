import { access, constants, lstat } from "node:fs/promises";
import path from "node:path";
import { AGENT_TARGETS, PROJECT_SKILL_ROOTS } from "../agents/index.ts";
import { SkillpilotError, toErrorObject, type ErrorObject } from "../errors.ts";
import { loadConfig } from "../schemas/config.ts";
import { escapeText as e } from "../renderers/escape.ts";
import type { CommandResult } from "../renderers/output.ts";
import { pendingState, recoverProject, type RecoveryResult } from "../installer/index.ts";
import { readLockfile } from "../storage/lockfile.ts";
import { cacheDir, MUTATION_LOCK_PATH, OPERATIONS_DIR } from "../storage/paths.ts";

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
  recovery: RecoveryResult | null;
}

export const SUPPORTED_NODE_MAJOR = 24;

/** Plain doctor never repairs; `recover` runs only journaled recovery for already-approved operations. */
export async function doctorCommand(projectRoot: string, opts: { recover?: boolean } = {}): Promise<CommandResult<DoctorData>> {
  const recovery = opts.recover ? await recoverProject(projectRoot) : null;
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

  try {
    const lock = await readLockfile(projectRoot);
    add("lockfile", "pass", lock.state === "absent" ? "No lockfile; no managed skills recorded." : `Lockfile is valid (schema 1, ${lock.lock.entries.length} entr${lock.lock.entries.length === 1 ? "y" : "ies"}).`);
  } catch (err) {
    add("lockfile", "fail", err instanceof SkillpilotError ? err.message : "Lockfile could not be read.");
    errors.push(toErrorObject(err));
  }

  const dir = cacheDir();
  const cacheExists = await lstat(dir).then(() => true, () => false);
  add("cache", "pass", cacheExists ? `Cache at ${dir}.` : `Cache location ${dir} (not created yet).`);

  const pending = await pendingState(projectRoot);
  if (pending.operations.length || pending.lock) {
    const what = `${pending.operations.length} unfinished operation(s) in ${OPERATIONS_DIR}/${pending.lock ? `, mutation lock ${pending.lock.alive ? "held by a running process" : "stale"}` : ""}`;
    add("recovery", pending.lock?.alive ? "warn" : "fail", `${what}.`);
    if (!pending.lock?.alive) errors.push({ code: "RECOVERY_REQUIRED", message: `Pending operation state: ${what}.`, nextAction: `Run skillpilot doctor --recover (it only rolls back or finishes journaled operations; ${MUTATION_LOCK_PATH} is removed afterwards).` });
  } else add("recovery", "pass", "No pending operations.");

  return { data: { projectRoot, cacheDir: dir, repositories, checks, recovery }, errors, text: renderDoctor };
}

function renderDoctor(d: DoctorData): string[] {
  const rec = d.recovery ? [d.recovery.operations.length || d.recovery.staleLockRemoved ? `Recovered: ${d.recovery.operations.map((o) => `${o.operationId} ${o.action}`).join(", ") || "no journals"}${d.recovery.staleLockRemoved ? "; stale mutation lock removed" : ""}` : "Recovery: nothing to recover."] : [];
  return [...rec, ...d.checks.map((c) => `${c.status.toUpperCase().padEnd(5)} ${c.id.padEnd(22)} ${e(c.message)}`)];
}
