# Implementation status

Updated 2026-10-29 (M4). Evidence = commands run locally on macOS (Darwin 25.4), Node 24.14.1.

## Milestones

| Milestone | Status | Evidence |
| --- | --- | --- |
| M0 Foundations | Done, except CI matrix and draft JSON schema files | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; `docs/compatibility.md`; `docs/decisions.md` D-001–D-007 |
| M1 Project intelligence | Done for FR-001–007 on macOS; Windows/Linux not yet run | `tests/unit/analyzer.test.ts`, `tests/unit/cli.test.ts` |
| M2 Discovery and recommendations | Done on macOS; evaluation labels pending human review | `npm test` + `npm run test:integration` (103 passed), `npm run validate:catalog`, `npm run test:evaluation` → `docs/evaluation-report.md` |
| M3 Immutable review and planning | Done on macOS | `tests/unit/rules.test.ts`, `tests/unit/canonical.test.ts`, `tests/integration/review-plan.test.ts` (200 tests total); live review of 3 catalog skills + offline plan verification (below) |
| M4 Approved lifecycle | Done on macOS; Linux/Windows runs pending (M6 CI) | `tests/integration/lifecycle.test.ts` (52 tests incl. crash injection at every journal transition), `tests/unit/lockfile.test.ts`; 254 tests total; real pseudo-TTY prompt smoke test (below) |
| M5 Agent package and usability | Not started | — |
| M6 Release readiness | Not started | — |

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
| FR-050 | Partial | Strict config schema + field-level errors implemented; formal published JSON schema pending M5 |
| FR-051 | Done | `doctor` checks runtime, root, config, destinations, writable, full lockfile schema, cache path, sources, pending journals and mutation-lock liveness; `doctor --recover` runs journaled recovery only |
| FR-052 | Partial | Envelope, stable codes, exit codes implemented for `scan`/`doctor`; published per-command schemas pending |
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
| NFR-001 | Partial | Recording-transport test: only `api.github.com/repos/<owner>/<repo>/…` requested; no project data in requests |
| NFR-002 | Partial | Secret canaries in analyzer tests |
| NFR-003 | Partial | Golden canonical-JSON/digest vectors in `tests/fixtures/golden/` (independently checked with `shasum`); deterministic plan digest test |
| NFR-006 | Partial | 15 s request timeout, 90 s command deadline, ≤2 retries with backoff, rate-limit handling. Concurrency is 1 (sequential) |
| NFR-009 | Partial | No color used; `--no-color`/`NO_COLOR` honoured trivially; terminal escaping tested |
| Others | Not started | — |

## Live evidence

- 2026-10-28, `recommend --repo cloudflare/skills` through the production `fetch` transport: resolved repository, branch, and tree, and fetched 2 verified blobs, then received HTTP 403 with `x-ratelimit-remaining: 0`. The output was `RATE_LIMITED` with reset time, status `partial`, bundled results still shown, and no cache written. A 19-skill repository needs ~22 unauthenticated requests of the 60/hour budget (see D-007).

- 2026-10-28, production transport (cache in a scratch directory):
  - `obra/superpowers#skills/test-driven-development`: 3 files, MIT (root LICENSE mapped), no findings, eligible.
  - `twostraws/SwiftUI-Agent-Skill#swiftui-pro`: 17 files including PNG under `payload-v2`, MIT, no findings, eligible.
  - `anthropics/skills#skills/webapp-testing`: 6 files, Apache-2.0, one medium RUN-001 finding (4 bundled Python scripts), so it requires acknowledgment. With `--ack`, a both-agent plan was written to `.skillpilot/plans/install.json`, re-verified offline with `verifyPlan`, and no agent directory was created.

- 2026-10-29, pseudo-terminal smoke test (`script -q /dev/null node src/cli.ts install --plan …`, scratch HOME, fixture payload): a wrong phrase returned `APPROVAL_DECLINED`, Ctrl-C returned `CANCELLED`, and typing `install <12 hex>` installed the skill. No directory was created in the first two runs.

## Unresolved decisions

- Evaluation labels need human maintainer review (D-013).

- GitHub unauthenticated rate limit vs. 200-file payload cap (D-007) — must be settled in M3.
- Package name, LICENSE copyright holder, security reporting channel — user/maintainer (publication only).
