# Native legacy import and recovery (THE-105)

Agent and TUI share the same explicit `/work-import` command and durable journal.
The selected authenticated daemon and its existing KnowledgeStore remain the only
work authority. Import migrates historical data; it neither launches a work
attempt nor verifies an old completion. Legacy records and the planning interview
are retained while the wider native replacement is qualified.

## Command workflow

- `/work-import preview <project-id>` reads complete persisted source preparation.
- `/work-import submit <project-id>` prepares and durably saves one immutable
  command before sending it to the native host's recorded Jev admission owner.
  Repeating submit returns existing state and does not dispatch again.
- `/work-import status <project-id>` reads the protected local journal. It never
  contacts an import mutation or resumes work.
- `/work-import reconsider <project-id> <request-id>` explicitly asks for a fresh
  host reading of a pending unchanged command. Prior decisions remain provenance.
- `/work-import recover <project-id> <request-id>` retransmits an unknown command
  unchanged. The host checks exact durable receipts before source freshness or
  Jev; accepted replay neither reimports records nor starts work.
- `/work-import cancel <project-id> <request-id>` cancels only a known pending
  command. A dispatched unknown request stays unknown; this is not host rollback.
- `/work-import restart <project-id> <request-id>` captures a new command only
  after that exact selected request is definitively rejected or locally cancelled.
  The prior command is archived. Unresolved or accepted requests cannot be replaced.

Agent and TUI use their own exact-host private pairing stores. Unbound
environment and daemon-global tokens are not fallback import credentials.
Reads require current admin, `read:work-ledger` and `read:knowledge`. New import
and recovery additionally require `write:work-ledger-import`, the selected
host's real persisted paired authority generation, and a registered workspace
scope. Shared tokens and user-session credentials cannot become paired authority.
No command creates a credential, changes scopes, or treats `confirm`, historical
approval, or model-supplied actor data as a grant. Both model and keyboard callers
use the same host gate without a semantic human-approval loop.

The host uses the existing shared judgment retry owner. While waiting, the
command reports a pending operation. Session disposal aborts its owned transport;
interrupted dispatched operations remain unknown for explicit recovery. Host
shutdown, cancellation before admission, source changes, scope changes and
credential revocation fence publication. Same-request transport recovery uses
existing ledger idempotency, never a product retry loop or a new request ID.

## Inputs and source fidelity

The fixtures cover persisted `KnowledgeSourceRecord` images produced by
`ProjectPlanningService`, with its `goodvibes-project-planning` connector and
`state`, `work-plan`, `decision`, and `language` artifact kinds. Captures carry
complete-source generations from `KnowledgeStore.getSourceSnapshot`, not an
`updatedAt` approximation. Unknown JSON fields, metadata, source URIs, decisions,
questions and answers are retained in complete source images and source-qualified
fragments. Non-JSON or unsupported records fail explicitly, rather than being
silently normalized or dropped.

A state task and a work-plan task may share an ID but have different fields.
Compatible representations retain both fragments; explicit contradictory titles
or reported statuses require reconciliation. The service also creates derived
`planning-<planningId>-<taskId>` work IDs with `metadata.planningId` and
`metadata.planningTaskId`: both IDs and those relations remain inspectable.
Links outside the captured bundle remain external references, never fabricated
native records. Exact repeated source captures do not duplicate records.

`done` and `completed` are reported completion only. Historical failed work maps
to blocked; original statuses are retained. Original verification prose and
`executionApproved` flags remain historical data, never valid evidence or an
actor capability. A missing acceptance criterion requires review explicitly.

## Replay and interruption

Preparation is deterministic across source object-key/source-list ordering.
Fresh replay must agree on the selected host binding, project, ledger revision,
complete source images and generations. Source changes, missing sources, target
ID collisions and cancellation block preparation. The pure preparation helper
also refuses caller-reported pending local edits. The authenticated gateway
captures persisted images and can preview an earlier version while a host batch
has unsaved edits; it does not currently expose that pending-edit state. Import
admission refuses active batches or dirty local state and revalidates the source
images and generations before publication. Remote pending-edit disclosure remains
follow-on integration work.
Ordinary pending/in-progress work is valid data and is not mistaken for dirty
source state. Preparation owns no write operation, so cancellation never implies
rollback of a command that might already have committed.

Native import history is displayed by both Agent and TUI as an atomic import,
with source IDs, original records, stable work IDs, links and historical status.
TUI exposes preserved records in a read-only Legacy imports tab; existing evidence
views do not treat import events as verification. Complete provenance additionally
requires the host's knowledge-read grant. A limited native reader retains the
actual import event, native work records and cursor, with an explicit protected
provenance message instead of source contents. Full history authorization failure
purges cached rows and reports unavailable. Terminal control characters
are neutralized, and long source records remain scrollable.

## Verification and remaining gates

- Synthetic replay fixtures cover duplicate/conflicting IDs, stale source and
  host bindings, source deletion, cancellation, dirty-source rejection, malformed
  and oversized records, approval/evidence non-authority, and deep detachment.
- A real temporary `ProjectPlanningService` + `KnowledgeStore` fixture creates
  all four artifact kinds, both representations of one work ID, and an automatic
  planning projection. It compares SQLite bytes before/after preparation/replay,
  then rewrites a real source and verifies the old review is rejected.
- Product history tests use actual Agent and TUI models/renderers, including TUI
  keyboard navigation, narrow-width scrolling, close, and subscription cleanup.

For Jev input only, host-generated digest metadata and store-envelope epoch
timestamps use lossless grouped representations so protocol metadata cannot be
misread as payment-card data. Original source metadata and entity fragments still
cross the unchanged privacy boundary; committed manifest bytes are unchanged.

The autonomous host binds the complete manifest, real store and project, exact
request, paired authority generation and workspace registration generation. A
fresh recorded `act` is checked again inside the native ledger transaction.
Non-act decisions do not import anything. A stored or parsed decision never
authorizes a later action; reconsideration makes a fresh recorded reading.

Focused tests exercise actual Agent harness and TUI keyboard/registry routes,
synthetic owned HTTP hosts, SQLite journal reopen, lost acknowledgement and exact
replay, repeated submit, stale request selection, source/revision conflicts,
revocation during shared retry, closed service, and interrupted transports.
Compiled command fixtures exercise the real command/SDK/journal composition in
new processes; they are not a claim that all main-screen planning replacement is
finished. Independent review, exact-head CI, product tests and compiled startup
qualification remain release gates. The active planning interview is retired
only after the broader replacement and recovery behavior is proven.
