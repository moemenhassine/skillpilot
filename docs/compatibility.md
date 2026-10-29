# Compatibility record

Official sources checked **2026-10-28** (M0). Recheck before release.

| Source | URL fetched | Finding used by SkillPilot |
| --- | --- | --- |
| Agent Skills specification | https://agentskills.io/specification | Required `name` (1–64, `a-z0-9` and single hyphens, no leading/trailing hyphen, must match parent directory) and `description` (1–1024). Optional `license`, `compatibility` (≤500), `metadata` (string→string map), `allowed-tools` (experimental). Implemented in `src/schemas/manifest.ts`. |
| Claude Code skills | https://code.claude.com/docs/en/skills | Project skills at `.claude/skills/<name>/SKILL.md`; personal at `~/.claude/skills/<name>/`. Claude-specific frontmatter (hooks, `context`, `allowed-tools`, `!` command interpolation, `${CLAUDE_SKILL_DIR}`, …) exists; unrecognized keys are ignored. Reserved name: `synced`. The page does not mention `.agents/skills`. |
| OpenAI / Codex skills | https://learn.chatgpt.com/docs/build-skills (308 redirect from https://developers.openai.com/codex/skills) | Repo skills at `.agents/skills` (CWD, parent up to repo root); user `$HOME/.agents/skills`; admin `/etc/codex/skills`. Optional `agents/openai.yaml` with `policy` and `dependencies.tools`. |
| GitHub REST | docs.github.com (repos, branches, git trees, git blobs, rate limits) | `GET /repos/{o}/{r}` → `default_branch`; `GET /repos/{o}/{r}/branches/{b}` → `commit.sha`; `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` with `truncated` flag (limit 100,000 entries / 7 MB); `GET /repos/{o}/{r}/git/blobs/{sha}` base64 content. Unauthenticated limit 60 requests/hour per IP; `x-ratelimit-*` headers. |

## Target mapping in use

| Target | Project path | Status |
| --- | --- | --- |
| `claude-code` | `.claude/skills/<name>/` | Path verified in docs. Real-agent discovery and declined-install smoke test: **passed** on Claude Code 2.1.302 (2026-10-29, below). |
| `codex` | `.agents/skills/<name>/` | Path verified in docs. Real-agent discovery smoke test: **not run**. |

## Portable skill package (M5, 2026-10-29)

| Check | Result | Evidence |
| --- | --- | --- |
| Frontmatter matches spec 15.1 exactly (`name`, `description`, `license`, `compatibility`, `metadata.version`); no `allowed-tools`, hooks, `!` interpolation, or provider variables | pass | `tests/unit/skill-package.test.ts` |
| Main instructions under 200 lines; every relative reference resolves inside the package | pass | same |
| SkillPilot's own `rules-v1` review of the package | coverage complete; only finding is `LIC-001` (no license text bundled yet, see D-028) | same |
| Structural adapter: copied into `.claude/skills/skillpilot/` and `.agents/skills/skillpilot/`, `list` reports a valid, name-matching skill in both | pass | same |
| Included in the `npm pack` tarball and the installed package | pass | `npm run test:package` |

Structural checks show the files are well-formed and in the documented locations. They do not show that an agent discovers or follows the skill.

## Agent smoke tests

| Agent | Version | OS | Date | Discovery | Invocation | Approval workflow |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | 2.1.302 | macOS (Darwin 25.4) | 2026-10-29 | pass | pass | pass (declined path only) |
| Codex | — | — | 2026-10-29 | not run | not run | not run |

**Claude Code (headless `claude -p`, run with the maintainer's go-ahead).** Setup: a copy of the `nextjs-ts` fixture in a scratch directory, `skills/skillpilot/` copied to `.claude/skills/skillpilot/`, and the built CLI on PATH through a shim that gives SkillPilot a scratch HOME (so its cache stayed in scratch). Tools: `Skill`, `Read`, and `Bash(skillpilot:*)`; `Write` and `Edit` were disallowed.

1. *Discovery.* Asked to list available skills without running tools, the session listed `skillpilot` with its description.
2. *Invocation and declined installation.* Prompt: browser-test skills, Claude Code only, "get it as far as you can toward installing, but I am not approving any installation". The session invoked the `skillpilot` skill and ran exactly `skillpilot --version`, `skillpilot recommend --json --goal "add browser tests" --agent claude-code`, and `skillpilot review anthropics/skills@ca45fc49…#skills/webapp-testing --json`. It explained one candidate with evidence, license, and the Python prerequisite, and set aside the three stack-only matches. It reported the medium `RUN-001` finding `F-d044f8d04cc0df4e` and the static-review limitation. It then stopped before planning because only the user may acknowledge the finding, and showed the command it would run after acknowledgment. It ran no `plan`, no `install`, and no `--ack`. Afterwards the project's git tree was clean, `.claude/skills/` held only `skillpilot`, and no `.skillpilot/` directory existed.

Not exercised: an approved install through the agent (spec 17.5 requires explicit tester consent for that; the approved path is covered by the CLI tests and `npm run smoke:public-source`), and interactive (non-headless) sessions.

**Codex:** no `codex` CLI on the development machine. Not run; SkillPilot makes no claim of verified Codex compatibility beyond the structural adapter test.
