# Troubleshooting reference

## The CLI is not installed

This skill and the SkillPilot CLI are separate. Copying this skill directory does not install the CLI. Tell the user about these options and let them choose; do not install it yourself.

- **From a source checkout** (currently the only option): in a SkillPilot repository checkout with Node.js 24, run `npm ci`, then `npm run build`, then `npm link` to put `skillpilot` on PATH. Alternatively, run it as `node <checkout>/dist/cli.js`.
- **From a package registry:** not available yet. No SkillPilot package has been published.

Check with `skillpilot --version` and `skillpilot doctor --json`.

## Error codes

| Code | Meaning | What to do |
| --- | --- | --- |
| `INVALID_ARGUMENT`, `INVALID_SCHEMA` | Bad input, config, plan, or lockfile | Fix the input named in `message`. A malformed lockfile blocks mutations; restore it from version control. |
| `SOURCE_UNAVAILABLE` | Repository, commit, or file not reachable, or offline without a cached copy | Check the source string; drop `--offline` if a fetch is acceptable. |
| `RATE_LIMITED` | GitHub's unauthenticated limit (60 requests per hour) was reached | Wait until the reset time in `details`. A skill costs about its file count plus 3 requests. |
| `POLICY_BLOCKED` | Blocking findings, or medium findings without acknowledgment | Blocking: stop. Medium: show the findings, and pass `--ack` only for those the user accepts. |
| `REVIEW_INCOMPLETE` | Unsupported or unreadable files | The skill cannot be installed under the current policy. |
| `APPROVAL_REQUIRED` | No `--approve` given | Present the plan and wait for the user. |
| `APPROVAL_MISMATCH` | Digest does not match the plan | Re-read the plan; never edit a digest. |
| `APPROVAL_DECLINED` | The person declined at the terminal prompt | Nothing changed. |
| `TARGET_CONFLICT` | A destination exists, is unmanaged, is locally edited, or is a symlink | Explain it. SkillPilot never overwrites it; the user decides what to do with the existing directory. |
| `PLAN_STALE`, `PLAN_EXPIRED` | The project, cache, policy, or clock moved on since planning | Regenerate the plan and ask for approval again. |
| `MUTATION_LOCKED` | Another SkillPilot mutation is running | Wait, then retry. |
| `RECOVERY_REQUIRED` | An earlier operation was interrupted, or recovery found a conflict | Run `skillpilot doctor --json` and show the user its result before running `doctor --recover`. If recovery reports conflicts, the user must resolve them by hand; evidence stays in `.skillpilot/operations/`. |
| `IO_ERROR` | Filesystem failure; the operation was rolled back | Fix the cause (permissions, disk space) and retry the same plan. |
| `CANCELLED` | Interrupted at the prompt | Nothing changed. |

## Files SkillPilot writes

- `.skillpilot/plans/*.json`: plans you created with `--out`. They contain the local absolute project path; keep them out of version control.
- `.skillpilot/lock.json`: provenance of managed skills; suitable for version control.
- `.skillpilot/operations/` and `.skillpilot/mutation.lock`: temporary transaction state; keep them out of version control.
- The user cache directory (shown by `doctor`): fetched payloads and source metadata.

## Offline use

`--offline` makes no network requests. Recommendations use the bundled catalog and cached metadata. Review and planning need a pinned source (`@commit`) that is already cached. Installation never uses the network.

## After installing or removing

Agents discover skills when a session starts or when they rescan. Suggest restarting the agent session. A skill that was already loaded may keep influencing the current session after removal.
