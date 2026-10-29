# CLI reference

`skillpilot <command> [options]`. Global options: `--json`, `--offline`, `--no-color`, `--verbose`, `--help`, `--version`.

## Commands

| Command | Purpose | Changes |
| --- | --- | --- |
| `scan [path]` | Project evidence, effective stack, installed-skill inventory | Nothing |
| `doctor [path]` | Runtime, root, destinations, writability, config, lockfile, cache, pending recovery | Nothing |
| `doctor [path] --recover` | Roll back or finish an interrupted, already-approved operation | Only that journaled operation |
| `search <query>` | Search the bundled catalog and cached/explicit repositories | Cache (with `--refresh`/`--repo`) |
| `recommend [path]` | Rank candidates for the project and goal | Cache (with `--refresh`/`--repo`) |
| `review <source>` | Fetch a pinned payload and run static review | Cache |
| `plan <source...>` | Review a selection and produce an install plan and digest | The `--out` plan file |
| `install` | Apply an approved install or removal plan | Agent skill directories, `.skillpilot/lock.json` |
| `list [path]` | Managed, modified, missing, unmanaged, agent-incompatible skills | Nothing |
| `remove <installed-id>` | Produce a removal plan | The `--out` plan file |
| `sources list` | Bundled catalog and configured repositories with cache state | Nothing |

## Options

- **Project:** `--project <path>` (default: current directory). A positional path and a different `--project` are rejected.
- **Recommendation:** `--goal <text>`, `--stack <a,b>` (replaces the detected stack), `--agent <claude-code|codex|both>` (default: rank for both, labelled), `--limit <1..20>` (default 5), `--explain` (adds exclusions).
- **Discovery:** `--refresh` refreshes configured repositories; `--repo <owner/repository>` adds one for this run (repeatable, implies refresh). `--offline --refresh` is invalid.
- **Planning:** `--agent` (required), `--ack <finding-id>` (repeatable; medium findings only), `--out <file>` (a new `.json` directly in `.skillpilot/plans/`). Without `--out`, the plan is printed but not saved.
- **Execution:** `--plan <file>`, `--approve <sha256:digest>`.
- **Removal planning:** `--agent` and `--out` are required. Installed IDs are the `id` values shown by `list`.

## Sources

`owner/repository[@<40-hex commit>]#<path>`, where `#.` means the repository root. Only public GitHub repositories are accepted; URLs, other hosts, and branch names are rejected. Without `@commit`, the default branch is resolved once and pinned.

## Approval

- On a terminal (stdin and stdout are TTYs, no `--json`), `install` prints the plan and asks you to type `install <first 12 hex>` or `remove <first 12 hex>`. Any other answer or end of input declines; Ctrl-C cancels.
- Otherwise, `--approve` must carry the complete plan digest. Without it, `install` returns `APPROVAL_REQUIRED` (with the digest in `details`) and changes nothing. It never waits for input.
- Medium findings are acknowledged by regenerating the plan with `--ack`, which produces a new digest.

## JSON envelope

Every `--json` invocation writes exactly one object to stdout; diagnostics go to stderr.

```json
{ "schemaVersion": 1, "command": "plan", "status": "ok", "data": {}, "warnings": [], "errors": [] }
```

`status` is `ok`, `partial` (results with errors, such as a failed refresh), or `error` (`data` is `null`). Each error has `code`, `message`, `nextAction`, and optional `details`. JSON output never contains ANSI sequences or prompts.

Schemas (JSON Schema 2020-12, generated from the code by `npm run schemas`; `npm run check:schemas` and the contract tests fail if they drift):

| File | Describes |
| --- | --- |
| `schemas/envelope.schema.json` | The envelope for any command |
| `schemas/commands/<command>.schema.json` | The envelope with each command's `data` (`scan`, `doctor`, `search`, `recommend`, `review`, `plan`, `install`, `list`, `remove`, `sources-list`) |
| `schemas/config.schema.json` | `.skillpilot/config.json` |
| `schemas/catalog.schema.json` | `catalog/skills.json` |
| `schemas/plan.schema.json` | Install and removal plans |
| `schemas/lockfile.schema.json` | `.skillpilot/lock.json` |
| `schemas/journal.schema.json` | `.skillpilot/operations/<id>/journal.json` |
| `schemas/mutation-lock.schema.json` | `.skillpilot/mutation.lock` |

**Compatibility policy.** `schemaVersion` changes only for incompatible changes: a removed or renamed field, a changed type, or a new required input. Adding an output field is compatible and keeps the version. Plans and lockfiles with an unknown `schemaVersion` are rejected (a lockfile is read-only until a migration exists). Contract tests validate the real output of every command against these schemas.

## Exit codes

| Exit | Codes |
| --- | --- |
| 0 | Success, including empty results and identical managed no-ops |
| 1 | `INTERNAL_ERROR` (sanitized) |
| 2 | `INVALID_ARGUMENT`, `INVALID_SCHEMA` |
| 3 | `SOURCE_UNAVAILABLE`, `RATE_LIMITED` |
| 4 | `POLICY_BLOCKED`, `REVIEW_INCOMPLETE` |
| 5 | `APPROVAL_REQUIRED`, `APPROVAL_MISMATCH`, `APPROVAL_DECLINED` |
| 6 | `TARGET_CONFLICT`, `PLAN_STALE`, `PLAN_EXPIRED` |
| 7 | `IO_ERROR`, `MUTATION_LOCKED`, `RECOVERY_REQUIRED` |
| 130 | `CANCELLED` |

A `review` with complete coverage and blocking findings is a successful report, but it exits 4 so automation cannot treat the skill as eligible.

**Precedence when several problems apply:** invalid input and plan schema/digest/expiry, then the independent re-review of cached bytes, then project identity, then pending recovery or a held lock, then current target and lockfile state, then approval. Preconditions are re-checked after approval, immediately before any write.

## Files

| Path | Written by | Version control |
| --- | --- | --- |
| `.skillpilot/config.json` | You | Yes |
| `.skillpilot/plans/*.json` | `plan --out`, `remove --out` | No (contains the absolute project path) |
| `.skillpilot/lock.json` | `install` | Yes (relative paths only) |
| `.skillpilot/operations/`, `.skillpilot/mutation.lock` | `install` (temporary) | No |
| `.claude/skills/<name>/`, `.agents/skills/<name>/` | `install` | Your choice |
| OS user cache (`doctor` prints it) | `review`, `plan`, `--refresh` | n/a |

Scan and recommend never create `.skillpilot/`.
