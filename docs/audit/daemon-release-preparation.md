# Explicit daemon release-preparation mechanics

THE-18 remains **In Progress**. This bounded port supplies the actual local
preparation mechanics from daemon `254699bf5d834cdca41436211ada1ae32bf89258`,
without choosing a product release channel or activating publication/update.
It supersedes only the release-preparation source/test deferral in earlier
native-packaging and migration-status audits; those dated receipts are preserved.

## Implemented surfaces

- `products/daemon/scripts/release-prepare.ts`, opt-in through `release:prepare`.
- `products/daemon/src/test/scripts/release-prepare.test.ts`, exercising actual
  filesystem writes and the CLI in isolated guarded-runner fixture directories.
- Product manifest version, compiled `src/version.ts` fallback and a README badge
  if one already exists; the actual private README has no badge.
- Caller-owned product `CHANGELOG.md` gets a `## [X.Y.Z] - YYYY-MM-DD` scaffold
  before its first section, never below the first separator. Existing notes and
  introduction remain. Existing matching version sections stay byte-identical.

Exactly one explicit bump/exact/no-bump mode is required. Notes require an
explicit valid date and existing product changelog; `--no-changelog` neither
reads nor creates one. No real manifest version or fallback was bumped and no
product changelog was created for this port. This preserves the unresolved
release/version ownership decision instead of silently creating a default.
`--no-bump --no-changelog` is an available future sync command, not a newly
configured toolchain releaseCut hook. Native prebuild remains read-only.

SemVer grammar and safe arithmetic are checked. Textual root-property token
location preserves manifest formatting and nested dependency versions and
rejects duplicate root version properties. The private package identity is
required. Exactly one binary fallback is required. Unknown, duplicate,
conflicting and incomplete CLI arguments refuse before mutation.

All inputs are read and validated before writes. Unchanged surfaces are not
written. Repeating exact-version/no-bump preparation is byte-idempotent; an
arithmetic bump explicitly requests another version. Ordinary filesystem write
failure attempts restoration in reverse order, including the failed file
because a write can fail after truncation. Incomplete restoration is surfaced
with original and restoration causes. This is not crash-safe multi-file
atomicity or concurrent-writer coordination. Use a clean, exclusive checkout,
review the diff and correct any reported incomplete restoration before release.

## Evidence and scope

The original pinned tests' top placement, old-body preservation, existing-section
idempotence, distinct prefix version, empty changelog and bump arithmetic
assertions are retained. Additional tests cover actual manifest/fallback/badge
consistency, escaped root property names and nested version fields, exact repeat
no-write behavior, both independent no-bump/no-changelog modes, missing notes,
invalid inputs and fallback, partial-write compensation and failed compensation,
CRLF notes, and execution of the copied CLI in a fixture checkout.

The guarded command `bun packages/engine/scripts/test.ts --cwd
../../products/daemon src/test/scripts` passes all **44 tests / 195 assertions**
in the three daemon script suites, including release preparation, native
packaging and CI artifacts. Full daemon `tsc --noEmit -p
products/daemon/tsconfig.json`, `product-workspaces.ts check` and `git diff
--check` pass. Independent review identified a SemVer build-metadata badge edge;
the optional metadata matcher and no-bump(metadata)-then-patch regression are
included in the final tested source. An initial direct `bun test` invocation hit the existing
fixture-runner guard; it made no fixtures and was rerun through the supported
runner rather than bypassing that guard.

Only the two release-preparation inventory/migration rows are now mapped. The
release workflow, hosted-proof and toolchain acceptance rows retain their
separate remaining obligations. This does not configure `releaseCut`, publish
or `perJobGreen`; choose shared versus separate version streams; rewrite saved
legacy updater settings; authenticate or publish a native cohort; activate
lifecycle adoption; or qualify other platforms or a real release/deployment.
