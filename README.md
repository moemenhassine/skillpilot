# SkillPilot

SkillPilot is a command-line tool plus a portable Agent Skill. It recommends agent skills that fit your project, statically reviews the exact files of a skill you select, and installs only a plan you have explicitly approved, recording provenance in a lockfile.

**Understand the project → discover candidates → rank and explain → review exact contents → plan → approve → install and record provenance.**

It installs skills for **Claude Code** (`.claude/skills/<name>/`) and **Codex** (`.agents/skills/<name>/`) at project scope.

> Status: pre-release (0.1.0). Not published to any package registry. Tested on macOS and Linux with Node.js 24; Windows is pending its first CI run. See [what works](#what-works-today), the [support matrix](#support-matrix), and [limits](#limits).

## Quickstart (from a clean checkout)

Requires Node.js 24.

```bash
npm ci
```

```bash
npm run build
```

```bash
npm run demo
```

The demo runs offline in a temporary directory. A fixture skill is placed in a temporary cache, then the real CLI reviews it, writes a plan, refuses to install without approval, installs it with the approved digest, lists it, and writes a removal plan. Nothing outside the OS temp directory is touched.

Try the read-only commands on a bundled fixture project:

```bash
node dist/cli.js recommend tests/fixtures/projects/nextjs-ts --goal "write browser tests" --offline
```

To put `skillpilot` on your PATH from the checkout:

```bash
npm link
```

## Typical use

```text
skillpilot recommend --goal "set up testing"                 # read-only ranking with evidence
skillpilot review anthropics/skills#skills/webapp-testing    # fetch a pinned payload, static review
skillpilot plan anthropics/skills@<commit>#skills/webapp-testing --agent claude-code \
  --ack <finding-id> --out .skillpilot/plans/webapp.json     # complete plan + digest; installs nothing
skillpilot install --plan .skillpilot/plans/webapp.json       # shows the plan; type "install <12 hex>"
skillpilot list                                               # managed / modified / missing / unmanaged
skillpilot remove anthropics/skills#skills/webapp-testing --agent claude-code --out .skillpilot/plans/rm.json
```

Agents and scripts use `--json` and approve with `--approve sha256:<full digest>`. There is no `--yes`, `--all`, or `--force`. The full reference is in [docs/cli.md](docs/cli.md).

## The Agent Skill and the CLI are separate

[`skills/skillpilot/`](skills/skillpilot/SKILL.md) is a portable skill that teaches Claude Code or Codex to drive the CLI. It presents candidates and review findings, asks you to choose agents and acknowledge findings, shows the final plan and digest, and waits for your explicit approval before installing.

To use it, copy the `skills/skillpilot/` directory to `.claude/skills/skillpilot/` or `.agents/skills/skillpilot/` in your project. **Copying the skill does not install the CLI.** Install the CLI from a source checkout as above. No registry package exists yet.

## What works today

- Bounded, read-only project analysis. It never opens secret-like files and never runs project code.
- A bundled, provenance-checked catalog of 28 skills from 13 publishers. Explicit public GitHub repository discovery (`--repo`, `--refresh`).
- Deterministic `fit-v1` recommendations with explanations. Fit is relevance, not safety.
- Immutable review: full commit pin, Git object and SHA-256 checks per file, payload caps, and the `rules-v1` static rules with license evidence. Medium findings need exact acknowledgment; high findings block with no override.
- Plans with a 24-hour expiry and a domain-separated digest. The installer re-verifies everything offline after approval.
- A transactional installer: project mutation lock, journal, staged rename promotion, atomic lockfile, and rollback or explicit recovery (`doctor --recover`). Identical managed installs are a no-op; existing or edited skills are never overwritten.
- `list` and approved removal plans.
- `--offline` makes zero network requests. Every `--json` command emits one envelope that matches a published JSON Schema in [`schemas/`](schemas/).

## Support matrix

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| CLI test suite, Node.js 24 | passing locally | passing (`node:24` container) | in CI matrix, not yet run |
| Package smoke test (`npm pack` → install → run) | passing | passing | in CI matrix, not yet run |

| Agent | Install location | Structural test | Real agent smoke test |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills/<name>/` | passing | discovery, recommendation, and declined install passed on 2.1.302 (2026-10-29) |
| Codex | `.agents/skills/<name>/` | passing | not run (no Codex CLI available) |

Details and dates are in [docs/compatibility.md](docs/compatibility.md).

## How SkillPilot differs from existing tools

[Vercel's Skills CLI](https://github.com/vercel-labs/skills) (`npx skills`) is a broad package manager for agent skills: it searches the skills.sh ecosystem, installs to many agents at project or global scope, and supports updates and private sources. Its [find-skills](https://github.com/vercel-labs/skills/blob/main/skills/find-skills/SKILL.md) skill helps an agent search for and install skills conversationally.

SkillPilot is narrower and stricter by design. It:

- ranks candidates against evidence from your project and stated goal, and explains each score;
- reviews the exact files at a pinned commit with versioned static rules before anything can be planned;
- installs only a plan whose digest you approved, and re-verifies it offline before writing;
- records provenance in a lockfile and recovers explicitly from interrupted operations.

It supports only Claude Code and Codex at project scope, public GitHub sources, and no updates yet. If you need breadth or global installs, the Skills CLI covers far more.

## Limits

- **Static review can miss harmful behavior.** A clean result means "no findings under rule set rules-v1", not safe, trusted, or certified. Read the instructions and bundled files before enabling a skill. See [docs/security-model.md](docs/security-model.md).
- **The approval digest binds content, not identity.** The CLI cannot tell whether a person or an agent passed `--approve`; the agent wrapper and the host's permissions enforce consent.
- **Unauthenticated GitHub access is limited to 60 requests per hour.** Fetching a skill costs about its file count plus 3 requests.
- **Not yet done:** updates, user-level installs, private sources, a Windows test run, and a Codex real-agent smoke test.
- **Not published.** The npm name `skillpilot` belongs to an unrelated package, so a release needs a different name or scope (see [docs/release-checklist.md](docs/release-checklist.md)).

## Development

```bash
npm run lint && npm run typecheck && npm test && npm run test:integration && npm run build
```

Also available: `npm run test:evaluation`, `npm run validate:catalog`, `npm run check:schemas`, `npm run check:notices`, `npm run test:package` (packs the tarball, installs it in a temporary directory, and runs the installed binary), and `npm run bench`. Two scripts use the network and are run by hand: `npm run smoke:public-source` reviews and installs one pinned public skill in a temporary project, and `npm run verify:catalog-sources` re-checks every catalog pin. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). Bundled dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Cataloged skills are not redistributed and keep their own upstream licenses.

Development instructions are in [AGENTS.md](AGENTS.md). Progress and decisions are tracked in [docs/implementation-status.md](docs/implementation-status.md) and [docs/decisions.md](docs/decisions.md).
