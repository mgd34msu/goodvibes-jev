# TUI file-picker and Gist semantic adoption

Scope: THE-62 P10, inventory `src/input/file-picker.ts` (line 1194/decision
1452) and `src/export/gist-uploader.ts` (line 123). Started from main
`d1dcb55c`. This receipt preserves the original inventory rationale and the
remaining THE-62/THE-30 product checklists; it does not close either product.

## Canonical owners and actual callers

- `engine.walk.skip-directory` is registered in the engine judgment registry.
  `utils/directory-reading.ts` owns its question, band, fixtures and level fan-out.
  Public `readWalkDirectories` returns true (skip), false (keep) or null (held).
  TUI `input/file-picker.ts` calls that public owner for actual visible directory
  entries with exact names and relative paths. Hidden-dot filtering, file type,
  depth/count limits and literal partial-path ranking remain code. Ordinary
  files named `dist` or `node_modules` are no longer mistaken for directories.
- Existing `engine.tools.credential-header` ownership is retained. Public
  `tools/credential-header-reading.ts` wraps that same battery; both the existing
  cross-origin redirect caller and TUI Gist resolver adopt it. No duplicate
  credential battery or retry owner is introduced. Only names enter judgment;
  configured values remain local, captured without invoking getters. Standard
  Bearer auth and GITHUB_TOKEN remain explicit authority. The first acting yes
  wins in original header order; held readings cannot select a credential.
- Both new readers screen complete supplied names/identities with the existing
  `snapshotJudgmentInput` boundary before projection and port access. Structured
  credential/card names, inline protected material and accessor directory input
  are rejected without a request or input-bearing diagnostic.

## Product lifetime and recovery

The picker aborts pending work on Close, invalidation and reopening. A captured
root/current-owner assertion guards traversal, each judgment transport attempt
and completion; old-root traversal cannot continue into another level or publish
a cache. Only complete successful readings populate the cache. Held/failed
readings render an explicit unavailable message, and reopening retries. The
original fuzzy-path ranking and selection/insert/inject semantics remain intact.

Gist uses a separate instance of the existing `ScheduleReadingLifetime` owner
pattern, wired beside scheduling to Escape, new input, session recovery changes
and shell shutdown. It fences the actual reader and final fetch, suppresses a
repeated pending submission, captures export content before async work, and
revalidates conversation generation, session and exact configured auth before
upload. A changed credential requires resubmission. An operational reading
failure preserves the local export and gives a value-free error. Per-attempt
atomic owner-only receipts preserve accepted URLs or unconfirmed dispatches under
the original session even after UI cancellation. A receipt durability failure
retains the accepted/unconfirmed outcome in explicitly source-labelled global
notification history, without mutating a replacement conversation. Cancellation
while fetch is already dispatched does not establish that GitHub received
nothing; no rollback or remote cancellation guarantee is claimed.

## Named synthetic proof

- Engine `test/directory-credential-readers.test.ts`: canonical fixtures,
  acting/held results, complete-name privacy floor and descriptor-safe capture.
- Existing engine `test/fetch-page-reading.test.ts`: protocol/tool-auth drop,
  nonstandard credential drop and acting noncredential cross-origin retention.
- TUI `src/test/input/file-picker-reading.test.ts`: level fan-out, exact paths,
  authored dist, literal hidden policy, normal files with conventional names,
  failed/held recovery, cache, close/invalidate/root/reopen and retry fencing.
- TUI `src/test/renderer/file-picker-overlay.test.ts`: original rendered picker
  cases plus explicit unavailable rendering rather than endless loading.
- TUI `src/test/export/gist-credential-reading.test.ts` and existing
  `share-e20.test.ts`: exact-value/header-order behavior, protected names,
  mutable/accessor capture, cancellation and standard auth/env/upload behavior.
- TUI `src/test/input/share-credential-reading.test.ts`: real `/share` command,
  pending Escape/session/exit/history/auth changes, repeated submissions,
  zero stale uploads, failure-preserved local export and successful retry.

## Remaining scope and evidence limits

General engine `walkDir`/find callers still use their existing policy and are
not claimed migrated by this TUI receipt. The canonical walk owner is available
for that separately coordinated adoption. This change does not claim WebUI
implementation or whole-product visual/binary/connected-daemon parity.

Tests use synthetic ports and fake fetch; they establish wiring and control
behavior, not semantic classification quality. Genuine configured calibration
and classification remain THE-35 work. No live service, real Gist or provider
was called during qualification. Final integrated source/API/build evidence
belongs to the exact final contribution and THE-15 aggregate receipts.
