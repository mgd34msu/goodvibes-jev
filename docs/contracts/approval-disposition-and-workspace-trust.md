# Approval disposition and workspace trust

Recorded approval provenance and ordinary awaited prompt results have distinct authority. Legacy booleans must not become permanent workspace choices. Validation uses owned temporary roots and never inspects or changes an operator's trust records.

## Result and record boundary

A legacy true/false result, amendment, cancellation, expiry or remembered outcome cannot by itself settle persistent workspace trust.

`PermissionPromptDecision` is unchanged. `RaisedApproval.decision` and
`ApprovalBroker.requestApproval` still return the exact ordinary prompt shape,
including existing remember, reason and modified-argument fields.

`SharedApprovalRecord.decision` instead uses `SharedApprovalDecision`, with an
optional closed `disposition`: approved, denied, amended, cancelled, expired or
remembered. There is no duplicate top-level marker. The broker strips this field
from pending-promise results. Legacy markerless records remain readable.

The explicit resolution input accepts only approved/denied/amended and checks
agreement with the boolean before mutation. An amendment cannot request any
remember tier or remember:true. Cancellation, expiry and remembered-rule sweeps
stamp their own recorded kinds. Invalid persisted marker/status/boolean
combinations are refused rather than normalized into authority.

## Current-record trust decision

The engine's public runtime operations export `createWorkspaceTrustDecisionAsk` from `runtime/workspace-trust-approval.ts`. It accepts a narrow broker port with `raiseApproval` and `getApproval`, the working directory and an optional timeout. It awaits the ordinary result, then reads the current record rather than the pending snapshot returned when the approval was raised. Approval ID, call ID, creation time, request call ID, request kind/category and exact workspace scope must match. Only explicit approved/true/approved-status or denied/false/denied-status terminal records return a persistent trusted or restricted choice. Every other outcome refuses this attempt while leaving trust undecided. Reason text is never provenance. Existing persisted trust choices remain honored; historical provenance cannot safely be invented to rewrite operator state.

## Producer boundary

Generic local prompt and embed callbacks produce ordinary booleans and remain
markerless. The generic client approval raiser chooses an approve/deny operation from
that boolean, so an operation name or HTTP URL alone is NOT evidence of an explicit trust choice.
HTTP markers are optional, checked against the action, and absent stays absent.
Known interactive button and explicit operator/transport operations supply their
own marker. The channel-reply producer maps settled approve/reject/amend readings
to approved/denied/amended through the actual broker input. Amendments preserve
the owner's full guidance while refusing the original proposal, without creating
a remembered rule. The ordinary awaited decision remains markerless.

The shared-record output schema and approve/deny input schemas carry the optional disposition. Ordinary prompt schema/results do not. Operator contracts, consumer types, WebUI facades, mock fixtures and OpenAPI descriptions must preserve that distinction. Product UI adapters must retain explicit-choice provenance; cancellation or an unqualified legacy callback must not become persistent denial.

## Validation boundary

Validate exact legacy promise shapes, stored/reopened markers, remembered sweeps, invalid pairs rejected without disk mutation, fresh and stale records, workspace correlation, explicit choices, all nonpersistent outcomes and real loopback HTTP action handling. Retain broker-backed trust component assertions. Component tests do not establish whole-runtime daemon services/server wiring or hosted-session composition.

Combined channel/broker/trust fixtures must exercise the real producer and current-record consumer: explicit approval and denial persist their respective workspace choices; amendment and cancellation leave trust undecided and write no trust file. Late channel approve/reject/amend readings cannot replace a cancelled record. Retain privacy-snapshot and workflow-containment assertions. Explicit offline judgment fixtures establish structural behavior; full daemon boot/hosted-session composition, live calibration and product parity require independent evidence.

Source and focused validation: [disposition types and validation](../../packages/engine/sdk/src/platform/control-plane/approval-disposition.ts), [trust consumer](../../packages/engine/sdk/src/platform/runtime/workspace-trust-approval.ts), [broker](../../packages/engine/sdk/src/platform/control-plane/approval-broker.ts), [test/approval-disposition.test.ts](../../packages/engine/test/approval-disposition.test.ts), [test/approval-disposition-wire.test.ts](../../packages/engine/test/approval-disposition-wire.test.ts), [test/approval-disposition-producers.test.ts](../../packages/engine/test/approval-disposition-producers.test.ts) and [test/workspace-trust-approval.test.ts](../../packages/engine/test/workspace-trust-approval.test.ts).
