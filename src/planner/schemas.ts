import { z } from "zod";
import { PayloadFileSchema, SourceIdentitySchema } from "../storage/payload-cache.ts";

export const PLAN_DOMAIN = "skillpilot-plan-v1";
export const PLAN_LIMITS = { maxSkills: 5, maxTotalBytes: 20 * 1024 * 1024 } as const;

const SEVERITY = z.enum(["info", "low", "medium", "high", "critical"]);
const FindingSchema = z
  .object({
    id: z.string(), ruleId: z.string(), severity: SEVERITY, confidence: z.enum(["high", "medium", "low"]), file: z.string(),
    lineStart: z.number().int().optional(), lineEnd: z.number().int().optional(), occurrences: z.number().int(),
    explanation: z.string(), remediation: z.string(), blocking: z.boolean(), context: z.string().optional(),
  })
  .strict();
const AGENT = z.enum(["claude-code", "codex"]);
const DIGEST = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SUMMARY = z.object({ critical: z.number().int(), high: z.number().int(), medium: z.number().int(), low: z.number().int(), info: z.number().int() }).strict();
const LICENSE = z.object({ spdx: z.string(), files: z.array(z.string()) }).strict();

export const LockEntryProposalSchema = z
  .object({
    sourceId: z.string(), source: SourceIdentitySchema, name: z.string(), agent: AGENT, installPath: z.string(),
    license: LICENSE, payloadDigest: z.string(), files: z.array(PayloadFileSchema), ruleSet: z.string(), findingsSummary: SUMMARY, acknowledged: z.array(z.string()),
  })
  .strict();
export type LockEntryProposal = z.infer<typeof LockEntryProposalSchema>;

export const PlanSkillSchema = z
  .object({
    source: SourceIdentitySchema,
    name: z.string(),
    payloadDigest: z.string(),
    files: z.array(PayloadFileSchema),
    license: LICENSE,
    review: z.object({ ruleSet: z.string(), policyVersion: z.string(), coverage: z.literal("complete"), decision: z.literal("eligible"), findings: z.array(FindingSchema), acknowledged: z.array(z.string()) }).strict(),
    targets: z.array(z.object({ agent: AGENT, path: z.string() }).strict()),
  })
  .strict();

const LOCK_PRECONDITION = z.union([z.object({ state: z.literal("absent") }).strict(), z.object({ state: z.literal("present"), sha256: z.string() }).strict()]);

const common = {
  schemaVersion: z.literal(1),
  domain: z.literal(PLAN_DOMAIN),
  toolVersion: z.string(),
  projectRoot: z.string(),
  agents: z.array(AGENT).min(1),
  policy: z.object({ ruleSet: z.string(), payloadPolicy: z.string(), policyDigest: z.string() }).strict(),
  configDigest: z.string().nullable(),
  disclosures: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string(),
  planDigest: DIGEST,
};

export const InstallPlanSchema = z
  .object({
    ...common,
    operation: z.literal("install"),
    skills: z.array(PlanSkillSchema).min(1).max(PLAN_LIMITS.maxSkills),
    preconditions: z
      .object({
        lockfile: LOCK_PRECONDITION,
        // "managed" = already installed by SkillPilot with identical bytes; such targets are a no-op.
        targets: z.array(z.object({ agent: AGENT, path: z.string(), state: z.enum(["absent", "managed"]) }).strict()),
      })
      .strict(),
    lockfileChanges: z.array(z.object({ op: z.literal("add"), entry: LockEntryProposalSchema }).strict()),
  })
  .strict();
export type InstallPlan = z.infer<typeof InstallPlanSchema>;

export const RemovalSchema = z
  .object({ sourceId: z.string(), name: z.string(), agent: AGENT, path: z.string(), payloadDigest: z.string(), files: z.array(PayloadFileSchema) })
  .strict();
export type Removal = z.infer<typeof RemovalSchema>;

export const RemovePlanSchema = z
  .object({
    ...common,
    operation: z.literal("remove"),
    removals: z.array(RemovalSchema).min(1),
    preconditions: z
      .object({
        lockfile: z.object({ state: z.literal("present"), sha256: z.string() }).strict(),
        targets: z.array(z.object({ agent: AGENT, path: z.string(), state: z.literal("managed") }).strict()),
      })
      .strict(),
    lockfileChanges: z.array(z.object({ op: z.literal("remove"), sourceId: z.string(), agent: AGENT }).strict()),
  })
  .strict();
export type RemovePlan = z.infer<typeof RemovePlanSchema>;

export const PlanSchema = z.discriminatedUnion("operation", [InstallPlanSchema, RemovePlanSchema]);
export type Plan = z.infer<typeof PlanSchema>;
