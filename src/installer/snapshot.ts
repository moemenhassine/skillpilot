import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SKILL_LIMITS } from "../fetcher/payload.ts";
import { sha256Hex } from "../storage/canonical.ts";

export interface OwnedFile {
  path: string;
  sha256: string;
  size: number;
  installedMode: string;
}

export type Comparison =
  | { state: "absent" }
  | { state: "identical" }
  | { state: "modified"; changed: string[]; missing: string[]; extra: string[] };

const CHECK_MODES = process.platform !== "win32";

/**
 * Compares a directory against the exact owned file set: every byte hash, the installed mode, and
 * no additional files, directories, or links. Never follows symlinks.
 */
export async function compareDir(dir: string, files: OwnedFile[]): Promise<Comparison> {
  const root = await lstat(dir).catch(() => null);
  if (!root) return { state: "absent" };
  if (!root.isDirectory()) return { state: "modified", changed: ["."], missing: [], extra: [] };
  const expected = new Map(files.map((f) => [f.path, f]));
  const expectedDirs = new Set(files.flatMap((f) => {
    const parts = f.path.split("/").slice(0, -1);
    return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  }));
  const changed: string[] = [], extra: string[] = [], seen = new Set<string>();
  const limit = SKILL_LIMITS.maxFiles * 2;
  const queue = [""];
  while (queue.length) {
    const rel = queue.shift()!;
    for (const ent of (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      if (seen.size + extra.length > limit) { extra.push("(more entries)"); return { state: "modified", changed, missing: [], extra }; }
      if (ent.isDirectory() && expectedDirs.has(p)) { queue.push(p); continue; }
      const want = expected.get(p);
      if (!ent.isFile() || !want) { extra.push(p); continue; }
      seen.add(p);
      const st = await lstat(path.join(dir, p));
      const modeOk = !CHECK_MODES || (st.mode & 0o777) === Number.parseInt(want.installedMode, 8);
      if (st.size !== want.size || !modeOk || sha256Hex(await readFile(path.join(dir, p))) !== want.sha256) changed.push(p);
    }
  }
  const missing = files.map((f) => f.path).filter((p) => !seen.has(p));
  return changed.length || missing.length || extra.length ? { state: "modified", changed, missing, extra } : { state: "identical" };
}
