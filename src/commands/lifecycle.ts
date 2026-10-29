import { lstat } from "node:fs/promises";
import path from "node:path";
import { AGENT_TARGETS } from "../agents/index.ts";
import { inventorySkills } from "../analyzer/inventory.ts";
import { readBounded } from "../analyzer/fsutil.ts";
import { SkillpilotError, toErrorObject, type ErrorObject } from "../errors.ts";
import { executePlan, previewPlan, type ExecuteResult, type FaultHook } from "../installer/index.ts";
import { compareDir } from "../installer/snapshot.ts";
import { buildRemovePlan, targetPath, verifyPlan, writePlanFile, type Plan, type RemovePlan } from "../planner/index.ts";
import { escapeText as e } from "../renderers/escape.ts";
import type { CommandResult } from "../renderers/output.ts";
import { confirmPhrase, renderPlan } from "../renderers/plan.ts";
import { readLockfile } from "../storage/lockfile.ts";
import { cacheDir } from "../storage/paths.ts";
import { parseAgents } from "./search.ts";

const VERSION = "0.1.0";
const MAX_PLAN_BYTES = 4 * 1024 * 1024;

/** Reads one line from the user; resolves null on EOF. Rejects with CANCELLED on interrupt. */
export type Prompt = (question: string) => Promise<string | null>;

export interface InstallOptions {
  plan?: string | undefined;
  approve?: string | undefined;
  /** JSON mode is always noninteractive (spec 13.2). */
  json: boolean;
  interactive: boolean;
  prompt?: Prompt;
  cacheRoot?: string;
  now?: Date;
  hooks?: FaultHook;
  /** Lines shown before the interactive prompt. */
  display?: (lines: string[]) => void;
}

async function readPlanFile(file: string): Promise<unknown> {
  const st = await lstat(file).catch(() => null);
  if (!st?.isFile()) throw new SkillpilotError("INVALID_ARGUMENT", `${file} is not a regular plan file.`, "Pass the path written by skillpilot plan --out or skillpilot remove --out.");
  const { bytes, truncated } = await readBounded(file, MAX_PLAN_BYTES);
  if (truncated) throw new SkillpilotError("INVALID_SCHEMA", "The plan file is too large.", "Regenerate the plan.");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SkillpilotError("INVALID_SCHEMA", "The plan file is not valid JSON.", "Regenerate the plan.");
  }
}

export async function installCommand(projectRoot: string, opts: InstallOptions): Promise<CommandResult<ExecuteResult>> {
  if (!opts.plan) throw new SkillpilotError("INVALID_ARGUMENT", "--plan is required.", "Example: skillpilot install --plan .skillpilot/plans/install.json");
  const json = await readPlanFile(opts.plan);
  const now = opts.now ?? new Date();
  const cacheRoot = opts.cacheRoot ?? cacheDir();
  // Blocked, incomplete, expired, or tampered plans are rejected before any approval is requested.
  const plan = await verifyPlan(json, { cacheRoot, now });
  const state = await previewPlan(plan, { projectRoot, cacheRoot, now, toolVersion: VERSION });
  let approve = opts.approve;
  if (approve === undefined) {
    if (opts.json || !opts.interactive || !opts.prompt) {
      throw new SkillpilotError("APPROVAL_REQUIRED", `This ${plan.operation} plan needs explicit approval; nothing was changed.`, "Show the plan to the user and, after they approve this exact plan, rerun with --approve <complete plan digest>.", { planDigest: plan.planDigest, operation: plan.operation });
    }
    opts.display?.([...renderPlan(plan), ...(state === "no-op" ? ["This plan is already applied; approving it changes nothing."] : [])]);
    const phrase = confirmPhrase(plan);
    const answer = await opts.prompt(`Type "${phrase}" to approve, anything else to cancel: `);
    if (answer === null || answer.trim() !== phrase) throw new SkillpilotError("APPROVAL_DECLINED", "Approval was not given; nothing was changed.", "Rerun skillpilot install when you are ready to approve this plan.");
    approve = plan.planDigest;
  }
  const result = await executePlan(json, { projectRoot, cacheRoot, now, toolVersion: VERSION, approve, ...(opts.hooks ? { hooks: opts.hooks } : {}) });
  return { data: result, text: renderExecute };
}

function renderExecute(r: ExecuteResult): string[] {
  if (r.outcome === "no-op") return [`Nothing to do: the ${r.operation} plan is already applied.`, ...r.unchanged.map((t) => `  = ${t.path}/ (${t.agent}, unchanged)`)];
  const verb = r.outcome === "installed" ? "Installed" : "Removed";
  return [
    ...r.changed.map((t) => `${verb} ${t.path}/ (${t.agent})`),
    ...r.unchanged.map((t) => `Unchanged ${t.path}/ (${t.agent}, already installed)`),
    `Lockfile ${r.lockfile}: .skillpilot/lock.json (plan ${r.planDigest})`,
    "Restart running agent sessions to pick up the change; an already-running agent may still hold earlier instructions.",
  ];
}

export async function removeCommand(projectRoot: string, installedId: string, opts: { agent?: string | undefined; out?: string | undefined; now?: Date }): Promise<CommandResult<{ plan: RemovePlan; path: string }>> {
  if (!opts.agent) throw new SkillpilotError("INVALID_ARGUMENT", "--agent is required for removal planning.", "Pass --agent claude-code, --agent codex, or --agent both.");
  if (!opts.out) throw new SkillpilotError("INVALID_ARGUMENT", "--out is required for removal planning.", "Example: --out .skillpilot/plans/remove.json");
  const plan = await buildRemovePlan({ projectRoot, installedId, agents: parseAgents(opts.agent), now: opts.now ?? new Date(), toolVersion: VERSION });
  const written = await writePlanFile(projectRoot, opts.out, plan);
  return {
    data: { plan, path: written },
    text: (d) => [...renderPlan(d.plan as Plan), `Saved: ${d.path}`, `Nothing has been removed. Apply with: skillpilot install --plan ${d.path}`],
  };
}

export type ListState = "managed" | "modified" | "missing" | "unmanaged" | "agent-incompatible";

export interface ListEntry {
  /** Installed ID for removal (managed entries) or the project-relative path (unmanaged). */
  id: string;
  name: string;
  agent: string;
  path: string;
  state: ListState;
  details?: Record<string, unknown>;
}

export async function listCommand(projectRoot: string): Promise<CommandResult<{ lockfile: "absent" | "present" | "invalid"; entries: ListEntry[] }>> {
  const errors: ErrorObject[] = [];
  const entries: ListEntry[] = [];
  let lockState: "absent" | "present" | "invalid";
  let lockEntries: Awaited<ReturnType<typeof readLockfile>> = { state: "absent" };
  try {
    lockEntries = await readLockfile(projectRoot);
    lockState = lockEntries.state;
  } catch (err) {
    lockState = "invalid";
    errors.push(toErrorObject(err));
  }
  const owned = new Set<string>();
  for (const l of lockEntries.state === "present" ? lockEntries.lock.entries : []) {
    owned.add(l.installPath);
    const base: Omit<ListEntry, "state"> = { id: l.sourceId, name: l.name, agent: l.agent, path: l.installPath };
    if (!AGENT_TARGETS.includes(l.agent) || l.installPath !== targetPath(l.agent, l.name)) { entries.push({ ...base, state: "agent-incompatible", details: { reason: "path does not follow the fixed agent mapping" } }); continue; }
    const cmp = await compareDir(path.join(projectRoot, l.installPath), l.files);
    entries.push(cmp.state === "identical" ? { ...base, state: "managed" } : cmp.state === "absent" ? { ...base, state: "missing" } : { ...base, state: "modified", details: { changed: cmp.changed, missing: cmp.missing, extra: cmp.extra } });
  }
  const inv = await inventorySkills(projectRoot);
  for (const s of inv.skills.filter((s) => !owned.has(s.path))) {
    const name = s.manifest.valid ? s.manifest.name : s.directoryName;
    const reason = s.symlink ? "symlinked skill directory" : !s.manifest.valid ? s.manifest.problems.join("; ") : !s.manifest.nameMatchesDirectory ? "manifest name does not match its directory" : null;
    entries.push({ id: s.path, name, agent: s.agent, path: s.path, state: reason ? "agent-incompatible" : "unmanaged", ...(reason ? { details: { reason } } : {}) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    data: { lockfile: lockState, entries },
    warnings: inv.warnings,
    errors,
    text: (d) => d.entries.length
      ? d.entries.map((x) => `${x.state.padEnd(18)} ${x.agent.padEnd(11)} ${e(x.path)}${x.state === "managed" || x.state === "modified" || x.state === "missing" ? `  id: ${e(x.id)}` : ""}${x.details?.reason ? `  (${e(String(x.details.reason))})` : ""}`)
      : ["No skills installed in this project's agent skill directories."],
  };
}
