import { readdir } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { readBounded } from "./fsutil.ts";

export interface WalkLimits {
  maxDepth: number;
  maxEntries: number;
}

export type SkipReason = "secret" | "symlink" | "special-file" | "unreadable";

export interface WalkResult {
  /** Project-relative POSIX paths of regular files, sorted. */
  files: string[];
  skipped: { path: string; reason: SkipReason }[];
  excludedDirs: number;
  ignoredCount: number;
  entriesVisited: number;
  limitHits: string[];
  ignoreFilesRead: string[];
}

// Mandatory exclusions (dependencies, VCS, envs, build output, caches, agent skill dirs). Not negatable.
const EXCLUDED_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", ".venv", "venv", ".tox", "__pycache__", ".mypy_cache", ".pytest_cache",
  ".ipynb_checkpoints", "site-packages", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".expo", ".gradle",
  ".build", "Pods", "DerivedData", "target", "coverage", ".turbo", ".cache", ".skillpilot", ".claude", ".agents",
]);

const SECRET_FILE = [
  /^\.env(\..*)?$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials|htpasswd)$/i,
  /credential/i,
  /secret/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|keystore|jks|mobileprovision|tfvars|kdbx)$/i,
  /^google-services\.json$/i,
  /^GoogleService-Info\.plist$/i,
  /^service-account.*\.json$/i,
];

export const isSecretFileName = (name: string) => SECRET_FILE.some((re) => re.test(name));

const IGNORE_FILES = [".gitignore", ".skillpilotignore"];

async function loadIgnore(root: string, read: string[]): Promise<Ignore> {
  const ig = ignore();
  for (const name of IGNORE_FILES) {
    try {
      // shortcut: only root-level ignore files are honoured; nested .gitignore files are not, upgrade if detection noise appears.
      const { bytes } = await readBounded(path.join(root, name), 64 * 1024);
      ig.add(bytes.toString("utf8"));
      read.push(name);
    } catch {
      // Absent or unreadable ignore files are optional.
    }
  }
  return ig;
}

/** Breadth-first, sorted, bounded, read-only walk that never follows symlinks. */
export async function walkProject(root: string, limits: WalkLimits): Promise<WalkResult> {
  const result: WalkResult = { files: [], skipped: [], excludedDirs: 0, ignoredCount: 0, entriesVisited: 0, limitHits: [], ignoreFilesRead: [] };
  const ig = await loadIgnore(root, result.ignoreFilesRead);
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];

  outer: while (queue.length) {
    const { rel, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      if (rel) result.skipped.push({ path: rel, reason: "unreadable" });
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (result.entriesVisited >= limits.maxEntries) {
        result.limitHits.push(`maxEntries (${limits.maxEntries})`);
        break outer;
      }
      result.entriesVisited++;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        result.skipped.push({ path: childRel, reason: "symlink" });
      } else if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) result.excludedDirs++;
        else if (ig.ignores(`${childRel}/`)) result.ignoredCount++;
        else if (depth + 1 < limits.maxDepth) queue.push({ rel: childRel, depth: depth + 1 });
        else if (!result.limitHits.includes(`maxDepth (${limits.maxDepth})`)) result.limitHits.push(`maxDepth (${limits.maxDepth})`);
      } else if (entry.isFile()) {
        if (isSecretFileName(entry.name)) result.skipped.push({ path: childRel, reason: "secret" });
        else if (ig.ignores(childRel)) result.ignoredCount++;
        else result.files.push(childRel);
      } else {
        result.skipped.push({ path: childRel, reason: "special-file" });
      }
    }
  }
  return result;
}
