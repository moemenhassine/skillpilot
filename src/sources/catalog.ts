import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SkillpilotError } from "../errors.ts";
import { SKILL_NAME } from "../schemas/manifest.ts";
import { REPOSITORY_ID, STACK_TOKEN } from "../schemas/config.ts";
import { GOAL_TAGS } from "../recommender/taxonomy.ts";
import { PAYLOAD_POLICY_VERSION } from "../review/policy.ts";

export const COMMIT_ID = /^[0-9a-f]{40}$/;
const SKILL_PATH = /^(\.|(?!\/)(?!.*\/\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._\-/]{1,240}(?<!\/))$/;
const AGENT_SUPPORT = z.enum(["verified", "portable", "unknown", "excluded"]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CatalogEntrySchema = z
  .object({
    id: z.string().min(3).max(300),
    name: z.string().regex(SKILL_NAME),
    description: z.string().min(1).max(1024),
    source: z
      .object({
        provider: z.literal("github"),
        owner: z.string().min(1).max(39),
        repository: z.string().min(1).max(100),
        skillPath: z.string().regex(SKILL_PATH),
        commit: z.string().regex(COMMIT_ID),
      })
      .strict(),
    categories: z.array(z.string().regex(STACK_TOKEN)).min(1).max(8),
    stack: z.array(z.string().regex(STACK_TOKEN)).max(12),
    /** Curated explicit incompatibility: when the project stack is known, it must contain one of these. */
    requiresAnyStack: z.array(z.string().regex(STACK_TOKEN)).max(12),
    tasks: z.array(z.enum(GOAL_TAGS)).min(1).max(8),
    prerequisites: z.array(z.string().min(1).max(200)).max(10),
    agents: z.object({ "claude-code": AGENT_SUPPORT, codex: AGENT_SUPPORT }).strict(),
    license: z
      .object({ spdx: z.string().min(1).max(64).nullable(), scope: z.enum(["skill", "repository"]), evidencePath: z.string().min(1).max(240) })
      .strict(),
    payload: z
      .object({ files: z.number().int().min(1), bytes: z.number().int().min(0), unsupportedFiles: z.array(z.string()).max(200) })
      .strict(),
    targetSpecificFrontmatter: z.array(z.string()).max(30),
    verifiedAt: DATE,
  })
  .strict();

export const CatalogSchema = z
  .object({ schemaVersion: z.literal(1), catalogVersion: z.string().regex(/^\d+\.\d+\.\d+$/), generatedAt: DATE, entries: z.array(CatalogEntrySchema).max(5000) })
  .strict();

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

/** Canonical source ID: lowercase owner/repository plus the case-preserved skill path. */
export const sourceId = (s: { owner: string; repository: string; skillPath: string }) =>
  `${s.owner.toLowerCase()}/${s.repository.toLowerCase()}#${s.skillPath}`;

/** Validates schema plus cross-field rules that the schema cannot express. */
export function validateCatalog(json: unknown): { catalog: Catalog | null; problems: string[] } {
  const parsed = CatalogSchema.safeParse(json);
  if (!parsed.success) return { catalog: null, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of parsed.data.entries) {
    const expected = sourceId(e.source);
    if (e.id !== expected) problems.push(`${e.id}: id must equal ${expected}`);
    if (!REPOSITORY_ID.test(`${e.source.owner}/${e.source.repository}`)) problems.push(`${e.id}: invalid owner/repository`);
    const base = e.source.skillPath === "." ? null : e.source.skillPath.split("/").pop();
    if (base !== null && base !== e.name) problems.push(`${e.id}: skill directory must match manifest name ${e.name}`);
    if (seen.has(e.id)) problems.push(`${e.id}: duplicate entry`);
    seen.add(e.id);
  }
  return { catalog: problems.length ? null : parsed.data, problems };
}

const BUNDLED = fileURLToPath(new URL("../../catalog/skills.json", import.meta.url));

export function loadBundledCatalog(file = BUNDLED): Catalog {
  const { catalog, problems } = validateCatalog(JSON.parse(readFileSync(file, "utf8")));
  if (!catalog) throw new SkillpilotError("INVALID_SCHEMA", "Bundled catalog failed validation.", "Reinstall SkillPilot or run npm run validate:catalog.", { problems: problems.slice(0, 20) });
  return catalog;
}

/** Detection-baseline categories (spec 7.1) and the tags that make an entry useful for each. */
export const BASELINE_CATEGORIES: Record<string, string[]> = {
  "javascript-typescript": ["web", "nextjs", "react", "node", "javascript", "typescript"],
  "react-web": ["web", "react", "nextjs"],
  "react-native-expo": ["react-native", "expo"],
  "swift-ios": ["swift", "ios"],
  android: ["android"],
  python: ["python"],
  "data-science-ml": ["data-science", "ml"],
  "ai-applications": ["ai"],
  "testing-infra": ["testing", "infra"],
};

export interface Coverage {
  entries: number;
  categories: string[];
  publishers: string[];
  policyVersion: string;
  baseline: Record<string, { candidates: number; installableUnderPolicy: number }>;
  gaps: string[];
}

/** FR-015 gate: ≥20 entries, ≥8 categories, ≥4 publishers, ≥1 candidate per baseline category. */
export function catalogCoverage(catalog: Catalog): Coverage {
  const categories = [...new Set(catalog.entries.flatMap((e) => e.categories))].sort();
  const publishers = [...new Set(catalog.entries.map((e) => e.source.owner.toLowerCase()))].sort();
  const baseline: Coverage["baseline"] = {};
  const gaps: string[] = [];
  for (const [cat, tags] of Object.entries(BASELINE_CATEGORIES)) {
    const matches = catalog.entries.filter((e) => [...e.stack, ...e.categories].some((t) => tags.includes(t)));
    const installable = matches.filter((e) => e.payload.unsupportedFiles.length === 0);
    baseline[cat] = { candidates: matches.length, installableUnderPolicy: installable.length };
    if (!matches.length) gaps.push(`${cat}: no candidate`);
    else if (!installable.length) gaps.push(`${cat}: candidates exist but none is installable under ${PAYLOAD_POLICY_VERSION}`);
  }
  if (catalog.entries.length < 20) gaps.push(`only ${catalog.entries.length} entries (need 20)`);
  if (categories.length < 8) gaps.push(`only ${categories.length} categories (need 8)`);
  if (publishers.length < 4) gaps.push(`only ${publishers.length} publishers (need 4)`);
  return { entries: catalog.entries.length, categories, publishers, policyVersion: PAYLOAD_POLICY_VERSION, baseline, gaps };
}
