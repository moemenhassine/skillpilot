import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SkillpilotError } from "../errors.ts";
import { LockEntryProposalSchema } from "../planner/schemas.ts";
import { sha256Hex } from "./canonical.ts";
import { LOCKFILE_PATH } from "./paths.ts";

export const LockEntrySchema = LockEntryProposalSchema.extend({
  planDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  installedAt: z.string(),
  toolVersion: z.string(),
}).strict();
export type LockEntry = z.infer<typeof LockEntrySchema>;

export const LockfileSchema = z.object({ schemaVersion: z.literal(1), entries: z.array(LockEntrySchema) }).strict();
export type Lockfile = z.infer<typeof LockfileSchema>;

export type LockfileRead = { state: "absent" } | { state: "present"; bytes: Buffer; sha256: string; lock: Lockfile };

const MAX_LOCKFILE_BYTES = 4 * 1024 * 1024;

/** Reads and validates the lockfile. Malformed or unknown-schema lockfiles block mutations; they are never replaced. */
export async function readLockfile(projectRoot: string): Promise<LockfileRead> {
  const bytes = await readFile(path.join(projectRoot, LOCKFILE_PATH)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw new SkillpilotError("IO_ERROR", `${LOCKFILE_PATH} could not be read.`, "Check file permissions.");
  });
  if (!bytes) return { state: "absent" };
  const blocked = (why: string) => new SkillpilotError("INVALID_SCHEMA", `${LOCKFILE_PATH} ${why}; mutations are blocked.`, `Restore ${LOCKFILE_PATH} from version control. SkillPilot never replaces it with an empty lockfile.`);
  if (bytes.length > MAX_LOCKFILE_BYTES) throw blocked("is too large");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw blocked("is not valid JSON");
  }
  if ((json as { schemaVersion?: unknown } | null)?.schemaVersion !== 1) throw blocked("uses an unknown schema version (read-only until a migration exists)");
  const parsed = LockfileSchema.safeParse(json);
  if (!parsed.success) throw blocked("failed schema validation");
  return { state: "present", bytes, sha256: sha256Hex(bytes), lock: parsed.data };
}

export const lockKey = (e: { sourceId: string; agent: string }) => `${e.sourceId}\u0000${e.agent}`;

/** Deterministic serialization: entries sorted by source ID then target, two-space JSON, trailing newline. */
export function serializeLockfile(entries: LockEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (lockKey(a) < lockKey(b) ? -1 : lockKey(a) > lockKey(b) ? 1 : 0));
  return Buffer.from(JSON.stringify({ schemaVersion: 1, entries: sorted } satisfies Lockfile, null, 2) + "\n");
}

async function fsyncDir(dir: string): Promise<void> {
  // Directory fsync is unsupported on some platforms (Windows); the rename is still atomic there.
  const fh = await open(dir, "r").catch(() => null);
  await fh?.sync().catch(() => {});
  await fh?.close();
}

/** Write-to-temporary, flush, and atomic rename into place. */
export async function writeFileAtomic(file: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fh = await open(tmp, "wx", 0o644);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await fsyncDir(path.dirname(file));
}
