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
