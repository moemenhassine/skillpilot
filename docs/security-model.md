# Security model

SkillPilot treats every candidate skill, catalog entry, cache file, plan file, and project file as untrusted data. This page summarizes what is enforced and what is not. Section 11 of the specification is the source of truth.

## What is protected, and where

| Concern | Enforcement |
| --- | --- |
| Candidate text acting as instructions | Never loaded as a skill before approval; rendered through `escapeText`; findings come from structured data. |
| Execution of candidate content | Nothing in a payload is executed, rendered, or decoded beyond UTF-8 text checks and image magic bytes. Files are installed as mode 0644. |
| Silent substitution between review and install | Full commit pin; Git object ID check per blob; SHA-256 per file; domain-separated payload and plan digests; `verifyPlan` re-reads the cache and re-runs review offline. |
| Edited or forged plans | Strict schema with no unknown fields; digest recomputed; targets re-derived from the fixed mapping; lockfile proposals re-derived; a fresh review must agree. A re-signed plan with weakened findings is still blocked. |
| Unsafe filesystem writes | Fixed target roots; symlinked `.claude`, `.agents`, `.skillpilot` refused; existing or case-variant targets refused; plan files only as new `.json` in `.skillpilot/plans/`. |
| Network exposure | Only `https://api.github.com/repos/<owner>/<repo>/…`; no auth headers; no redirects; non-public DNS results refused; response size caps; `--offline` makes zero requests. |
| Project privacy | The analyzer never opens secret-like files; no project data is sent anywhere. |

## Policy

- `coverage` (complete/incomplete) and `decision` (eligible / requires-acknowledgment / blocked) are separate.
- High/critical findings and structural, coverage, and license blockers cannot be overridden. There is no `--force`.
- Medium findings need their exact IDs acknowledged in a newly generated plan.
- Review output always includes: "Static checks can miss harmful behavior. Review the instructions and bundled files before enabling this skill." An empty result reads "No findings under rule set rules-v1." and is never labelled "secure", "trusted", or "certified".

## Not protected

A compromised OS, a malicious process running as the same user, a tampered SkillPilot executable, and anything an agent does after a skill is enabled. Static heuristics miss semantic attacks. A plan digest binds content; it does not prove that a human approved it, and it does not identify the publisher.
