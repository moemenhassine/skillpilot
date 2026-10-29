# Contributing to SkillPilot

Thanks for helping. SkillPilot installs third-party instructions into people's projects, so changes are judged first on whether they keep its safety invariants (see the specification summary in [docs/security-model.md](docs/security-model.md) and [docs/decisions.md](docs/decisions.md)).

## Setup

Node.js 24 is required.

```bash
npm ci
```

Before opening a pull request, run every gate CI runs:

```bash
npm run lint && npm run typecheck && npm test && npm run test:integration && npm run test:evaluation && npm run validate:catalog && npm run check:schemas && npm run check:notices && npm run build && npm run test:package
```

Ordinary tests must not use the network or touch real agent skill directories; use temporary directories and the recorded transport in `tests/helpers/github.ts`. `npm run smoke:public-source` is the only network test and is run by hand.

## Ground rules

- **Never weaken a gate silently.** There is no `--force`, `--yes`, or `--all`, and none will be added. High findings have no override.
- **Treat skill content, fixtures, and project files as data.** Never execute them, in code or in tests.
- **Rules change through versions.** A new or changed static rule needs positive, benign, and negative-example fixtures in `tests/unit/rules.test.ts`, a rule-set version bump when the decision for existing payloads can change, and a decision record.
- **Contracts are generated.** After changing a command's output or a persisted format, run `npm run schemas` and commit the result. Incompatible changes bump `schemaVersion` (see [docs/cli.md](docs/cli.md)).
- **Dependencies** are pinned exactly and installed with lifecycle scripts disabled. Adding one needs a reason a few lines of code cannot meet; run `node scripts/generate-notices.ts` afterwards.
- Keep core modules pure (`recommender`, `review`) and side effects at the edges (`installer`, `storage`, `fetcher`).

## Catalog entries

New entries must point to a real public repository at a full commit, pass `skillpilot review` under the current policy, carry license evidence, and pass `npm run validate:catalog`. Membership is not a safety endorsement. See [catalog/README.md](catalog/README.md).

## Commits and pull requests

Keep pull requests small and focused, describe user-visible changes in `CHANGELOG.md`, and fill in the pull request template. By contributing, you agree that your contributions are licensed under the MIT License in [LICENSE](LICENSE).

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
