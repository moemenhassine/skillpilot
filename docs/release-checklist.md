# Release checklist

Status as of 2026-10-29 for version 0.1.0. Items marked **maintainer** need a decision or an account that only the maintainer has. Nothing here has been pushed or published.

## 1. Engineering gates (spec section 20)

| Gate | Status | Evidence |
| --- | --- | --- |
| Working CLI with documented commands; no mock production discovery or review path | done | `docs/cli.md`; production transport used by `smoke:public-source` |
| P0 requirement ledger linked to evidence | done | `docs/implementation-status.md` |
| Valid catalog with verified real entries and measured coverage | done | `npm run validate:catalog`; `npm run verify:catalog-sources`: 28/28 pins verified on 2026-10-29 |
| Deterministic ranking evaluation meeting its targets | done, labels need human review | `docs/evaluation-report.md`, D-013 |
| Security rules with adversarial fixtures and documented limits | done | `tests/unit/rules.test.ts`, `docs/security-model.md` |
| Approval, content binding, lockfile, crash recovery, removal tests | done | `tests/integration/lifecycle.test.ts` |
| CI passing on Linux, macOS, and Windows with Node 24 | **partial**: macOS local and Linux container pass; Windows waits for the first CI run | `.github/workflows/ci.yml` |
| Package built and tested from its packed tarball | done on macOS and Linux | `npm run test:package` |
| Portable skill included; wrapper vs. CLI installation documented | done | `skills/skillpilot/`, README |
| README: purpose, fixture quickstart, complete workflow, prior art, honest support matrix | done | `README.md` (support status summarized, full matrix in `docs/compatibility.md`) |
| Architecture, CLI, JSON schemas, security model, compatibility, decisions, release checklist | done | `docs/`, `schemas/` |
| MIT license; upstream notices preserved; catalog not assumed MIT | done | `LICENSE`, `THIRD_PARTY_NOTICES.md` (`npm run check:notices`), catalog license evidence |
| `SECURITY.md` with a real private reporting channel | **maintainer**: placeholder present, no address invented | `SECURITY.md` |
| CONTRIBUTING, code of conduct, issue and PR templates, changelog | done; the conduct contact is a **maintainer** placeholder | repository root, `.github/` |
| No tokens, `.env`, user paths, cache, plans, or journals in the release bundle | done | `test:package` content check; `.gitignore` |
| Package and repository name availability | **blocked**: npm `skillpilot` is taken (an unrelated package, 0.1.8, checked 2026-10-29) | `npm view skillpilot` |
| Public-source smoke evidence refreshed and dated; agent checks recorded | done; Codex recorded as not run | `docs/implementation-status.md`, `docs/compatibility.md` |
| Maintainer authorized repository creation, push, and publication | **maintainer** | — |

## 2. Before creating the public repository (maintainer)

1. Choose the GitHub owner and repository name, and its visibility.
2. Choose the npm identity: a scoped name such as `@<scope>/skillpilot` or a new unscoped name. Check it with `npm view <name>`; a 404 means it is free.
3. Replace the placeholders in `SECURITY.md` and `CODE_OF_CONDUCT.md` with real, monitored channels. GitHub private vulnerability reporting needs the repository to exist first, so enable it right after step 4 below.
4. Have a person review the evaluation labels in `tests/evaluations/cases.json` (D-013).

## 3. Local release build

Run from a clean checkout of the commit to be released:

```bash
npm ci --ignore-scripts
```

```bash
npm run lint && npm run typecheck && npm test && npm run test:integration && npm run test:evaluation && npm run validate:catalog && npm run check:schemas && npm run check:notices && npm run build && npm run test:package
```

```bash
npm audit --audit-level=high
```

These two use the network and are run by hand:

```bash
npm run verify:catalog-sources
```

```bash
npm run smoke:public-source
```

Record the dated results in `docs/implementation-status.md`.

## 4. Repository creation and push (after explicit authorization)

Replace `<owner>` and `<repo>` with the names chosen in step 2.1, and choose `--public` or `--private`:

```bash
gh repo create <owner>/<repo> --private --source . --remote origin
```

```bash
git push -u origin main
```

Then, on GitHub:

- Confirm that the CI workflow passes on all three operating systems. A Windows failure must be fixed or documented as an explicit narrowing of support before release.
- Enable private vulnerability reporting, and update `SECURITY.md` if that is the chosen channel.
- Add the repository URL to `package.json` (`repository`, `bugs`, `homepage`), and add `$id` values to the JSON Schemas if they will be served from a stable URL (D-027).

## 5. Tag and publish (after explicit authorization)

1. Set the final package name in `package.json`, and update the README, `skills/skillpilot/references/troubleshooting.md`, and `CHANGELOG.md` (version heading and date).
2. Commit, then tag:

```bash
git tag -a v0.1.0 -m "SkillPilot 0.1.0"
```

```bash
git push origin v0.1.0
```

3. Inspect exactly what will be published:

```bash
npm pack --dry-run
```

4. Publish. Use `--access public` for a scoped public package, and provenance if publishing from CI:

```bash
npm publish --access public
```

5. After publishing, update `skills/skillpilot/references/troubleshooting.md` and the README to describe registry installation, which until now has been documented as unavailable.

## Launch wording

Use: "SkillPilot recommends agent skills for your project, shows why they fit, reviews their files, and installs the exact selection you approve."

Do not claim that it finds every best skill, guarantees safe skills, or is verified with agents beyond the recorded smoke tests.
