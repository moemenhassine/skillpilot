// JSON contracts for every `--json` command (FR-052). Each schema is checked at compile time against
// the TypeScript type the command actually returns, so the published JSON Schemas cannot drift.
import { z } from "zod";
import type { ProjectAnalysis } from "../analyzer/index.ts";
import type { DoctorData } from "../commands/doctor.ts";
import type { ListEntry } from "../commands/lifecycle.ts";
import type { RecommendData } from "../commands/recommend.ts";
import type { SearchData } from "../commands/search.ts";
import { ERROR_CODES } from "../errors.ts";
import type { ExecuteResult } from "../installer/index.ts";
import { InstallPlanSchema, RemovePlanSchema } from "../planner/schemas.ts";
import { GOAL_TAGS } from "../recommender/taxonomy.ts";
import type { ReviewResult } from "../review/index.ts";
import { CatalogEntrySchema } from "../sources/catalog.ts";
import type { SourceStatus } from "../sources/discovery.ts";
import { PayloadFileSchema, SourceIdentitySchema } from "../storage/payload-cache.ts";

const AGENT = z.enum(["claude-code", "codex"]);
const CONFIDENCE = z.enum(["high", "medium", "low"]);
const GOAL = z.enum(GOAL_TAGS);

export const ErrorObjectSchema = z
  .object({ code: z.enum(ERROR_CODES), message: z.string(), nextAction: z.string(), details: z.record(z.string(), z.unknown()).optional() })
  .strict();

/** The envelope every `--json` command writes as its only stdout output. */
export const envelope = <T extends z.ZodType>(command: string, data: T) =>
  z
    .object({
      schemaVersion: z.literal(1),
      command: z.literal(command),
      status: z.enum(["ok", "partial", "error"]),
      data: data.nullable(),
      warnings: z.array(z.string()),
      errors: z.array(ErrorObjectSchema),
    })
    .strict();

const EvidenceSchema = z.object({ path: z.string(), key: z.string(), token: z.string(), confidence: CONFIDENCE, origin: z.enum(["detected", "user-declared"]) }).strict();
const InstalledSkillSchema = z
  .object({
    agent: AGENT, path: z.string(), directoryName: z.string(), symlink: z.boolean(), userLevelSameName: z.array(z.string()),
    manifest: z.union([
      z.object({ valid: z.literal(true), name: z.string(), description: z.string(), nameMatchesDirectory: z.boolean() }).strict(),
      z.object({ valid: z.literal(false), problems: z.array(z.string()) }).strict(),
    ]),
  })
  .strict();

export const ScanDataSchema = z
  .object({
    projectRoot: z.string(),
    detectedStack: z.array(z.object({ token: z.string(), confidence: CONFIDENCE, evidenceCount: z.number().int() }).strict()),
    effectiveStack: z.array(z.string()),
    stackOrigin: z.enum(["cli", "config", "detected", "none"]),
    stackNotes: z.array(z.string()),
    goal: z.string().nullable(),
    evidence: z.array(EvidenceSchema),
    monorepo: z.object({ detected: z.boolean(), childPackages: z.array(z.string()) }).strict(),
    inventory: z.object({ skills: z.array(InstalledSkillSchema), warnings: z.array(z.string()) }).strict(),
    scan: z
      .object({
        filesRead: z.array(z.string()), bytesRead: z.number().int(), entriesVisited: z.number().int(),
        skipped: z.array(z.object({ path: z.string(), reason: z.enum(["secret", "symlink", "special-file", "unreadable"]) }).strict()),
        excludedDirs: z.number().int(), ignoredCount: z.number().int(), limitHits: z.array(z.string()),
        unparsed: z.array(z.object({ path: z.string(), reason: z.string() }).strict()), inspectedCategories: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export const DoctorDataSchema = z
  .object({
    projectRoot: z.string(), cacheDir: z.string(), repositories: z.array(z.string()),
    checks: z.array(z.object({ id: z.string(), status: z.enum(["pass", "warn", "fail"]), message: z.string() }).strict()),
    recovery: z
      .object({
        operations: z.array(z.object({ operationId: z.string(), action: z.enum(["rolled-back", "completed-cleanup", "discarded-staging"]) }).strict()),
        staleLockRemoved: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const SourceStatusSchema = z
  .object({
    id: z.string(), kind: z.enum(["bundled", "repository"]), state: z.enum(["loaded", "cached", "refreshed", "not-cached", "failed"]),
    commit: z.string().optional(), fetchedAt: z.string().optional(), skills: z.number().int(), invalid: z.number().int().optional(),
  })
  .strict();

export const SearchDataSchema = z
  .object({
    query: z.string(), queryTasks: z.array(GOAL), queryStack: z.array(z.string()), searched: z.number().int(),
    results: z.array(
      z.object({ id: z.string(), name: z.string(), matchedTasks: z.array(GOAL), matchedStack: z.array(z.string()), nameMatch: z.boolean(), license: z.string().nullable(), discoveredVia: z.array(z.string()), limitations: z.array(z.string()) }).strict(),
    ),
  })
  .strict();

const SUPPORT = CatalogEntrySchema.shape.agents.shape.codex;
export const RecommendDataSchema = z
  .object({
    scoringVersion: z.literal("fit-v1"),
    applicableStack: z.array(z.string()),
    goalTags: z.array(GOAL),
    recommendations: z.array(
      z
        .object({
          rank: z.number().int(), id: z.string(), name: z.string(), description: z.string(), source: CatalogEntrySchema.shape.source,
          score: z.object({ stackFit: z.number(), goalFit: z.number(), compatibility: z.number(), metadataCompleteness: z.number(), base: z.number(), redundancyPenalty: z.number(), final: z.number() }).strict(),
          matchedStack: z.array(z.object({ projectToken: z.string(), candidateTag: z.string() }).strict()),
          matchedGoals: z.array(GOAL),
          compatibility: z.object({ "claude-code": SUPPORT, codex: SUPPORT }).strict(),
          license: CatalogEntrySchema.shape.license,
          prerequisites: z.array(z.string()).nullable(),
          limitations: z.array(z.string()),
          reviewState: z.enum(["not-reviewed", "reviewed", "incomplete", "stale"]),
          discoveredVia: z.array(z.string()),
        })
        .strict(),
    ),
    notes: z.array(z.string()),
    project: z
      .object({ root: z.string(), effectiveStack: z.array(z.string()), stackOrigin: z.string(), evidence: z.array(z.object({ path: z.string(), key: z.string(), token: z.string() }).strict()) })
      .strict(),
    goal: z.string().nullable(),
    agents: z.array(z.string()),
    agentAssumption: z.string().nullable(),
    sources: z.array(SourceStatusSchema),
    searched: z.number().int(),
    exclusions: z.array(z.object({ id: z.string(), reason: z.string(), base: z.number().optional() }).strict()).optional(),
  })
  .strict();

const FindingSchema = InstallPlanSchema.shape.skills.element.shape.review.shape.findings.element;
export const ReviewDataSchema = z
  .object({
    ruleSet: z.literal("rules-v1"),
    policyVersion: z.literal("payload-v2"),
    source: SourceIdentitySchema,
    name: z.string().nullable(),
    description: z.string().nullable(),
    payloadDigest: z.string(),
    files: z.array(PayloadFileSchema),
    coverage: z.enum(["complete", "incomplete"]),
    decision: z.enum(["eligible", "requires-acknowledgment", "blocked"]),
    findings: z.array(FindingSchema),
    acknowledged: z.array(z.string()),
    license: z.object({ spdx: z.string().nullable(), files: z.array(z.string()), manifestField: z.string().nullable(), problem: z.string().nullable() }).strict(),
    disclosures: z
      .object({ scripts: z.array(z.string()), images: z.array(z.string()), externalDomains: z.array(z.string()), targetSpecificFrontmatter: z.array(z.string()), compatibility: z.string().nullable(), fileModeNormalization: z.string() })
      .strict(),
  })
  .strict();

export const PlanDataSchema = z.object({ plan: InstallPlanSchema, path: z.string().nullable() }).strict();
export const RemoveDataSchema = z.object({ plan: RemovePlanSchema, path: z.string() }).strict();

const TARGET = z.object({ agent: z.string(), path: z.string() }).strict();
export const InstallDataSchema = z
  .object({
    operation: z.enum(["install", "remove"]), planDigest: z.string(), outcome: z.enum(["installed", "removed", "no-op"]),
    changed: z.array(TARGET), unchanged: z.array(TARGET), lockfile: z.enum(["created", "updated", "unchanged"]),
  })
  .strict();

export const ListDataSchema = z
  .object({
    lockfile: z.enum(["absent", "present", "invalid"]),
    entries: z.array(
      z.object({ id: z.string(), name: z.string(), agent: z.string(), path: z.string(), state: z.enum(["managed", "modified", "missing", "unmanaged", "agent-incompatible"]), details: z.record(z.string(), z.unknown()).optional() }).strict(),
    ),
  })
  .strict();

export const SourcesListDataSchema = z.object({ sources: z.array(SourceStatusSchema), cacheDir: z.string() }).strict();

/** Command name → data schema; `schemas/commands/<name>.schema.json` is generated from this map. */
export const COMMAND_DATA = {
  scan: ScanDataSchema,
  doctor: DoctorDataSchema,
  search: SearchDataSchema,
  recommend: RecommendDataSchema,
  review: ReviewDataSchema,
  plan: PlanDataSchema,
  install: InstallDataSchema,
  list: ListDataSchema,
  remove: RemoveDataSchema,
  "sources list": SourcesListDataSchema,
} as const;

// Compile-time contract checks: each schema's output type and the command's TypeScript type are mutually assignable.
// Optional keys are normalized because zod types them `T | undefined` while exactOptionalPropertyTypes does not.
type Norm<T> = T extends object ? { [K in keyof T]: Norm<Exclude<T[K], undefined>> } : T;
type Same<A, B> = [Norm<A>] extends [Norm<B>] ? ([Norm<B>] extends [Norm<A>] ? true : false) : false;
const same = <A, B>(ok: Same<A, B>) => ok;
same<z.output<typeof ScanDataSchema>, ProjectAnalysis>(true);
same<z.output<typeof DoctorDataSchema>, DoctorData>(true);
same<z.output<typeof SearchDataSchema>, SearchData>(true);
same<z.output<typeof RecommendDataSchema>, RecommendData>(true);
same<z.output<typeof ReviewDataSchema>, ReviewResult>(true);
same<z.output<typeof InstallDataSchema>, ExecuteResult>(true);
same<z.output<typeof ListDataSchema>["entries"][number], ListEntry>(true);
same<z.output<typeof SourcesListDataSchema>["sources"][number], SourceStatus>(true);
