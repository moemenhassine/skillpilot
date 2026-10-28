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
| `claude-code` | `.claude/skills/<name>/` | Path verified in docs. Real-agent discovery smoke test: **not run**. |
| `codex` | `.agents/skills/<name>/` | Path verified in docs. Real-agent discovery smoke test: **not run**. |

## Agent smoke tests

| Agent | Version | OS | Date | Discovery | Invocation | Approval workflow |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | — | — | — | not run | not run | not run |
| Codex | — | — | — | not run | not run | not run |
