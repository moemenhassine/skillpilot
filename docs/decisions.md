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
