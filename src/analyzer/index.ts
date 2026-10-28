import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SkillpilotError } from "../errors.ts";
import { SCAN_HARD_LIMITS, STACK_TOKEN, type Config } from "../schemas/config.ts";
import { detectFromContent, detectFromName, isParsedFile, type Confidence, type Evidence } from "./detect.ts";
import { readBounded } from "./fsutil.ts";
import { inventorySkills, type Inventory } from "./inventory.ts";
import { walkProject, type WalkResult } from "./walk.ts";

export type { Evidence } from "./detect.ts";

export interface StackToken {
  token: string;
  confidence: Confidence;
  evidenceCount: number;
}

export interface ProjectAnalysis {
  projectRoot: string;
  detectedStack: StackToken[];
  effectiveStack: string[];
  stackOrigin: "cli" | "config" | "detected" | "none";
  stackNotes: string[];
  goal: string | null;
  evidence: Evidence[];
  monorepo: { detected: boolean; childPackages: string[] };
  inventory: Inventory;
  scan: {
    filesRead: string[];
    bytesRead: number;
    entriesVisited: number;
    skipped: WalkResult["skipped"];
    excludedDirs: number;
    ignoredCount: number;
    limitHits: string[];
    unparsed: { path: string; reason: string }[];
    inspectedCategories: string[];
  };
}

export interface AnalyzeOptions {
  stack?: string[] | undefined;
  goal?: string | undefined;
  config?: Config | null;
  /** Overrides the home directory used for user-level inventory (tests). */
  home?: string;
}

const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const ALIASES: Record<string, string> = { next: "nextjs", "next.js": "nextjs", rn: "react-native", ts: "typescript", js: "javascript", py: "python" };

export const INSPECTED_CATEGORIES = [
  "JavaScript/TypeScript manifests", "React/web", "React Native/Expo (app.json)", "Swift/iOS", "Android/Gradle",
  "Python manifests", "Data science/ML dependencies", "AI SDK dependencies", "Testing/infra config files",
];

/** Normalizes user-declared stack tokens; rejects invalid ones rather than guessing. */
export function normalizeStack(tokens: string[]): string[] {
  const out: string[] = [];
  for (const raw of tokens) {
    const t = raw.normalize("NFKC").trim().toLowerCase();
    if (!t) continue;
    const token = ALIASES[t] ?? t;
    if (!STACK_TOKEN.test(token)) throw new SkillpilotError("INVALID_ARGUMENT", `Invalid stack token "${raw.slice(0, 40)}".`, "Use lowercase tokens such as nextjs,typescript,expo.");
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/** Resolves an explicit project root; never ascends to a different workspace (FR-001). */
export async function resolveProjectRoot(input: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path.resolve(input));
  } catch {
    throw new SkillpilotError("INVALID_ARGUMENT", "Project path does not exist or is not accessible.", "Pass an existing project directory.", { path: input });
  }
  if (!(await stat(real)).isDirectory()) {
    throw new SkillpilotError("INVALID_ARGUMENT", "Project path is not a directory.", "Pass a project directory, not a file.");
  }
  return real;
}

export async function analyzeProject(projectRoot: string, opts: AnalyzeOptions = {}): Promise<ProjectAnalysis> {
  const limits: Record<keyof typeof SCAN_HARD_LIMITS, number> = { ...SCAN_HARD_LIMITS };
  for (const [k, v] of Object.entries(opts.config?.scan ?? {})) if (v !== undefined) limits[k as keyof typeof limits] = v;
  const walk = await walkProject(projectRoot, limits);
  const evidence: Evidence[] = [];
  const filesRead = [...walk.ignoreFilesRead];
  const unparsed: { path: string; reason: string }[] = [];
  const limitHits = [...walk.limitHits];
  let bytesRead = 0;
  let parsedCount = 0;
  let workspaces = false;

  for (const rel of walk.files) {
    evidence.push(...detectFromName(rel));
    if (!isParsedFile(rel)) continue;
    if (parsedCount >= limits.maxParsedFiles) {
      if (!limitHits.some((h) => h.startsWith("maxParsedFiles"))) limitHits.push(`maxParsedFiles (${limits.maxParsedFiles})`);
      unparsed.push({ path: rel, reason: "parsed-file limit reached" });
      continue;
    }
    const remaining = limits.maxTotalBytes - bytesRead;
    if (remaining <= 0) {
      if (!limitHits.some((h) => h.startsWith("maxTotalBytes"))) limitHits.push(`maxTotalBytes (${limits.maxTotalBytes})`);
      unparsed.push({ path: rel, reason: "total parsed-bytes limit reached" });
      continue;
    }
    let read;
    try {
      read = await readBounded(path.join(projectRoot, rel), Math.min(limits.maxFileBytes, remaining));
    } catch {
      unparsed.push({ path: rel, reason: "unreadable" });
      continue;
    }
    parsedCount++;
    filesRead.push(rel);
    bytesRead += read.bytes.length;
    if (read.truncated) {
      unparsed.push({ path: rel, reason: "exceeds per-file size limit" });
      continue;
    }
    const found = detectFromContent(rel, read.bytes.toString("utf8"));
    evidence.push(...found.evidence);
    if (found.problem) unparsed.push({ path: rel, reason: found.problem });
    if (found.workspaces && !rel.includes("/")) workspaces = true;
  }

  const dedup = new Map<string, Evidence>();
  for (const e of evidence) dedup.set(`${e.path}\0${e.key}\0${e.token}`, e);
  const sorted = [...dedup.values()].sort((a, b) => cmp(a.path, b.path) || cmp(a.key, b.key) || cmp(a.token, b.token));

  const byToken = new Map<string, StackToken>();
  for (const e of sorted) {
    const cur = byToken.get(e.token);
    if (!cur) byToken.set(e.token, { token: e.token, confidence: e.confidence, evidenceCount: 1 });
    else {
      cur.evidenceCount++;
      if (RANK[e.confidence] > RANK[cur.confidence]) cur.confidence = e.confidence;
    }
  }
  const detectedStack = [...byToken.values()].sort((a, b) => cmp(a.token, b.token));

  const childPackages = [...new Set(walk.files.filter((f) => f.includes("/") && /(^|\/)(package\.json|pyproject\.toml)$/.test(f)).map((f) => f.slice(0, f.lastIndexOf("/"))))].sort();
  const workspaceFile = walk.files.some((f) => /^(pnpm-workspace\.yaml|lerna\.json|turbo\.json|nx\.json)$/.test(f));
  const monorepo = { detected: workspaces || workspaceFile || childPackages.length >= 2, childPackages };

  // Precedence: explicit CLI stack, then configured stack, then detected (spec 14.5). Lists are never unioned.
  const cliStack = opts.stack ? normalizeStack(opts.stack) : [];
  const configStack = opts.config?.stack ? normalizeStack(opts.config.stack) : [];
  const detectedTokens = detectedStack.filter((t) => t.confidence !== "low").map((t) => t.token);
  const [effectiveStack, stackOrigin] = cliStack.length ? [cliStack, "cli" as const]
    : configStack.length ? [configStack, "config" as const]
    : detectedTokens.length ? [detectedTokens, "detected" as const] : [[], "none" as const];
  const stackNotes: string[] = [];
  const declared: Evidence[] = [];
  if (stackOrigin === "cli" || stackOrigin === "config") {
    for (const t of effectiveStack) declared.push({ path: ".", key: `${stackOrigin}-stack`, token: t, confidence: "high", origin: "user-declared" });
    const notDeclared = detectedTokens.filter((t) => !effectiveStack.includes(t));
    if (notDeclared.length) stackNotes.push(`Detected but not in the ${stackOrigin} stack: ${notDeclared.join(", ")}.`);
    const notDetected = effectiveStack.filter((t) => !byToken.has(t));
    if (notDetected.length) stackNotes.push(`Declared without file evidence: ${notDetected.join(", ")}.`);
  }
  if (stackOrigin === "detected" && detectedStack.some((t) => t.confidence === "low")) {
    stackNotes.push("Low-confidence tokens (source file extensions only) are reported but excluded from the effective stack.");
  }

  return {
    projectRoot,
    detectedStack,
    effectiveStack,
    stackOrigin,
    stackNotes,
    goal: opts.goal?.trim().slice(0, 500) || null,
    evidence: [...sorted, ...declared],
    monorepo,
    inventory: await inventorySkills(projectRoot, opts.home),
    scan: {
      filesRead, bytesRead, entriesVisited: walk.entriesVisited, skipped: walk.skipped, excludedDirs: walk.excludedDirs,
      ignoredCount: walk.ignoredCount, limitHits, unparsed, inspectedCategories: INSPECTED_CATEGORIES,
    },
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
