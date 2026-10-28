import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SkillpilotError } from "../errors.ts";

/** Hard security caps; project config may only narrow them (FR-054). */
export const SCAN_HARD_LIMITS = {
  maxDepth: 4,
  maxEntries: 5000,
  maxParsedFiles: 100,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
} as const;

export const REPOSITORY_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const STACK_TOKEN = /^[a-z0-9][a-z0-9.+-]{0,39}$/;

const cap = (max: number) => z.number().int().min(1).max(max);

export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultLimit: z.number().int().min(1).max(20).optional(),
    stack: z.array(z.string().regex(STACK_TOKEN)).max(50).optional(),
    repositories: z.array(z.string().regex(REPOSITORY_ID)).max(20).optional(),
    excludeSkillIds: z.array(z.string().min(1).max(300)).max(200).optional(),
    scan: z
      .object({
        maxDepth: cap(SCAN_HARD_LIMITS.maxDepth).optional(),
        maxEntries: cap(SCAN_HARD_LIMITS.maxEntries).optional(),
        maxParsedFiles: cap(SCAN_HARD_LIMITS.maxParsedFiles).optional(),
        maxFileBytes: cap(SCAN_HARD_LIMITS.maxFileBytes).optional(),
        maxTotalBytes: cap(SCAN_HARD_LIMITS.maxTotalBytes).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_PATH = ".skillpilot/config.json";

/** Loads and strictly validates the project config. Returns null when absent. */
export async function loadConfig(projectRoot: string): Promise<Config | null> {
  const file = path.join(projectRoot, CONFIG_PATH);
  for (const p of [path.dirname(file), file]) {
    const st = await lstat(p).catch(() => null);
    if (!st) return null;
    if (st.isSymbolicLink()) {
      throw new SkillpilotError("INVALID_SCHEMA", `${path.relative(projectRoot, p)} is a symlink and is not trusted.`, "Replace it with a regular file or directory.");
    }
  }
  const raw = await readFile(file, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new SkillpilotError("INVALID_SCHEMA", `${CONFIG_PATH} is not valid JSON.`, `Fix the JSON syntax in ${CONFIG_PATH}.`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ field: i.path.join(".") || "(root)", message: i.message }));
    throw new SkillpilotError("INVALID_SCHEMA", `${CONFIG_PATH} failed validation.`, "Correct the listed fields; unknown keys are rejected.", { issues });
  }
  return parsed.data;
}
