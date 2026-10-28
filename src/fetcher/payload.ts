import path from "node:path";
import { SkillpilotError } from "../errors.ts";
import { classifyPath, MAX_IMAGE_BYTES } from "../review/policy.ts";
import { collisionKey, pathProblem, type SourceRef } from "../sources/grammar.ts";
import { sha256Hex } from "../storage/canonical.ts";
import {
  invalidatePayload, readPayload, updateManifest, writePayload,
  type CachedPayload, type Excluded, type PayloadFile, type SourceIdentity,
} from "../storage/payload-cache.ts";
import type { GitHubClient, TreeEntry } from "./github.ts";

export const SKILL_LIMITS = { maxFiles: 200, maxFileBytes: 512 * 1024, maxTotalBytes: 5 * 1024 * 1024 } as const;
const ROOT_LICENSE = /^(LICEN[CS]E|COPYING)(\.(txt|md))?$/i;
const ROOT_NOTICE = /^NOTICE(\.(txt|md))?$/i;

export interface FetchedPayload {
  manifest: CachedPayload;
  bytes: Map<string, Uint8Array>;
  fromCache: boolean;
  cacheDir?: string;
}

/**
 * Resolves a source to an immutable commit and returns its complete, hash-verified payload.
 * With a pinned commit, a valid cache entry is used without network access. Install never calls this.
 */
export async function fetchPayload(client: GitHubClient | null, ref: SourceRef, cacheRoot: string, now: Date): Promise<FetchedPayload> {
  if (ref.commit) {
    const cached = await readPayload(cacheRoot, { ...ref, commit: ref.commit });
    if (cached.state === "ok") {
      cached.manifest.lastUsed = now.toISOString();
      await updateManifest(cacheRoot, cached.manifest);
      return { manifest: cached.manifest, bytes: cached.bytes, fromCache: true };
    }
    if (cached.state === "corrupt") {
      await invalidatePayload(cacheRoot, { ...ref, commit: ref.commit });
      if (!client) throw new SkillpilotError("SOURCE_UNAVAILABLE", `Cached payload was corrupt (${cached.reason}) and has been invalidated.`, "Rerun without --offline to refetch it.");
    }
  }
  if (!client) {
    throw new SkillpilotError("SOURCE_UNAVAILABLE", ref.commit ? "The pinned payload is not in the local cache and --offline forbids fetching it." : "--offline requires a pinned @<commit> source with a cached payload.", "Rerun without --offline, or pass owner/repository@<commit>#path for a cached payload.");
  }

  const info = await client.getRepository(ref.owner, ref.repository);
  const commit = ref.commit ?? (await client.resolveBranch(ref.owner, ref.repository, info.defaultBranch));
  if (!ref.commit) {
    const cached = await readPayload(cacheRoot, { ...ref, commit });
    if (cached.state === "ok") return { manifest: cached.manifest, bytes: cached.bytes, fromCache: true };
  }
  const tree = await client.getTree(ref.owner, ref.repository, commit);
  const source: SourceIdentity = { provider: "github", owner: ref.owner, repository: ref.repository, skillPath: ref.skillPath, commit };
  const prefix = ref.skillPath === "." ? "" : `${ref.skillPath}/`;
  const inPayload = tree.filter((e) => (prefix ? e.path.startsWith(prefix) : true) && e.type !== "tree");
  if (prefix && !inPayload.length) throw new SkillpilotError("SOURCE_UNAVAILABLE", `No skill directory at ${ref.skillPath} in that commit.`, "Check the path after #.");

  const excluded: Excluded[] = [];
  const wanted: TreeEntry[] = [];
  for (const e of inPayload) {
    const rel = e.path.slice(prefix.length);
    const kind = classifyPath(rel);
    if (e.type === "commit") excluded.push({ sourcePath: e.path, reason: "submodule" });
    else if (e.type !== "blob") excluded.push({ sourcePath: e.path, reason: "special-file" });
    else if (e.mode === "120000") excluded.push({ sourcePath: e.path, reason: "symlink" });
    else if (pathProblem(rel)) excluded.push({ sourcePath: e.path, reason: "unsafe-path" });
    else if (kind === "unsupported") excluded.push({ sourcePath: e.path, reason: "unsupported-type" });
    else if ((e.size ?? 0) > (kind === "image" ? MAX_IMAGE_BYTES : SKILL_LIMITS.maxFileBytes)) excluded.push({ sourcePath: e.path, reason: "oversize-file" });
    else wanted.push(e);
  }
  // Caps apply before any blob is fetched.
  const limitsExceeded: string[] = [];
  const blobCount = inPayload.filter((e) => e.type === "blob").length;
  const totalBytes = inPayload.reduce((n, e) => n + (e.size ?? 0), 0);
  if (blobCount > SKILL_LIMITS.maxFiles) limitsExceeded.push(`more than ${SKILL_LIMITS.maxFiles} files (${blobCount})`);
  if (totalBytes > SKILL_LIMITS.maxTotalBytes) limitsExceeded.push(`more than ${SKILL_LIMITS.maxTotalBytes} bytes (${totalBytes})`);

  const files: PayloadFile[] = [];
  const bytes = new Map<string, Uint8Array>();
  const add = async (e: TreeEntry, target: string, role: PayloadFile["role"]) => {
    const b = await client.getBlob(ref.owner, ref.repository, e.sha, SKILL_LIMITS.maxFileBytes);
    files.push({ path: target, sourcePath: e.path, size: b.length, sha256: sha256Hex(b), installedMode: "0644", role });
    bytes.set(target, b);
  };
  if (!limitsExceeded.length) {
    for (const e of wanted.sort((a, b) => (a.path < b.path ? -1 : 1))) await add(e, e.path.slice(prefix.length), "skill");
    // Upstream license/notice outside the skill directory is mapped in as provenance (spec 10.3).
    if (prefix && !files.some((f) => classifyPath(f.path) === "license" && !f.path.includes("/"))) {
      const taken = new Set(files.map((f) => collisionKey(f.path)));
      for (const [re, role] of [[ROOT_LICENSE, "license"], [ROOT_NOTICE, "notice"]] as const) {
        const root = tree.filter((e) => e.type === "blob" && e.mode !== "120000" && re.test(e.path)).sort((a, b) => (a.path < b.path ? -1 : 1))[0];
        if (!root) continue;
        const target = path.posix.basename(root.path);
        if (taken.has(collisionKey(target))) excluded.push({ sourcePath: root.path, reason: "license-collision" });
        else await add(root, target, role);
      }
    }
  }
  const stamp = now.toISOString();
  const manifest: CachedPayload = { schemaVersion: 1, source, fetchedAt: stamp, lastUsed: stamp, files, excluded, limitsExceeded };
  const cacheDir = await writePayload(cacheRoot, manifest, bytes);
  return { manifest, bytes, fromCache: false, cacheDir };
}
