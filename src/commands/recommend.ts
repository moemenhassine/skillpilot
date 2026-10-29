import path from "node:path";
import { compareDir } from "../installer/snapshot.ts";
import { readLockfile } from "../storage/lockfile.ts";
import { analyzeProject } from "../analyzer/index.ts";
import { SkillpilotError } from "../errors.ts";
import { recommend, type RecommendResult } from "../recommender/index.ts";
import { goalTags } from "../recommender/taxonomy.ts";
import { escapeText as e } from "../renderers/escape.ts";
import type { CommandResult } from "../renderers/output.ts";
import { parseAgents } from "./search.ts";
import { loadProjectSources, type SourceOptions } from "./sources.ts";
import type { SourceStatus } from "../sources/discovery.ts";

export interface RecommendOptions extends SourceOptions {
  goal?: string | undefined;
  stack?: string[] | undefined;
  agent?: string | undefined;
  limit?: string | undefined;
  explain?: boolean | undefined;
}

export interface RecommendData extends Omit<RecommendResult, "exclusions"> {
  project: { root: string; effectiveStack: string[]; stackOrigin: string; evidence: { path: string; key: string; token: string }[] };
  goal: string | null;
  agents: string[];
  agentAssumption: string | null;
  sources: SourceStatus[];
  searched: number;
  exclusions?: RecommendResult["exclusions"];
}

/** `${id}@${commit}` for payloads installed, managed, and byte-identical for every selected agent (FR-024). */
async function managedExact(projectRoot: string, agents: string[]): Promise<{ keys: Set<string>; paths: Set<string>; warnings: string[] }> {
  let lock: Awaited<ReturnType<typeof readLockfile>>;
  try {
    lock = await readLockfile(projectRoot);
  } catch {
    return { keys: new Set(), paths: new Set(), warnings: ["The lockfile is unreadable; installed skills were not excluded."] };
  }
  const byKey = new Map<string, Set<string>>();
  const paths = new Set<string>();
  for (const e of lock.state === "present" ? lock.lock.entries : []) {
    paths.add(e.installPath);
    if ((await compareDir(path.join(projectRoot, e.installPath), e.files)).state !== "identical") continue;
    const key = `${e.sourceId}@${e.source.commit}`;
    byKey.set(key, (byKey.get(key) ?? new Set()).add(e.agent));
  }
  return { keys: new Set([...byKey].filter(([, set]) => agents.every((a) => set.has(a))).map(([k]) => k)), paths, warnings: [] };
}

export async function recommendCommand(projectRoot: string, opts: RecommendOptions): Promise<CommandResult<RecommendData>> {
  const agents = parseAgents(opts.agent);
  const { config, loaded } = await loadProjectSources(projectRoot, opts);
  let limit = config?.defaultLimit ?? 5;
  if (opts.limit !== undefined) {
    limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new SkillpilotError("INVALID_ARGUMENT", "--limit must be an integer from 1 to 20.", "Pass --limit 5, for example.");
  }
  const analysis = await analyzeProject(projectRoot, { stack: opts.stack, goal: opts.goal, config });
  const managed = await managedExact(projectRoot, agents);
  const result = recommend({
    candidates: loaded.candidates,
    stack: analysis.effectiveStack,
    goalTags: analysis.goal ? goalTags(analysis.goal) : [],
    agents,
    limit,
    excludeIds: new Set(config?.excludeSkillIds ?? []),
    installedExact: managed.keys,
  });
  const warnings = [...loaded.warnings, ...analysis.inventory.warnings, ...managed.warnings];
  for (const r of result.recommendations) {
    for (const s of analysis.inventory.skills.filter((s) => !managed.paths.has(s.path))) {
      const name = s.manifest.valid ? s.manifest.name : s.directoryName;
      if (name === r.name) warnings.push(`${r.name}: a same-name unmanaged skill already exists at ${s.path}; installing would conflict.`);
    }
  }
  const { exclusions, ...rest } = result;
  const data: RecommendData = {
    ...rest,
    project: {
      root: analysis.projectRoot,
      effectiveStack: analysis.effectiveStack,
      stackOrigin: analysis.stackOrigin,
      evidence: analysis.evidence.filter((x) => analysis.effectiveStack.includes(x.token)).map(({ path, key, token }) => ({ path, key, token })),
    },
    goal: analysis.goal,
    agents,
    agentAssumption: opts.agent ? null : "No --agent given; compatibility is ranked for both claude-code and codex.",
    sources: loaded.sources,
    searched: loaded.candidates.length,
    ...(opts.explain ? { exclusions } : {}),
  };
  return { data, warnings, errors: loaded.errors, text: renderRecommend };
}

function renderRecommend(d: RecommendData): string[] {
  const lines = [`Project: ${d.project.effectiveStack.join(", ") || "unknown stack"} (${d.project.stackOrigin})`];
  const ev = [...new Set(d.project.evidence.map((x) => (x.path === "." ? `declared via ${x.key}` : `${e(x.path)} ${e(x.key)}`)))];
  if (ev.length) lines.push(`Evidence: ${ev.slice(0, 4).join("; ")}${ev.length > 4 ? "; …" : ""}`);
  lines.push(`Goal: ${d.goal ? e(d.goal) : "(none)"}${d.goalTags.length ? ` → ${d.goalTags.join(", ")}` : ""}`);
  lines.push(`Sources: ${d.sources.map((s) => `${e(s.id)} (${s.state})`).join("; ")}; ${d.searched} entries searched; ${d.recommendations.length} shortlisted`);
  if (d.agentAssumption) lines.push(`Note: ${d.agentAssumption}`);
  for (const n of d.notes) lines.push(`Note: ${n}`);
  lines.push("");
  if (!d.recommendations.length) {
    lines.push("No recommendations met the fit threshold. The bundled catalog is curated and covers a limited set of stacks and tasks;");
    lines.push("try a more specific --goal, declare --stack, or add a public repository with --repo owner/repository.");
  }
  for (const r of d.recommendations) {
    const s = r.score;
    lines.push(`${r.rank}. ${e(r.name).padEnd(34)} Fit ${s.final}/100   Review: ${r.reviewState}`);
    lines.push(`   Score: stack ${s.stackFit}/40, goal ${s.goalFit}/35, compatibility ${s.compatibility}/15, metadata ${s.metadataCompleteness}/10${s.redundancyPenalty ? `, redundancy -${s.redundancyPenalty}` : ""}`);
    const why = [
      ...(r.matchedGoals.length ? [`goal ${r.matchedGoals.join(", ")}`] : []),
      ...(r.matchedStack.length ? [`stack ${r.matchedStack.map((m) => (m.candidateTag === m.projectToken ? m.projectToken : `${m.projectToken} via ${m.candidateTag}`)).join(", ")}`] : []),
    ];
    lines.push(`   Why: matches ${why.join("; ")}.`);
    lines.push(`   Source: ${e(r.id)} @ ${r.source.commit.slice(0, 12)}   License: ${e(r.license.spdx ?? "unknown")}`);
    if (r.prerequisites?.length) lines.push(`   Requires: ${r.prerequisites.map(e).join("; ")}`);
    for (const l of r.limitations) lines.push(`   Caveat: ${e(l)}`);
  }
  if (d.exclusions) {
    lines.push("", "Excluded:");
    for (const x of d.exclusions) lines.push(`  ${e(x.id)}: ${x.reason}${x.base !== undefined ? ` (base ${x.base})` : ""}`);
  }
  lines.push("", `Fit scores (${d.scoringVersion}) measure relevance, not safety. Nothing has been installed. Review and plan a selection to continue.`);
  return lines;
}
