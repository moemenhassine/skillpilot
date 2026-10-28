import os from "node:os";
import path from "node:path";

/** OS-appropriate user cache directory; never inside an agent skill discovery root. */
export function cacheDir(env = process.env, platform = process.platform, home = os.homedir()): string {
  if (platform === "darwin") return path.join(home, "Library", "Caches", "skillpilot");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "skillpilot", "Cache");
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "skillpilot");
}

export const LOCKFILE_PATH = ".skillpilot/lock.json";
export const OPERATIONS_DIR = ".skillpilot/operations";
export const MUTATION_LOCK_PATH = ".skillpilot/mutation.lock";
