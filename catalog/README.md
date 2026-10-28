# Bundled catalog

`skills.json` is SkillPilot's curated, versioned discovery metadata. It is **not** a trust list: membership never exempts a skill from review, and every entry is re-fetched and reviewed at its pinned commit before installation.

## How catalog 0.1.0 was built (2026-10-28)

1. For each publisher, resolved the default branch to a full commit ID and fetched the recursive tree from the public GitHub REST API (no authentication).
2. Read each selected `SKILL.md` at that exact commit and validated it with SkillPilot's own manifest parser (`src/schemas/manifest.ts`).
3. Recorded the payload size, file count, files outside payload policy v1, license evidence, and any target-specific frontmatter from the tree.
4. Added curated `stack`, `requiresAnyStack`, and `tasks` annotations by hand. These drive ranking; upstream descriptions are stored for display only.

Run `npm run validate:catalog` for the offline schema and coverage gate.

## Field notes

- `requiresAnyStack`: a curated, explicit incompatibility. When a project's stack is known and contains none of these tokens, the entry is excluded (for example, Expo skills on an Android-native project).
- `payload.unsupportedFiles`: files outside the current payload policy (`payload-v2`; for example `.ipynb` or `Dockerfile`). Such entries are shown with a caveat, and review will block installation until the policy changes.
- `license.scope`: `skill` when a license file sits in the skill directory; `repository` when the repository's root license applies and must be shipped as a mapped provenance file.

## Candidates checked and excluded

| Source | Reason |
| --- | --- |
| vercel-labs/agent-skills (react-best-practices, composition-patterns, react-native-skills) | Manifest name does not match the directory name; no license file in the repository. |
| vercel-labs/agent-skills (web-design-guidelines, deploy-to-vercel) | No license evidence. |
| android/skills (all 36 skills) | `metadata.keywords` is a list; the Agent Skills spec requires string values. |
| anthropics/skills#skills/claude-api | Description exceeds 1,024 characters. |
| callstackincubator/agent-skills#skills/react-native-best-practices | Payload exceeds the 5 MiB / 512 KiB-per-file caps. |
| callstackincubator/agent-skills (vendored react-native-testing) | Vendored copy; upstream provenance and license not verified. |
| openai/skills#…/jupyter-notebook | `.ipynb` templates are outside payload policy. (playwright, openai-docs, and gh-fix-ci were excluded for PNG icons under v1; they are eligible under `payload-v2` and can be added in a later catalog version.) |
| trailofbits/skills#…/devcontainer-setup | `.zshrc` and `Dockerfile` resources outside payload policy. |
| getsentry/skills#skills/security-review | Skill-level LICENSE describes OWASP-derived terms that differ from the repository license; ambiguous. |
| dpearson2699/swift-ios-skills | PolyForm Perimeter (source-available, not open source); not redistributed by the catalog. |

## Coverage

Under `payload-v2` (D-012), every baseline category, including Swift/iOS, has at least one candidate that the payload policy can review.
