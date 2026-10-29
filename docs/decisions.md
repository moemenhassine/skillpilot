# Decisions

## D-001 Toolchain (M0, 2026-10-28)
Node.js 24 (`engines: >=24 <25`), TypeScript 5.9.3 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`). TypeScript 7.0 exists but `typescript-eslint` 8.72 supports `<6.1`, so 5.9 is pinned. Sources use `.ts` import specifiers with `rewriteRelativeImportExtensions`, so `npm run cli` runs `node src/cli.ts` via Node's native type stripping and `npm run build` emits `dist/`.

Runtime dependencies (exact pins, installed with `--ignore-scripts`): commander 15.0.0, zod 4.6.7, yaml 2.9.1 (strict YAML), smol-toml 1.9.1 (TOML data parsing), ignore 7.0.14 (gitignore semantics). Dev: vitest 5.0.5, eslint 10.13.0, typescript-eslint 8.72.1.

## D-002 Scan depth semantics
Root-level files are depth 1; with `maxDepth` 4 the walker lists directories down to depth 3, so files at most four path segments deep are seen. Hitting the boundary is reported as a limit hit.

## D-003 Ignore files
Only the root `.gitignore` and `.skillpilotignore` are honoured (bounded to 64 KiB). Mandatory exclusions are checked first, so ignore negations (`!.env`) cannot re-include them. Nested ignore files are a known shortcut.

## D-004 Secret-like filenames
Excluded and never opened: `.env*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, names containing `credential` or `secret`, SSH private key names, `*.pem|key|p12|pfx|keystore|jks|mobileprovision|tfvars|kdbx`, Firebase config files, `service-account*.json`. The list is deliberately over-broad; the cost of a false exclusion is weaker detection, which is reported.

## D-005 Detection confidence and effective stack
Dependency keys and parsed manifest keys are `high`; bounded literal matches (Android plugin IDs, `IPHONEOS_DEPLOYMENT_TARGET`, `.iOS(`) and tooling config-file existence are `medium`; source-file extensions are `low`. Low-confidence tokens are reported but excluded from the effective stack, so a stray `.kt` file never implies Android and a `.swift` file never implies iOS.

## D-006 Skill directories are not stack evidence
`.claude/` and `.agents/` are excluded from the evidence walk; installed skills are read only through the manifest-only inventory, so candidate skill text never influences detection.

## D-007 Spikes (desk-checked, code pending)
- **Immutable fetch:** the GitHub endpoints in `docs/compatibility.md` resolve a default branch to a full commit SHA, enumerate a tree with an explicit `truncated` flag, and return blob bytes for local SHA-256 hashing. No blocker found. The 60 req/hour unauthenticated limit means a 200-file skill cannot be fetched in one hour blob-by-blob; M3 must evaluate fetching blobs via the tree + per-blob calls under that budget, or document the limit. **Open risk for M3.**
- **Recoverable install:** same-filesystem `rename` of a fully staged directory plus a journal written by atomic replace is available on all three OSes in Node 24. Windows rename-over-existing and junction behaviour must be proven in M4 CI.

## D-008 Catalog curation (M2)
Catalog 0.1.0 has 28 entries from 13 publishers, all pinned to full commit IDs and validated with SkillPilot's own manifest parser. Upstream skills that violate the Agent Skills spec are excluded rather than repaired (see `catalog/README.md`). Annotations are curated by hand; descriptions are display-only.

## D-009 Stack applicability and implied tokens (fit-v1)
Stack fit counts only "applicable" project tokens: framework/platform/domain tokens in the taxonomy. Tooling-only tokens (docker, ci, vercel, netlify, xcode) and the near-universal `javascript`/`typescript` are excluded, because no entry targets them and they diluted platform matches (an Expo app scored 13/40 against Expo skills). Ancestors and implied tokens collapse to leaves: `react-native` implies `react` for counting, but a React-web candidate never matches a React Native project.

## D-010 `requiresAnyStack` as explicit incompatibility (FR-023)
Platform-specific entries declare the stacks they require. With a known project stack and no overlap, the entry is excluded with a visible reason. With an unknown stack (new project, no `--stack`), nothing is excluded on this basis.

## D-011 Repository discovery
`--refresh` (or a per-invocation `--repo`) reads only the four supported roots, at most 30 skills per repository, through `api.github.com` with no auth headers and no redirects. A truncated tree fails closed. Each blob's decoded bytes are checked against its Git object ID. Tags for discovered skills are derived from the manifest name and description only and are labelled `derived-from-metadata`. Metadata is cached under the OS cache directory, and cache writes are disclosed as a warning. A discovered entry that duplicates a catalog entry keeps the catalog pin and records both sources. Shortcut: DNS is checked for non-public addresses before `fetch` resolves again (TOCTOU), because pinning the connect address needs an extra dependency.

## D-012 Inert image assets (payload-v2) — RESOLVED 2026-10-28
Both Swift/iOS catalog entries contain PNG icons. Payload policy v1 (spec 10.3) has no image formats, so review will block them. Options: (a) keep v1 and document the gap; (b) payload policy v2 accepts PNG/JPEG/GIF/WebP as inert binary assets with magic-byte verification, a size cap, no rendering, and its own rule fixtures. This also unblocks four OpenAI curated skills. It needs a maintainer decision before M3 locks the payload policy.

## D-013 Evaluation labels
The 24 evaluation cases were drafted by the implementing agent in the same session that tuned the taxonomy, so 22/22 top-3 hits is a regression baseline, not an accuracy estimate. Precision@3 is not measurable on catalog 0.1.0 (no case has three eligible relevant entries). Labels need human maintainer review before release.

**Resolution (maintainer, 2026-10-28):** option (b). `payload-v2` (`src/review/policy.ts`) accepts `.png`, `.jpg/.jpeg`, `.gif`, and `.webp` as inert binary assets. Each image must carry the magic-byte signature of its claimed format and be at most 1 MiB; it is copied as bytes and never decoded, rendered, or scanned as instructions. A mismatched signature is an `STR-003` incomplete-review blocker. `.ipynb`, `Dockerfile`, dotfiles, and other formats remain unsupported.

## D-014 Static rules `rules-v1` (M3)
Text rules live in `src/review/rules.ts`, with positive, benign, and context fixtures in `tests/unit/rules.test.ts`. Each rule variant emits one finding per file at its first occurrence, with an occurrence count. Findings store locations and rule text only, never matched excerpts, so a secret match can't leak through a report. DOC-001 lowers severity by one level (and confidence to low) only when *every* occurrence in the file sits on a clearly negative-example line ("never", "do not", "avoid", …); the evidence stays visible. Secret rules are never softened. A skill cannot suppress findings through comments or frontmatter.

## D-015 Bundled scripts are one medium RUN-001 finding
Following spec 11.2 ("medium disclosure"), any bundled script makes the payload require acknowledgment. Scripts are aggregated into a single finding per payload, with a stable ID over the script list, so one `--ack` covers the disclosure. Network destinations found in bundled code are a separate medium NET-001 finding.

## D-016 License evidence
LIC-001 is clear only when a bundled license text is identified by signature (MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0, CC-BY-4.0, CC-BY-SA-4.0, Unlicense) and does not contradict the manifest `license` field. A manifest declaration with no text blocks, because attribution needs the text. When the skill directory has no license file, the repository-root LICENSE/COPYING and NOTICE at the same commit are mapped into the payload as `role: license` / `notice`, hashed, scanned, and recorded with their source paths. Name collisions block.

## D-017 Lockfile proposals and the plan digest
`lockfileChanges` entries are derived from the planned skills and exclude `planDigest` and `installedAt`, which the executor adds when it commits (the digest cannot contain itself). `verifyPlan` re-derives the proposals and rejects any difference.

## D-018 Unacknowledged medium findings produce no plan
Instead of writing a non-executable plan, `plan` returns `POLICY_BLOCKED` with the exact finding IDs and the `--ack` flags to regenerate. Acknowledging an ID that is not a medium finding in the selection is `INVALID_ARGUMENT`.

## D-019 Existing targets in M3 — superseded by D-022
Any existing destination, including a case-fold variant, is `TARGET_CONFLICT` at plan time. Treating an identical managed installation as a successful no-op needs the M4 lockfile.

## D-020 Payload fetching
Fetching pins a full commit, enforces count and byte caps from the tree *before* any blob request, fetches blobs sequentially, checks each against its Git object ID, and stores it under its SHA-256 in a per-source cache directory. Review is a pure function of the cached bytes plus the recorded excluded entries, so `verifyPlan` (and the M4 executor) can re-run it offline. A repository-root skill (`#.`) uses the whole repository as its payload. Cost: about `files + 3` unauthenticated requests per skill, so a 60-request hour covers roughly two or three average skills (see D-007).

## D-021 Transaction design (M4)
`install --plan` runs, in order: plan validation and fresh offline review, project identity (the plan's real project root must equal the resolved `--project`), approval, the mutation lock, a check for unfinished operations, live preconditions, staging, journal, promotion, lockfile, commit, and cleanup. Staging lives in `.skillpilot/operations/<id>/`, which is on the project's filesystem and outside every agent discovery root. Each promotion or removal is one directory `rename`, so an owned tree is always in exactly one of two journaled places. Recovery first checks every step (hashes of the moved tree, absence at the other location, lockfile hash equal to the journaled "after" or "before" value) and acts only if all checks pass. Otherwise it changes nothing and returns `RECOVERY_REQUIRED` with the conflicts. Uncommitted operations are always rolled back, never rolled forward. Committed ones only finish cleanup. Agent-root parent directories created by an install are left in place.

## D-022 Managed no-op and partial overlap
At plan time a target is `absent`, or `managed` when the lockfile records this exact source and payload there and every owned file is byte- and mode-identical. Managed targets get no lockfile change and no write, so adding Codex to a Claude-only install leaves the Claude copy and its provenance untouched. Applying an already-applied plan, or a plan whose targets are all managed, returns `no-op` without touching the lockfile. Any other existing state conflicts. Updates (another revision at the same path) need remove, then install, as the spec requires.

## D-023 Stale locks
The mutation lock records PID, hostname, operation ID, and time. Process start time is not available portably from Node, so liveness is a PID check. A reused PID reads as alive, which blocks conservatively. A lock from another host, or an unreadable one, is never broken automatically. `install` never clears a stale lock itself: it returns `RECOVERY_REQUIRED` and points to `doctor --recover`, which handles the journal and then removes the lock. Two concurrent `doctor --recover` runs are not serialized (shortcut). Every recovery step re-checks state, so a second run finds nothing to do or a conflict.

## D-024 Approval prompt
The TTY phrase is `install <first 12 hex>` or `remove <first 12 hex>`, so typing the phrase for an install plan cannot approve a removal plan. EOF and any other answer are `APPROVAL_DECLINED` (exit 5). Ctrl-C is `CANCELLED` (130). Interactive mode needs both stdin and stdout to be TTYs, and `--json` is never interactive. `APPROVAL_REQUIRED` includes the full digest in `details` so an agent wrapper can show it to the user. The digest proves only that the approval value matches the plan, not who supplied it (spec 13.2).

## D-025 Fault injection
`executePlan` accepts a `hooks` callback, called after every durable transition (`locked`, `staged`, `journaled`, `moved:<i>`, `lockfile`, `committed`, `cleaned`). Only tests pass it; the CLI has no flag or environment variable that reaches it. Throwing `SimulatedCrash` skips rollback and lock release, as a process kill would.

## D-026 Removal plans
Removal plans share the plan envelope (`operation: "remove"`) and the executor. They list the exact lockfile-owned files per target. Planning and execution both require every owned file present and identical, with no added files or directories. Removed trees are moved into the operation directory as journaled backups, and deleted only after the lockfile commit. The installed ID is the lockfile source ID (`owner/repo#path`), shown by `list`.
