import { analyzeProject, type ProjectAnalysis } from "../analyzer/index.ts";
import { loadConfig } from "../schemas/config.ts";
import { escapeText as e } from "../renderers/escape.ts";
import type { CommandResult } from "../renderers/output.ts";

export interface ScanOptions {
  stack?: string[] | undefined;
  goal?: string | undefined;
}

export async function scanCommand(projectRoot: string, opts: ScanOptions): Promise<CommandResult<ProjectAnalysis>> {
  const config = await loadConfig(projectRoot);
  const analysis = await analyzeProject(projectRoot, { ...opts, config });
  const warnings = [...analysis.inventory.warnings];
  for (const hit of analysis.scan.limitHits) warnings.push(`Scan limit reached: ${hit}. Detection may be incomplete.`);
  for (const s of analysis.inventory.skills) {
    for (const u of s.userLevelSameName) warnings.push(`Project skill ${s.path} has a same-name user-level skill at ${u}.`);
  }
  return { data: analysis, warnings, text: renderScan };
}

export function renderScan(a: ProjectAnalysis): string[] {
  const lines = [`Project: ${e(a.projectRoot)}`];
  if (a.effectiveStack.length) lines.push(`Stack (${a.stackOrigin}): ${a.effectiveStack.join(", ")}`);
  else {
    lines.push("Stack: unknown");
    lines.push(`  Inspected: ${a.scan.inspectedCategories.join("; ")}`);
    lines.push("  Tip: declare a planned stack with --stack (e.g. --stack expo,typescript) and describe a --goal.");
  }
  for (const note of a.stackNotes) lines.push(`  Note: ${note}`);
  if (a.goal) lines.push(`Goal: ${e(a.goal)}`);
  if (a.detectedStack.length) {
    lines.push("Detected evidence:");
    for (const t of a.detectedStack) {
      const items = a.evidence.filter((x) => x.token === t.token && x.origin === "detected").slice(0, 3);
      const more = t.evidenceCount > items.length ? ` (+${t.evidenceCount - items.length} more)` : "";
      lines.push(`  ${t.token.padEnd(14)} ${t.confidence.padEnd(6)} ${items.map((x) => `${e(x.path)} ${e(x.key)}`).join("; ")}${more}`);
    }
  }
  if (a.monorepo.detected) {
    lines.push(`Monorepo: child packages ${a.monorepo.childPackages.map(e).join(", ") || "(none within scan depth)"}`);
    lines.push("  Rerun with --project <package-path> for focused results.");
  }
  lines.push(a.inventory.skills.length ? "Installed project skills:" : "Installed project skills: none");
  for (const s of a.inventory.skills) {
    const m = s.manifest;
    const status = s.symlink ? "symlink (not inspected)" : m.valid ? (m.nameMatchesDirectory ? `name ${m.name}` : `name ${m.name} (does not match directory)`) : `invalid manifest: ${e(m.problems[0] ?? "")}`;
    lines.push(`  ${s.agent.padEnd(12)} ${e(s.path)}  ${status}`);
  }
  const counts = (r: string) => a.scan.skipped.filter((s) => s.reason === r).length;
  lines.push(
    `Skipped: ${counts("secret")} secret-like files (never opened), ${counts("symlink")} symlinks, ${a.scan.excludedDirs} excluded directories, ${a.scan.ignoredCount} ignored paths.`,
  );
  for (const u of a.scan.unparsed) lines.push(`  Not parsed: ${e(u.path)} (${u.reason})`);
  lines.push(`Read ${a.scan.filesRead.length} files (${a.scan.bytesRead} bytes) of ${a.scan.entriesVisited} entries visited. Nothing was written.`);
  return lines;
}
