import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { COMMIT_ID } from "../sources/catalog.ts";
import { domainDigest, sha256Hex } from "./canonical.ts";

export const CACHE_CAP_BYTES = 100 * 1024 * 1024;

export const SourceIdentitySchema = z
  .object({ provider: z.literal("github"), owner: z.string(), repository: z.string(), skillPath: z.string(), commit: z.string().regex(COMMIT_ID) })
  .strict();
export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;

export const PayloadFileSchema = z
  .object({
    path: z.string(),
    sourcePath: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    installedMode: z.literal("0644"),
    role: z.enum(["skill", "license", "notice"]),
  })
  .strict();
export type PayloadFile = z.infer<typeof PayloadFileSchema>;

export const ExcludedSchema = z
  .object({
    sourcePath: z.string(),
    reason: z.enum(["symlink", "submodule", "special-file", "unsupported-type", "oversize-file", "unsafe-path", "license-collision"]),
  })
  .strict();
export type Excluded = z.infer<typeof ExcludedSchema>;

export const CachedPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: SourceIdentitySchema,
    fetchedAt: z.string(),
    lastUsed: z.string(),
    files: z.array(PayloadFileSchema).max(202),
    excluded: z.array(ExcludedSchema),
    limitsExceeded: z.array(z.string()),
    review: z
      .object({ ruleSet: z.string(), policyVersion: z.string(), payloadDigest: z.string(), coverage: z.string(), decision: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type CachedPayload = z.infer<typeof CachedPayloadSchema>;

/** Digest over the canonical, path-sorted inventory plus exact source identity (spec 12.2). */
export function payloadDigest(source: SourceIdentity, files: PayloadFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return domainDigest("skillpilot-payload-v1", { source, files: sorted });
}

export function payloadDir(cacheRoot: string, s: Pick<SourceIdentity, "owner" | "repository" | "commit" | "skillPath">): string {
  return path.join(cacheRoot, "payloads", `${s.owner.toLowerCase()}__${s.repository.toLowerCase()}`, s.commit, encodeURIComponent(s.skillPath));
}

async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function writePayload(cacheRoot: string, manifest: CachedPayload, bytes: Map<string, Uint8Array>): Promise<string> {
  const dir = payloadDir(cacheRoot, manifest.source);
  await mkdir(path.join(dir, "blobs"), { recursive: true });
  for (const f of manifest.files) await atomicWrite(path.join(dir, "blobs", f.sha256), bytes.get(f.path)!);
  await atomicWrite(path.join(dir, "manifest.json"), JSON.stringify(CachedPayloadSchema.parse(manifest), null, 2));
  await evictPayloads(cacheRoot, CACHE_CAP_BYTES, dir);
  return dir;
}

export type CacheRead =
  | { state: "absent" }
  | { state: "corrupt"; reason: string }
  | { state: "ok"; manifest: CachedPayload; bytes: Map<string, Uint8Array> };

/** Reads a cached payload and verifies every file's size and SHA-256. Cache contents are never trusted. */
export async function readPayload(cacheRoot: string, s: Pick<SourceIdentity, "owner" | "repository" | "commit" | "skillPath">): Promise<CacheRead> {
  const dir = payloadDir(cacheRoot, s);
  const raw = await readFile(path.join(dir, "manifest.json"), "utf8").catch(() => null);
  if (raw === null) return { state: "absent" };
  let manifest: CachedPayload;
  try {
    manifest = CachedPayloadSchema.parse(JSON.parse(raw));
  } catch {
    return { state: "corrupt", reason: "manifest failed validation" };
  }
  const id = manifest.source;
  if (id.owner.toLowerCase() !== s.owner.toLowerCase() || id.repository.toLowerCase() !== s.repository.toLowerCase() || id.commit !== s.commit || id.skillPath !== s.skillPath) {
    return { state: "corrupt", reason: "manifest identity does not match its location" };
  }
  const bytes = new Map<string, Uint8Array>();
  for (const f of manifest.files) {
    const b = await readFile(path.join(dir, "blobs", f.sha256)).catch(() => null);
    if (!b || b.length !== f.size || sha256Hex(b) !== f.sha256) return { state: "corrupt", reason: `cached bytes for ${f.path} do not match their hash` };
    bytes.set(f.path, b);
  }
  return { state: "ok", manifest, bytes };
}

/** Manifest-only read for status display; never used to authorize installation. */
export async function readCachedManifest(cacheRoot: string, s: Pick<SourceIdentity, "owner" | "repository" | "commit" | "skillPath">): Promise<CachedPayload | null> {
  const raw = await readFile(path.join(payloadDir(cacheRoot, s), "manifest.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  const parsed = CachedPayloadSchema.safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
  return parsed.success && parsed.data.source.commit === s.commit ? parsed.data : null;
}

export async function updateManifest(cacheRoot: string, manifest: CachedPayload): Promise<void> {
  await atomicWrite(path.join(payloadDir(cacheRoot, manifest.source), "manifest.json"), JSON.stringify(CachedPayloadSchema.parse(manifest), null, 2));
}

export async function invalidatePayload(cacheRoot: string, s: Pick<SourceIdentity, "owner" | "repository" | "commit" | "skillPath">): Promise<void> {
  await rm(payloadDir(cacheRoot, s), { recursive: true, force: true });
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) total += (await stat(path.join(e.parentPath, e.name))).size;
  }
  return total;
}

/** Deterministic LRU eviction by `lastUsed`, then path. Never evicts `keep`. */
export async function evictPayloads(cacheRoot: string, capBytes: number, keep?: string): Promise<string[]> {
  const root = path.join(cacheRoot, "payloads");
  const entries: { dir: string; size: number; lastUsed: string }[] = [];
  for (const repo of await readdir(root).catch(() => [])) {
    for (const commit of await readdir(path.join(root, repo)).catch(() => [])) {
      for (const skill of await readdir(path.join(root, repo, commit)).catch(() => [])) {
        const dir = path.join(root, repo, commit, skill);
        const m = await readFile(path.join(dir, "manifest.json"), "utf8").then((t) => JSON.parse(t) as { lastUsed?: string }, () => ({ lastUsed: "" }));
        entries.push({ dir, size: await dirSize(dir), lastUsed: m.lastUsed ?? "" });
      }
    }
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  const evicted: string[] = [];
  for (const e of entries.sort((a, b) => (a.lastUsed < b.lastUsed ? -1 : a.lastUsed > b.lastUsed ? 1 : a.dir < b.dir ? -1 : 1))) {
    if (total <= capBytes) break;
    if (e.dir === keep) continue;
    await rm(e.dir, { recursive: true, force: true });
    total -= e.size;
    evicted.push(e.dir);
  }
  return evicted;
}
