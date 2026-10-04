# Native work settlement

Native execution and verified completion have different lifetimes. A passed
runner is necessary, but it cannot establish ledger verification. The native
host owns a separate non-executing settlement lifetime after runner and any
foreground turn have drained.

## Ownership and proof

`NativeWorkExecutionHost.settle(key, authority)` captures current paired identity,
scopes and registered workspace generation. It can reconstruct this bounded
verification ownership after restart without reconstructing permission to
resume an execution. It never calls runner start, resume, tools or a planner. The real runner exposes
read-only `inspectDurable` for its typed receipt/checkpoint envelope and
`joinDurable` to confirm drainage under the existing execution lease. A live
foreign execution lease fails closed; a terminal status alone is insufficient.
Ordinary status reads never schedule settlement. The daemon schedules settlement
from successful start/resume receipt retention; cancellation and shutdown fence
and drain admitted verification, including both concurrently issued judgment
requests and an abort-ignoring late response.

The verifier detaches the strict native record before its first borrowed hook or
await. The real `DurableContractReceipt`, request payload, checkpoint owner,
session, native source and resolved placement must agree. The complete original
goal and every ordered criterion come from `request.input.nativeSource`, never a
plan or completion report. Original source is included structurally in both
recorded unit-judge and independent quality calls. The host uses the existing
shared transport and its before-attempt guard; settlement introduces no retry
loop or terminal-runner execution exception.

The native checkpoint must contain genuine recorded passing unit and deliverable
checks. Stored prior readings must agree with the recorded raw passing answers
and criterion text; declared pass flags cannot substitute for them. Settlement then runs a fresh criterion/quality battery against authorized
bounded host-read artifacts and final output. Recorded decision IDs must match
the actual request's site, state hash, question digest and raw answers. Both
request images and returned answers are detached and frozen before borrowed
hooks or later microtasks can change what the batteries interpret. Every criterion gets
content-identified decision/check/execution/receipt/artifact references. Missing,
changed or unrecorded proof cannot become verified.

Terminal worktree application may evict the execution tree. A successful
application/commit is checked before owner-tree files are captured. Failed
application/commit is unavailable; a skipped application with changed paths is
also unavailable. Output-only work can be checked without an artifact. Artifact
paths must be contained regular files without linked parents or symlink leaves,
under the original read-access filter. Captures have per-file, total and reference
bounds, measured in raw bytes even for binary files. Deletions can be captured
when parent directories are gone, while linked parents still fail closed. Changed bytes, authority, scope, target or contract identity invalidate
checking or final publication.

## Atomic settlement and recovery

The separate `native_work_execution_settlements` v1 table preserves the exact
nine-field native execution record and existing intent formats. Its receipt binds
request payload, real runner receipt, original target, contract/publication
digests, adjacent ordinary report/evidence events and the post-report target.

The existing KnowledgeStore SQLite owner performs one `transactPersisted`
operation. It validates the current execution, intent and complete ordinary
ledger history, applies the ordinary report and evidence reducers in memory,
validates the resulting history and receipt, and publishes both ledger changes
and settlement row as one image. There are no sequential ledger service calls.
The report describes the runner's reported completion; the separate evidence can
still say verification failed. Missing/unavailable proof publishes neither.

Exact receipt reconciliation reconfirms durability and returns the original
IDs without another semantic read or effect. A failure before publication leaves
neither event. A lost acknowledgement after rename can be reconciled after
reopening. Conflicting publication content refuses. Independent database owners
serialize publication; paired-owner contention retains its existing explicit
`PAIRING_TOKEN_STORE_BUSY` failure, with an exact settlement retry after drainage.
Later work revisions do not change the historic receipt or silently retarget it.

Conversation intake retains its DB5 -> DB6 migration. Settlement migrates
DB6 -> DB7 after validating the existing conversation capture table, history
and native authority rows. Fresh DB7 stores create and validate both conversation
capture and settlement tables. Old writers refuse newer versions; migration
never repairs missing authority tables into an empty history.

## Product observation and limits

The credential-free execution snapshot optionally exposes settlement state
(`pending`, `required`, `failed`, `published`) and evidence/event identifiers.
Agent and TUI show publication separately from runtime progress. Their ordinary
ledger subscriptions observe the actual atomic report/evidence revision.
Failed in-process settlement is inspectable; after restart an unpublished
settlement is reachable through authenticated explicit `workLedger.execution.resume`
(`/work resume <workId>` in Agent or the TUI resume/reconcile control). For a
passed terminal execution this action only calls host settlement; a published
receipt only reconciles its original publication. Product controls first read
status on the selected current attempt and retain the original admitted revisions
for this exact recovery, even if publication already completed the ledger before
its acknowledgment was lost. Cancelled executions remain cancelled and failed
terminal runs cannot restart. Status and ledger GETs never schedule verification
or execution. No new credential, grant or endpoint is introduced.

This is the successor implementation of PR102's original-source verification
and atomic publication capability. It does not import the old parallel execution
journal, raw JSON receipt seam or obsolete state validator. Local implementation
and test results do not constitute independent review of the combined native
engine stack, public delivery, a release, or permission to merge or close PR102.
