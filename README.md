# SkillPilot

**SkillPilot recommends agent skills for your project, shows why they fit, reviews their files, and installs the exact selection you approve.**

It works with **Claude Code** and **Codex**. You ask your agent in plain language, and SkillPilot does the checking. Nothing is installed until you say "approve".

> Pre-release (0.1.0). Not on npm yet. Needs Node.js 24.

## Setup (once)

**1. Install the tool**

```bash
git clone https://github.com/moemenhassine/skillpilot.git
```

```bash
cd skillpilot && npm ci && npm run build && npm link
```

**2. Add the skill to your project**

From inside the `skillpilot` folder, copy the skill into your project (use `.agents/skills/` instead for Codex):

```bash
cp -R skills/skillpilot /path/to/your-project/.claude/skills/
```

Or, with Vercel's Skills CLI (you still need step 1):

```bash
npx skills add https://github.com/moemenhassine/skillpilot --skill skillpilot
```

## Use it

Open a new Claude Code or Codex session in your project and ask, for example:

> "Which skills would help me add tests to this project?"

The agent will:

1. **Look at your project** and detect your stack. It never opens `.env` or other secret files.
2. **Recommend up to 5 skills** and explain why each one fits.
3. **Let you choose** the skills and the agent (Claude Code, Codex, or both).
4. **Check the exact files** of your choice for risky content. Serious problems block the install; minor ones need your OK.
5. **Show you the plan**: what gets installed and where.
6. **Install only after you reply "approve"**, then record it in `.skillpilot/lock.json`.

To remove a skill later, ask: *"Remove the webapp-testing skill."*

Try it without an agent: `npm run demo` runs the whole flow offline in a temporary folder.

## Good to know

- **Checks can miss things.** A clean review means no known problems were found, not that the skill is safe. Read a skill's files before relying on it.
- **Your files are protected.** SkillPilot never overwrites or deletes a skill it didn't install, or one you edited, and it never runs the scripts it installs.
- **GitHub limit:** without a login, GitHub allows 60 requests per hour, which is enough to check two or three new skills.
- **Tested:** macOS, Linux, and Claude Code 2.1.302. Not yet tested: Windows (CI pending) and Codex. See [docs/compatibility.md](docs/compatibility.md).
- **Compared with Vercel's [Skills CLI](https://github.com/vercel-labs/skills):** that tool supports many more agents and sources. SkillPilot is narrower but stricter: it ranks skills for your project, reviews their files, and installs only the plan you approved.

## Learn more

| Topic | Where |
| --- | --- |
| All commands and options | [docs/cli.md](docs/cli.md) |
| Security model and limits | [docs/security-model.md](docs/security-model.md) |
| How it is built | [docs/architecture.md](docs/architecture.md) |
| Contributing and running the tests | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Design decisions and progress | [docs/decisions.md](docs/decisions.md), [docs/implementation-status.md](docs/implementation-status.md) |

## License

MIT, see [LICENSE](LICENSE). Dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Cataloged skills are not bundled and keep their own licenses.
