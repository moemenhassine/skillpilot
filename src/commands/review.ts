import type { AgentTarget } from "../agents/index.ts";
import { SkillpilotError, type ErrorObject } from "../errors.ts";
import { fetchTransport, GitHubClient, type Transport } from "../fetcher/github.ts";
import { fetchPayload } from "../fetcher/payload.ts";
import { buildPlan, writePlanFile, type Plan } from "../planner/index.ts";
import { escapeText as e } from "../renderers/escape.ts";
import type { CommandResult } from "../renderers/output.ts";
import { reviewPayload, STATIC_LIMITATION, type ReviewResult } from "../review/index.ts";
import { RULE_SET_VERSION } from "../review/rules.ts";
import { parseSource } from "../sources/grammar.ts";
import { updateManifest } from "../storage/payload-cache.ts";
import { cacheDir } from "../storage/paths.ts";
import { parseAgents } from "./search.ts";

export interface FetchOptions {
  offline?: boolean | undefined;
  verbose?: boolean | undefined;
  transport?: Transport;
  cacheRoot?: string;
  now?: Date;
}

const VERSION = "0.1.0";

async function reviewSource(sourceArg: string, opts: FetchOptions, acknowledged: string[] = []): Promise<{ review: ReviewResult; fromCache: boolean }> {
  const ref = parseSource(sourceArg);
  const client = opts.offline ? null : new GitHubClient(opts.transport ?? fetchTransport, { ...(opts.verbose ? { onRequest: (s: string) => process.stderr.write(`[skillpilot] ${s}\n`) } : {}) });
  const cacheRoot = opts.cacheRoot ?? cacheDir();
  const fetched = await fetchPayload(client, ref, cacheRoot, opts.now ?? new Date());
  const review = reviewPayload(fetched.manifest, fetched.bytes, acknowledged);
  fetched.manifest.review = { ruleSet: review.ruleSet, policyVersion: review.policyVersion, payloadDigest: review.payloadDigest, coverage: review.coverage, decision: review.decision };
  await updateManifest(cacheRoot, fetched.manifest);
  return { review, fromCache: fetched.fromCache };
}

function reviewErrors(r: ReviewResult): ErrorObject[] {
  if (r.coverage === "incomplete") return [{ code: "REVIEW_INCOMPLETE", message: "Review coverage is incomplete; this skill cannot be installed.", nextAction: "See the STR-003 findings." }];
  if (r.decision === "blocked") return [{ code: "POLICY_BLOCKED", message: "Blocking findings; this skill cannot be installed.", nextAction: "High findings and structural/license blockers have no override." }];
  return [];
}

export function renderReview(r: ReviewResult): string[] {
  const lines = [
    `Skill: ${e(r.name ?? "(invalid manifest)")}   Source: ${e(`${r.source.owner}/${r.source.repository}`)}@${r.source.commit}#${e(r.source.skillPath)}`,
    `Payload: ${r.files.length} files, ${r.files.reduce((n, f) => n + f.size, 0)} bytes, digest ${r.payloadDigest}`,
    `License: ${e(r.license.spdx ?? "unresolved")}${r.license.files.length ? ` (${r.license.files.map(e).join(", ")})` : ""}`,
    `Rule set ${r.ruleSet}, policy ${r.policyVersion}: coverage ${r.coverage}, decision ${r.decision}`,
  ];
  if (!r.findings.length) lines.push(`No findings under rule set ${RULE_SET_VERSION}.`);
  for (const f of r.findings) {
    const where = f.lineStart ? `${e(f.file)}:${f.lineStart}` : e(f.file);
    lines.push(`  [${f.severity.toUpperCase()}${f.blocking ? ", blocking" : f.severity === "medium" ? ", needs --ack" : ""}] ${f.ruleId} ${f.id} ${where}${f.occurrences > 1 ? ` (${f.occurrences}×)` : ""}`);
    lines.push(`      ${e(f.explanation)} ${e(f.remediation)}`);
    if (f.context) lines.push(`      ${e(f.context)}`);
  }
  if (r.disclosures.scripts.length) lines.push(`Scripts (never run by SkillPilot): ${r.disclosures.scripts.map(e).join(", ")}`);
  if (r.disclosures.externalDomains.length) lines.push(`Referenced domains (not fetched): ${r.disclosures.externalDomains.map(e).join(", ")}`);
  lines.push(r.disclosures.fileModeNormalization, STATIC_LIMITATION);
  return lines;
}

export async function reviewCommand(sourceArg: string, opts: FetchOptions): Promise<CommandResult<ReviewResult>> {
  const { review, fromCache } = await reviewSource(sourceArg, opts);
  return {
    data: review,
    status: "ok",
    errors: reviewErrors(review),
    warnings: [...(fromCache ? ["Reviewed from the verified local cache."] : ["Fetched payload was written to the SkillPilot cache."])],
    text: renderReview,
  };
}

export interface PlanOptions extends FetchOptions {
  agent?: string | undefined;
  ack?: string[] | undefined;
  out?: string | undefined;
}

export async function planCommand(projectRoot: string, sources: string[], opts: PlanOptions): Promise<CommandResult<{ plan: Plan; path: string | null }>> {
  if (!opts.agent) throw new SkillpilotError("INVALID_ARGUMENT", "--agent is required for planning.", "Pass --agent claude-code, --agent codex, or --agent both.");
  const agents: AgentTarget[] = parseAgents(opts.agent);
  if (!sources.length) throw new SkillpilotError("INVALID_ARGUMENT", "Select at least one source.", "Example: skillpilot plan owner/repo#skills/name --agent codex");
  const acks = [...new Set(opts.ack ?? [])];
  const reviews: ReviewResult[] = [];
  for (const s of [...new Set(sources)]) reviews.push((await reviewSource(s, opts, acks)).review);
  const plan = await buildPlan({ projectRoot, agents, reviews, acknowledged: acks, now: opts.now ?? new Date(), toolVersion: VERSION });
  const written = opts.out ? await writePlanFile(projectRoot, opts.out, plan) : null;
  return {
    data: { plan, path: written },
    warnings: written ? [`Created ${written}. Plans contain this machine's absolute project path; keep .skillpilot/plans/ out of version control.`] : [],
    text: (d) => [
      `Install plan for ${d.plan.agents.join(" + ")} (${d.plan.skills.length} skill${d.plan.skills.length > 1 ? "s" : ""}), expires ${d.plan.expiresAt}`,
      ...d.plan.skills.flatMap((s) => [
        `  ${e(s.name)}  ${e(`${s.source.owner}/${s.source.repository}`)}@${s.source.commit.slice(0, 12)}  ${s.files.length} files  ${e(s.license.spdx)}`,
        ...s.targets.map((t) => `    → ${t.path}/`),
        ...(s.review.acknowledged.length ? [`    acknowledged: ${s.review.acknowledged.join(", ")}`] : []),
      ]),
      `Lockfile: ${d.plan.preconditions.lockfile.state === "absent" ? "will be created" : "will be updated"} with ${d.plan.lockfileChanges.length} entr${d.plan.lockfileChanges.length === 1 ? "y" : "ies"} (.skillpilot/lock.json)`,
      ...d.plan.disclosures.map((x) => `Note: ${e(x)}`),
      `Plan digest: ${d.plan.planDigest}`,
      d.path ? `Saved: ${d.path}` : "Plan not saved (pass --out .skillpilot/plans/<name>.json to save it).",
      "Nothing has been installed. Approval and installation (skillpilot install) arrive in milestone M4.",
    ],
  };
}
