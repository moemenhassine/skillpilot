# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue.

> **Before publication:** the maintainer must add a real, monitored private channel here, for example GitHub private vulnerability reporting on the published repository or a maintained security mailbox. This repository has no published location yet, and no address has been invented. See `docs/release-checklist.md`.

Include the SkillPilot version (`skillpilot --version`), your OS and Node.js version, the commands you ran, and, if possible, a minimal fixture that reproduces the problem. Do not include real credentials, tokens, or private repository content.

## Scope

In scope:

- An unapproved, drifted, or partial mutation of agent skill directories or `.skillpilot/lock.json`.
- A way for reviewed bytes to differ from installed bytes.
- A path, symlink, or journal trick that writes or deletes outside the planned targets.
- A way for candidate skill content to change SkillPilot's own decisions or output, for example terminal escape injection or forged plans that are accepted.
- Network requests to hosts other than `api.github.com`, or project data leaving the machine.
- Secrets read during analysis or echoed in output.
- A static rule that can be bypassed in a way the documented limitations do not cover.

Out of scope, as documented limitations (see [docs/security-model.md](docs/security-model.md)):

- Static review missing harmful *semantic* instructions. Rule improvements are still welcome as ordinary issues.
- Anything an agent does after a skill is enabled.
- A compromised OS, a malicious process running as the same user, or a tampered SkillPilot executable.
- The approval digest not proving who supplied `--approve`.

## Supported versions

Until 1.0, only the latest released version receives security fixes.
