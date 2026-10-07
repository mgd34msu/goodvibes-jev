# Native question acceptance foundation

## Capability limit

This is an inert, host-only storage and input-acceptance foundation. No product
creates native questions, no gateway verb exposes replies, and no runner consumes
answers. An `answered` record means durable input acceptance only. It does not
mean that execution resumed, that criteria passed, or that an owner granted new
authority. Native `runner.reply` continues to reject owner approval replies.

The source baseline is main `ada8e3a677bb32a68a44c6285aab5e7b764a382e`, tree
`b12152e2950ccd730fb129bba1e48f0033f5964d`.

## Identity and authority

Each immutable question binds the project, work and attempt IDs, exact work,
criteria and attempt revisions, question ID/revision, question text and checkpoint
ID. Its host-only admission binding contains the existing contract ID, owner-agent
ID, payload revision and hashed paired-owner/workspace bindings. A model-written
label, legacy reply, external review, or proposed owner ID cannot supply this
association. Storage validates it against the actual persisted native execution
receipt in the same database image.

The reply wire shape contains only that public identity, a stable request ID and
the exact answer. Extra fields, malformed identities, unsupported shapes and
oversize input are refused. The answer is retained without normalization and its
digest binds the complete reply. Original source goal and ordered criteria are
never edited by this protocol.

The nonserialized host authority must still be the admitted paired-token owner
with current scopes and workspace registration. A first acceptance also requires
the original active attempt and exact current ledger revisions. Cancelled work,
replaced attempts, changed criteria and revoked owners cannot accept fresh input.
An exact already-accepted retry can return the same historical receipt after work
has advanced, but still requires the current admitted owner and workspace binding.

## Durable state and replay

KnowledgeStore schema 8 adds `native_work_questions` to its existing coordinated
SQLite image. Opening a store automatically performs the inert schema migration;
opening its question capability is host-only and installs no product behavior.
Questions and answers do not occupy a separate sidecar database.

The only transitions in this slice are `open -> answered`, `open -> cancelled`
and `open -> superseded`. Answered and closed records cannot be reopened or edited.
An accepted answer includes its stable request ID, text and digest in the same row
as the question. Request IDs are unique within the project. Reusing one for a
different question or payload conflicts. An exact duplicate returns the original
record without mutating it. Status is read-only.

Acceptance validates against a fresh persisted image while holding the existing
file ownership lock, then commits question and answer together. Its authority
and scope leases surround the operation. It never calls a runner, provider, tool,
start, resume or continuation callback. A lost acknowledgement is an unknown
delivery result; retry the exact request. Unchanged replay uses the existing
`confirmDurable` path before acknowledging, whereas status alone is an observation,
not a durability-confirmation operation.

Before-rename failures leave the old image intact. After-rename durability errors
may leave the complete new receipt visible; they must not trigger restoration of
older bytes. The caller reconciles/replays the exact request. Schema migration
validates prior authorities and refuses unexpected pre-v8 question tables. Current
schema validation refuses missing/malformed tables, indexes, rows and associations
before any base-schema repair. Existing authority JSON is not rewritten.

Pending local database changes prevent guarded publication. Closing the store
drains admitted question operations, and a closed capability rejects new calls.
Migration snapshot files are recovery copies, not independently proven fsynced
backups. A completely deleted database is still indistinguishable from first
creation to a fresh owner; this foundation does not solve that existing limitation.

## Required later work, deliberately unresolved

A native question producer must prove an actual paused checkpoint within the
already-admitted attempt, persist that checkpoint, then register the immutable
question. The current trusted storage seam is not that producer. Registration
must supersede older open revisions explicitly and cannot convert historical
escalations into native authority.

A future question-specific consumer needs a durable answer-consumption marker in
the runner checkpoint and an exact linkage to the immutable acceptance receipt.
Question storage and runner checkpoints occupy different persistence domains.
Therefore acceptance alone cannot prove exactly-once continuation. Before any
implementation enables continuation, specify and test its claim/consumption
handshake, authority rechecks, cancellation races and restart reconciliation. If
dispatch may have occurred and consumption cannot be established, fail closed
with recovery required rather than injecting the answer again. Generic `start`
or `resume` must not be used as a lost-acknowledgement fallback.

Only after that contract is reviewed should a gateway/client or product surface
show native questions or a continuation action. Evaluator, settlement and
historical TUI reply semantics are outside this change.
