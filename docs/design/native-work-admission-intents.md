# Durable cancellation before native admission

The native-work wire distinguishes a real execution association from an admission
intent. An intent stores the complete deterministic host request, immutable
existing work/attempt revisions, captured paired authority and scope facts, a
prospective evaluation generation, and a state. It contains no decision,
execution receipt, contract ID or owner-agent ID.

## Publication and cancellation

Before its first Jev request, start creates generation 1 under the existing paired
owner, workspace scope and KnowledgeStore transaction locks. All locks are
released while Jev performs network work or retry backoff. Every attempt guard
rechecks the original ledger target and the persisted intent generation/state.
A successful recorded act publishes the existing native execution record and an
associated intent atomically. Final runner launch checks that association again
while holding the real owner locks.

Cancellation may arrive even before the start has created an intent. The
identity-only target is checked against the existing active ledger attempt and
its authenticated paired owner; cancellation can then create a cancelled intent
without making a Jev decision or inventing an execution receipt. For an existing
intent/association, cancellation resolves the stored attempt rather than replacing
its original revisions with current edited criteria.

The cancelled intent is persisted first. Locks are then released before local
pending evaluations are aborted and their actual promises are joined. A late
reading from a transport that ignores abort cannot publish or claim the work.
The host retains actual receipt IDs from its validated transaction and local
launch boundary, so a genuine association that won the race is cancelled and
drained too. The daemon supplies that trusted foreground lifetime callback and
fences known admitted turns before awaiting persistence. Cleanup does not depend
on a new protected status read: later authority revocation or an indeterminate
write cannot release the accepted operation's cleanup ownership. Product input
cannot provide a receipt ID or callback. Failed or ambiguous publication never
becomes a successful cancellation response.

An owner store can explicitly reject a request as unavailable while a competing
initial lock is held. This is not cancellation acknowledgement: no tombstone or
successful outcome is implied, and the operator must inspect status or explicitly
retry cancellation.

## Recovery

An interrupted admitting intent is inspection-only. Repeating start does not
restart it. Explicit resume may advance the persisted evaluation generation by
one for the same unchanged target and request, and performs a fresh Jev reading.
Generation is an intent workflow revision, not an authority grant or invented
historical epoch. Late continuations from older generations cannot publish.

A semantic refusal is stored as refused and remains HTTP 422 for start. Status
shows the refused intent; only explicit resume can reconsider the unchanged
request. A cancelled intent never resumes or starts again. Executing later
requires a legitimately new ledger attempt. Work/criteria edits never rewrite an
intent; they make resume stale while status/cancellation remain reachable.

A client disconnect is not authenticated cancellation and does not prove that
the server stopped. When transport cancellation or daemon shutdown interrupts a
local evaluation, it leaves the intent held without inventing a cancellation
tombstone. Existing prepared execution resume and
launch-claimed recovery restrictions remain unchanged. No external effects are
replayed or declared reconciled by this change.

## Wire results

All methods retain the strict identity-only request and existing paired admin,
read:work-ledger and write:fleet requirements. Result schemas are a strict union:

- kind: execution carries the real existing execution projection, including its
  nullable genuine receipt and progress.
- kind: pending-intent carries identity/current-revision fields, state admitting
  or refused, and recovery pending or required. It has no receipt/progress fields.
- kind: prevented-before-admission carries identity/current-revision fields,
  state cancelled and recovery cancelled. It has no receipt/progress fields.

Prevention is reported only when no native execution association was published.
Once association publication wins, cancellation reports the execution branch,
including any real receipt available. A successful HTTP response alone is not a
claim that execution began; clients must inspect the discriminator.

## Storage compatibility

KnowledgeStore schema 4 adds native_work_execution_intents keyed by project and
attempt. Schema-3 execution JSON and its version-1 parser are preserved without
intent backfill. Existing records remain inspectable/cancellable under their
original owner/recovery checks. An associated intent with no execution record
requires recovery; it cannot synthesize a replacement record.

Migration validates existing ledger/execution tables before adding the table.
Missing/corrupt schema-4 intent storage fails closed, and older readers/writers
cannot downgrade or erase the new table. Intent identity is immutable throughout
its lifetime; cancellation is irreversible. The record and intent cancellation
transition are atomic when both exist.

Focused fixtures cover real paired and scope owners, HTTP and WebSocket dispatch,
actual child-process exit with an unassociated intent, stale-generation replies,
shared Jev retry-after backoff, abort-ignoring transport drainage, schema migration
and before/after-publication fault injection. These do not simulate physical
power loss or implement ordinary conversational intake.
