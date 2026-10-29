import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PROJECT_SKILL_ROOTS } from "../agents/index.ts";
import { SkillpilotError } from "../errors.ts";
import { checkAncestors, planIntents, readPreconditions, readRemovalState, verifyPlan, type InstallPlan, type Plan, type RemovePlan } from "../planner/index.ts";
import { sha256Hex } from "../storage/canonical.ts";
import { lockKey, readLockfile, serializeLockfile, writeFileAtomic, type LockEntry, type LockfileRead } from "../storage/lockfile.ts";
import { LOCKFILE_PATH, MUTATION_LOCK_PATH, OPERATIONS_DIR } from "../storage/paths.ts";
import { PayloadFileSchema, payloadDigest, readPayload, type PayloadFile } from "../storage/payload-cache.ts";
import { compareDir, type OwnedFile } from "./snapshot.ts";

/** Thrown by test fault hooks to simulate a process kill: no rollback, no lock release. */
export class SimulatedCrash extends Error {}

/** Called after every durable transition. Only tests pass hooks; the CLI never exposes them. */
export type FaultHook = (point: string) => void | Promise<void>;

const MutationLockSchema = z.object({ pid: z.number().int(), hostname: z.string(), operationId: z.string(), createdAt: z.string() }).strict();
type MutationLock = z.infer<typeof MutationLockSchema>;

const StepSchema = z.object({ kind: z.enum(["promote", "demote"]), from: z.string(), to: z.string(), files: z.array(PayloadFileSchema) }).strict();
const JournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string(),
    operation: z.enum(["install", "remove"]),
    planDigest: z.string(),
    state: z.enum(["prepared", "committed"]),
    steps: z.array(StepSchema),
    lockfile: z.object({ before: z.union([z.object({ state: z.literal("absent") }).strict(), z.object({ state: z.literal("present"), sha256: z.string() }).strict()]), after: z.object({ sha256: z.string() }).strict() }).strict(),
  })
  .strict();
type Journal = z.infer<typeof JournalSchema>;

const JOURNAL = "journal.json";
const LOCK_BACKUP = "lock.before.json";
/** Operation IDs whose mutation lock is held by this process (simultaneous in-process mutations). */
const held = new Set<string>();

const abs = (root: string, rel: string) => path.join(root, ...rel.split("/"));
const exists = (p: string) => lstat(p).then(() => true, () => false);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readMutationLock(projectRoot: string): Promise<{ lock: MutationLock | null; alive: boolean; foreign: boolean } | null> {
  const raw = await readFile(abs(projectRoot, MUTATION_LOCK_PATH), "utf8").catch(() => null);
  if (raw === null) return null;
  let lock: MutationLock | null;
  try { lock = MutationLockSchema.parse(JSON.parse(raw)); } catch { lock = null; }
  if (!lock) return { lock: null, alive: false, foreign: true };
  if (held.has(lock.operationId)) return { lock, alive: true, foreign: false };
  if (lock.hostname !== os.hostname()) return { lock, alive: false, foreign: true };
  // shortcut: liveness is PID-based (no process start time); a reused PID reads as alive and blocks conservatively.
  return { lock, alive: lock.pid !== process.pid && processAlive(lock.pid), foreign: false };
}

async function acquireLock(projectRoot: string, operationId: string, now: Date): Promise<void> {
  const body: MutationLock = { pid: process.pid, hostname: os.hostname(), operationId, createdAt: now.toISOString() };
  try {
    const fh = await open(abs(projectRoot, MUTATION_LOCK_PATH), "wx", 0o644);
    try { await fh.writeFile(JSON.stringify(body, null, 2) + "\n"); await fh.sync(); } finally { await fh.close(); }
    held.add(operationId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const state = await readMutationLock(projectRoot);
    if (state?.alive) throw new SkillpilotError("MUTATION_LOCKED", "Another SkillPilot mutation is running in this project.", "Wait for it to finish, then retry.", { operationId: state.lock?.operationId });
    throw new SkillpilotError("RECOVERY_REQUIRED", "A previous SkillPilot mutation did not finish (stale mutation lock).", "Run skillpilot doctor --recover, then retry.", { operationId: state?.lock?.operationId ?? null });
  }
}

async function releaseLock(projectRoot: string, operationId: string): Promise<void> {
  const state = await readMutationLock(projectRoot);
  if (state?.lock?.operationId === operationId) await unlink(abs(projectRoot, MUTATION_LOCK_PATH));
  held.delete(operationId);
}

async function writeJournal(opDir: string, journal: Journal): Promise<void> {
  await writeFileAtomic(path.join(opDir, JOURNAL), Buffer.from(JSON.stringify(journal, null, 2) + "\n"));
}

const listOperations = async (projectRoot: string) => (await readdir(abs(projectRoot, OPERATIONS_DIR)).catch(() => [] as string[])).sort();

async function stagePayload(dir: string, files: OwnedFile[], bytes: Map<string, Uint8Array>): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o755 });
  for (const f of files) {
    const target = abs(dir, f.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    const fh = await open(target, "wx", 0o644);
    try { await fh.writeFile(bytes.get(f.path)!); await fh.sync(); } finally { await fh.close(); }
    await chmod(target, 0o644);
  }
}

export interface ExecuteOptions {
  projectRoot: string;
  cacheRoot: string;
  now: Date;
  toolVersion: string;
  /** The complete `sha256:` plan digest the user approved. */
  approve: string;
  hooks?: FaultHook;
}

export interface ExecuteResult {
  operation: Plan["operation"];
  planDigest: string;
  outcome: "installed" | "removed" | "no-op";
  changed: { agent: string; path: string }[];
  unchanged: { agent: string; path: string }[];
  lockfile: "created" | "updated" | "unchanged";
}

/**
 * Applies an approved install or removal plan (spec 13.4). Order: validate plan and fresh review →
 * project identity → approval → lock → pending-recovery check → live preconditions → stage → journal →
 * promote → lockfile → commit → cleanup. On failure, rolls back from the journal or reports a conflict.
 */
export async function executePlan(planJson: unknown, opts: ExecuteOptions): Promise<ExecuteResult> {
  const plan = await verifyPlan(planJson, { cacheRoot: opts.cacheRoot, now: opts.now });
  assertProject(plan, opts.projectRoot);
  if (opts.approve !== plan.planDigest) throw new SkillpilotError("APPROVAL_MISMATCH", "The supplied approval does not match this plan's digest; nothing was changed.", "Review the plan and pass its complete digest with --approve.");
  const hook = opts.hooks ?? (() => {});
  const root = opts.projectRoot;

  await checkAncestors(root);
  if (!(await exists(abs(root, ".skillpilot")))) await mkdir(abs(root, ".skillpilot"));
  const operationId = `${opts.now.toISOString().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`;
  await acquireLock(root, operationId, opts.now);
  let crashed = false;
  const opRel = `${OPERATIONS_DIR}/${operationId}`;
  const opDir = abs(root, opRel);
  let journaled = false;
  try {
    await hook("locked");
    const pending = await listOperations(root);
    if (pending.length) throw new SkillpilotError("RECOVERY_REQUIRED", "An earlier operation is unfinished.", "Run skillpilot doctor --recover, then retry.", { operations: pending });

    const lock = await readLockfile(root);
    const prepared = plan.operation === "install" ? await prepareInstall(plan, lock, opts) : await prepareRemove(plan, lock, opts);
    if (prepared.noop) return { operation: plan.operation, planDigest: plan.planDigest, outcome: "no-op", changed: [], unchanged: prepared.unchanged, lockfile: "unchanged" };

    await mkdir(opDir, { recursive: true });
    const steps: Journal["steps"] = [];
    for (const [i, s] of prepared.steps.entries()) {
      if (s.kind === "promote") {
        await stagePayload(path.join(opDir, "staged", String(i)), s.files, s.bytes!);
        if ((await compareDir(path.join(opDir, "staged", String(i)), s.files)).state !== "identical") throw new SkillpilotError("IO_ERROR", "Staged files do not match the plan.", "Retry; check disk health if this repeats.");
        steps.push({ kind: "promote", from: `${opRel}/staged/${i}`, to: s.target, files: s.files });
      } else steps.push({ kind: "demote", from: s.target, to: `${opRel}/backup/${i}`, files: s.files });
    }
    await hook("staged");

    const newLock = serializeLockfile(prepared.entries);
    if (lock.state === "present") await writeFileAtomic(path.join(opDir, LOCK_BACKUP), lock.bytes);
    const journal: Journal = {
      schemaVersion: 1, operationId, operation: plan.operation, planDigest: plan.planDigest, state: "prepared", steps,
      lockfile: { before: lock.state === "present" ? { state: "present", sha256: lock.sha256 } : { state: "absent" }, after: { sha256: sha256Hex(newLock) } },
    };
    await writeJournal(opDir, journal);
    journaled = true;
    await hook("journaled");

    for (const [i, s] of steps.entries()) {
      await checkAncestors(root);
      if (s.kind === "promote") {
        await mkdir(path.dirname(abs(root, s.to)), { recursive: true });
        await checkAncestors(root);
        if (await exists(abs(root, s.to))) throw new SkillpilotError("TARGET_CONFLICT", `${s.to} appeared after planning; it was not overwritten.`, "Inspect the directory, then regenerate the plan.");
        await rename(abs(root, s.from), abs(root, s.to));
      } else {
        if ((await compareDir(abs(root, s.from), s.files)).state !== "identical") throw new SkillpilotError("TARGET_CONFLICT", `${s.from} changed after planning; it was not removed.`, "Inspect the directory, then regenerate the removal plan.");
        await mkdir(path.dirname(abs(root, s.to)), { recursive: true });
        await rename(abs(root, s.from), abs(root, s.to));
      }
      await hook(`moved:${i}`);
    }

    await writeFileAtomic(abs(root, LOCKFILE_PATH), newLock);
    await hook("lockfile");
    await writeJournal(opDir, { ...journal, state: "committed" });
    await hook("committed");
    await rm(opDir, { recursive: true });
    await hook("cleaned");
    return {
      operation: plan.operation, planDigest: plan.planDigest, outcome: plan.operation === "install" ? "installed" : "removed",
      changed: prepared.steps.map((s) => ({ agent: s.agent, path: s.target })), unchanged: prepared.unchanged,
      lockfile: lock.state === "present" ? "updated" : "created",
    };
  } catch (err) {
    if (err instanceof SimulatedCrash) { crashed = true; held.delete(operationId); throw err; }
    if (journaled) {
      try {
        await recoverOperation(root, operationId);
      } catch (recoveryErr) {
        if (recoveryErr instanceof SkillpilotError) throw recoveryErr;
        throw new SkillpilotError("RECOVERY_REQUIRED", "The operation failed and automatic rollback could not finish.", "Run skillpilot doctor --recover; evidence is preserved under .skillpilot/operations/.", { operationId });
      }
    } else {
      await rm(opDir, { recursive: true, force: true }).catch(() => {});
    }
    if (err instanceof SkillpilotError) throw err;
    throw new SkillpilotError("IO_ERROR", `The operation failed and was rolled back: ${(err as NodeJS.ErrnoException).code ?? "filesystem error"}.`, "Fix the filesystem problem and retry with the same plan.");
  } finally {
    if (!crashed) await releaseLock(root, operationId);
  }
}

function assertProject(plan: Plan, projectRoot: string): void {
  if (plan.projectRoot !== projectRoot) throw new SkillpilotError("PLAN_STALE", "The plan was generated for a different project root.", `Run the command from ${plan.projectRoot} or regenerate the plan here.`);
}

/** Read-only check used before prompting: stale targets or lockfile are rejected before approval is requested. */
export async function previewPlan(plan: Plan, opts: Pick<ExecuteOptions, "projectRoot" | "cacheRoot" | "now" | "toolVersion">): Promise<"ready" | "no-op"> {
  assertProject(plan, opts.projectRoot);
  const pending = await pendingState(opts.projectRoot);
  if (pending.lock?.alive) throw new SkillpilotError("MUTATION_LOCKED", "Another SkillPilot mutation is running in this project.", "Wait for it to finish, then retry.");
  if (pending.lock || pending.operations.length) throw new SkillpilotError("RECOVERY_REQUIRED", "A previous SkillPilot mutation did not finish.", "Run skillpilot doctor --recover, then retry.", { operations: pending.operations });
  await checkAncestors(opts.projectRoot);
  const lock = await readLockfile(opts.projectRoot);
  const prepared = plan.operation === "install" ? await prepareInstall(plan, lock, opts) : await prepareRemove(plan, lock, opts);
  return prepared.noop ? "no-op" : "ready";
}

interface PreparedStep { kind: "promote" | "demote"; agent: string; target: string; files: PayloadFile[]; bytes?: Map<string, Uint8Array> }
interface Prepared { noop: boolean; steps: PreparedStep[]; unchanged: { agent: string; path: string }[]; entries: LockEntry[] }

async function prepareInstall(plan: InstallPlan, lock: LockfileRead, opts: Pick<ExecuteOptions, "projectRoot" | "cacheRoot" | "now" | "toolVersion">): Promise<Prepared> {
  const current = await readPreconditions(opts.projectRoot, planIntents(plan.skills), lock);
  const unchanged = current.targets.filter((t) => t.state === "managed").map((t) => ({ agent: t.agent, path: t.path }));
  if (current.targets.every((t) => t.state === "managed")) return { noop: true, steps: [], unchanged, entries: [] };
  if (JSON.stringify(current) !== JSON.stringify(plan.preconditions)) throw new SkillpilotError("PLAN_STALE", "Project state changed since the plan was created (lockfile or targets).", "Regenerate the plan and approve the new digest.");
  const steps: PreparedStep[] = [];
  for (const s of plan.skills) {
    const cached = await readPayload(opts.cacheRoot, s.source);
    if (cached.state !== "ok" || payloadDigest(s.source, cached.manifest.files) !== s.payloadDigest) throw new SkillpilotError("PLAN_STALE", `Cached payload for ${s.name} changed after approval.`, "Regenerate the plan.");
    for (const t of s.targets) if (!unchanged.some((u) => u.path === t.path)) steps.push({ kind: "promote", agent: t.agent, target: t.path, files: s.files, bytes: cached.bytes });
  }
  const added: LockEntry[] = plan.lockfileChanges.map((c) => ({ ...c.entry, planDigest: plan.planDigest, installedAt: opts.now.toISOString(), toolVersion: opts.toolVersion }));
  const keys = new Set(added.map(lockKey));
  const entries = [...(lock.state === "present" ? lock.lock.entries.filter((e) => !keys.has(lockKey(e))) : []), ...added];
  return { noop: false, steps, unchanged, entries };
}

async function prepareRemove(plan: RemovePlan, lock: LockfileRead, opts: Pick<ExecuteOptions, "projectRoot">): Promise<Prepared> {
  const entries = lock.state === "present" ? lock.lock.entries : [];
  const gone = await Promise.all(plan.removals.map(async (r) => !entries.some((e) => e.sourceId === r.sourceId && e.agent === r.agent) && !(await exists(abs(opts.projectRoot, r.path)))));
  if (gone.every(Boolean)) return { noop: true, steps: [], unchanged: [], entries: [] };
  const current = await readRemovalState(opts.projectRoot, plan.removals, lock);
  if (JSON.stringify(current) !== JSON.stringify(plan.preconditions)) throw new SkillpilotError("PLAN_STALE", "The lockfile changed since the removal plan was created.", "Regenerate the removal plan and approve the new digest.");
  const removed = new Set(plan.lockfileChanges.map(lockKey));
  return {
    noop: false,
    steps: plan.removals.map((r) => ({ kind: "demote" as const, agent: r.agent, target: r.path, files: r.files })),
    unchanged: [],
    entries: entries.filter((e) => !removed.has(lockKey(e))),
  };
}

function validJournalPath(p: string, operationId: string): boolean {
  if (p.split("/").some((seg) => seg === ".." || seg === "" || seg === ".")) return false;
  if (p.startsWith(`${OPERATIONS_DIR}/${operationId}/`)) return true;
  return Object.values(PROJECT_SKILL_ROOTS).some((r) => p.startsWith(`${r}/`) && !p.slice(r.length + 1).includes("/"));
}

export type RecoveryAction = "rolled-back" | "completed-cleanup" | "discarded-staging";

/**
 * Restores the previous consistent state for one journaled operation, or finishes cleanup of a committed one.
 * Every action is checked before any is taken; an unexpected file or hash is a preserved conflict.
 */
export async function recoverOperation(projectRoot: string, operationId: string): Promise<RecoveryAction> {
  const opDir = abs(projectRoot, `${OPERATIONS_DIR}/${operationId}`);
  const raw = await readFile(path.join(opDir, JOURNAL), "utf8").catch(() => null);
  if (raw === null) {
    // No journal means nothing was promoted: the directory holds only staged copies.
    await rm(opDir, { recursive: true, force: true });
    return "discarded-staging";
  }
  let journal: Journal;
  try { journal = JournalSchema.parse(JSON.parse(raw)); } catch {
    throw new SkillpilotError("RECOVERY_REQUIRED", `The journal for ${operationId} is unreadable; nothing was changed.`, `Inspect ${OPERATIONS_DIR}/${operationId}/ and restore targets manually.`, { operationId });
  }
  if (journal.operationId !== operationId || journal.steps.some((s) => !validJournalPath(s.from, operationId) || !validJournalPath(s.to, operationId))) {
    throw new SkillpilotError("RECOVERY_REQUIRED", `The journal for ${operationId} references unexpected paths; nothing was changed.`, "Inspect the journal and restore targets manually.", { operationId });
  }
  if (journal.state === "committed") {
    await rm(opDir, { recursive: true });
    return "completed-cleanup";
  }

  const conflicts: string[] = [];
  const actions: (() => Promise<void>)[] = [];
  const lockAbs = abs(projectRoot, LOCKFILE_PATH);
  const curLock = await readFile(lockAbs).catch(() => null);
  const cur = curLock ? sha256Hex(curLock) : null;
  const before = journal.lockfile.before.state === "present" ? journal.lockfile.before.sha256 : null;
  if (cur === journal.lockfile.after.sha256 && cur !== before) {
    if (before) {
      const backup = await readFile(path.join(opDir, LOCK_BACKUP)).catch(() => null);
      if (!backup || sha256Hex(backup) !== before) conflicts.push(`${LOCKFILE_PATH}: backup missing or altered`);
      else actions.push(() => writeFileAtomic(lockAbs, backup));
    } else actions.push(() => unlink(lockAbs));
  } else if (cur !== before) conflicts.push(`${LOCKFILE_PATH}: changed by something other than this operation`);

  // Each move is one atomic rename from `from` to `to`, so the owned tree is in exactly one of the two places.
  for (const s of [...journal.steps].reverse()) {
    const atTo = await compareDir(abs(projectRoot, s.to), s.files);
    const atFrom = await compareDir(abs(projectRoot, s.from), s.files);
    if (atFrom.state === "absent" && atTo.state === "identical") actions.push(() => rename(abs(projectRoot, s.to), abs(projectRoot, s.from)));
    else if (atFrom.state === "absent") conflicts.push(atTo.state === "absent" ? `${s.to}: owned files are missing from both ${s.from} and ${s.to}` : `${s.to}: contents changed after the move`);
    else if (s.kind === "promote" ? atFrom.state !== "identical" : atTo.state !== "absent") conflicts.push(`${s.to}: unexpected state`);
    // otherwise the move never happened; anything else at the destination is not ours and stays untouched
  }
  if (conflicts.length) {
    throw new SkillpilotError("RECOVERY_REQUIRED", `Operation ${operationId} cannot be rolled back automatically; nothing was changed.`, `Resolve the listed conflicts manually. Evidence is preserved under ${OPERATIONS_DIR}/${operationId}/.`, { operationId, conflicts });
  }
  for (const act of actions) await act();
  await rm(opDir, { recursive: true });
  return "rolled-back";
}

export interface RecoveryResult {
  operations: { operationId: string; action: RecoveryAction }[];
  staleLockRemoved: boolean;
}

/** `doctor --recover`: bound to existing journals only; never starts a new selection. */
export async function recoverProject(projectRoot: string): Promise<RecoveryResult> {
  const lockState = await readMutationLock(projectRoot);
  if (lockState?.alive) throw new SkillpilotError("MUTATION_LOCKED", "A SkillPilot mutation is still running; recovery was not attempted.", "Wait for it to finish.", { operationId: lockState.lock?.operationId });
  if (lockState?.foreign) throw new SkillpilotError("RECOVERY_REQUIRED", "The mutation lock is unreadable or was created on another host; its owner cannot be verified.", `Confirm no SkillPilot process is running, then delete ${MUTATION_LOCK_PATH} manually and rerun doctor --recover.`);
  // shortcut: two concurrent `doctor --recover` runs are not serialized; recovery steps are idempotent re-checks.
  const operations: RecoveryResult["operations"] = [];
  for (const id of await listOperations(projectRoot)) operations.push({ operationId: id, action: await recoverOperation(projectRoot, id) });
  if (lockState) await unlink(abs(projectRoot, MUTATION_LOCK_PATH));
  return { operations, staleLockRemoved: Boolean(lockState) };
}

export async function pendingState(projectRoot: string): Promise<{ operations: string[]; lock: Awaited<ReturnType<typeof readMutationLock>> }> {
  return { operations: await listOperations(projectRoot), lock: await readMutationLock(projectRoot) };
}
