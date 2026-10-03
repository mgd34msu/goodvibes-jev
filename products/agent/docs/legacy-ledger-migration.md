# Legacy ledger preparation and replay (THE-105)

This product slice consumes the canonical engine legacy-import preparation API.
It does not discover a local database, submit an import, run a verifier, replace
pending editor contents, delete legacy records, or retire the planning interview.
The selected authenticated daemon and its existing KnowledgeStore remain the
only authority. A prepared manifest is not an import receipt.

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
ID collisions, cancellation and unsaved host-side source edits block preparation.
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

A user-facing import submission/recovery flow still needs the authenticated host
prepare/execute contract, review of the complete bounded command, stable request
identity across indeterminate outcomes, same-request receipt reconciliation,
closed/revoked/conflicting-state handling, and real product recovery tests. No
planning-interview retirement is authorized by these preparation/history tests.
Full engine integration, independent review, exact-head CI and compiled startup
qualification are required before this can be called a completed migration.
