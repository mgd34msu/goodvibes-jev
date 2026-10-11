# Native work persistence and historical compatibility

Historical planning records, approval fields and verification prose remain
inspectable source claims. They are not authenticated actors, native execution
capabilities or genuine criterion evidence. Native work uses the
[autonomous decision contract](../design/autonomous-jev-decisions.md),
[explicit import and recovery](../../products/agent/docs/legacy-ledger-migration.md)
and [passive TUI history](tui-passive-planning-history.md) boundaries.

## Coordinated persistence

The shared SQLite persistence owner preserves canonical path/alias identity,
hardlink refusal, baseline comparison, sibling temporary-file publication and
strict `.knowledge-lock` ownership. Directory creation and publication require
durable file/directory synchronization, explicit before-publication versus
indeterminate errors, observed-file/directory confirmation on replay and cleanup
isolation after commitment. Never report a postcommit cleanup failure as proof
that no write occurred.

Coordinated SQLiteStore operations use detached `readPersisted`, fresh-image
`transactPersisted`, clean-image/baseline and image-epoch checks. Preserve
coordinated initialization, admission queues, owned batch drains, rejection of
asynchronous decision callbacks, reentrant local-write preservation, cache fences
and fail-closed current schema/header checks. Unrelated default SQLiteStore
consumers retain their ordinary-save behavior.

A live cross-process lock owner cannot be evicted by age. Malformed metadata is
not ownership evidence, and unsupported atomic lock publication cannot fall back
to an empty visible lock. Validate ordinary/guarded process writers, stale images
and batches, aliases, hardlinks, migration ownership, initialization retention,
image epochs, exact receipts, corrupt files, close/drain and real process crashes.
Raw KnowledgeStore fixtures use their actual schema version. Killing a process
is not a hardware power-loss test.

The storage owner detects disappearance after observing its file. A fresh owner
without an external existence manifest cannot distinguish whole-database deletion
before startup from first creation. Keep established-open identity explicit;
corrupt-present files and missing current ledger tables fail closed. File
serialization tests do not establish distributed actor revocation. Authentication
and current revocation route through the real authority owner; runtime/source
projection needs its own publication/dedup semantics rather than an implied
atomic outbox.

## Generic conditional source writes

`getSourceSnapshot`, `getSourceGeneration` and `upsertSourceIfCurrent` remain
separate generic source APIs. Generations hash sorted column names and every raw
source value, including original JSON bytes. They are content preconditions,
never timestamps or authority. Capture input before initialization, preserve
expected-null absence, `source-changed` and `pending-local-changes`, mirror refresh,
and initialization retention/failure cleanup. Narrow SQL-writer dependencies
allow writes to a fresh image rather than a cached owner image.

Preserve named `KnowledgeSourceSnapshot`/`KnowledgeSourceWriteResult` exports and
public consumer proofs for these generic types. Native aggregate revisions and
receipts do not silently replace generic conditional writes. Regenerate API
reports from actual composed source instead of copying a historical whole report.
Test the generic source and narrow work-ledger surfaces independently; a generic
SQLite proof does not validate planning-action types or actual product callers.

## Explicit legacy state actions

`getState` returns state, source and optional `{ sourceId, generation }` revision
from one detached persisted-row snapshot; absent source has no revision. Existing
GET/POST output schemas describe the optional revision while state-upsert omits
it. Trusted-admin compatibility does not create a new mutation route or permission.

`applyStateAction` binds explicit approve/answer operations to a selected revision
or one captured current-mode snapshot. Capture input and expectation before the
first await. The final conditional write refuses a changed source as
`state-changed` and matching source with pending local writes as
`pending-local-changes`; neither hold writes source, tasks or work-plan bytes.
`answerQuestion` delegates to guarded current mode while retaining its result and
validation shape. Callers reconcile these holds rather than treating any resolved
promise as success; returned state/evaluation belong to the same action result.
Input mutation cannot retarget the answer/project during initialization. Storage
exceptions still reject.

Selected actions carry the displayed revision through the actual command/SDK
call. A missing selected revision never silently becomes current-mode; explicit
manual commands may choose current mode. Preserve numeric saved selectors and
approval metadata as compatibility data, without using them for native dispatch.
A committed source action followed by task/work-plan synchronization remains
multi-step; a later synchronization failure may follow an accepted write. Re-read
before retrying: this is not an atomic outbox or native replay receipt protocol.

## Native entry and host authority

TUI `/project-plan` and `/planning` enter native work/recovery; `/plan` permission
posture is a separate subsystem. Keep historical list/show and old deep links
read-only where documented. Native project discovery comes from the authenticated
native host binding, not a historical planning-status result. Agent `/work`
inspection and first-class native goal entry remain distinct from importing old
planning records. Active-work briefing/routing consumes native work and execution
receipts while historical source views remain separate.

Model and keyboard entries reach the same actual host gate. Payload `confirm` or
`explicitUserRequest` flags are not authority; a blanket model ban is not a host
capability check. Explicit command parsing is deterministic; free-form intent
belongs to the shared Jev intake owner. Preserve original input/session identity
through the shared dispatch and secondary agent tool/spawn entrances. No renderer
may recreate durable admission from ordinary `runner.start` or bypass it through
a secondary contract-start path. Historical records are never deleted or
reinterpreted simply because local planning storage ceases to own active work.

The host supplies native selected-project/store discovery and a construction-owned
principal with live grant/scope generations. Equal identity/admin/scope strings
after revoke-and-restore cannot prove equal authority. Native intake is idempotent,
with immutable goal/criteria/input, expected ledger revision and request identity,
returning durable work/attempt identity. Product inputs do not supply authoritative
actors or verifier grants.

Recorded Jev evaluation binds the complete captured command/source/action/authority/
scope and authentic call lineage to host-owned context. Structural receipt parsing
or a model flag is not permission. Registered, versioned continuation/condition
owners execute revise or observe defer; rejection performs no action. The single
shared availability-retry owner exposes pending progress and respects cancellation,
revocation and shutdown; retry never repeats external effects. Recheck currentness
at the atomic admission/publication boundary.

Durable runner admission/start/resume is tied to work, criteria revision and
attempt, with real status/history/subscription/cancellation, authentic criterion
evidence and atomic current-target publication. Import admission uses the already
persisted exact command, actual decision provenance and fresh authority on replay.
An unknown request is never re-prepared with a new request ID. Old journals keep
empty provenance rather than fabricated decisions.

Validate actual Agent and TUI entries against the same host-owned admission and
durable runner: permitted work completes unattended; revise/defer/reject executes
only the offered outcome; availability loss stays pending; cancellation/revocation
prevents late effects; edited targets invalidate stale results; restart/replay
causes no duplicate execution. Preserve readable legacy records and protected
provenance throughout. Component storage or protected-read tests alone do not
establish this end-to-end behavior.

## Runner and diagnostic validation

The shared test runner accepts only complete newline-terminated heartbeat records,
published through same-directory atomic rename. Blank, malformed, torn or future
timestamps cannot replace the last real progress or extend the real stall deadline.
A truly wedged child ignoring TERM still reaches KILL and is reaped before the
independent overall ceiling. Keep deadlines and process ownership unchanged.

Startup diagnostics import the onboarding-marker leaf and public SDK recovery
operations without depending on unrelated feature-enablement barrel initialization.
Fatal-output controls must reach the actual reporter, output guard, logger and
legacy/fixed sinks. Activity logs distinguish intercepted legacy output from the
descriptor sink; compiled sink mutation and an earlier initialization exception
must still expose failures on stderr rather than hide them.

Keep isolated guarded engine/product test projects and explicit NodeNext JSON
import attributes. Validate selected/current action races, input mutation,
independent handles/process writers, strict locks, initialization/batch holds,
actual planning/service/routes, public schema/API consumers, product command and
compiled recovery paths, standard native artifact/version smoke and eager
namespace initialization scans. Do not weaken credential scanning or copy historical
commit-specific suppressions; generate fixture lock IDs at runtime. Historical
counts and source-slice accounting remain in the existing Linear owners.

### Focused engine validation

- [knowledge-coordinated-persistence.test.ts](../../packages/engine/test/knowledge-coordinated-persistence.test.ts)
- [knowledge-strict-lock.test.ts](../../packages/engine/test/knowledge-strict-lock.test.ts)
- [legacy-import-read-reconstruction.test.ts](../../packages/engine/test/legacy-import-read-reconstruction.test.ts)
- [legacy-import-recovery-reconstruction.test.ts](../../packages/engine/test/legacy-import-recovery-reconstruction.test.ts)
- [legacy-import-request-binding.test.ts](../../packages/engine/test/legacy-import-request-binding.test.ts)
- [planning-persisted-generation.test.ts](../../packages/engine/test/planning-persisted-generation.test.ts)
- [planning-revision-guards.test.ts](../../packages/engine/test/planning-revision-guards.test.ts)
- [sqlite-publication-durability.test.ts](../../packages/engine/test/sqlite-publication-durability.test.ts)
- [work-ledger-import-transport.test.ts](../../packages/engine/test/work-ledger-import-transport.test.ts)
- [work-ledger-sqlite-process.test.ts](../../packages/engine/test/work-ledger-sqlite-process.test.ts)
- [work-ledger-sqlite.test.ts](../../packages/engine/test/work-ledger-sqlite.test.ts)
- [types/knowledge-source-generation-public.ts](../../packages/engine/test/types/knowledge-source-generation-public.ts)
