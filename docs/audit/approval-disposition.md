# Explicit approval provenance and workspace trust

THE-33 corrects the pinned daemon trust adapter's conversion of every boolean
answer into a permanent workspace choice. Six regressions against the original
adapter each observed a trust file for a legacy true/false, amendment,
cancellation, expiry or remembered outcome. Tests use owned temporary roots;
no actual operator trust records are inspected or changed.

## Record-only contract

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

## Consumer and producer boundaries

The original `runtime/trust/trust-gated-approvals.ts` is hoisted to the engine's
`runtime/workspace-trust-approval.ts`, exported through public runtime operations.
`createWorkspaceTrustDecisionAsk` now accepts a narrow broker port with
`raiseApproval` and `getApproval`, plus the working directory and optional timeout.
It awaits the ordinary result and then reads the CURRENT record, rather than the
pending object returned at raise time. It verifies approval/call/creation/request
identity, request kind and exact workspace scope before interpreting the answer.
Only a matching explicit approved/true or denied/false terminal record returns a
persistent trust level. All other outcomes refuse this attempt and leave trust
undecided. No reason-text inference is used. The existing files of previously
recorded trust are honored; historical provenance cannot safely be invented to
rewrite an operator's state.

Generic local prompt and embed callbacks produce ordinary booleans and remain
markerless. The generic client approval raiser chooses an approve/deny URL from
that boolean, so the HTTP URL alone is NOT evidence of an explicit trust choice.
HTTP markers are optional, checked against the action, and absent stays absent.
Known interactive button and explicit operator/transport operations supply their
own marker. The channel-reply producer maps settled approve/reject/amend readings
to approved/denied/amended through the actual broker input. Amendments preserve
the owner's full guidance while refusing the original proposal, without creating
a remembered rule. The ordinary awaited decision remains markerless.

The shared-record output schema and approve/deny input schemas carry the optional
field. Ordinary prompt schema/results do not. Generated operator contracts,
consumer types, WebUI facade, mock fixtures and OpenAPI files are regenerated.
New product UI adapters must preserve explicit choice provenance rather than
turn cancellation or an unqualified legacy callback into a persistent denial.

## Acceptance evidence and remaining work

Tests cover exact legacy promise shapes, stored/reopened markers, remembered
sweeps, invalid pairs rejected without disk mutation, fresh and stale records,
workspace correlation, explicit choices, all nonpersistent outcomes and real
loopback HTTP action handling. Original daemon trust component assertions are
retained with real broker-backed fixture records. Its two original whole-runtime
wiring assertions remain pending the actual daemon services/server port and are
not declared migrated by these component tests.

Combined channel/broker/trust fixtures exercise the real producer and current
record consumer: explicit approval and denial persist their respective workspace
choices, while amendment and cancellation leave trust undecided and write no
trust file. Late channel approve/reject/amend readings cannot replace a cancelled
record. Existing privacy snapshot and workflow containment assertions remain in
the combined checkout. These fixtures use explicit offline judgment answers;
they are not a live judgment proof or a publication. Full daemon boot/hosted-session
composition, live calibration and product parity remain separate acceptance gates.
