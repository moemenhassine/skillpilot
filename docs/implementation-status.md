# Implementation status

Updated 2026-10-28. Evidence = commands run locally on macOS (Darwin 25.4), Node 24.14.1.

## Milestones

| Milestone | Status | Evidence |
| --- | --- | --- |
| M0 Foundations | Done, except CI matrix and draft JSON schema files | `npm run lint`, `npm run typecheck`, `npm test` (57 passed), `npm run build`; `docs/compatibility.md`; `docs/decisions.md` D-001–D-007 |
| M1 Project intelligence | Done for FR-001–007 on macOS; Windows/Linux not yet run | `tests/unit/analyzer.test.ts`, `tests/unit/cli.test.ts` |
| M2 Discovery and recommendations | Not started | — |
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
| FR-053 | Partial | `--offline` accepted; `scan`/`doctor` make no network calls. Enforcement test lands with the transport in M3 |
| FR-054 | Done | Config caps can only narrow scan limits (schema max = hard cap); tests |
| FR-010–048 | Not started | — |
| NFR-002 | Partial | Secret canaries in analyzer tests |
| NFR-009 | Partial | No color used; `--no-color`/`NO_COLOR` honoured trivially; terminal escaping tested |
| Others | Not started | — |

## Unresolved decisions

- GitHub unauthenticated rate limit vs. 200-file payload cap (D-007) — must be settled in M3.
- Package name, LICENSE copyright holder, security reporting channel — user/maintainer (publication only).
