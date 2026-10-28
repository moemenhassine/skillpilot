# Implementation status

Updated 2026-10-28 (M2). Evidence = commands run locally on macOS (Darwin 25.4), Node 24.14.1.

## Milestones

| Milestone | Status | Evidence |
| --- | --- | --- |
| M0 Foundations | Done, except CI matrix and draft JSON schema files | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; `docs/compatibility.md`; `docs/decisions.md` D-001–D-007 |
| M1 Project intelligence | Done for FR-001–007 on macOS; Windows/Linux not yet run | `tests/unit/analyzer.test.ts`, `tests/unit/cli.test.ts` |
| M2 Discovery and recommendations | Done on macOS; evaluation labels pending human review | `npm test` + `npm run test:integration` (103 passed), `npm run validate:catalog`, `npm run test:evaluation` → `docs/evaluation-report.md` |
| M3 Immutable review and planning | Not started | — |
| M4 Approved lifecycle | Not started | — |
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
| FR-006 | Partial | Both project roots inventoried (manifest only), user-level same-name check. Managed/modified state needs the M4 lockfile |
| FR-007 | Done | Secret canary fixture never read or echoed; symlinks skipped; mandatory exclusions not negatable; limit tests |
| FR-050 | Partial | Strict config schema + field-level errors implemented; formal published JSON schema pending M5 |
| FR-051 | Partial | `doctor` checks runtime, root, config, destinations, writable, lockfile (JSON + version only), cache path, sources, pending recovery. Full lock schema in M4; `--recover` in M4 |
| FR-052 | Partial | Envelope, stable codes, exit codes implemented for `scan`/`doctor`; published per-command schemas pending |
| FR-053 | Partial | `--offline` blocks the GitHub client (zero-request test); `--offline --refresh` rejected. Review/install paths come in M3/M4 |
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
| FR-024 | Partial | Redundancy penalty and same-name unmanaged collision warnings are done. Exact managed-install exclusion is implemented in the scorer, but needs the M4 lockfile to supply the input |
| FR-025 | Partial | Always `not-reviewed` until the M3 review cache exists |
| FR-026 | Done | No popularity input exists in the candidate model |
| FR-030–048 | Not started | — |
| NFR-001 | Partial | Recording-transport test: only `api.github.com/repos/<owner>/<repo>/…` requested; no project data in requests |
| NFR-002 | Partial | Secret canaries in analyzer tests |
| NFR-006 | Partial | 15 s request timeout, 90 s command deadline, ≤2 retries with backoff, rate-limit handling. Concurrency is 1 (sequential) |
| NFR-009 | Partial | No color used; `--no-color`/`NO_COLOR` honoured trivially; terminal escaping tested |
| Others | Not started | — |

## Live evidence

- 2026-10-28, `recommend --repo cloudflare/skills` through the production `fetch` transport: resolved repository, branch, and tree, and fetched 2 verified blobs, then received HTTP 403 with `x-ratelimit-remaining: 0`. The output was `RATE_LIMITED` with reset time, status `partial`, bundled results still shown, and no cache written. A 19-skill repository needs ~22 unauthenticated requests of the 60/hour budget (see D-007).

## Unresolved decisions

- Evaluation labels need human maintainer review (D-013).

- GitHub unauthenticated rate limit vs. 200-file payload cap (D-007) — must be settled in M3.
- Package name, LICENSE copyright holder, security reporting channel — user/maintainer (publication only).
