## Summary

## Checklist

- [ ] All CI gates pass locally (see CONTRIBUTING.md).
- [ ] Tests cover the change; no test uses the network or real agent skill directories.
- [ ] No new `--force`/`--yes`/`--all` style bypass, and no weakened review or approval gate.
- [ ] Rule changes include positive, benign, and negative-example fixtures and a rule-set version decision.
- [ ] `npm run schemas` rerun if outputs or persisted formats changed.
- [ ] `CHANGELOG.md` updated for user-visible changes; decisions recorded in `docs/decisions.md` if any.
