# Architecture

Layered, with pure recommendation logic and explicit side-effect boundaries (spec section 8).

```text
Claude Code / Codex ── skills/skillpilot/SKILL.md (instructions only)
        │
src/cli.ts ── renderers/ (escaping, text, JSON envelope)
        │
        ├── analyzer/     bounded read-only project evidence + skill inventory
        ├── sources/      catalog validation, explicit GitHub discovery, source grammar
        ├── recommender/  pure fit-v1 scoring and explanations
        ├── fetcher/      commit-pinned GitHub client, verified payload fetch
        ├── review/       payload policy, rules-v1, license evidence
        ├── planner/      plan schemas, digests, preconditions, verifyPlan
        └── installer/    approval check, lock, journal, staging, promotion, recovery
                │
           storage/       canonical JSON, cache, lockfile, atomic writes
           agents/        fixed target roots
           schemas/       config, manifest, and JSON contracts
```

| Module | Does | Never does |
| --- | --- | --- |
| `analyzer` | Reads bounded local evidence and normalizes stack and goal | Executes project code or sends project contents anywhere |
| `sources` | Loads the catalog and lists explicit public repositories | Installs files or interprets skill instructions |
| `fetcher` | Resolves commits and fetches verified, bounded blobs | Follows arbitrary URLs, runs Git, or runs hooks |
| `recommender` | Eligibility, scores, ordering, explanations | Network or filesystem access |
| `review` | Structural and static checks over cached bytes | Certifies safety or executes content |
| `planner` | Complete plans, preconditions, digests, verification | Writes agent skill directories |
| `installer` | Applies and recovers an approved plan | Changes the selection or fetches anything |
| `storage` | Validates cache, lockfile, plan, and journal data | Trusts stored digests without recomputing them |
| `renderers` | Escapes untrusted text and formats output | Emits commands taken from candidate text |

Key flows and decisions are in [decisions.md](decisions.md), the threat model is in [security-model.md](security-model.md), and the command surface is in [cli.md](cli.md).
