import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_TARGETS, PROJECT_SKILL_ROOTS, type AgentTarget } from "../agents/index.ts";
import { SkillpilotError } from "../errors.ts";
import { SKILL_LIMITS } from "../fetcher/payload.ts";
import { reviewPayload, type ReviewResult } from "../review/index.ts";
import { PAYLOAD_POLICY_VERSION } from "../review/policy.ts";
import { RULE_SET_VERSION } from "../review/rules.ts";
import { CONFIG_PATH } from "../schemas/config.ts";
import { domainDigest, sha256Hex } from "../storage/canonical.ts";
import { LOCKFILE_PATH } from "../storage/paths.ts";
import { compareDir } from "../installer/snapshot.ts";
import { sourceId } from "../sources/catalog.ts";
import { lockKey, readLockfile, type LockfileRead } from "../storage/lockfile.ts";
import { readPayload, payloadDigest } from "../storage/payload-cache.ts";
import { PLAN_DOMAIN, PLAN_LIMITS, PlanSchema, type InstallPlan, type Plan, type RemovePlan } from "./schemas.ts";

export { PLAN_DOMAIN, PLAN_LIMITS, PlanSchema, type InstallPlan, type Plan, type RemovePlan } from "./schemas.ts";

export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const RESERVED_NAMES: Record<AgentTarget, string[]> = { "claude-code": ["synced"], codex: [] };

export function currentPolicyDigest(): string {
  return domainDigest("skillpilot-policy-v1", { ruleSet: RULE_SET_VERSION, payloadPolicy: PAYLOAD_POLICY_VERSION, skillLimits: SKILL_LIMITS, planLimits: PLAN_LIMITS, roots: PROJECT_SKILL_ROOTS });
}

export const computePlanDigest = (plan: Omit<Plan, "planDigest"> | Plan) => {
  const { planDigest: _ignored, ...rest } = plan as Plan;
  void _ignored;
  return domainDigest(PLAN_DOMAIN, rest);
};

export const targetPath = (agent: AgentTarget, name: string) => `${PROJECT_SKILL_ROOTS[agent]}/${name}`;

function severityCounts(findings: { severity: "info" | "low" | "medium" | "high" | "critical" }[]) {
  const c = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

/** Lockfile proposals are derived, never free-form; the executor adds planDigest, installedAt, and toolVersion at commit. */
export function deriveLockChanges(skills: InstallPlan["skills"], preconditions: InstallPlan["preconditions"]): InstallPlan["lockfileChanges"] {
  const managed = new Set(preconditions.targets.filter((t) => t.state === "managed").map((t) => t.path));
  return skills.flatMap((s) =>
    s.targets.filter((t) => !managed.has(t.path)).map((t) => ({
      op: "add" as const,
      entry: {
        sourceId: sourceId(s.source),
        source: s.source, name: s.name, agent: t.agent, installPath: t.path, license: s.license,
        payloadDigest: s.payloadDigest, files: s.files, ruleSet: s.review.ruleSet,
        findingsSummary: severityCounts(s.review.findings),
        acknowledged: s.review.acknowledged,
      },
    })),
  ).sort((a, b) => (lockKey(a.entry) < lockKey(b.entry) ? -1 : 1));
}

async function assertNotRedirected(projectRoot: string, rel: string): Promise<boolean> {
  const st = await lstat(path.join(projectRoot, rel)).catch(() => null);
  if (st?.isSymbolicLink()) throw new SkillpilotError("TARGET_CONFLICT", `${rel} is a symlink; SkillPilot refuses redirected destinations.`, `Replace ${rel} with a regular directory.`);
  if (st && !st.isDirectory()) throw new SkillpilotError("TARGET_CONFLICT", `${rel} exists and is not a directory.`, `Remove or rename ${rel}.`);
  return Boolean(st);
}

/** Rejects symlinked or non-directory `.skillpilot` and agent-root ancestors (spec 13.3). */
export async function checkAncestors(projectRoot: string): Promise<void> {
  await assertNotRedirected(projectRoot, ".skillpilot");
  for (const root of Object.values(PROJECT_SKILL_ROOTS)) {
    await assertNotRedirected(projectRoot, path.posix.dirname(root));
    await assertNotRedirected(projectRoot, root);
  }
}

export interface TargetIntent {
  agent: AgentTarget;
  path: string;
  sourceId: string;
  payloadDigest: string;
  files: InstallPlan["skills"][number]["files"];
}

/**
 * Current target and lockfile state for an install. A target is "absent", or "managed" when the lockfile
 * records this exact payload there and every owned byte is unchanged (FR-044 no-op). Anything else conflicts.
 */
export async function readPreconditions(projectRoot: string, targets: TargetIntent[], lock?: LockfileRead): Promise<InstallPlan["preconditions"]> {
  await checkAncestors(projectRoot);
  const lockfile = lock ?? (await readLockfile(projectRoot));
  const entries = lockfile.state === "present" ? lockfile.lock.entries : [];
  const out: InstallPlan["preconditions"]["targets"] = [];
  for (const t of targets) {
    const root = PROJECT_SKILL_ROOTS[t.agent];
    const names = await readdir(path.join(projectRoot, root)).catch(() => [] as string[]);
    const existing = names.find((n) => n.toLowerCase() === path.posix.basename(t.path).toLowerCase());
    const entry = entries.find((e) => e.installPath.toLowerCase() === t.path.toLowerCase());
    if (!existing && !entry) { out.push({ agent: t.agent, path: t.path, state: "absent" }); continue; }
    const at = `${root}/${existing ?? path.posix.basename(t.path)}`;
    if (!entry) throw new SkillpilotError("TARGET_CONFLICT", `${at} already exists and is not managed by SkillPilot; it is never overwritten.`, "Remove or rename the existing skill directory, or choose a different skill.", { path: at, state: "unmanaged" });
    if (!existing) throw new SkillpilotError("TARGET_CONFLICT", `The lockfile records ${entry.installPath} but the directory is missing.`, `Restore it from version control, or remove the stale entry from ${LOCKFILE_PATH} by hand.`, { path: entry.installPath, state: "missing" });
    if (entry.sourceId !== t.sourceId || entry.payloadDigest !== t.payloadDigest || existing !== path.posix.basename(t.path)) {
      throw new SkillpilotError("TARGET_CONFLICT", `${at} is managed for a different source or revision; updates are not supported.`, `Create a removal plan with skillpilot remove ${entry.sourceId} --agent ${entry.agent}, apply it, then plan this install again.`, { path: at, state: "managed-other" });
    }
    const cmp = await compareDir(path.join(projectRoot, t.path), entry.files);
    if (cmp.state !== "identical") throw new SkillpilotError("TARGET_CONFLICT", `${at} is managed but has local changes; it is never overwritten.`, "Reconcile the local edits manually.", { path: at, state: "modified", ...(cmp.state === "modified" ? { changed: cmp.changed, missing: cmp.missing, extra: cmp.extra } : {}) });
    out.push({ agent: t.agent, path: t.path, state: "managed" });
  }
  return { lockfile: lockfile.state === "present" ? { state: "present", sha256: lockfile.sha256 } : { state: "absent" }, targets: out };
}

export const planIntents = (skills: InstallPlan["skills"]): TargetIntent[] =>
  skills.flatMap((s) => s.targets.map((t) => ({ ...t, sourceId: sourceId(s.source), payloadDigest: s.payloadDigest, files: s.files })));

export interface BuildPlanInput {
  projectRoot: string;
  agents: AgentTarget[];
  reviews: ReviewResult[];
  acknowledged: string[];
  now: Date;
  toolVersion: string;
}

async function commonFields(projectRoot: string, agents: AgentTarget[], now: Date, toolVersion: string) {
  const config = await readFile(path.join(projectRoot, CONFIG_PATH)).catch(() => null);
  return {
    schemaVersion: 1 as const, domain: PLAN_DOMAIN as typeof PLAN_DOMAIN, toolVersion, projectRoot, agents: AGENT_TARGETS.filter((a) => agents.includes(a)),
    policy: { ruleSet: RULE_SET_VERSION, payloadPolicy: PAYLOAD_POLICY_VERSION, policyDigest: currentPolicyDigest() },
    configDigest: config ? `sha256:${sha256Hex(config)}` : null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
  };
}

/** Builds a complete install plan; fails the whole selection if any skill is ineligible (spec 14.2). */
export async function buildPlan(input: BuildPlanInput): Promise<InstallPlan> {
  const { reviews } = input;
  if (reviews.length > PLAN_LIMITS.maxSkills) throw new SkillpilotError("INVALID_ARGUMENT", `A plan may contain at most ${PLAN_LIMITS.maxSkills} skills.`, "Split the selection into several plans.");
  const total = reviews.reduce((n, r) => n + r.files.reduce((m, f) => m + f.size, 0), 0);
  if (total > PLAN_LIMITS.maxTotalBytes) throw new SkillpilotError("POLICY_BLOCKED", "The combined payload exceeds 20 MiB.", "Select fewer skills.");

  const mediumIds = new Set(reviews.flatMap((r) => r.findings.filter((f) => f.severity === "medium").map((f) => f.id)));
  const unknownAcks = input.acknowledged.filter((id) => !mediumIds.has(id));
  if (unknownAcks.length) throw new SkillpilotError("INVALID_ARGUMENT", `--ack does not match a medium finding in this selection: ${unknownAcks.join(", ")}.`, "Acknowledge only the medium finding IDs shown by review.");

  const diagnostics = reviews.map((r) => ({ source: `${r.source.owner}/${r.source.repository}#${r.source.skillPath}`, coverage: r.coverage, decision: r.decision, blocking: r.findings.filter((f) => f.blocking).map((f) => `${f.id} ${f.ruleId} ${f.file}`) }));
  if (reviews.some((r) => r.coverage === "incomplete")) throw new SkillpilotError("REVIEW_INCOMPLETE", "Review coverage is incomplete for at least one selected skill; no plan was produced.", "Inspect `skillpilot review` output; incomplete payloads cannot be installed.", { diagnostics });
  if (reviews.some((r) => r.decision === "blocked")) throw new SkillpilotError("POLICY_BLOCKED", "At least one selected skill has blocking findings; no plan was produced.", "Remove the blocked skill from the selection. High findings cannot be overridden.", { diagnostics });
  const pending = reviews.flatMap((r) => r.findings.filter((f) => f.severity === "medium" && !input.acknowledged.includes(f.id)).map((f) => f.id));
  if (pending.length) throw new SkillpilotError("POLICY_BLOCKED", `Medium findings require acknowledgment: ${pending.join(", ")}.`, `After reviewing them, regenerate the plan with ${pending.map((id) => `--ack ${id}`).join(" ")}.`, { requiresAcknowledgment: pending });

  const names = new Map<string, string>();
  for (const r of reviews) {
    const prev = names.get(r.name!.toLowerCase());
    if (prev) throw new SkillpilotError("INVALID_ARGUMENT", `Two selected skills share the name ${r.name}.`, "Select only one of them.");
    names.set(r.name!.toLowerCase(), r.name!);
    for (const a of input.agents) if (RESERVED_NAMES[a].includes(r.name!.toLowerCase())) throw new SkillpilotError("INVALID_ARGUMENT", `${r.name} is a reserved skill name for ${a}.`, "Choose a different skill.");
  }
  const common = await commonFields(input.projectRoot, input.agents, input.now, input.toolVersion);
  const skills: InstallPlan["skills"] = reviews
    .map((r) => ({
      source: r.source, name: r.name!, payloadDigest: r.payloadDigest,
      files: [...r.files].sort((a, b) => (a.path < b.path ? -1 : 1)),
      license: { spdx: r.license.spdx!, files: r.license.files },
      review: { ruleSet: r.ruleSet, policyVersion: r.policyVersion, coverage: "complete" as const, decision: "eligible" as const, findings: r.findings, acknowledged: r.acknowledged },
      targets: common.agents.map((agent) => ({ agent, path: targetPath(agent, r.name!) })),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const preconditions = await readPreconditions(input.projectRoot, planIntents(skills));
  const prereqs = reviews.map((r) => r.disclosures.compatibility).filter((x): x is string => Boolean(x));
  const plan: Omit<InstallPlan, "planDigest"> = {
    ...common, operation: "install", skills, preconditions,
    lockfileChanges: deriveLockChanges(skills, preconditions),
    disclosures: [
      "All files are installed as regular non-executable files (mode 0644); source bytes are otherwise unchanged.",
      ...(common.agents.length > 1 ? ["Two independent copies are written, one per agent directory."] : []),
      ...(preconditions.targets.some((t) => t.state === "managed") ? ["Targets already installed by SkillPilot with identical content are left unchanged."] : []),
      ...prereqs.map((p) => `Upstream compatibility note: ${p}`),
      "SkillPilot never runs bundled scripts or installs dependencies. Restart running agent sessions after installation.",
    ],
  };
  return { ...plan, planDigest: computePlanDigest(plan) };
}

/** Current removal preconditions: every owned file is present and byte-identical, with nothing added. */
export async function readRemovalState(projectRoot: string, removals: RemovePlan["removals"], lock?: LockfileRead): Promise<RemovePlan["preconditions"]> {
  await checkAncestors(projectRoot);
  const lockfile = lock ?? (await readLockfile(projectRoot));
  if (lockfile.state !== "present") throw new SkillpilotError("PLAN_STALE", "There is no lockfile; nothing is managed by SkillPilot.", "Run skillpilot list.");
  for (const r of removals) {
    const entry = lockfile.lock.entries.find((e) => e.sourceId === r.sourceId && e.agent === r.agent);
    if (!entry || entry.installPath !== r.path || entry.payloadDigest !== r.payloadDigest || JSON.stringify(entry.files) !== JSON.stringify(r.files)) {
      throw new SkillpilotError("PLAN_STALE", `Lockfile ownership for ${r.path} does not match.`, "Run skillpilot list and create a new removal plan.");
    }
    const cmp = await compareDir(path.join(projectRoot, r.path), r.files);
    if (cmp.state !== "identical") {
      throw new SkillpilotError("TARGET_CONFLICT", `${r.path} is ${cmp.state === "absent" ? "missing" : "locally modified"}; removal only deletes exact, unchanged managed content.`, "Reconcile local changes manually; SkillPilot will not delete edited or added files.", { path: r.path, ...(cmp.state === "modified" ? { changed: cmp.changed, missing: cmp.missing, extra: cmp.extra } : { state: "missing" }) });
    }
  }
  return { lockfile: { state: "present", sha256: lockfile.sha256 }, targets: removals.map((r) => ({ agent: r.agent, path: r.path, state: "managed" as const })) };
}

export const deriveRemovalChanges = (removals: RemovePlan["removals"]): RemovePlan["lockfileChanges"] => removals.map((r) => ({ op: "remove" as const, sourceId: r.sourceId, agent: r.agent }));

/** Builds a removal plan for one installed ID (a lockfile source ID) and the selected targets. */
export async function buildRemovePlan(input: { projectRoot: string; installedId: string; agents: AgentTarget[]; now: Date; toolVersion: string }): Promise<RemovePlan> {
  const lock = await readLockfile(input.projectRoot);
  const entries = lock.state === "present" ? lock.lock.entries : [];
  const common = await commonFields(input.projectRoot, input.agents, input.now, input.toolVersion);
  const removals: RemovePlan["removals"] = common.agents.map((agent) => {
    const e = entries.find((x) => x.sourceId === input.installedId && x.agent === agent);
    if (!e) throw new SkillpilotError("INVALID_ARGUMENT", `${input.installedId} is not managed by SkillPilot for ${agent}.`, "Run skillpilot list to see installed IDs.");
    return { sourceId: e.sourceId, name: e.name, agent, path: e.installPath, payloadDigest: e.payloadDigest, files: e.files };
  });
  const plan: Omit<RemovePlan, "planDigest"> = {
    ...common, operation: "remove", removals,
    preconditions: await readRemovalState(input.projectRoot, removals, lock),
    lockfileChanges: deriveRemovalChanges(removals),
    disclosures: [
      "Only the files recorded in the lockfile are removed; parent directories and other skills are untouched.",
      "Removing a skill does not unload instructions already loaded in a running agent session.",
    ],
  };
  return { ...plan, planDigest: computePlanDigest(plan) };
}

/**
 * Validates a plan independently of its stored fields (FR-036): schema, digest, clock, policy, targets,
 * cached bytes, a fresh review under the installed rule set, and derived lockfile changes.
 * Target preconditions are checked by the executor, which reads the live project state.
 */
export async function verifyPlan(json: unknown, opts: { cacheRoot: string; now: Date }): Promise<Plan> {
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) throw new SkillpilotError("INVALID_SCHEMA", "The plan file failed schema validation.", "Regenerate the plan with skillpilot plan.", { issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) });
  const plan = parsed.data;
  if (computePlanDigest(plan) !== plan.planDigest) throw new SkillpilotError("PLAN_STALE", "The plan was modified after it was generated; its digest no longer matches.", "Regenerate the plan and approve the new digest.");
  const created = Date.parse(plan.createdAt), expires = Date.parse(plan.expiresAt), now = opts.now.getTime();
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires - created !== PLAN_TTL_MS || created > now + CLOCK_SKEW_MS) throw new SkillpilotError("INVALID_SCHEMA", "The plan has invalid or future timestamps.", "Regenerate the plan.");
  if (now > expires) throw new SkillpilotError("PLAN_EXPIRED", "The plan expired (plans are valid for 24 hours).", "Regenerate the plan and approve it again.");
  if (plan.policy.policyDigest !== currentPolicyDigest() || plan.policy.ruleSet !== RULE_SET_VERSION || plan.policy.payloadPolicy !== PAYLOAD_POLICY_VERSION) {
    throw new SkillpilotError("PLAN_STALE", "The plan was produced under a different review policy.", "Regenerate the plan with this SkillPilot version.");
  }
  const agents = AGENT_TARGETS.filter((a) => plan.agents.includes(a));
  if (agents.length !== plan.agents.length || agents.some((a, i) => a !== plan.agents[i])) throw new SkillpilotError("INVALID_SCHEMA", "Plan agents are not canonical.", "Regenerate the plan.");
  if (plan.operation === "remove") {
    const expected = agents.flatMap((a) => plan.removals.filter((r) => r.agent === a));
    if (expected.length !== plan.removals.length || expected.some((r, i) => r !== plan.removals[i] || r.path !== targetPath(r.agent, r.name))) throw new SkillpilotError("PLAN_STALE", "Removal targets differ from the fixed agent mapping.", "Regenerate the removal plan.");
    if (JSON.stringify(deriveRemovalChanges(plan.removals)) !== JSON.stringify(plan.lockfileChanges)) throw new SkillpilotError("PLAN_STALE", "Proposed lockfile changes do not match the planned removals.", "Regenerate the removal plan.");
    return plan;
  }
  for (const s of plan.skills) {
    const expectedTargets = agents.map((agent) => ({ agent, path: targetPath(agent, s.name) }));
    if (JSON.stringify(s.targets) !== JSON.stringify(expectedTargets)) throw new SkillpilotError("PLAN_STALE", `Targets for ${s.name} differ from the fixed agent mapping.`, "Regenerate the plan.");
    const cached = await readPayload(opts.cacheRoot, s.source);
    if (cached.state !== "ok") throw new SkillpilotError("PLAN_STALE", `Cached payload for ${s.name} is ${cached.state === "absent" ? "missing" : `corrupt (${cached.reason})`}.`, "Regenerate the plan to refetch and re-review it.");
    if (payloadDigest(s.source, cached.manifest.files) !== s.payloadDigest || JSON.stringify([...cached.manifest.files].sort((a, b) => (a.path < b.path ? -1 : 1))) !== JSON.stringify(s.files)) {
      throw new SkillpilotError("PLAN_STALE", `Cached payload for ${s.name} differs from the planned payload.`, "Regenerate the plan.");
    }
    const fresh = reviewPayload(cached.manifest, cached.bytes, s.review.acknowledged);
    const sameFindings = JSON.stringify(fresh.findings.map((f) => f.id).sort()) === JSON.stringify(s.review.findings.map((f) => f.id).sort());
    if (fresh.decision !== "eligible" || fresh.coverage !== "complete") throw new SkillpilotError("POLICY_BLOCKED", `Independent review of ${s.name} is ${fresh.coverage === "complete" ? fresh.decision : "incomplete"}.`, "The plan cannot be executed.");
    if (!sameFindings || fresh.name !== s.name || fresh.license.spdx !== s.license.spdx) throw new SkillpilotError("PLAN_STALE", `Review findings for ${s.name} differ from the plan.`, "Regenerate the plan and review the findings again.");
  }
  const targetPaths = plan.skills.flatMap((s) => s.targets.map((t) => `${t.agent}:${t.path}`));
  if (JSON.stringify(plan.preconditions.targets.map((t) => `${t.agent}:${t.path}`)) !== JSON.stringify(targetPaths)) throw new SkillpilotError("PLAN_STALE", "Target preconditions do not cover exactly the planned targets.", "Regenerate the plan.");
  if (JSON.stringify(deriveLockChanges(plan.skills, plan.preconditions)) !== JSON.stringify(plan.lockfileChanges)) throw new SkillpilotError("PLAN_STALE", "Proposed lockfile changes do not match the planned skills.", "Regenerate the plan.");
  return plan;
}

/** Validates and creates a new plan file strictly beneath `<project>/.skillpilot/plans/`. */
export async function writePlanFile(projectRoot: string, out: string, plan: Plan): Promise<string> {
  const abs = path.resolve(out);
  const plansDir = path.join(projectRoot, ".skillpilot", "plans");
  const rel = path.relative(plansDir, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep) || !rel.endsWith(".json")) {
    throw new SkillpilotError("INVALID_ARGUMENT", "--out must be a new .json file directly inside .skillpilot/plans/ of the project.", "Example: --out .skillpilot/plans/install.json");
  }
  for (const dir of [path.join(projectRoot, ".skillpilot"), plansDir]) {
    const st = await lstat(dir).catch(() => null);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new SkillpilotError("INVALID_ARGUMENT", `${path.relative(projectRoot, dir)} is not a regular directory.`, "Replace it with a regular directory.");
    if (!st) await mkdir(dir);
  }
  try {
    await writeFile(abs, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new SkillpilotError("INVALID_ARGUMENT", `${path.relative(projectRoot, abs)} already exists; plans are never overwritten.`, "Choose a new file name.");
    throw err;
  }
  return path.relative(projectRoot, abs).split(path.sep).join("/");
}
