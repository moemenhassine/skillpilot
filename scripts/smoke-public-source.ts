// Explicit, network-dependent smoke test (spec 17.5): review one pinned, previously reviewed public skill
// through the production GitHub transport, plan it, and apply the plan in a temporary project only.
// Never part of ordinary test runs. Uses a temporary cache and HOME, so nothing outside temp is touched.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SOURCE = "obra/superpowers@2ce8aa15d05bd57213e6f746f953aafb7ded7a8b#skills/test-driven-development";
const ROOT = path.resolve(import.meta.dirname, "..");
const work = mkdtempSync(path.join(os.tmpdir(), "skillpilot-public-"));
const project = realpathSync(mkdtempSync(path.join(work, "project-")));
const home = path.join(work, "home");
const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_CACHE_HOME: path.join(home, ".cache"), NO_COLOR: "1" };
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "src/cli.ts"), ...args, "--json"], { cwd: project, env, encoding: "utf8", input: "", timeout: 120_000 });
  const json = JSON.parse(r.stdout || "null");
  console.log(`$ skillpilot ${args.join(" ")} → exit ${r.status}, ${json?.status}${json?.errors?.length ? ` [${json.errors.map((e: { code: string }) => e.code).join(", ")}]` : ""}`);
  return json;
};

const review = run("review", SOURCE, "--verbose");
if (review?.status !== "ok") process.exit(1);
console.log(`  ${review.data.files.length} files, decision ${review.data.decision}, findings ${review.data.findings.length}, license ${review.data.license.spdx}`);
const plan = run("plan", SOURCE, "--agent", "codex", "--out", ".skillpilot/plans/smoke.json", "--offline");
if (plan?.status !== "ok") process.exit(1);
const install = run("install", "--plan", ".skillpilot/plans/smoke.json", "--approve", plan.data.plan.planDigest);
const list = run("list");
const ok = install?.data?.outcome === "installed" && list?.data?.entries?.[0]?.state === "managed";
console.log(ok ? `Public-source smoke test passed (temporary project ${project}).` : "Public-source smoke test FAILED.");
process.exit(ok ? 0 : 1);
