import type { AgentTarget } from "../agents/index.ts";
import type { CatalogEntry } from "../sources/catalog.ts";
import { APPLICABLE_STACK, leafTokens, SCORING_VERSION, stackMatches, type GoalTag } from "./taxonomy.ts";

export const ELIGIBILITY_THRESHOLD = 35;
export const REDUNDANCY_PENALTY = 15;

export type ReviewState = "not-reviewed" | "reviewed" | "incomplete" | "stale";

/** A normalized candidate: catalog shape plus discovery provenance. */
export type Candidate = Omit<CatalogEntry, "prerequisites"> & {
  /** null = prerequisites were never disclosed or checked. */
  prerequisites: string[] | null;
  annotationOrigin: "curated" | "derived-from-metadata";
  discoveredVia: string[];
  reviewState?: ReviewState;
};

export interface RecommendInput {
  candidates: Candidate[];
  stack: string[];
  goalTags: GoalTag[];
  agents: AgentTarget[];
  limit: number;
  excludeIds?: Set<string>;
  /** `${id}@${commit}` keys installed and managed for every selected agent. */
  installedExact?: Set<string>;
}

export interface ScoreBreakdown {
  stackFit: number;
  goalFit: number;
  compatibility: number;
  metadataCompleteness: number;
  base: number;
  redundancyPenalty: number;
  final: number;
}

export interface Recommendation {
  rank: number;
  id: string;
  name: string;
  description: string;
  source: Candidate["source"];
  score: ScoreBreakdown;
  matchedStack: { projectToken: string; candidateTag: string }[];
  matchedGoals: GoalTag[];
  compatibility: Record<AgentTarget, Candidate["agents"]["codex"]>;
  license: Candidate["license"];
  prerequisites: string[] | null;
  limitations: string[];
  reviewState: ReviewState;
  discoveredVia: string[];
}

export interface Exclusion {
  id: string;
  reason: string;
  base?: number;
}

export interface RecommendResult {
  scoringVersion: typeof SCORING_VERSION;
  applicableStack: string[];
  goalTags: GoalTag[];
  recommendations: Recommendation[];
  exclusions: Exclusion[];
  notes: string[];
}

const COMPAT_POINTS = { verified: 15, portable: 8, unknown: 0, excluded: 0 } as const;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
}

type Scored = { c: Candidate; rec: Omit<Recommendation, "rank"> };

function scoreCandidate(c: Candidate, applicable: string[], input: RecommendInput): Scored {
  const matchedStack: Recommendation["matchedStack"] = [];
  for (const projectToken of applicable) {
    const tag = [...new Set(c.stack)].sort().find((t) => stackMatches(t, projectToken));
    if (tag) matchedStack.push({ projectToken, candidateTag: tag });
  }
  const matchedGoals = input.goalTags.filter((g) => c.tasks.includes(g));
  const stackFit = applicable.length ? Math.round((40 * matchedStack.length) / applicable.length) : 0;
  const goalFit = input.goalTags.length ? Math.round((35 * matchedGoals.length) / input.goalTags.length) : 0;
  const portableOnly = c.targetSpecificFrontmatter.length === 0;
  const compatibility = Math.min(
    ...input.agents.map((a) => (c.agents[a] === "portable" && !portableOnly ? 0 : COMPAT_POINTS[c.agents[a]])),
  );
  const metadataCompleteness =
    2 + (c.license.spdx ? 2 : 0) + (c.prerequisites !== null ? 2 : 0) + (c.source.commit ? 2 : 0) + (c.verifiedAt ? 2 : 0);
  const base = stackFit + goalFit + compatibility + metadataCompleteness;

  const limitations: string[] = [];
  if (c.payload.unsupportedFiles.length) {
    limitations.push(`Contains files outside payload policy (${c.payload.unsupportedFiles.slice(0, 3).join(", ")}${c.payload.unsupportedFiles.length > 3 ? ", …" : ""}); review will be incomplete and installation blocked.`);
  }
  if (c.targetSpecificFrontmatter.length) limitations.push(`Uses target-specific frontmatter (${c.targetSpecificFrontmatter.join(", ")}); compatibility scored as unknown.`);
  for (const a of input.agents) if (c.agents[a] === "unknown") limitations.push(`Compatibility with ${a} is unknown.`);
  if (!c.license.spdx) limitations.push("License evidence is missing or unrecognized; installation will be blocked until it is resolved.");
  if (c.annotationOrigin === "derived-from-metadata") limitations.push("Stack/task tags were derived from upstream metadata, not curated.");
  if (c.prerequisites === null) limitations.push("Prerequisites have not been disclosed.");

  const compat = Object.fromEntries(input.agents.map((a) => [a, c.agents[a]])) as Recommendation["compatibility"];
  return {
    c,
    rec: {
      id: c.id, name: c.name, description: c.description, source: c.source,
      score: { stackFit, goalFit, compatibility, metadataCompleteness, base, redundancyPenalty: 0, final: base },
      matchedStack, matchedGoals, compatibility: compat, license: c.license, prerequisites: c.prerequisites,
      limitations, reviewState: c.reviewState ?? "not-reviewed", discoveredVia: c.discoveredVia,
    },
  };
}

/** Pure, deterministic fit-v1 ranking (spec section 9). */
export function recommend(input: RecommendInput): RecommendResult {
  const applicable = leafTokens(input.stack.filter((t) => APPLICABLE_STACK.has(t)));
  const notes: string[] = [];
  if (!applicable.length) notes.push("No applicable stack tokens; stack fit contributes 0.");
  if (!input.goalTags.length) notes.push("No recognized goal tags; goal fit contributes 0.");

  const exclusions: Exclusion[] = [];
  const eligible: Scored[] = [];
  for (const c of [...input.candidates].sort((a, b) => cmp(a.id, b.id))) {
    if (input.excludeIds?.has(c.id)) { exclusions.push({ id: c.id, reason: "excluded by project configuration" }); continue; }
    const blockedAgent = input.agents.find((a) => c.agents[a] === "excluded");
    if (blockedAgent) { exclusions.push({ id: c.id, reason: `explicitly excludes ${blockedAgent}` }); continue; }
    if (input.installedExact?.has(`${c.id}@${c.source.commit}`)) { exclusions.push({ id: c.id, reason: "exact payload already installed and managed" }); continue; }
    if (input.stack.length && c.requiresAnyStack.length && !c.requiresAnyStack.some((r) => input.stack.some((t) => stackMatches(r, t)))) {
      exclusions.push({ id: c.id, reason: `requires one of: ${c.requiresAnyStack.join(", ")}` });
      continue;
    }
    if (c.reviewState === "incomplete") { exclusions.push({ id: c.id, reason: "current review is incomplete" }); continue; }
    const s = scoreCandidate(c, applicable, input);
    if (!s.rec.matchedStack.length && !s.rec.matchedGoals.length) { exclusions.push({ id: c.id, reason: "no stack or goal match" }); continue; }
    if (s.rec.score.base < ELIGIBILITY_THRESHOLD) { exclusions.push({ id: c.id, reason: `fit score below ${ELIGIBILITY_THRESHOLD}`, base: s.rec.score.base }); continue; }
    eligible.push(s);
  }

  const selected: Scored[] = [];
  const penalized = new Set<Scored>();
  const order = (a: Scored, b: Scored) => b.rec.score.final - a.rec.score.final || b.rec.score.base - a.rec.score.base || cmp(a.rec.id, b.rec.id);
  let remaining = [...eligible];
  while (selected.length < input.limit && remaining.length) {
    remaining.sort(order);
    const next = remaining[0]!;
    if (next.rec.score.final < ELIGIBILITY_THRESHOLD) break;
    selected.push(next);
    remaining = remaining.slice(1);
    for (const r of remaining) {
      if (!penalized.has(r) && r.c.tasks[0] === next.c.tasks[0] && jaccard(r.c.tasks, next.c.tasks) >= 0.8) {
        penalized.add(r);
        r.rec.score.redundancyPenalty = REDUNDANCY_PENALTY;
        r.rec.score.final = r.rec.score.base - REDUNDANCY_PENALTY;
      }
    }
  }
  for (const r of remaining) {
    exclusions.push({ id: r.rec.id, reason: r.rec.score.final < ELIGIBILITY_THRESHOLD ? "below threshold after redundancy penalty" : `outside limit of ${input.limit}`, base: r.rec.score.base });
  }
  exclusions.sort((a, b) => cmp(a.id, b.id));

  return {
    scoringVersion: SCORING_VERSION,
    applicableStack: applicable,
    goalTags: input.goalTags,
    recommendations: selected.map((s, i) => ({ rank: i + 1, ...s.rec })),
    exclusions,
    notes,
  };
}
