# PR57 extraction into the native durable ledger slice

This is a selective reuse inventory against PR57 head
`78ec67e4d3f82f69af030b055bb9791a18cf5950` (20 changed files), not a claim that
PR57 is completely replaced. The native ledger changes project-work authority;
it does not automatically make the legacy planning approval/answer callers safe.
PR57 must remain open until its useful pieces and legacy callers are explicitly
accounted for. This document is not a closing instruction for PR57 or PR56.

## Keep and harden: shared persistence

- `sdk/src/platform/state/sqlite-store-persistence.ts`: retain canonical path and
  alias identity, hardlink refusal, baseline comparison, sibling temporary-file
  publication, and `.knowledge-lock`. Add durable directory creation and fsync,
  explicit before-publication/indeterminate errors, durable observed-file and
  directory confirmation on replay, and postcommit cleanup isolation.
- `sdk/src/platform/state/sqlite-store.ts`: retain coordinated option, detached
  `readPersisted`, fresh-image `transactPersisted`, clean-image/baseline and image
  epoch checks, coordinated initialization and ordinary-save behavior. Add an
  explicit admission queue, owned batch drains, synchronous-decision rejection,
  reentrant-local-write preservation, cache fencing, and fail-closed current
  schema/header validation. Unrelated default SQLiteStore users stay unchanged.
- `sdk/src/platform/workspace/checkpoint/cross-process-lock.ts`: retain the exact
  strict-ownership behavior: live owners cannot be evicted by age, malformed
  metadata cannot become authority, and an unsupported atomic lock publication
  cannot fall back to an empty visible lock. Default checkpoint behavior remains.
- `test/knowledge-strict-lock.test.ts`: retained. `test/knowledge-coordinated-persistence.test.ts`:
  retained, with raw KnowledgeStore-file fixtures explicitly opening schema v2.
  These cover ordinary and guarded process writers, stale images/batches, aliases,
  hardlinks, migration ownership, initialization retention, and image epochs.
- New `test/sqlite-publication-durability.test.ts`, `test/work-ledger-sqlite.test.ts`
  and `test/work-ledger-sqlite-process.test.ts` cover durability phases, exact
  receipts, corruption, close/drain and real process crashes. Killing a process
  is not a power-loss test.

## Keep: generic conditional source-write compatibility

- `knowledge/store-source-generation.ts`: retained unchanged. Generations hash
  sorted column names and every raw source value, including JSON bytes. They are
  content preconditions, never authority or timestamps.
- `knowledge/store-evidence-writes.ts`: retain the narrow SQL-writer parameter
  needed to write a fresh image rather than the cached owner image.
- `knowledge/store.ts`: retain all three generic methods:
  `getSourceSnapshot`, `getSourceGeneration`, and `upsertSourceIfCurrent`.
  Input capture before initialization, expected-null absence semantics,
  `source-changed`/`pending-local-changes`, mirror refresh, and initialization
  retention/failure cleanup are preserved on the hardened boundary.
- `knowledge/index.ts`: retain only the generic named exports
  `KnowledgeSourceSnapshot` and `KnowledgeSourceWriteResult` from the PR57 hunk.
- `test/types/planning-persisted-guard-public.ts`: adapt its generic source and
  SQLite portions into `test/types/knowledge-source-generation-public.ts`.
  Do not claim that this validates the omitted planning-action types.

Generic source preconditions remain available for legacy integrations to adopt.
The native ledger's aggregate revision/receipt protocol is separate; it is not
presented as a replacement for generic conditional source writes.

## Defer: legacy planning actions and callers

These PR57 hunks are deliberately **not** included:

- `knowledge/project-planning/service.ts`: selected/current-mode
  `applyStateAction`, frozen revision binding, atomic selected-source comparison,
  action-specific approval/answer handling, `getState` revision pairing, and
  downstream synchronization gating.
- `knowledge/project-planning/types.ts` and `project-planning/index.ts`, plus the
  planning-type lines in `knowledge/index.ts`: `ProjectPlanningRevision`, action,
  expected/input/result types, and optional selected revision on state results.
- `test/planning-revision-guards.test.ts`, planning-dependent parts of
  `test/planning-persisted-generation.test.ts` and
  `test/pr57-independent-persisted-races.test.ts`, and the planning half of the
  public type fixture. Generic races overlap the retained coordinated tests;
  selected approval, duplicate answer, and actual planning-caller proofs do not.

The legacy `ProjectPlanningService`, admin state-upsert route, and callers remain
on their existing API. No caller is silently redirected into native work or
converted into an authenticated actor. Preserving legacy metadata, including
`executionApproved`, does not make it authority in the native ledger. Existing
trusted-admin compatibility is unchanged, not removed or newly verified by
native ledger tests. The TUI producer/modal/command integration bytes were never
part of this engine-only extraction and remain a separate acceptance obligation.

Before PR57 can be retired, choose and prove either explicit legacy caller
migration to the native service or continued revision-guard compatibility for
those callers. An accepted legacy source mutation followed by task/work-plan
synchronization remains a multi-step operation; no atomic outbox is added here.

## Other PR57 hunks

- `etc/subpath-api-surface.json`: regenerate from this composed source; never
  copy its obsolete complete report. Generic exports and the new narrow
  `sdk/platform/workflow/work-ledger` surface are tested independently.
- `contract/batteries/owner-reply.ts`: the explicit type-annotation stability
  correction is not extracted. It is unrelated to ledger persistence; assess
  independently if the actual clean API gate reproduces ordering drift. It is
  not claimed obsolete merely because local extraction passed.
- `.gitleaksignore`: historical commit-specific fixture suppressions are not
  copied into this new commit history. Retained fixtures generate lock IDs at
  runtime. Do not weaken credential scanning to accept historical prose.
- `docs/audit/planning-revision-guards.md`: remains PR57 historical evidence.
  This inventory and the native ledger README describe the new contract instead.

## Remaining native integration limits

The storage owner detects disappearance after observing the file. A fresh owner
has no external existence manifest and cannot distinguish deletion of the whole
DB before startup from first creation. Established-open identity remains an
explicit integration requirement; corrupt-present files and missing current-v2
ledger tables do fail closed. No unused opt-in pretends to solve host identity.

One production authority owner routes authentication/revocation. Multiple local
process tests establish file serialization, not distributed actor revocation.
Runtime/source projection still needs an atomic outbox plus downstream dedup;
actual verifier execution and Agent/TUI product adoption are separate work.
