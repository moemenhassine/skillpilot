import type { Plan } from "../planner/index.ts";
import { LOCKFILE_PATH } from "../storage/paths.ts";
import { escapeText as e } from "./escape.ts";

export const shortDigest = (digest: string) => digest.slice("sha256:".length, "sha256:".length + 12);
export const confirmPhrase = (plan: Plan) => `${plan.operation} ${shortDigest(plan.planDigest)}`;

/** Everything a human approves: operation, sources, review results, every target path, bytes, modes, and lockfile change. */
export function renderPlan(plan: Plan): string[] {
  const lines: string[] = [];
  if (plan.operation === "install") {
    lines.push(`INSTALL plan for ${plan.agents.join(" + ")} (${plan.skills.length} skill${plan.skills.length > 1 ? "s" : ""}), expires ${plan.expiresAt}`);
    for (const s of plan.skills) {
      const bytes = s.files.reduce((n, f) => n + f.size, 0);
      lines.push(`  ${e(s.name)}  ${e(`${s.source.owner}/${s.source.repository}`)}@${s.source.commit.slice(0, 12)}#${e(s.source.skillPath)}  ${s.files.length} files, ${bytes} bytes  ${e(s.license.spdx)}`);
      lines.push(`    review ${s.review.ruleSet}: ${s.review.coverage}, ${s.review.decision}, ${s.review.findings.length} finding(s)`);
      for (const f of s.review.findings) lines.push(`      [${f.severity.toUpperCase()}] ${f.ruleId} ${f.id} ${e(f.file)}${s.review.acknowledged.includes(f.id) ? " (acknowledged)" : ""}`);
      for (const t of s.targets) {
        const state = plan.preconditions.targets.find((p) => p.path === t.path)?.state;
        lines.push(`    → ${t.path}/${state === "managed" ? "  (already installed, unchanged)" : ""}`);
      }
    }
  } else {
    lines.push(`REMOVE plan for ${plan.agents.join(" + ")}, expires ${plan.expiresAt}`);
    for (const r of plan.removals) lines.push(`  ${e(r.name)}  ${e(r.sourceId)}`, `    ✗ ${r.path}/  (${r.files.length} owned files deleted)`);
  }
  const n = plan.lockfileChanges.length;
  lines.push(`Lockfile: ${plan.preconditions.lockfile.state === "absent" ? "created" : "updated"} at ${LOCKFILE_PATH} (${n} entr${n === 1 ? "y" : "ies"} ${plan.operation === "install" ? "added" : "removed"})`);
  lines.push(...plan.disclosures.map((x) => `Note: ${e(x)}`));
  lines.push(`Plan digest: ${plan.planDigest}`);
  return lines;
}
