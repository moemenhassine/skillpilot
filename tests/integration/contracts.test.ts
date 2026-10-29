import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planCommand } from "../../src/commands/review.ts";
import { PlanSchema } from "../../src/planner/schemas.ts";
import { COMMAND_DATA, envelope } from "../../src/schemas/contracts.ts";
import { publishedSchemas } from "../../src/schemas/publish.ts";
import { LockfileSchema } from "../../src/storage/lockfile.ts";
import { cacheDir } from "../../src/storage/paths.ts";
import { fixtureTransport, MIT, skillMd, syntheticRepo } from "../helpers/github.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const COMMIT = "c".repeat(40);

describe("JSON contracts (FR-052, spec 14.3, 17.5)", () => {
  it("checked-in schemas/ matches the generated contracts", async () => {
    for (const [rel, content] of publishedSchemas()) expect(await readFile(path.join(ROOT, "schemas", rel), "utf8"), rel).toBe(content);
  });

  it("every command's real --json output validates against its published contract", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "sp-home-"));
    const project = await realpath(await mkdtemp(path.join(os.tmpdir(), "sp-contract-")));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local"), NO_COLOR: "1" };
    delete env.XDG_CACHE_HOME;
    const t = fixtureTransport(syntheticRepo("acme/kit", { LICENSE: MIT, "skills/good-skill/SKILL.md": skillMd("good-skill"), "skills/med-skill/SKILL.md": skillMd("med-skill"), "skills/med-skill/run.sh": "echo hi\n" }, { commit: COMMIT }));
    await planCommand(project, ["acme/kit#skills/med-skill"], { transport: t.transport, cacheRoot: cacheDir(env, process.platform, home), agent: "codex" }).catch(() => {});
    const seeded = await planCommand(project, ["acme/kit#skills/good-skill"], { transport: t.transport, cacheRoot: cacheDir(env, process.platform, home), agent: "codex" });
    expect(seeded.data.path).toBeNull();
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, "src/cli.ts"), ...args, "--json", "--offline"], { cwd: project, env, encoding: "utf8", input: "", timeout: 20_000 });
      expect(r.stdout).not.toContain("\u001b");
      return { status: r.status, json: JSON.parse(r.stdout) as { command: string; data: unknown } };
    };
    const ok = (command: keyof typeof COMMAND_DATA, ...args: string[]) => {
      const r = run(...args);
      const parsed = envelope(command, COMMAND_DATA[command]).safeParse(r.json);
      expect(parsed.success, `${command}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
      return r;
    };
    const fixture = path.join(ROOT, "tests/fixtures/projects/nextjs-ts");
    ok("scan", "scan", fixture);
    ok("doctor", "doctor", fixture);
    ok("search", "search", "testing");
    ok("recommend", "recommend", fixture, "--goal", "write tests", "--explain");
    ok("sources list", "sources", "list");
    ok("review", "review", `acme/kit@${COMMIT}#skills/good-skill`);
    const medium = ok("review", "review", `acme/kit@${COMMIT}#skills/med-skill`);
    expect(medium.status).toBe(0);
    const planned = ok("plan", "plan", `acme/kit@${COMMIT}#skills/good-skill`, "--agent", "codex", "--out", ".skillpilot/plans/a.json");
    const digest = (planned.json.data as { plan: { planDigest: string } }).plan.planDigest;
    expect(PlanSchema.safeParse(JSON.parse(await readFile(path.join(project, ".skillpilot/plans/a.json"), "utf8"))).success).toBe(true);
    ok("install", "install", "--plan", ".skillpilot/plans/a.json", "--approve", digest);
    expect(LockfileSchema.safeParse(JSON.parse(await readFile(path.join(project, ".skillpilot/lock.json"), "utf8"))).success).toBe(true);
    ok("list", "list");
    ok("remove", "remove", "acme/kit#skills/good-skill", "--agent", "codex", "--out", ".skillpilot/plans/r.json");
    ok("doctor", "doctor", "--recover");

    // Expected errors use the same envelope with null data.
    const failures: [keyof typeof COMMAND_DATA, string[], string][] = [
      ["install", ["install", "--plan", ".skillpilot/plans/r.json"], "APPROVAL_REQUIRED"],
      ["plan", ["plan", `acme/kit@${COMMIT}#skills/med-skill`, "--agent", "codex"], "POLICY_BLOCKED"],
      ["scan", ["scan", path.join(project, "missing")], "INVALID_ARGUMENT"],
    ];
    for (const [command, args, code] of failures) {
      const r = ok(command, ...args);
      expect(r.json).toMatchObject({ status: "error", data: null, errors: [{ code }] });
    }
  });
});
