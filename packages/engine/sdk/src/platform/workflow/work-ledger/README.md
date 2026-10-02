# Native work ledger foundation (THE-104)

This is an additive, provisional engine seam. It does not wire a runner, create
another executor, persist a second database, or replace the old planning UX.
THE-104 remains open until production persistence, runner and product integration
are exercised end to end. Import the supported narrow
`@goodvibes-jev/engine/sdk/platform/workflow/work-ledger` subpath. The SDK root
and broad workflow barrel deliberately do not re-export this authority seam.

## Trusted composition and consumers

`createWorkLedger({ projectId, storage, clock })` returns `{ service, authority }`.
Keep `authority` in the trusted host. It mints opaque instance-local actor handles
from authenticated `{actorId, projectId, role}` and can revoke them. Structural
copies, persisted handles, and handles from other instances fail authentication.
Restarting restores records, never identities or approval grants. This guarantee
is local to the authority owner's event loop; distributed hosts need routing to
that owner or durable authorization epochs at publication.

The consumer surface is:

- `readSnapshot(actor): Promise<WorkLedgerSnapshot>`
- `history(afterSequence, actor): Promise<readonly WorkLedgerEvent[]>`
- `subscribe(actor, listener): () => void`
- `execute(command, actor, {signal}?): Promise<WorkLedgerResult>`
- `close(): Promise<void>`

`readSnapshot`/`history` reject `WorkLedgerAccessError` with codes `closed`,
`forbidden`, `invalid_cursor` (history only), `invalid_state`, or `storage_error`.
Subscribe admission can throw `closed`/`forbidden`; storage subscription errors
propagate. A callback must be short and nonblocking. Promise-returning observers
are never awaited, and thrown/rejected observers cannot change write receipts or
strand `close`. Notifications are best-effort detached snapshots, not a reliable
transport. Subscribe first, then read snapshot and catch up with history(cursor);
ignore cursors already seen. On reconnect, catch up again from durable history.
Unsubscribe is idempotent; revocation and close detach owned subscriptions.

Admission ownership is reserved before entering adapters, command getters or
other host hooks. A synchronous reentrant `close()` cannot miss the operation
that invoked it. Subscription cleanup ownership is also installed before the
adapter runs; failed admission silences queued notifications and late-returned
cleanup executes exactly once. The close promise is published before cleanup
hooks, so reentrant and repeated closes share one drain.

`close` stops new admissions and notifications, then drains all already admitted
reads and commands. Already admitted writes can commit. Reads still in flight
reject `closed` after their underlying read finishes. Hosts must bound storage
I/O themselves; this module does not pretend a stuck store has drained.

## Revision and receipt semantics

Every command has `requestId` and `expectedRevision`. The latter is the global
project-ledger revision (including create and record_evidence), not the work's
revision. Each accepted non-replay advances it once. Rejected commands do not
consume request IDs or advance state. Exact replay is scoped by authenticated
actor ID + request ID + canonical schema-normalized command + role and returns
the original event, even after the expected revision is old or an abort follows.
Changed request content returns `request_conflict`. Authenticate before replay.
New IDs come from the trusted host, never prose. Ownership transfers create new
attempt IDs linked to predecessors. Claims and reports cannot take over another
owner's attempt. Coordinator transitions are explicit.

Execute returns one of:

- `accepted`: `{replayed, event}`. The event is a durable receipt.
- `rejected`: `{code, reason, revision}`. No state change. Codes include conflict,
  stale_evidence, forbidden, cancelled, invalid_command, invalid_transition,
  not_found, request_conflict, closed, invalid_state and host_error.
- `indeterminate`: `{requestId, actorId, reason}`. Store I/O did not establish a
  durable outcome. Reconcile using an exact retry with the same request ID and
  command. Do not invent a new request ID or tell the caller it was cancelled.

The storage adapter owns one serialized transaction across **all** writers. It
loads fresh state under its lock, calls the synchronous decision once, rejects
async decisions, and accepts publication without any intervening await or hook.
Keep the lock through persistence. The callback is an admission/commit decision,
not by itself a durability claim. Resolve only after persistence succeeds;
postcommit cache, observer, cleanup and notification errors must not change the
receipt. If persistence is uncertain, throw so the service returns indeterminate.
Read/rename alone and a stale sql.js image do not implement this contract.

Actor revocation, AbortSignal, state revision and evidence currentness are checked
inside the transaction; the final actor/abort guard follows clock/ID hooks and
next-state validation. Abort/revoke after publication acceptance does not undo
that transaction. Only its durable/indeterminate result describes the outcome.
No cancellation command is allowed to bypass the host runner's cancellation or
approval boundaries. Ledger actions are record edits, never grants to execute.

## Reported state and verification

A complete report remains **unverified** until a trusted verifier records current
evidence. Evidence targets `{workId, workRevision, criteriaRevision, attemptId,
attemptRevision}`. Edits invalidate previous verdicts; stale async targets cannot
apply. Evidence acceptance advances the ledger revision only, avoiding instantly
invalidating itself. The verification states are unverified, verified, failed,
unavailable and stale. There is no fallback promotion when evidence is absent.

`record_evidence` additionally takes `outcome`, `reason`, `references`, `source`
(`host_check` or `judgment`), and `criteriaResults`. Each result has
`criterionIndex`, `status` (satisfied/unsatisfied/unknown), and reference strings
that match unique supplied reference `ref`s. A verified verdict requires
host_check, exactly every criterion satisfied, and content-identified references
(with digests) for every criterion. Judgment-only, incomplete or URI-only claims
cannot become verified. Failed/unavailable evidence can carry partial checks.

The core validates the shape and revision binding of an attestation; it cannot
prove a tool ran or that a digest is true. The authenticated verifier adapter
must obtain genuine runner/check results and validate content identities before
issuing that attestation. Never expose the verifier handle or authority to model
payloads as an approval bypass. Host integration and end-to-end execution proof
are still pending, rather than implied by these focused tests.

The store must preserve history and receipts atomically. Reads fail closed on
invalid state/receipt/event relationships; they never reset corrupt state. This
foundation does not silently prune history, receipts, evidence or live work.
A production retention/migration policy is separate integration work.


## Production persistence and shutdown

The regular KnowledgeStore owns the only database. Trusted composition calls
`await knowledgeStore.openWorkLedgerStorage(projectId)` then supplies that
storage to `createWorkLedger`. The daemon runtime composes one native authority
owner and exposes only its service. Independent processes may coordinate file
writes, but authentication and revocation remain routed through the authority
owner; this does not implement distributed revocation epochs.

Schema v2 adds only `work_ledgers(project_id, format_version, revision,
state_json)`. Each project row contains its state, immutable history and exact
request receipts in one atomic SQLite image. Legacy source metadata remains
unchanged and is never converted into authority or verification. Old binaries
refuse schema v2. No automatic WorkPlanStore import or duplicate editable mirror
is created.

All KnowledgeStore initialization, ordinary saves, batches and ledger writes
share the canonical database `.knowledge-lock`. The existing pending save queue
runs in admission order. A ledger transaction blocked by unsaved local changes
or an active batch fails admission before invoking its decision callback; dirty
local edits are never discarded. Stale ordinary saves fail instead of replacing
newer ledger state. Coordination is for cooperating processes on one local host
and PID namespace, not rogue writers or distributed filesystems. Hardlinked
file aliases and malformed/live strict lock ownership are refused.

Publication writes a same-directory temporary file, fsyncs it, renames it, then
fsyncs the parent directory. Newly created directory ancestry is synchronized.
Failure before rename leaves the old file; failure after rename and before
parent sync is indeterminate and never restores old bytes. Exact no-op retries
read authoritative disk and synchronize both the observed file and its parent
before returning a durable receipt. Cleanup and observer failures after durable
publication cannot turn success into rollback; failed mirror refresh fences
ordinary cache operations. Corrupt or truncated existing images and missing
current-version ledger tables are refused before schema repair or ordinary saves.
An owner that has observed its database also refuses subsequent disappearance.
IMPORTANT: a newly constructed owner has no external existence manifest. If the
entire database was deleted before process startup, this owner cannot distinguish
that loss from first creation and may initialize a new store. This slice does not
claim cross-restart deletion detection; hosts need independent established-store
knowledge to enforce an explicit open-existing policy in a follow-on contract.

Notifications use local wakeups and an owned, unreferenced polling fallback for
cross-process changes. They may coalesce; snapshots and history cursors are the
catch-up authority, not notification counts. Storage close removes observers and
drains admitted work. Backing-store close also drains active ordinary batches
and their deferred saves. Native runtime close immediately fences service admission,
then awaits ledger/storage shutdown before its backing KnowledgeStore closes.

This slice does not launch agents, grant cancellation/execution approval, or
execute verifiers. Future runtime/source projection needs an atomic outbox and
downstream deduplication; a postcommit observer is not an outbox. Process-kill
checks establish old-or-new whole-file recovery only, not power-loss durability.

## Service graph versus process host

The durable adapter and daemon service-graph composition build directly on the
merged native core. They do not depend on the separate owned daemon process-host
change (PR71), and this slice does not introduce its listener/signal lifecycle
files or facade restart fence. The drain contract here is exercised through
`RuntimeServices.close()` and the existing acquisition/disposal scopes. A process
host must await that close before process teardown. Combined process-host proofs
are separate evidence and are not claimed as main-only integration acceptance.
