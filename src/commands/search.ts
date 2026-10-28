import { SkillpilotError } from "../errors.ts";
import { AGENT_TARGETS, type AgentTarget } from "../agents/index.ts";
import { normalizeStack } from "../analyzer/index.ts";
import type { Candidate } from "../recommender/index.ts";
import { APPLICABLE_STACK, goalTags, normalizeWords, stackMatches, type GoalTag } from "../recommender/taxonomy.ts";
import { escapeText as e } from "../renderers/escape.ts";
import type { CommandResult } from "../renderers/output.ts";
import { loadProjectSources, type SourceOptions } from "./sources.ts";

export interface SearchHit {
  id: string;
  name: string;
  matchedTasks: GoalTag[];
  matchedStack: string[];
  nameMatch: boolean;
  license: string | null;
  discoveredVia: string[];
  limitations: string[];
}

export interface SearchData {
  query: string;
  queryTasks: GoalTag[];
  queryStack: string[];
  searched: number;
  results: SearchHit[];
}

export function parseAgents(value: string | undefined): AgentTarget[] {
  if (value === undefined || value === "both") return [...AGENT_TARGETS];
  if (value === "claude-code" || value === "codex") return [value];
  throw new SkillpilotError("INVALID_ARGUMENT", `Unsupported agent "${value.slice(0, 40)}".`, "Use claude-code, codex, or both.");
}

/** Local catalog search; nothing about the query leaves the machine (FR-010). */
export function searchCandidates(candidates: Candidate[], query: string, filters: { stack: string[]; agents: AgentTarget[] }): SearchHit[] {
  const words = normalizeWords(query);
  const queryTasks = goalTags(query);
  const queryStack = [...new Set(words.filter((w) => APPLICABLE_STACK.has(w)))];
  const hits: [number, SearchHit][] = [];
  for (const c of candidates) {
    if (filters.agents.some((a) => c.agents[a] === "excluded")) continue;
    if (filters.stack.length && !filters.stack.some((t) => c.stack.some((tag) => stackMatches(tag, t)))) continue;
    const matchedTasks = queryTasks.filter((t) => c.tasks.includes(t));
    const matchedStack = queryStack.filter((t) => c.stack.some((tag) => stackMatches(tag, t)));
    const nameWords = new Set(c.name.split("-"));
    const nameMatch = words.some((w) => nameWords.has(w));
    const weight = matchedTasks.length * 2 + matchedStack.length * 2 + (nameMatch ? 1 : 0);
    if (!weight) continue;
    hits.push([weight, {
      id: c.id, name: c.name, matchedTasks, matchedStack, nameMatch, license: c.license.spdx, discoveredVia: c.discoveredVia,
      limitations: c.payload.unsupportedFiles.length ? ["contains files outside payload policy"] : [],
    }]);
  }
  hits.sort((a, b) => b[0] - a[0] || (a[1].id < b[1].id ? -1 : 1));
  return hits.map(([, h]) => h);
}

export async function searchCommand(projectRoot: string, query: string, opts: SourceOptions & { stack?: string[] | undefined; agent?: string | undefined }): Promise<CommandResult<SearchData>> {
  if (!query.trim()) throw new SkillpilotError("INVALID_ARGUMENT", "Search query is empty.", "Pass words such as \"expo navigation\".");
  const agents = parseAgents(opts.agent);
  const stack = normalizeStack(opts.stack ?? []);
  const { loaded } = await loadProjectSources(projectRoot, opts);
  const results = searchCandidates(loaded.candidates, query, { stack, agents });
  const data: SearchData = { query, queryTasks: goalTags(query), queryStack: [...new Set(normalizeWords(query).filter((w) => APPLICABLE_STACK.has(w)))], searched: loaded.candidates.length, results };
  return {
    data,
    warnings: loaded.warnings,
    errors: loaded.errors,
    text: (d) => [
      `Searched ${d.searched} entries for "${e(d.query)}" (tasks: ${d.queryTasks.join(", ") || "none"}; stack: ${d.queryStack.join(", ") || "none"})`,
      ...(d.results.length
        ? d.results.map((r) => `  ${e(r.name).padEnd(36)} ${e(r.id)}${r.limitations.length ? "  [" + r.limitations.join("; ") + "]" : ""}`)
        : ["  No matches. The bundled catalog is curated and small; try task words such as testing, deploy, or upgrade."]),
      "Search results are not recommendations or reviews. Nothing has been installed.",
    ],
  };
}
