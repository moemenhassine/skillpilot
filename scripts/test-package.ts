// Installed-package smoke test (spec 17.5): pack, install the tarball into a temporary directory (dependencies
// from the npm cache, falling back to the registry), and run the installed binary with no repository-relative imports.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const work = mkdtempSync(path.join(os.tmpdir(), "skillpilot-pkg-"));
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };

const packed = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", work], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" }))[0] as { filename: string; files: { path: string }[] };
const contents = packed.files.map((f) => f.path);
for (const required of ["dist/cli.js", "skills/skillpilot/SKILL.md", "skills/skillpilot/references/workflow.md", "skills/skillpilot/references/approval.md", "skills/skillpilot/references/troubleshooting.md", "catalog/skills.json", "schemas/plan.schema.json", "schemas/commands/install.schema.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "skills/skillpilot/LICENSE", "package.json"]) {
  check(contents.includes(required), `tarball contains ${required}`);
}
check(!contents.some((p) => /^(src|tests|scripts|docs|node_modules)\/|(^|\/)\.env|\.skillpilot\//.test(p)), "tarball has no sources, tests, scripts, docs, env files, or local state");

// The package is installed into its own directory; a copied fixture is the project it analyzes.
const prefix = path.join(work, "install");
const project = path.join(work, "project");
cpSync(path.join(ROOT, "tests/fixtures/projects/nextjs-ts"), project, { recursive: true });
mkdirSync(prefix);
writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ name: "pkg-smoke", private: true }));
const install = spawnSync(npm, ["install", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts", path.join(work, packed.filename)], { cwd: prefix, encoding: "utf8", shell: process.platform === "win32" });
check(install.status === 0, "npm install of the tarball (dependencies from the npm cache, registry as fallback)");
if (install.status !== 0) console.error(install.stderr.slice(-2000));

const home = path.join(work, "home");
const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_CACHE_HOME: path.join(home, ".cache"), NO_COLOR: "1" };
const bin = path.join(prefix, "node_modules", "skillpilot", "dist", "cli.js");
const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: project, env, encoding: "utf8", input: "", timeout: 30_000 });

if (existsSync(bin)) {
  check(run("--version").stdout.trim() === JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version, "installed binary reports the package version");
  const scan = JSON.parse(run("scan", "--json").stdout);
  check(scan.status === "ok" && scan.data.effectiveStack.includes("nextjs"), "installed scan detects the fixture stack");
  const search = JSON.parse(run("search", "testing", "--json", "--offline").stdout);
  check(search.status === "ok" && search.data.results.length > 0, "installed search loads the bundled catalog");
  const rec = JSON.parse(run("recommend", "--goal", "write tests", "--json", "--offline").stdout);
  check(rec.status === "ok" && rec.data.recommendations.length > 0, "installed recommend ranks candidates offline");
  const refused = run("install", "--plan", "missing.json", "--json");
  check(refused.status === 2 && JSON.parse(refused.stdout).errors[0].code === "INVALID_ARGUMENT", "installed install rejects a missing plan with a JSON envelope");
  const doctor = JSON.parse(run("doctor", "--json").stdout);
  check(doctor.data.checks.find((c: { id: string }) => c.id === "recovery")?.status === "pass", "installed doctor runs");
  check(!existsSync(path.join(project, ".claude")) && !existsSync(path.join(project, ".agents")) && !existsSync(path.join(project, ".skillpilot")), "read-only commands created no agent or SkillPilot directories");
  const skill = path.join(prefix, "node_modules", "skillpilot", "skills", "skillpilot");
  check(statSync(path.join(skill, "SKILL.md")).isFile(), "portable skill is present in the installed package");
}

console.log(failures.length ? `\n${failures.length} package check(s) failed. Work dir: ${work}` : `\nPackage smoke test passed (${packed.filename}).`);
process.exit(failures.length ? 1 : 0);
