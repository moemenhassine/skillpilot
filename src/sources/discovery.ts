import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SkillpilotError, toErrorObject, type ErrorObject } from "../errors.ts";
import type { GitHubClient, TreeEntry } from "../fetcher/github.ts";
import type { Candidate } from "../recommender/index.ts";
import { APPLICABLE_STACK, goalTags, normalizeWords } from "../recommender/taxonomy.ts";
import { classifyPath } from "../review/policy.ts";
import { parseSkillManifest } from "../schemas/manifest.ts";
import { COMMIT_ID, sourceId, type Catalog } from "./catalog.ts";

export const MAX_SKILLS_PER_REPO = 30;
const MAX_SKILL_MD = 256 * 1024;
const LICENSE_NAME = /^(LICEN[CS]E|NOTICE|COPYING)(\.(txt|md))?$/i;

/** MVP discovery roots (spec 7.2). Anything else must be referenced by a catalog entry. */
const DISCOVERY_ROOTS = [/^SKILL\.md$/, /^skills\/[^/]+\/SKILL\.md$/, /^\.agents\/skills\/[^/]+\/SKILL\.md$/, /^\.claude\/skills\/[^/]+\/SKILL\.md$/];

const DiscoveredSkillSchema = z.object({
  skillPath: z.string(),
  name: z.string(),
  description: z.string(),
  extraKeys: z.array(z.string()),
  files: z.number().int(),
  bytes: z.number().int(),
  unsupportedFiles: z.array(z.string()),
  licensePath: z.string().nullable(),
});

export const RepoCacheSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: z.string(),
    commit: z.string().regex(COMMIT_ID),
    fetchedAt: z.string(),
    licenseSpdx: z.string().nullable(),
    skills: z.array(DiscoveredSkillSchema).max(MAX_SKILLS_PER_REPO),
    invalid: z.array(z.object({ skillPath: z.string(), problems: z.array(z.string()) })),
    warnings: z.array(z.string()),
  })
  .strict();
export type RepoCache = z.infer<typeof RepoCacheSchema>;

function payloadPrecheck(tree: TreeEntry[], dir: string) {
  const prefix = dir === "" ? "" : `${dir}/`;
  // A root skill's payload is the repository root minus nested skill roots; MVP counts top-level files only.
  const inDir = tree.filter((e) => (prefix ? e.path.startsWith(prefix) : !e.path.includes("/")));
  const files = inDir.filter((e) => e.type === "blob");
  const special = inDir.filter((e) => e.type === "commit" || e.mode === "120000").map((e) => e.path.slice(prefix.length));
  const unsupported = files
    .map((e) => e.path.slice(prefix.length))
    .filter((r) => classifyPath(r) === "unsupported");
  const license = files.find((e) => LICENSE_NAME.test(e.path.slice(prefix.length)));
  return {
    files: files.length,
    bytes: files.reduce((n, e) => n + (e.size ?? 0), 0),
    unsupportedFiles: [...unsupported, ...special].sort(),
    licensePath: license?.path ?? null,
  };
}

/** Enumerates supported skill roots in one public repository at its default-branch commit. */
export async function discoverRepository(client: GitHubClient, repository: string, now: Date): Promise<RepoCache> {
  const [owner, repo] = repository.split("/") as [string, string];
  const info = await client.getRepository(owner, repo);
  const commit = await client.resolveBranch(owner, repo, info.defaultBranch);
  const tree = await client.getTree(owner, repo, commit);
  const manifests = tree.filter((e) => DISCOVERY_ROOTS.some((re) => re.test(e.path))).sort((a, b) => (a.path < b.path ? -1 : 1));
  const warnings: string[] = [];
  if (manifests.length > MAX_SKILLS_PER_REPO) warnings.push(`${repository} has ${manifests.length} skills in supported roots; only the first ${MAX_SKILLS_PER_REPO} were read.`);
  const out: RepoCache = { schemaVersion: 1, repository, commit, fetchedAt: now.toISOString(), licenseSpdx: info.licenseSpdx, skills: [], invalid: [], warnings };
  for (const m of manifests.slice(0, MAX_SKILLS_PER_REPO)) {
    const dir = m.path === "SKILL.md" ? "" : m.path.slice(0, -"/SKILL.md".length);
    const skillPath = dir || ".";
    if (m.type !== "blob" || m.mode === "120000") { out.invalid.push({ skillPath, problems: ["SKILL.md is not a regular file"] }); continue; }
    const parsed = parseSkillManifest((await client.getBlob(owner, repo, m.sha, MAX_SKILL_MD)).toString("utf8"));
    if (!parsed.ok) { out.invalid.push({ skillPath, problems: parsed.problems }); continue; }
    if (dir && path.posix.basename(dir) !== parsed.manifest.name) {
      out.invalid.push({ skillPath, problems: [`manifest name ${parsed.manifest.name} does not match directory`] });
      continue;
    }
    out.skills.push({ skillPath, name: parsed.manifest.name, description: parsed.manifest.description, extraKeys: parsed.extraKeys, ...payloadPrecheck(tree, dir) });
  }
  return out;
}

const STACK_PHRASES: [RegExp, string][] = [[/\breact native\b/, "react-native"], [/\bnext\.?js\b/, "nextjs"], [/\bswiftui\b/, "ios"], [/\bjetpack compose\b/, "android"]];

/** Converts discovered metadata to candidates; tags are derived from name/description and labelled as such. */
export function candidatesFromRepo(cache: RepoCache): Candidate[] {
  const [owner, repository] = cache.repository.split("/") as [string, string];
  return cache.skills.map((s) => {
    const text = `${s.name.replace(/-/g, " ")} ${s.description}`;
    const words = new Set(normalizeWords(text));
    const stack = [...new Set([...[...words].filter((w) => APPLICABLE_STACK.has(w)), ...STACK_PHRASES.filter(([re]) => re.test(text.toLowerCase())).map(([, t]) => t)])].sort();
    const source = { provider: "github" as const, owner, repository, skillPath: s.skillPath, commit: cache.commit };
    const support = s.extraKeys.length ? "unknown" : "portable";
    return {
      id: sourceId(source), name: s.name, description: s.description, source,
      categories: ["discovered"], stack, requiresAnyStack: [], tasks: goalTags(text), prerequisites: null,
      agents: { "claude-code": support, codex: support },
      license: s.licensePath ? { spdx: null, scope: "skill" as const, evidencePath: s.licensePath } : { spdx: cache.licenseSpdx, scope: "repository" as const, evidencePath: "(repository metadata)" },
      payload: { files: s.files, bytes: s.bytes, unsupportedFiles: s.unsupportedFiles },
      targetSpecificFrontmatter: s.extraKeys, verifiedAt: cache.fetchedAt.slice(0, 10),
      annotationOrigin: "derived-from-metadata" as const, discoveredVia: [`repository:${cache.repository}`],
    };
  });
}

const cacheFile = (cacheRoot: string, repository: string) => path.join(cacheRoot, "sources", `${repository.toLowerCase().replace("/", "__")}.json`);

export async function readRepoCache(cacheRoot: string, repository: string): Promise<RepoCache | null> {
  const raw = await readFile(cacheFile(cacheRoot, repository), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = RepoCacheSchema.parse(JSON.parse(raw));
    return parsed.repository.toLowerCase() === repository.toLowerCase() ? parsed : null;
  } catch {
    return null; // Corrupt cache entries are ignored and refetched on the next --refresh.
  }
}

export async function writeRepoCache(cacheRoot: string, data: RepoCache): Promise<string> {
  const file = cacheFile(cacheRoot, data.repository);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
  return file;
}

export interface SourceStatus {
  id: string;
  kind: "bundled" | "repository";
  state: "loaded" | "cached" | "refreshed" | "not-cached" | "failed";
  commit?: string;
  fetchedAt?: string;
  skills: number;
  invalid?: number;
}

export interface LoadedSources {
  candidates: Candidate[];
  sources: SourceStatus[];
  warnings: string[];
  errors: ErrorObject[];
  cacheWrites: string[];
}

export interface LoadSourcesOptions {
  catalog: Catalog;
  repositories: string[];
  refresh: boolean;
  cacheRoot: string;
  client: GitHubClient | null;
  now: Date;
}

/** Merges bundled catalog and repository candidates, deduplicating by source identity (FR-013). */
export async function loadSources(opts: LoadSourcesOptions): Promise<LoadedSources> {
  const result: LoadedSources = { candidates: [], sources: [], warnings: [], errors: [], cacheWrites: [] };
  const byId = new Map<string, Candidate>();
  for (const e of opts.catalog.entries) byId.set(e.id, { ...e, annotationOrigin: "curated", discoveredVia: ["bundled"] });
  result.sources.push({ id: `bundled catalog ${opts.catalog.catalogVersion}`, kind: "bundled", state: "loaded", skills: opts.catalog.entries.length });

  for (const repository of [...new Set(opts.repositories.map((r) => r.toLowerCase()))].sort()) {
    let cache = await readRepoCache(opts.cacheRoot, repository);
    let state: SourceStatus["state"] = cache ? "cached" : "not-cached";
    if (opts.refresh) {
      try {
        if (!opts.client) throw new SkillpilotError("SOURCE_UNAVAILABLE", "Network access is disabled.", "Rerun without --offline.");
        cache = await discoverRepository(opts.client, repository, opts.now);
        result.cacheWrites.push(await writeRepoCache(opts.cacheRoot, cache));
        state = "refreshed";
      } catch (err) {
        const e = toErrorObject(err);
        result.errors.push({ ...e, message: `${repository}: ${e.message}` });
        state = "failed";
      }
    }
    if (state === "not-cached") result.warnings.push(`${repository} has no cached metadata; run with --refresh to discover it.`);
    if (cache) {
      result.warnings.push(...cache.warnings);
      for (const c of candidatesFromRepo(cache)) {
        const existing = byId.get(c.id);
        if (!existing) byId.set(c.id, c);
        else {
          existing.discoveredVia = [...new Set([...existing.discoveredVia, ...c.discoveredVia])].sort();
          if (existing.source.commit !== c.source.commit) {
            result.warnings.push(`${c.id}: repository head ${c.source.commit.slice(0, 12)} differs from the catalog pin ${existing.source.commit.slice(0, 12)}; the catalog pin is used.`);
          }
        }
      }
    }
    result.sources.push({
      id: repository, kind: "repository", state, skills: cache?.skills.length ?? 0,
      ...(cache ? { commit: cache.commit, fetchedAt: cache.fetchedAt, invalid: cache.invalid.length } : {}),
    });
  }
  result.candidates = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return result;
}
