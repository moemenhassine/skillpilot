# SkillPilot workflow reference

All commands accept `--json`, which prints exactly one JSON object on stdout:

```json
{ "schemaVersion": 1, "command": "recommend", "status": "ok", "data": {}, "warnings": [], "errors": [] }
```

`status` is `ok`, `partial` (results plus errors, for example a failed source refresh), or `error` (`data` is `null`). Exit codes: 0 success, 2 invalid input, 3 source or network problem, 4 review blocked or incomplete, 5 approval missing, declined, or mismatched, 6 conflict or stale plan, 7 filesystem, lock, or recovery problem, 130 cancelled. JSON Schemas for every command ship in the package's `schemas/` directory.

## Commands

| Step | Command | Changes files? |
| --- | --- | --- |
| Inspect the project | `skillpilot scan [path] --json` | No |
| Recommend | `skillpilot recommend [path] --goal "<text>" [--stack a,b] [--agent t] [--limit n] [--explain] --json` | No |
| Search the catalog | `skillpilot search "<words>" --json` | No |
| Review one skill | `skillpilot review <owner/repo[@commit]#path> --json` | Cache only |
| Plan | `skillpilot plan <source>... --agent t [--ack id]... --out .skillpilot/plans/<new>.json --json` | Writes the plan file only |
| Apply | `skillpilot install --plan <file> --approve <digest> --json` | Yes, as planned |
| Inventory | `skillpilot list --json` | No |
| Plan a removal | `skillpilot remove <installed-id> --agent t --out .skillpilot/plans/<new>.json --json` | Writes the plan file only |
| Diagnose | `skillpilot doctor --json` | No |
| Recover | `skillpilot doctor --recover --json` | Only the journaled operation |

Use `--project <path>` when the project is not the current directory. `--offline` forbids every network request; review and plan then work only for pinned sources already in the cache.

Sources use the form `owner/repo@<40-hex commit>#path/to/skill`. Without `@commit`, `review` resolves the default branch once and pins the result; reuse the pinned source string it reports.

## Fields to read

**recommend** `data.recommendations[]`: `rank`, `id`, `name`, `description`, `source` (owner, repository, skillPath, commit), `score` (stackFit, goalFit, compatibility, metadataCompleteness, redundancyPenalty, final), `matchedStack`, `matchedGoals`, `compatibility` per agent, `license`, `prerequisites` (null means never disclosed), `limitations`, `reviewState`. Also read `data.agentAssumption`, `data.notes`, and `warnings`, for example same-name skills already present.

**review** `data`: `coverage` (complete or incomplete), `decision` (eligible, requires-acknowledgment, or blocked), `findings[]` (`id`, `ruleId`, `severity`, `file`, `lineStart`, `explanation`, `remediation`, `blocking`), `disclosures.scripts`, `disclosures.externalDomains`, `license`.

**plan** `data.plan`: `operation`, `agents`, `skills[].targets[].path`, `skills[].review.acknowledged`, `preconditions.targets[].state` (`managed` means already installed and unchanged), `lockfileChanges`, `disclosures`, `expiresAt`, `planDigest`. `data.path` is the saved file.

**install** `data`: `outcome` (installed, removed, or no-op), `changed[]`, `unchanged[]`, `lockfile`.

**list** `data.entries[]`: `id` (use it with `remove`), `path`, `agent`, `state` (managed, modified, missing, unmanaged, agent-incompatible), `details`.

## Example session

The user asks: "Which skills would help me test this Next.js app?"

1. `skillpilot recommend --goal "write and run browser tests" --json`. Explain the top results, for example a webapp testing skill matched on `nextjs` and the `testing` goal, with its license and review state.
2. The user picks one skill for Claude Code only.
3. `skillpilot review anthropics/skills#skills/webapp-testing --json` shows one medium `RUN-001` finding: four bundled Python scripts. Explain that SkillPilot never runs them, but the agent might later. The user accepts finding `F-…`.
4. `skillpilot plan anthropics/skills@<commit>#skills/webapp-testing --agent claude-code --ack F-… --out .skillpilot/plans/webapp-testing.json --json`.
5. Present the plan (see approval.md) and wait. The user replies "Yes, install that plan."
6. `skillpilot install --plan .skillpilot/plans/webapp-testing.json --approve sha256:… --json`, then `skillpilot list --json`. Report `.claude/skills/webapp-testing/` and suggest restarting the session.
