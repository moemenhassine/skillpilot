import { SkillpilotError } from "../errors.ts";
import { fetchTransport, GitHubClient, type Transport } from "../fetcher/github.ts";
import { escapeText as e } from "../renderers/escape.ts";
import type { CommandResult } from "../renderers/output.ts";
import { loadConfig, REPOSITORY_ID, type Config } from "../schemas/config.ts";
import { loadBundledCatalog } from "../sources/catalog.ts";
import { loadSources, type LoadedSources, type SourceStatus } from "../sources/discovery.ts";
import { cacheDir } from "../storage/paths.ts";

export interface SourceOptions {
  offline?: boolean | undefined;
  refresh?: boolean | undefined;
  repo?: string[] | undefined;
  /** Test seams; production uses fetch, the OS cache dir, and the wall clock. */
  transport?: Transport;
  cacheRoot?: string;
  now?: Date;
  verbose?: boolean | undefined;
}

export async function loadProjectSources(projectRoot: string, opts: SourceOptions): Promise<{ config: Config | null; loaded: LoadedSources }> {
  if (opts.offline && opts.refresh) throw new SkillpilotError("INVALID_ARGUMENT", "--offline and --refresh cannot be combined.", "Drop one of the two options.");
  for (const r of opts.repo ?? []) {
    if (!REPOSITORY_ID.test(r)) throw new SkillpilotError("INVALID_ARGUMENT", `Invalid repository "${r.slice(0, 80)}".`, "Use owner/repository for a public GitHub repository; URLs and other hosts are not accepted.");
  }
  const config = await loadConfig(projectRoot);
  const client = opts.offline
    ? null
    : new GitHubClient(opts.transport ?? fetchTransport, { ...(opts.verbose ? { onRequest: (s: string) => process.stderr.write(`[skillpilot] ${s}\n`) } : {}) });
  const loaded = await loadSources({
    catalog: loadBundledCatalog(),
    repositories: [...(config?.repositories ?? []), ...(opts.repo ?? [])],
    // --repo is a per-invocation discovery request, so it refreshes unless offline.
    refresh: Boolean(opts.refresh || (opts.repo?.length && !opts.offline)),
    cacheRoot: opts.cacheRoot ?? cacheDir(),
    client,
    now: opts.now ?? new Date(),
  });
  if (loaded.cacheWrites.length) loaded.warnings.push(`Cache updated: ${loaded.cacheWrites.length} source metadata file(s) under the SkillPilot cache.`);
  return { config, loaded };
}

export function renderSourceLine(s: SourceStatus): string {
  const extra = s.commit ? ` @ ${s.commit.slice(0, 12)} fetched ${s.fetchedAt}` : "";
  return `  ${e(s.id).padEnd(34)} ${s.state.padEnd(10)} ${s.skills} skills${s.invalid ? ` (${s.invalid} invalid)` : ""}${extra}`;
}

export async function sourcesListCommand(projectRoot: string, opts: SourceOptions): Promise<CommandResult<{ sources: SourceStatus[]; cacheDir: string }>> {
  const { loaded } = await loadProjectSources(projectRoot, opts);
  return {
    data: { sources: loaded.sources, cacheDir: opts.cacheRoot ?? cacheDir() },
    warnings: loaded.warnings,
    errors: loaded.errors,
    text: (d) => ["Sources:", ...d.sources.map(renderSourceLine), "Repository sources are discovery inputs, not trust endorsements."],
  };
}
