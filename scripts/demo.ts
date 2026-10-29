// Offline end-to-end demo for the README: a fixture skill is fetched through a recorded transport into a
// temporary cache, then the real CLI reviews, plans, refuses without approval, installs, lists, and removes
// it in a temporary project. Touches nothing outside the OS temp directory and makes no network requests.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewCommand } from "../src/commands/review.ts";
import { cacheDir } from "../src/storage/paths.ts";
import { fixtureTransport, MIT, syntheticRepo } from "../tests/helpers/github.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const COMMIT = "d".repeat(40);
const SOURCE = `demo-org/demo-skills@${COMMIT}#skills/release-notes`;
const work = mkdtempSync(path.join(os.tmpdir(), "skillpilot-demo-"));
const project = realpathSync(mkdtempSync(path.join(work, "project-")));
const home = path.join(work, "home");
const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_CACHE_HOME: path.join(home, ".cache") };

const repo = syntheticRepo("demo-org/demo-skills", {
  LICENSE: MIT,
  "skills/release-notes/SKILL.md": "---\nname: release-notes\ndescription: Drafts release notes from merged changes. Use when preparing a release.\n---\n# Release notes\n\nGroup changes by user impact and link each item to its pull request.\n",
  "skills/release-notes/references/template.md": "## Highlights\n\n## Fixes\n",
}, { commit: COMMIT });
await reviewCommand(SOURCE, { transport: fixtureTransport(repo).transport, cacheRoot: cacheDir(env, process.platform, home) });

const exec = (args: string[]) => spawnSync(process.execPath, [path.join(ROOT, "src/cli.ts"), ...args], { cwd: project, env, encoding: "utf8", input: "" });
const cli = (...args: string[]) => {
  console.log(`\n$ skillpilot ${args.join(" ")}`);
  const r = exec(args);
  process.stdout.write(r.stdout + r.stderr.replace(/^/gm, "  ").trimEnd() + `\n  (exit ${r.status})\n`);
};

console.log(`Demo project: ${project}\n(fixture source cached offline; every command below runs the real CLI with --offline)`);
cli("review", SOURCE, "--offline");
cli("plan", SOURCE, "--agent", "codex", "--out", ".skillpilot/plans/demo.json", "--offline");
cli("install", "--plan", ".skillpilot/plans/demo.json");
// An agent takes the digest from the plan it showed the user, and passes it only after the user approves that plan.
const digest = JSON.parse(readFileSync(path.join(project, ".skillpilot/plans/demo.json"), "utf8")).planDigest;
console.log("\n(The user reviews the plan above and approves it; the agent passes that exact digest.)");
cli("install", "--plan", ".skillpilot/plans/demo.json", "--approve", digest);
cli("list");
cli("remove", "demo-org/demo-skills#skills/release-notes", "--agent", "codex", "--out", ".skillpilot/plans/remove.json");
console.log("\nThe removal plan is not applied in this demo; apply it with `skillpilot install --plan .skillpilot/plans/remove.json` and approve it.");
