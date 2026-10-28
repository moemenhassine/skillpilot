import { SkillpilotError } from "../errors.ts";

export const MAX_PATH_LENGTH = 240;
export const MAX_PATH_DEPTH = 10;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Portable relative POSIX path check (spec 10.3). Returns a problem description, or null when valid. */
export function pathProblem(p: string): string | null {
  if (!p) return "empty path";
  if (p.length > MAX_PATH_LENGTH) return `longer than ${MAX_PATH_LENGTH} characters`;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "absolute path";
  if (p.includes("\\")) return "backslash";
  if (CONTROL.test(p)) return "control character";
  if (p.includes(":")) return "colon (alternate data stream)";
  const segs = p.split("/");
  if (segs.length > MAX_PATH_DEPTH) return `deeper than ${MAX_PATH_DEPTH} segments`;
  for (const s of segs) {
    if (s === "" ) return "empty segment";
    if (s === "." || s === "..") return "dot segment";
    if (/[. ]$/.test(s)) return "trailing dot or space";
    if (WINDOWS_RESERVED.test(s.split(".")[0]!)) return "reserved Windows name";
  }
  return null;
}

/** Key for detecting case-fold and Unicode-normalization collisions. */
export const collisionKey = (p: string) => p.normalize("NFC").toLowerCase();

export interface SourceRef {
  owner: string;
  repository: string;
  commit: string | null;
  skillPath: string;
}

const SOURCE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?:@([^#]*))?#(.+)$/;

/** Parses `owner/repository[@<40-hex commit>]#path`, with `#.` for a repository-root skill. */
export function parseSource(input: string): SourceRef {
  const bad = (msg: string, next = "Use owner/repository#path/to/skill or owner/repository@<full-commit-id>#path/to/skill.") =>
    new SkillpilotError("INVALID_ARGUMENT", `Invalid source "${input.slice(0, 120)}": ${msg}`, next);
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) || input.startsWith("git@")) throw bad("URLs and other hosts are not accepted.");
  const m = SOURCE.exec(input);
  if (!m) {
    if (/^[^/#]+\/[^/#@]+@[^#]+$/.test(input)) throw bad("owner/repository@name is another tool's notation; SkillPilot requires #path.");
    throw bad("unrecognized format.");
  }
  const [, owner, repository, rev, skillPath] = m as unknown as [string, string, string, string | undefined, string];
  if (repository === "." || repository === "..") throw bad("invalid repository name.");
  if (rev !== undefined && !/^[0-9a-f]{40}$/.test(rev)) {
    throw bad("revisions must be full 40-character commit IDs; branch and tag names are not accepted.");
  }
  if (skillPath !== ".") {
    const problem = pathProblem(skillPath);
    if (problem) throw bad(`skill path ${problem}.`);
  }
  return { owner, repository, commit: rev ?? null, skillPath };
}

export const formatSource = (s: SourceRef) => `${s.owner.toLowerCase()}/${s.repository.toLowerCase()}${s.commit ? `@${s.commit}` : ""}#${s.skillPath}`;
