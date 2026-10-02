# Native work ledger foundation (THE-104)

This is an additive, provisional engine seam. It does not wire a runner, create
another executor, persist a second database, or replace the old planning UX.
THE-104 remains open until production persistence, runner and product integration
are exercised end to end. Import the local `index.ts`; it is not yet exported by
the published SDK root or declared as a package subpath.

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
