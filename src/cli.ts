#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import { resolveProjectRoot } from "./analyzer/index.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { recommendCommand } from "./commands/recommend.ts";
import { searchCommand } from "./commands/search.ts";
import { sourcesListCommand } from "./commands/sources.ts";
import { scanCommand } from "./commands/scan.ts";
import { SkillpilotError } from "./errors.ts";
import { emitError, emitResult, type CommandResult, type OutputOptions } from "./renderers/output.ts";

export const VERSION = "0.1.0";

interface GlobalOpts {
  json?: boolean;
  color?: boolean;
  offline?: boolean;
  verbose?: boolean;
}

function outputOptions(cmd: Command): OutputOptions {
  const g = cmd.optsWithGlobals<GlobalOpts>();
  return { json: Boolean(g.json), color: g.color !== false && !process.env.NO_COLOR && !g.json };
}

async function projectFrom(positional: string | undefined, option: string | undefined): Promise<string> {
  if (positional && option && positional !== option) {
    throw new SkillpilotError("INVALID_ARGUMENT", "Conflicting positional path and --project.", "Pass the project root once.");
  }
  return resolveProjectRoot(positional ?? option ?? ".");
}

/** Runs a command handler and sets the exit code; every outcome goes through one envelope. */
function run<A extends unknown[], T>(name: string, handler: (...args: A) => Promise<CommandResult<T>>) {
  return async (...args: A) => {
    const cmd = args[args.length - 1] as Command;
    const out = outputOptions(cmd);
    try {
      process.exitCode = emitResult(name, await handler(...args), out);
    } catch (err) {
      if (cmd.optsWithGlobals<GlobalOpts>().verbose && !(err instanceof SkillpilotError)) console.error(err);
      process.exitCode = emitError(name, err, out);
    }
  };
}

const splitList = (v: string) => v.split(",");

export function buildProgram(): Command {
  const program = new Command("skillpilot")
    .description("Project-aware agent skill recommendations with reviewed, approved installation.")
    .version(VERSION)
    .option("--json", "emit one JSON envelope on stdout")
    .option("--offline", "forbid all network requests")
    .option("--no-color", "disable color output")
    .option("--verbose", "safe diagnostics on stderr")
    .showHelpAfterError();

  program
    .command("scan [path]")
    .description("Read-only project evidence and installed-skill inventory")
    .option("--project <path>", "project root (default: current directory)")
    .option("--stack <tokens>", "comma-separated planned stack; replaces detected stack", splitList)
    .option("--goal <text>", "what you want to accomplish")
    .action(run("scan", async (pathArg: string | undefined, opts: { project?: string; stack?: string[]; goal?: string }) =>
      scanCommand(await projectFrom(pathArg, opts.project), { stack: opts.stack, goal: opts.goal })));

  program
    .command("doctor [path]")
    .description("Validate runtime, project destinations, config, lockfile, cache, and pending recovery")
    .option("--project <path>", "project root (default: current directory)")
    .action(run("doctor", async (pathArg: string | undefined, opts: { project?: string }) =>
      doctorCommand(await projectFrom(pathArg, opts.project))));

  const g = () => program.opts<GlobalOpts>();
  const repoOpt = () => new Option("--repo <owner/repository>", "add a public GitHub repository for this invocation (repeatable)").argParser((v: string, prev: string[] = []) => [...prev, v]);

  program
    .command("search <query>")
    .description("Search the local catalog (and cached/explicit repositories) by task and stack words")
    .option("--project <path>", "project root for config and cache (default: current directory)")
    .option("--stack <tokens>", "only entries matching these stack tokens", splitList)
    .option("--agent <target>", "claude-code, codex, or both")
    .option("--refresh", "refresh configured repository metadata from GitHub")
    .addOption(repoOpt())
    .action(run("search", async (query: string, opts: { project?: string; stack?: string[]; agent?: string; refresh?: boolean; repo?: string[]; offline?: boolean }) =>
      searchCommand(await projectFrom(undefined, opts.project), query, { ...opts, offline: Boolean(opts.offline || g().offline), verbose: g().verbose })));

  program
    .command("recommend [path]")
    .description("Analyze the project and rank candidate skills (never installs)")
    .option("--project <path>", "project root (default: current directory)")
    .option("--goal <text>", "what you want to accomplish")
    .option("--stack <tokens>", "comma-separated planned stack; replaces detected stack", splitList)
    .option("--agent <target>", "claude-code, codex, or both (default: rank for both)")
    .option("--limit <n>", "number of recommendations, 1-20 (default 5)")
    .option("--explain", "include excluded candidates and reasons")
    .option("--refresh", "refresh configured repository metadata from GitHub")
    .addOption(repoOpt())
    .action(run("recommend", async (pathArg: string | undefined, opts: { project?: string; goal?: string; stack?: string[]; agent?: string; limit?: string; explain?: boolean; refresh?: boolean; repo?: string[]; offline?: boolean }) =>
      recommendCommand(await projectFrom(pathArg, opts.project), { ...opts, offline: Boolean(opts.offline || g().offline), verbose: g().verbose })));

  const sources = program.command("sources").description("Inspect discovery sources");
  sources
    .command("list")
    .description("Show the bundled catalog and configured repositories with cache state")
    .option("--project <path>", "project root (default: current directory)")
    .action(run("sources list", async (opts: { project?: string }) => sourcesListCommand(await projectFrom(undefined, opts.project), { offline: true })));

  const all = (c: Command): Command[] => [c, ...c.commands.flatMap(all)];
  for (const c of all(program).slice(1)) c.addOption(new Option("--json").hideHelp()).addOption(new Option("--offline").hideHelp());
  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildProgram();
  const json = argv.includes("--json");
  program.exitOverride();
  const all = (c: Command): Command[] => [c, ...c.commands.flatMap(all)];
  for (const c of all(program)) {
    c.exitOverride();
    if (json) c.configureOutput({ writeErr: () => {} });
  }
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version" || err.code === "commander.help") {
      process.exitCode = 0;
      return;
    }
    const command = program.commands.find((c) => argv.includes(c.name()))?.name() ?? "skillpilot";
    process.exitCode = emitError(command, new SkillpilotError("INVALID_ARGUMENT", err.message.replace(/^error: /, ""), "Run skillpilot --help for usage."), { json, color: false });
  }
}

await main(process.argv);
