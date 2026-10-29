// NFR-004/005 benchmark: scan a bounded 5,000-entry project fixture and rank a 1,000-entry catalog,
// 20 runs each, reporting p50/p95 wall time; then review a maximum-size payload and report peak RSS.
// Generated fixtures live in the OS temp directory. Prints the machine it ran on; no network.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { analyzeProject } from "../src/analyzer/index.ts";
import { recommend, type Candidate } from "../src/recommender/index.ts";
import { goalTags } from "../src/recommender/taxonomy.ts";
import { reviewPayload } from "../src/review/index.ts";
import { loadBundledCatalog } from "../src/sources/catalog.ts";
import { sha256Hex } from "../src/storage/canonical.ts";

const RUNS = 20;
const LIMIT_MS = 3000;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;

// ~5,000 entries: 50 packages × (package dir, src dir, package.json, 96 sources) plus the root files.
const project = mkdtempSync(path.join(os.tmpdir(), "skillpilot-bench-"));
writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "bench", dependencies: { next: "15.0.0", react: "19.0.0" }, devDependencies: { "@playwright/test": "1.0.0", typescript: "5.6.0" } }));
for (let p = 0; p < 50; p++) {
  const dir = path.join(project, "packages", `pkg-${p}`, "src");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(project, "packages", `pkg-${p}`, "package.json"), JSON.stringify({ name: `pkg-${p}`, dependencies: { react: "19.0.0" } }));
  for (let f = 0; f < 96; f++) writeFileSync(path.join(dir, `file-${f}.ts`), "export const x = 1;\n");
}

async function time(fn: () => unknown | Promise<unknown>): Promise<number[]> {
  await fn(); // warm-up, not counted
  const out: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
  }
  return out;
}

const scan = await time(() => analyzeProject(project, {}));
const analysis = await analyzeProject(project, {});

const base = loadBundledCatalog().entries;
const candidates: Candidate[] = Array.from({ length: 1000 }, (_, i) => {
  const e = base[i % base.length]!;
  return { ...e, id: `${e.id}-${i}`, name: `${e.name}-${i}`.slice(0, 64), annotationOrigin: "curated", discoveredVia: ["bench"] };
});
const tags = goalTags("write and run browser tests for the web app");
const rank = await time(() => recommend({ candidates, stack: analysis.effectiveStack, goalTags: tags, agents: ["claude-code", "codex"], limit: 5 }));

// Maximum supported payload: 200 text files totalling ~5 MiB.
const files = Array.from({ length: 200 }, (_, i) => {
  const text = i === 0 ? "---\nname: bench\ndescription: Benchmark payload.\nlicense: MIT\n---\n" : `# Part ${i}\n${"Plain reference text for review. ".repeat(800)}\n`;
  return { path: i === 0 ? "SKILL.md" : `references/part-${i}.md`, bytes: Buffer.from(text) };
});
files.push({ path: "LICENSE", bytes: Buffer.from("MIT License\n\nCopyright (c) 2026 Bench\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n") });
const bytes = new Map(files.map((f) => [f.path, f.bytes]));
const reviewMs = await time(() => reviewPayload({
  schemaVersion: 1, fetchedAt: "", lastUsed: "", excluded: [], limitsExceeded: [],
  source: { provider: "github", owner: "bench", repository: "bench", skillPath: "bench", commit: "0".repeat(40) },
  files: files.map((f) => ({ path: f.path, sourcePath: f.path, size: f.bytes.length, sha256: sha256Hex(f.bytes), installedMode: "0644" as const, role: f.path === "LICENSE" ? "license" as const : "skill" as const })),
}, bytes));

const rssMiB = process.resourceUsage().maxRSS / 1024; // maxRSS is in KiB on every platform
const fmt = (xs: number[]) => `p50 ${pct(xs, 50).toFixed(1)} ms, p95 ${pct(xs, 95).toFixed(1)} ms`;
console.log(`Machine: ${os.cpus()[0]?.model ?? "unknown"} × ${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB, ${os.platform()} ${os.release()}, Node ${process.versions.node}`);
console.log(`Scan 5,000-entry fixture (${analysis.scan.entriesVisited} entries visited, ${analysis.scan.limitHits.length ? `limits hit: ${analysis.scan.limitHits.join(", ")}` : "no limits hit"}): ${fmt(scan)}`);
console.log(`Rank 1,000-entry catalog: ${fmt(rank)}`);
console.log(`Review 200-file ${(files.reduce((n, f) => n + f.bytes.length, 0) / 2 ** 20).toFixed(1)} MiB payload: ${fmt(reviewMs)}`);
console.log(`Peak RSS for the whole run: ${rssMiB.toFixed(0)} MiB (limit 256 MiB)`);
const ok = pct(scan, 95) <= LIMIT_MS && pct(rank, 95) <= LIMIT_MS && rssMiB <= 256;
console.log(ok ? "PASS NFR-004/005 targets on this machine." : "FAIL: a target was missed on this machine.");
process.exit(ok ? 0 : 1);
