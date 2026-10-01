/**
 * contract-bridge-types.ts, contract-typed bridges for the operator method families the
 * webui facade calls (fleet.*, checkpoints.*, sessions.search).
 *
 * As of the SDK 1.0.0 pin-bump (see CHANGELOG.md), the SDK's generated
 * `OperatorMethodInputMap`/`OperatorMethodOutputMap` (foundation-client-types.ts)
 * carry real entries for every id below, so each bridge type now flows straight from
 * `OperatorMethodInput<M>`/`OperatorMethodOutput<M>`. This is the `// SWAP:` seam the
 * pre-1.0.0 header described, now applied: the hand-authored interfaces that stood in for
 * the missing generic-map entries at 0.38 are gone, replaced one-for-one by the generated
 * contract types they mirrored.
 *
 * goodvibes.ts imports these names ONLY from this module (never redefines them), so the
 * facade's exported names (FleetProcessNode, WorkspaceCheckpoint, ...) do not change,
 * only their definition now derives from the SDK contract. The item-level aliases
 * (FleetProcessNode = FleetSnapshotResult['nodes'][number], etc.) keep every existing
 * consumer import compiling unchanged.
 *
 * `bridge-matches-schema` in goodvibes.test.ts pins these shapes against the installed
 * SDK's `operator-contract.json` artifact, so any future drift (including a later pin
 * bump silently changing a shape) fails the test immediately.
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';

/** Method ids this module provides a contract-typed bridge for (see file header). */
export const BRIDGE_TYPED_METHOD_IDS = [
  'fleet.snapshot',
  'fleet.list',
  'fleet.archive',
  'fleet.unarchive',
  'fleet.archiveFinished',
  'fleet.archived.list',
  'checkpoints.list',
  'checkpoints.create',
  'checkpoints.diff',
  'checkpoints.restore',
  'checkpoints.restorePreview',
  'checkpoints.revertHunkPreview',
  'checkpoints.revertHunk',
  'rewind.plan',
  'rewind.apply',
  'fleet.attempts.list',
  'fleet.attempts.pick',
  'fleet.attempts.judge',
  'fleet.observed.steer',
  'sessions.search',
  'sessions.detach',
  'sessions.changes.get',
  'cost.attribution.get',
  'sessions.hosted.list',
  'sessions.hosted.create',
  'sessions.hosted.attach',
  'sessions.hosted.detach',
  'sessions.hosted.kill',
] as const;

// ─── Fleet (fleet.*) ─────────────────────────────────────────────────────────
// SWAP applied: fleet.snapshot/fleet.list now carry real OperatorMethodInputMap/OutputMap
// entries, so these flow straight from the generated contract. FleetProcessNode is the
// shared node shape, derived from the snapshot output for readability.
export type FleetSnapshotResult = OperatorMethodOutput<'fleet.snapshot'>;
export type FleetListInput = OperatorMethodInput<'fleet.list'>;
export type FleetListResult = OperatorMethodOutput<'fleet.list'>;
export type FleetProcessNode = FleetSnapshotResult['nodes'][number];
// Fleet archive (SDK 1.6.0): move finished subtrees out of the live fleet
// view into the session archive and back; list what is archived.
export type FleetArchiveInput = OperatorMethodInput<'fleet.archive'>;
export type FleetArchiveResult = OperatorMethodOutput<'fleet.archive'>;
export type FleetUnarchiveResult = OperatorMethodOutput<'fleet.unarchive'>;
export type FleetArchiveFinishedResult = OperatorMethodOutput<'fleet.archiveFinished'>;
export type FleetArchivedListResult = OperatorMethodOutput<'fleet.archived.list'>;

// ─── Checkpoints (checkpoints.*) ──────────────────────────────────────────────
// SWAP applied: checkpoints.list/create/diff/restore now carry real map entries.
// WorkspaceCheckpoint is derived from the list output's item shape.
export type CheckpointsListInput = OperatorMethodInput<'checkpoints.list'>;
export type CheckpointsListResult = OperatorMethodOutput<'checkpoints.list'>;
export type CheckpointsCreateInput = OperatorMethodInput<'checkpoints.create'>;
export type CheckpointsCreateResult = OperatorMethodOutput<'checkpoints.create'>;
export type CheckpointsDiffInput = OperatorMethodInput<'checkpoints.diff'>;
export type CheckpointsDiffResult = OperatorMethodOutput<'checkpoints.diff'>;
export type CheckpointsRestoreInput = OperatorMethodInput<'checkpoints.restore'>;
export type CheckpointsRestoreResult = OperatorMethodOutput<'checkpoints.restore'>;
// checkpoints.restorePreview (SDK 1.6.1): non-destructive preview of what a
// restore would change, plus a short-lived single-use confirmToken the restore
// call passes back instead of a blind confirm:true.
export type CheckpointsRestorePreviewInput = OperatorMethodInput<'checkpoints.restorePreview'>;
export type CheckpointsRestorePreviewResult = OperatorMethodOutput<'checkpoints.restorePreview'>;
export type WorkspaceCheckpoint = CheckpointsListResult['checkpoints'][number];

// checkpoints.revertHunkPreview / checkpoints.revertHunk (SDK 1.6.1's per-hunk
// reverse-apply): the review-cockpit's REJECT→REVERT flow. revertHunkPreview is read-only
// (validates the hunk still reverse-applies, mints a ~2min single-use confirmToken, or
// answers applies:false with a human conflict string and a null token); revertHunk consumes
// the token to snapshot-then-reverse-apply exactly that one hunk, returning a receipt whose
// `undo` block carries the pre-revert safety checkpoint id. A stale hunk is an honest 409
// CONFLICT (lib/errors.ts isConflictError), never a partial write.
export type CheckpointsRevertHunkPreviewInput = OperatorMethodInput<'checkpoints.revertHunkPreview'>;
export type CheckpointsRevertHunkPreviewResult = OperatorMethodOutput<'checkpoints.revertHunkPreview'>;
export type CheckpointsRevertHunkInput = OperatorMethodInput<'checkpoints.revertHunk'>;
export type CheckpointsRevertHunkResult = OperatorMethodOutput<'checkpoints.revertHunk'>;

// ─── Rewind (rewind.plan / rewind.apply) ──────────────────────────────────────
// SDK 1.6.1's unified message-anchored rewind: a terraform-style dry-run/apply pair over
// the platform's history stores. plan is read-only (previews what restoring files and/or
// conversation to a turn anchor would change, mints a single-use confirmToken); apply
// consumes it, records an undo point (a pre-restore safety checkpoint and/or a captured
// conversation snapshot) so the rewind is itself reversible, and emits REWIND_APPLIED.
// `transport: ["ws"]` only, generic-invoke-only, routed through invokeGatewayMethod.
export type RewindPlanInput = OperatorMethodInput<'rewind.plan'>;
export type RewindPlanResult = OperatorMethodOutput<'rewind.plan'>;
export type RewindApplyInput = OperatorMethodInput<'rewind.apply'>;
export type RewindApplyResult = OperatorMethodOutput<'rewind.apply'>;

// ─── Best-of-N attempts (fleet.attempts.list / pick / judge) ──────────────────
// SDK 1.6.1's best-of-N sibling-attempt resolution over held-merge candidate groups.
// list is read-only (held groups with per-candidate diffs + any prior judge proposal);
// judge PROPOSES a winner with reasons, explicitly model judgment (scoredBy:'model'), never
// an auto-pick; pick accepts one candidate as the winner (merging it, cleaning losers) and
// is a 409 CONFLICT for an unknown/not-ready group. `transport: ["ws"]` only, generic-
// invoke-only, routed through invokeGatewayMethod.
export type FleetAttemptsListInput = OperatorMethodInput<'fleet.attempts.list'>;
export type FleetAttemptsListResult = OperatorMethodOutput<'fleet.attempts.list'>;
export type FleetAttemptGroup = FleetAttemptsListResult['groups'][number];
export type FleetAttemptCandidate = FleetAttemptGroup['candidates'][number];
export type FleetAttemptJudgment = NonNullable<FleetAttemptGroup['judgment']>;
export type FleetAttemptsPickInput = OperatorMethodInput<'fleet.attempts.pick'>;
export type FleetAttemptsPickResult = OperatorMethodOutput<'fleet.attempts.pick'>;
export type FleetAttemptsJudgeInput = OperatorMethodInput<'fleet.attempts.judge'>;
export type FleetAttemptsJudgeResult = OperatorMethodOutput<'fleet.attempts.judge'>;

// ─── Observed foreign agents (fleet.observed.steer) ───────────────────────────
// SDK 1.8.0's read-only visibility of externally-launched coding-agent sessions
// (an `observed-external` fleet.snapshot node, see the ProcessObserved fields on
// FleetProcessNode). Steer is the ONE verb offered, and only via the row's
// drill-in detail (steerDrillInOnly:true, an owner-ruled UX weight), never a
// primary/bulk affordance, and never stop (observing is not owning the
// lifecycle). `id` addresses the observed node itself (not a sessionId, these
// rows carry no sessionRef). `transport: ["ws"]` only, generic-invoke-only,
// same family as fleet.attempts.* above.
export type FleetObservedSteerInput = OperatorMethodInput<'fleet.observed.steer'>;
export type FleetObservedSteerResult = OperatorMethodOutput<'fleet.observed.steer'>;

// ─── Sessions search (sessions.search) ────────────────────────────────────────
// SWAP applied: sessions.search now carries a real map entry.
export type SessionsSearchInput = OperatorMethodInput<'sessions.search'>;
export type SessionsSearchResult = OperatorMethodOutput<'sessions.search'>;
export type SessionsSearchSessionSummary = SessionsSearchResult['sessions'][number];

// ─── Sessions detach (sessions.detach) ────────────────────────────────────────
// SWAP applied (1.21.0 pin): sessions.detach now carries a real
// OperatorMethodInputMap/OutputMap entry, so this flows straight from the generated
// contract the same way fleet.*/checkpoints.*/sessions.search do above. SessionParticipant
// is the item alias for the result's own participants array, matching this file's
// existing item-level-alias convention (FleetProcessNode, WorkspaceCheckpoint, ...).
export type SessionsDetachInput = OperatorMethodInput<'sessions.detach'>;
export type SessionsDetachResult = OperatorMethodOutput<'sessions.detach'>;
export type SessionParticipant = SessionsDetachResult['session']['participants'][number];

// ─── Session workspace changes (sessions.changes.get) ─────────────────────────
// SWAP applied from day one: sessions.changes.get shipped with a real
// OperatorMethodInputMap/OutputMap entry (SDK 1.6.1's session-changes repack).
// `transport: ["ws"]` only, no `http` route, same generic-invoke-only shape as
// checkpoints.*/sessions.search, routed through invokeGatewayMethod in goodvibes.ts's
// sdk.operator.sessions.changes.get.
export type SessionsChangesGetInput = OperatorMethodInput<'sessions.changes.get'>;
export type SessionsChangesGetResult = OperatorMethodOutput<'sessions.changes.get'>;

// ─── Cost attribution (cost.attribution.get) ───────────────────────────────────
// SDK 1.6.1: windowed (24h/7d), cache-aware-priced cost attribution grouped by a
// dimension (agent/tool/hook/mcp/model/provider/session). Real generated I/O map entry,
// `transport: ["ws"]` only, same generic-invoke-only shape as sessions.changes.get
// above, routed through invokeGatewayMethod. Honest-unpriced: a row's costUsd is `null`
// when nothing in it could be priced (an unrecognized model), costState says whether the
// figure is priced/estimated/unpriced, callers must render that state, never treat a
// null cost as zero.
export type CostAttributionGetInput = OperatorMethodInput<'cost.attribution.get'>;
export type CostAttributionGetResult = OperatorMethodOutput<'cost.attribution.get'>;
export type CostAttributionRow = CostAttributionGetResult['rows'][number];

// ─── Hosted sessions (sessions.hosted.*) ───────────────────────────────────────
// SWAP applied (2.0.0 pin): sessions.hosted.list/create/attach/detach/kill now carry
// real OperatorMethodInputMap/OutputMap entries (verified against the installed
// @goodvibes-jev/engine/contracts's operator-method-ids.ts and operator-contract.json, the
// `sessions.hosted.` ids appear in both), so these flow straight from the generated
// contract the same way sessions.detach's own SWAP applied above. HostedSessionRecord
// and HostedSessionHistoryMessage are item-level aliases (this file's existing
// convention) derived from the list/attach outputs rather than redeclared by hand.
// goodvibes.ts now calls these through invokeGatewayMethod like every other family in
// this file, invokeGatewayMethodUncheckedInput (its pre-SWAP escape hatch) is gone.
//
// Deliberately NOT bridged here: a hosted-specific steer/cancel verb. There is none,
// see the SDK's method-catalog-hosted-sessions.ts header comment. A hosted session is
// steered with the ORDINARY sessions.steer/followUp/toolCalls.cancel, which resolve a
// hosted id the same way they resolve any other session.
export type SessionsHostedListInput = OperatorMethodInput<'sessions.hosted.list'>;
export type SessionsHostedListResult = OperatorMethodOutput<'sessions.hosted.list'>;
/** The record every hosted-session verb returns, one row of sessions.hosted.list. */
export type HostedSessionRecord = SessionsHostedListResult['sessions'][number];
export type SessionsHostedCreateInput = OperatorMethodInput<'sessions.hosted.create'>;
export type SessionsHostedCreateResult = OperatorMethodOutput<'sessions.hosted.create'>;
export type SessionsHostedAttachInput = OperatorMethodInput<'sessions.hosted.attach'>;
export type SessionsHostedAttachResult = OperatorMethodOutput<'sessions.hosted.attach'>;
/** One message of a hosted session's history, as attach hands it back. */
export type HostedSessionHistoryMessage = SessionsHostedAttachResult['history'][number];
export type SessionsHostedDetachInput = OperatorMethodInput<'sessions.hosted.detach'>;
export type SessionsHostedDetachResult = OperatorMethodOutput<'sessions.hosted.detach'>;
export type SessionsHostedKillInput = OperatorMethodInput<'sessions.hosted.kill'>;
export type SessionsHostedKillResult = OperatorMethodOutput<'sessions.hosted.kill'>;
