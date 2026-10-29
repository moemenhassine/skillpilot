# Implementation status

Updated 2026-10-29 (M6). Evidence = commands run locally on macOS (Darwin 25.4), Node 24.14.1.

## Milestones

| Milestone | Status | Evidence |
| --- | --- | --- |
| M0 Foundations | Done, except CI matrix and draft JSON schema files | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; `docs/compatibility.md`; `docs/decisions.md` D-001–D-007 |
| M1 Project intelligence | Done for FR-001–007 on macOS; Windows/Linux not yet run | `tests/unit/analyzer.test.ts`, `tests/unit/cli.test.ts` |
| M2 Discovery and recommendations | Done on macOS; evaluation labels pending human review | `npm test` + `npm run test:integration` (103 passed), `npm run validate:catalog`, `npm run test:evaluation` → `docs/evaluation-report.md` |
| M3 Immutable review and planning | Done on macOS | `tests/unit/rules.test.ts`, `tests/unit/canonical.test.ts`, `tests/integration/review-plan.test.ts` (200 tests total); live review of 3 catalog skills + offline plan verification (below) |
| M4 Approved lifecycle | Done on macOS; Linux/Windows runs pending (M6 CI) | `tests/integration/lifecycle.test.ts` (52 tests incl. crash injection at every journal transition), `tests/unit/lockfile.test.ts`; 254 tests total; real pseudo-TTY prompt smoke test (below) |
| M5 Agent package and usability | Done on macOS. Claude Code smoke test passed (discovery, invocation, declined install); Codex not run (CLI not installed) | `skills/skillpilot/`, `schemas/`, `README.md`, `docs/cli.md`, `docs/architecture.md`; `tests/unit/skill-package.test.ts`, `tests/integration/contracts.test.ts`; `npm run test:package`, `npm run demo`, `npm run smoke:public-source` (live, below) |
| M6 Release readiness | Done locally, except maintainer items and the first Windows CI run | `LICENSE`, `THIRD_PARTY_NOTICES.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `.github/`, `docs/release-checklist.md`; all gates green in a `node:24` Linux container; `npm run bench`; `npm run verify:catalog-sources` 28/28 |

## Requirements

| ID | Status | Evidence / notes |
| --- | --- | --- |
| FR-001 | Done | `resolveProjectRoot` realpath, no ascent; tests "project root resolution", CLI conflicting-root test |
| FR-002 | Done | Every evidence item has relative path, key, token, confidence, origin; JSON/TOML/strict YAML/bounded literals only; `app.config.js` never read (test) |
| FR-003 | Done | 11 stack fixtures with positive and negative tokens |
| FR-004 | Done | `--stack`/`--goal`; CLI > config > detected precedence, conflict notes; empty-project test |
| FR-005 | Done | Monorepo fixture reports child packages; no recursive action |
| FR-006 | Done | Both project roots inventoried (manifest only), user-level same-name check; managed/modified/missing state via `list` against the lockfile |
| FR-007 | Done | Secret canary fixture never read or echoed; symlinks skipped; mandatory exclusions not negatable; limit tests |
| FR-050 | Done | Strict config schema with field-level errors; published as `schemas/config.schema.json` |
| FR-051 | Done | `doctor` checks runtime, root, config, destinations, writable, full lockfile schema, cache path, sources, pending journals and mutation-lock liveness; `doctor --recover` runs journaled recovery only |
| FR-052 | Done | One envelope per `--json` command with stable codes; `schemas/` publishes the envelope, every command's data, config, catalog, plan, lockfile, journal, and mutation lock. Generated from zod schemas that are compile-time checked against the command types; a contract test validates real CLI output of all 10 commands, including error envelopes |
| FR-053 | Done | `--offline` makes zero requests for discovery and for review/plan of cached pinned payloads; `install` has no network path at all (test: zero transport calls after the branch moves) |
| FR-054 | Done | Config caps can only narrow scan limits (schema max = hard cap); tests |
| FR-010 | Done | `search` is local; query text is never sent anywhere (no transport is used unless `--refresh`/`--repo`) |
| FR-011 | Done | `src/sources/discovery.ts`; recorded supabase fixture; supported roots only; tests in `tests/integration/discovery.test.ts` |
| FR-012 | Done | Candidates carry normalized ID, owner/repo/path, commit, `discoveredVia`, `verifiedAt`, agent support (unknown where unverified) |
| FR-013 | Done | Dedup test: catalog pin kept, both sources attributed, sorted IDs |
| FR-014 | Done | Truncated tree, redirect, identity change, private repo, rate limit, tampered blob, malformed tree, 404: all fail closed (tests). Invalid manifests are listed and never become candidates |
| FR-015 | Done | 28 entries, 15 categories, 13 publishers; every baseline category has a candidate installable under `payload-v2` (D-012) |
| FR-016 | Done | Schema requires provenance, tags, license evidence, verification date; catalog README states membership is not a safety exemption |
| FR-020 | Done | `fit-v1` in `src/recommender`; determinism test with shuffled input |
| FR-021 | Done | Default 5, `--limit` 1–20 validated; threshold 35 |
| FR-022 | Done | Score components, matched evidence/goals, source, license, prerequisites, caveats, review state in text and JSON |
| FR-023 | Done | Agent exclusion, `requiresAnyStack`, unknown compatibility labelled; `--explain` lists exclusions |
| FR-024 | Done | Redundancy penalty, same-name unmanaged collision warnings, and exclusion of payloads installed byte-identically for every selected agent (from the lockfile; test) |
| FR-025 | Done | Cached review (same commit, rule set, and policy) gives reviewed/incomplete/stale; a blocked review excludes the candidate (test) |
| FR-026 | Done | No popularity input exists in the candidate model |
| FR-030 | Done | Commit pinned (full ID); whole selected subtree fetched; per-file SHA-256 + Git object ID check |
| FR-031 | Done | Manifest, path, cap, encoding, image-signature, LFS, symlink/submodule, and activation-descriptor checks; bytes stored unmodified |
| FR-032 | Done | `rules-v1` with rule ID, severity, confidence, location, explanation, remediation; positive/benign/context fixtures for every rule |
| FR-033 | Done | Plan with payload manifest, findings, targets, preconditions, lockfile changes, policy/config digests, 24 h expiry, `planDigest`; incomplete or blocked reviews produce no plan |
| FR-034 | Done | Scripts, referenced domains, upstream compatibility notes, and mode normalization disclosed; nothing installed or granted |
| FR-035 | Done | Existing/case-variant/redirected targets, reserved names, duplicate names, license evidence checked before approval |
| FR-036 | Done | `verifyPlan` recomputes digest, targets, payload digest, cached bytes, fresh review, and lockfile proposals; edits, forged re-signed plans, tampered cache, expiry, and skew are tested |
| FR-040 | Done | `install` requires `--approve <full digest>` or a typed `install|remove <12 hex>` on a TTY; JSON and non-TTY never prompt (`APPROVAL_REQUIRED`, digest in details); mismatch/declined/EOF/Ctrl-C leave targets, lockfile, journal, and lock untouched (tests + pty smoke) |
| FR-041 | Done | `claude-code`, `codex`, `both`; both-target plans disclose two copies and list both paths; Codex-only never creates `.claude` (test) |
| FR-042 | Done | Executor re-runs `verifyPlan` (cache bytes, fresh review, derived lockfile changes), checks project identity, re-reads live preconditions, re-verifies staged hashes and modes; no network path |
| FR-043 | Done | Atomic `wx` mutation lock with PID/host/operation ID; journal written atomically before any promotion; staged directories promoted by rename; lockfile replaced atomically; commit mark; recovery rolls back or finishes. Crash tests after every transition for install and removal |
| FR-044 | Done | Unmanaged, case-variant, other-revision, missing, and locally modified targets are `TARGET_CONFLICT` with bytes preserved; identical managed installs are a no-op that keeps lockfile bytes and timestamps |
| FR-045 | Done | `.skillpilot/lock.json` schema 1: source ID, full source identity, commit, name, license, payload digest, per-file inventory with modes, agent, relative path, rule set, findings summary, acks, plan digest, `installedAt`, tool version; sorted; no absolute paths (test) |
| FR-046 | Done | `list`: managed, modified (changed/missing/extra files), missing, unmanaged, agent-incompatible (test) |
| FR-047 | Done | `remove <id> --agent --out` writes a removal plan; applied only through `install --plan` with approval; edited, added, or missing files block; unrelated skills and parent directories untouched (tests) |
| FR-048 | Done | The executor only writes files, renames directories, and replaces the lockfile; scripts land as mode 0644 (test) |
| NFR-001 | Done | Recording-transport tests: only `api.github.com/repos/<owner>/<repo>/…` is requested, with no project data, goal text, or paths; install has no network path |
| NFR-002 | Done | Secret-canary fixtures never opened or echoed; `DAT-001` findings are redacted; no auth headers are ever sent |
| NFR-003 | Done | Golden canonical-JSON/digest vectors in `tests/fixtures/golden/` (independently checked with `shasum`); deterministic plan digest and shuffled-input ranking tests |
| NFR-006 | Done | 15 s request timeout, 90 s command deadline, at most 2 retries with backoff, rate-limit handling with coverage status. Request concurrency is 1, within the bound of 4 |
| NFR-009 | Done | Statuses are spelled out in text, and no color is used; JSON has no ANSI (contract test); the prompt works with plain terminal input (pty smoke test) |
| NFR-007 | Done | Scan, search, ranking, cached review and planning, and install run with `--offline` and no transport (tests, `npm run demo`, package smoke test) |
| NFR-014 | Done on macOS and Linux | The README quickstart (`npm ci`, `npm run build`, `npm run demo`) works from a fresh copy in a Linux container and on macOS. The README states working and deferred features, static-review limits, and the agent test matrix |
| NFR-004 | Done (measured) | `npm run bench`, 20 runs after warm-up. macOS (Apple M4, 10 cores, 16 GiB): scan 5,000-entry fixture p95 17.6 ms; rank 1,000-entry catalog p95 2.6 ms. Linux container limited to 2 CPUs and 4 GiB: scan p95 25.0 ms, rank p95 2.0 ms. Target 3 s |
| NFR-005 | Done (measured) | Peak RSS for the whole benchmark, including 21 reviews of a 200-file, 5 MiB payload: 220 MiB on macOS, 173 MiB on Linux (limit 256 MiB). The macOS margin is small; watch it if limits grow |
| NFR-008 | Partial | macOS local and Linux (`node:24` container): all gates pass. Windows is in the CI matrix but has not run yet |
| NFR-010 | Done | Pure `recommender` and `review` modules; strict TypeScript; versioned, generated schemas; rule and policy changes recorded in `docs/decisions.md` |
| NFR-011 | Done | Crash injection after every durable transition for install and removal; corrupt plans, lockfiles, journals, and caches are rejected (tests) |
| NFR-012 | Partial | `--verbose` prints GitHub request summaries to stderr. Operation IDs and recovery steps appear in error `details` and `doctor --recover` output, but `install --verbose` does not yet stream them |
| NFR-013 | Done | Exact-pinned dependencies installed with `--ignore-scripts`; CI actions pinned to commit SHAs; generated, checked notices; `npm audit --audit-level=high` found 0 vulnerabilities (2026-10-29) and runs in CI, report only |

## Live evidence

- 2026-10-28, `recommend --repo cloudflare/skills` through the production `fetch` transport: resolved repository, branch, and tree, and fetched 2 verified blobs, then received HTTP 403 with `x-ratelimit-remaining: 0`. The output was `RATE_LIMITED` with reset time, status `partial`, bundled results still shown, and no cache written. A 19-skill repository needs ~22 unauthenticated requests of the 60/hour budget (see D-007).

- 2026-10-28, production transport (cache in a scratch directory):
  - `obra/superpowers#skills/test-driven-development`: 3 files, MIT (root LICENSE mapped), no findings, eligible.
  - `twostraws/SwiftUI-Agent-Skill#swiftui-pro`: 17 files including PNG under `payload-v2`, MIT, no findings, eligible.
  - `anthropics/skills#skills/webapp-testing`: 6 files, Apache-2.0, one medium RUN-001 finding (4 bundled Python scripts), so it requires acknowledgment. With `--ack`, a both-agent plan was written to `.skillpilot/plans/install.json`, re-verified offline with `verifyPlan`, and no agent directory was created.

- 2026-10-29, pseudo-terminal smoke test (`script -q /dev/null node src/cli.ts install --plan …`, scratch HOME, fixture payload): a wrong phrase returned `APPROVAL_DECLINED`, Ctrl-C returned `CANCELLED`, and typing `install <12 hex>` installed the skill. No directory was created in the first two runs.

- 2026-10-29, `npm run smoke:public-source` through the production transport: `obra/superpowers@2ce8aa15…#skills/test-driven-development` reviewed (3 files, MIT, 0 findings, eligible), planned offline for Codex, installed with `--approve` into a temporary project, and `list` reported it `managed`.

- 2026-10-29, `npm run verify:catalog-sources`: all 28 catalog entries (13 repositories) still resolve to public repositories with the same identity, and each pinned commit contains its `SKILL.md`.
- 2026-10-29, Linux: a fresh copy (no `node_modules`) in `node:24` (Node 24.22.2) passed lint, typecheck, 157 unit and 110 integration tests, evaluation, catalog, schema and notice checks, build, and the package smoke test.
- 2026-10-29: `npm view skillpilot` shows an unrelated published package (0.1.8), so the npm name is not available.

## Unresolved decisions

- Evaluation labels need human maintainer review (D-013).

- GitHub unauthenticated rate limit vs. 200-file payload cap (D-007): accepted for MVP and disclosed (D-020).
- Codex real-agent smoke test (no Codex CLI available; `docs/compatibility.md`).
- npm package name: `skillpilot` is taken (release checklist step 2).
- Real `SECURITY.md` and code-of-conduct contacts (maintainer).
- First Windows CI run.
- Package name, LICENSE copyright holder, security reporting channel — user/maintainer (publication only).
