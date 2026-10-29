import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
const inGit = (() => { try { return git("rev-parse", "--is-inside-work-tree").trim() === "true"; } catch { return false; } })();

describe.runIf(inGit)("repository hygiene", () => {
  it("every file under tests/, skills/, catalog/, and schemas/ is committable (fresh checkouts and CI see the same files)", () => {
    // Fixtures may contain their own .gitignore on purpose; files they hide must be force-added.
    expect(git("ls-files", "--others", "--ignored", "--exclude-standard", "tests", "skills", "catalog", "schemas").trim()).toBe("");
  });
});
