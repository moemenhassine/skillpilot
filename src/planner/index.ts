import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AGENT_TARGETS, PROJECT_SKILL_ROOTS, type AgentTarget } from "../agents/index.ts";
import { SkillpilotError } from "../errors.ts";
import { SKILL_LIMITS } from "../fetcher/payload.ts";
import { reviewPayload, type ReviewResult } from "../review/index.ts";
import { PAYLOAD_POLICY_VERSION } from "../review/policy.ts";
import { RULE_SET_VERSION } from "../review/rules.ts";
import { CONFIG_PATH } from "../schemas/config.ts";
import { domainDigest, sha256Hex } from "../storage/canonical.ts";
import { LOCKFILE_PATH } from "../storage/paths.ts";
import { PayloadFileSchema, readPayload, SourceIdentitySchema, payloadDigest } from "../storage/payload-cache.ts";

export const PLAN_DOMAIN = "skillpilot-plan-v1";
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const PLAN_LIMITS = { maxSkills: 5, maxTotalBytes: 20 * 1024 * 1024 } as const;
export const RESERVED_NAMES: Record<AgentTarget, string[]> = { "claude-code": ["synced"], codex: [] };

const SEVERITY = z.enum(["info", "low", "medium", "high", "critical"]);
const FindingSchema = z
  .object({
    id: z.string(), ruleId: z.string(), severity: SEVERITY, confidence: z.enum(["high", "medium", "low"]), file: z.string(),
    lineStart: z.number().int().optional(), lineEnd: z.number().int().optional(), occurrences: z.number().int(),
    explanation: z.string(), remediation: z.string(), blocking: z.boolean(), context: z.string().optional(),
  })
  .strict();
const AGENT = z.enum(["claude-code", "codex"]);
const SUMMARY = z.object({ critical: z.number().int(), high: z.number().int(), medium: z.number().int(), low: z.number().int(), info: z.number().int() }).strict();

export const LockEntryProposalSchema = z
  .object({
    sourceId: z.string(), source: SourceIdentitySchema, name: z.string(), agent: AGENT, installPath: z.string(),
    license: z.object({ spdx: z.string(), files: z.array(z.string()) }).strict(),
    payloadDigest: z.string(), files: z.array(PayloadFileSchema), ruleSet: z.string(), findingsSummary: SUMMARY, acknowledged: z.array(z.string()),
  })
  .strict();
export type LockEntryProposal = z.infer<typeof LockEntryProposalSchema>;

export const PlanSkillSchema = z
  .object({
    source: SourceIdentitySchema,
    name: z.string(),
    payloadDigest: z.string(),
    files: z.array(PayloadFileSchema),
    license: z.object({ spdx: z.string(), files: z.array(z.string()) }).strict(),
    review: z.object({ ruleSet: z.string(), policyVersion: z.string(), coverage: z.literal("complete"), decision: z.literal("eligible"), findings: z.array(FindingSchema), acknowledged: z.array(z.string()) }).strict(),
    targets: z.array(z.object({ agent: AGENT, path: z.string() }).strict()),
  })
  .strict();

export const PlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    domain: z.literal(PLAN_DOMAIN),
    operation: z.enum(["install", "remove"]),
    toolVersion: z.string(),
    projectRoot: z.string(),
    agents: z.array(AGENT).min(1),
    skills: z.array(PlanSkillSchema).min(1).max(PLAN_LIMITS.maxSkills),
    policy: z.object({ ruleSet: z.string(), payloadPolicy: z.string(), policyDigest: z.string() }).strict(),
    configDigest: z.string().nullable(),
    preconditions: z
      .object({
        lockfile: z.union([z.object({ state: z.literal("absent") }).strict(), z.object({ state: z.literal("present"), sha256: z.string() }).strict()]),
        targets: z.array(z.object({ agent: AGENT, path: z.string(), state: z.literal("absent") }).strict()),
      })
      .strict(),
    lockfileChanges: z.array(z.object({ op: z.literal("add"), entry: LockEntryProposalSchema }).strict()),
    disclosures: z.array(z.string()),
    createdAt: z.string(),
    expiresAt: z.string(),
    planDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;

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

/** Lockfile proposals are derived, never free-form; the executor adds planDigest and installedAt at commit. */
export function deriveLockChanges(skills: Plan["skills"]): Plan["lockfileChanges"] {
  return skills.flatMap((s) =>
    s.targets.map((t) => ({
      op: "add" as const,
      entry: {
        sourceId: `${s.source.owner.toLowerCase()}/${s.source.repository.toLowerCase()}#${s.source.skillPath}`,
        source: s.source, name: s.name, agent: t.agent, installPath: t.path, license: s.license,
        payloadDigest: s.payloadDigest, files: s.files, ruleSet: s.review.ruleSet,
        findingsSummary: severityCounts(s.review.findings),
        acknowledged: s.review.acknowledged,
      },
    })),
  ).sort((a, b) => (a.entry.sourceId + a.entry.agent < b.entry.sourceId + b.entry.agent ? -1 : 1));
}

async function assertNotRedirected(projectRoot: string, rel: string): Promise<boolean> {
  const st = await lstat(path.join(projectRoot, rel)).catch(() => null);
  if (st?.isSymbolicLink()) throw new SkillpilotError("TARGET_CONFLICT", `${rel} is a symlink; SkillPilot refuses redirected destinations.`, `Replace ${rel} with a regular directory.`);
  if (st && !st.isDirectory()) throw new SkillpilotError("TARGET_CONFLICT", `${rel} exists and is not a directory.`, `Remove or rename ${rel}.`);
  return Boolean(st);
}

/** Current target and lockfile state; any existing target (or case-fold sibling) is a conflict in M3. */
export async function readPreconditions(projectRoot: string, targets: { agent: AgentTarget; path: string }[]): Promise<Plan["preconditions"]> {
  await assertNotRedirected(projectRoot, ".skillpilot");
  for (const root of Object.values(PROJECT_SKILL_ROOTS)) {
    await assertNotRedirected(projectRoot, path.posix.dirname(root));
    if (await assertNotRedirected(projectRoot, root)) {
      const names = new Map((await readdir(path.join(projectRoot, root))).map((n) => [n.toLowerCase(), n]));
      for (const t of targets.filter((t) => PROJECT_SKILL_ROOTS[t.agent] === root)) {
        const existing = names.get(path.posix.basename(t.path).toLowerCase());
        if (existing) throw new SkillpilotError("TARGET_CONFLICT", `${root}/${existing} already exists; SkillPilot never overwrites it.`, "Remove or rename the existing skill directory, or choose a different skill.", { path: `${root}/${existing}` });
      }
    }
  }
  const lock = await readFile(path.join(projectRoot, LOCKFILE_PATH)).catch(() => null);
  if (lock) {
    let ok: boolean;
    try { ok = (JSON.parse(lock.toString("utf8")) as { schemaVersion?: unknown }).schemaVersion === 1; } catch { ok = false; }
    if (!ok) throw new SkillpilotError("INVALID_SCHEMA", "The lockfile is malformed or uses an unknown schema; mutations are blocked.", `Restore ${LOCKFILE_PATH} from version control.`);
  }
  return {
    lockfile: lock ? { state: "present", sha256: sha256Hex(lock) } : { state: "absent" },
    targets: targets.map((t) => ({ ...t, state: "absent" as const })),
  };
}

export interface BuildPlanInput {
  projectRoot: string;
  agents: AgentTarget[];
  reviews: ReviewResult[];
  acknowledged: string[];
  now: Date;
  toolVersion: string;
}

/** Builds a complete install plan; fails the whole selection if any skill is ineligible (spec 14.2). */
export async function buildPlan(input: BuildPlanInput): Promise<Plan> {
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
  const agents = AGENT_TARGETS.filter((a) => input.agents.includes(a));
  const skills: Plan["skills"] = reviews
    .map((r) => ({
      source: r.source, name: r.name!, payloadDigest: r.payloadDigest,
      files: [...r.files].sort((a, b) => (a.path < b.path ? -1 : 1)),
      license: { spdx: r.license.spdx!, files: r.license.files },
      review: { ruleSet: r.ruleSet, policyVersion: r.policyVersion, coverage: "complete" as const, decision: "eligible" as const, findings: r.findings, acknowledged: r.acknowledged },
      targets: agents.map((agent) => ({ agent, path: targetPath(agent, r.name!) })),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const targets = skills.flatMap((s) => s.targets);
  const config = await readFile(path.join(input.projectRoot, CONFIG_PATH)).catch(() => null);
  const prereqs = reviews.map((r) => r.disclosures.compatibility).filter((x): x is string => Boolean(x));
  const plan: Omit<Plan, "planDigest"> = {
    schemaVersion: 1, domain: PLAN_DOMAIN, operation: "install", toolVersion: input.toolVersion, projectRoot: input.projectRoot, agents, skills,
    policy: { ruleSet: RULE_SET_VERSION, payloadPolicy: PAYLOAD_POLICY_VERSION, policyDigest: currentPolicyDigest() },
    configDigest: config ? `sha256:${sha256Hex(config)}` : null,
    preconditions: await readPreconditions(input.projectRoot, targets),
    lockfileChanges: deriveLockChanges(skills),
    disclosures: [
      "All files are installed as regular non-executable files (mode 0644); source bytes are otherwise unchanged.",
      ...(agents.length > 1 ? ["Two independent copies are written, one per agent directory."] : []),
      ...prereqs.map((p) => `Upstream compatibility note: ${p}`),
      "SkillPilot never runs bundled scripts or installs dependencies. Restart running agent sessions after installation.",
    ],
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + PLAN_TTL_MS).toISOString(),
  };
  return { ...plan, planDigest: computePlanDigest(plan) };
}

/**
 * Validates a plan independently of its stored fields (FR-036): schema, digest, clock, policy, targets,
 * cached bytes, a fresh review under the installed rule set, and derived lockfile changes.
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
  if (plan.operation !== "install") throw new SkillpilotError("INVALID_ARGUMENT", "Removal plans are not supported until M4.", "Use an install plan.");
  const agents = AGENT_TARGETS.filter((a) => plan.agents.includes(a));
  if (agents.length !== plan.agents.length || agents.some((a, i) => a !== plan.agents[i])) throw new SkillpilotError("INVALID_SCHEMA", "Plan agents are not canonical.", "Regenerate the plan.");
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
  if (JSON.stringify(deriveLockChanges(plan.skills)) !== JSON.stringify(plan.lockfileChanges)) throw new SkillpilotError("PLAN_STALE", "Proposed lockfile changes do not match the planned skills.", "Regenerate the plan.");
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
