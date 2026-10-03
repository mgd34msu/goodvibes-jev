# Autonomous Jev decision contract

Status: shared contract foundation. This adds no live provider call or side effect, and does not claim that legacy callers have been migrated.

## Current direction

Mike's direction on 2026-10-03 supersedes the older product human-confirmation and escalation semantics: “there will be NO human in the loop with goodvibes-jev --- NONE. Jev will make all of the decisions”. He also specified one shared retry implementation, retrying until Jev is available with backoff. Work is tracked in [THE-116](https://linear.app/the-artificery/issue/THE-116/define-autonomous-jev-decision-contract).

This is the GoodVibes Jev product contract. It does not change the permissions of development tools or authorize live external actions by a developer.

Jev owns semantic decisions. Code still validates deterministic authentication, capability/scope membership, revocation, fixed formats, monetary arithmetic, version equality and execution idempotency. A model cannot grant itself a capability or erase a revoked authorization by describing an action as safe. These checks do not ask a human to decide semantics.

## Shared consumer interface

Import from `@goodvibes-jev/judgment/decisions`, the runtime-neutral entry point:

```ts
import {
  JEV_DECISION_SCHEMA,
  parseJevDecision,
  validateJevDecision,
  type JevDecision,
  type JevDecisionBinding,
  type JevDecisionContext,
} from '@goodvibes-jev/judgment/decisions';
```

`JEV_DECISION_SCHEMA` is a closed draft-7 JSON Schema for persisted/wire receipts. `parseJevDecision(unknown)` performs strict runtime shape validation and returns a detached, deeply frozen receipt. Unknown fields, legacy outcome names, empty call lineage, duplicate references and malformed variants fail with a value-free `JevDecisionError`.

`validateJevDecision(unknown, currentHostContext)` additionally binds the receipt to host-owned current identities and offered references. Neither function is an authorization service. A receipt, a TypeScript type, or a model-generated copy of a host ID is not sufficient authority to execute.

### Semantic outcomes

| Outcome | Consumer behavior |
| --- | --- |
| `act` | Candidate to execute exactly the bound action after current deterministic boundaries and atomic ledger claim. Requires at least one captured evidence reference. |
| `revise` | Execute the selected host-offered `next` step: `reconsider`, `gather-evidence`, or `revise-action`. This never executes the original action. Any changed action/input requires a fresh decision and binding. |
| `defer` | Keep the current action unexecuted. Observe the host-registered `until` condition; when satisfied, obtain a fresh decision using current context. Deferral itself never authorizes later execution. |
| `reject` | Refuse the bound action. No continuation or execution is implied. New evidence or a changed request can start a new decision. |

Each receipt has `schemaVersion: 1`, `decisionId`, `binding`, nonempty `judgmentDecisionIds`, `evidence`, `summary`, and `outcome`. Only `revise` has `next`; only `defer` has `until`. The informational summary is never executable text or approval.

There is no `confirm`, `escalate`, `approved`, `allow-all` or terminal `unavailable` semantic outcome. Valid semantic uncertainty is not a transport error: Jev can select further evidence/reconsideration, a meaningful external-condition deferral, or refusal. Repeating an unchanged uncertain reading until it happens to cross a threshold is not evidence gathering. There is no deterministic fallback that guesses what Jev would have chosen.

### Binding and provenance

`JevDecisionBinding` contains:

| Fields | Host obligation |
| --- | --- |
| `sourceId`, `inputRevision` | Identify the immutable source input snapshot and change the revision for any relevant content/context change. |
| `actionId`, `actionRevision` | Identify the exact operation, arguments, destination and effect scope. A revised command, recipient or payload gets a new revision. |
| `authorityId`, `authorityRevision` | Identify the actual principal/capability context and current grant generation. Revocation or a changed grant invalidates old decisions. |
| `scopeId`, `scopeRevision` | Identify the actual tenant/workspace/resource scope and generation. Switching or shrinking scope invalidates old decisions. |

References are opaque host-owned, nonempty printable-ASCII strings of at most 256 characters, not display names or credentials. A revision can be a content digest or a monotonic immutable version. This module does not compute or authenticate it. The host registry must make an ID/revision pair immutable; reusing a revision after content changes breaks the contract.

The host assigns `decisionId`, validates that `judgmentDecisionIds` name actual recorded successful Jev calls for this binding, and supplies the available evidence manifest. An evidence reference is `{ id, revision }`. The receipt may select only known versions from that manifest. Call records and evidence must belong to the exact decision snapshot; a global allowlist is insufficient.

The host also supplies exact versioned `continuations` and `resumeConditions`. Jev selects among these offered steps and conditions. An arbitrary string in the model response must never create a tool call, callback, subscription or condition. Each continuation's own capabilities and effect scope are checked deterministically before it runs. Host context must not be populated by echoing the untrusted receipt.

The parser guarantees detached receipt immutability. Binding validation cannot make execution atomic: immediately before a side effect the owner must rebuild current context, revalidate, run deterministic boundaries, and atomically claim `(decisionId, actionId, actionRevision)` against the execution ledger. Already claimed receipts cannot execute twice. Revocation and claim/execution must use the owner's existing synchronization mechanism. Do not retain a stale validated receipt as a durable permission grant.

## Retry and product progress

The judgment port is the only transport-retry owner. Daemon, TUI, Agent, Web UI and native bridges consume its lifecycle signal and waiting notifications. They must not wrap it in another retry loop, turn waiting into `reject`/`defer`, synthesize an answer, or display an approval prompt.

Operational progress is separate from `JevDecision`. While a logical reading is pending, the consumer has a pending task and the port's credential-free waiting/backoff data; it has no semantic receipt. Display “Waiting for Jev” or equivalent and keep cancellation responsive. User cancellation, supersession, shutdown and deterministic authority revocation stop that operation without manufacturing a semantic decision. Permanent request/authentication/format failures remain explicit operational failures; they do not grant execution authority.

Semantic reconsideration is a new Jev reading with new recorded lineage, not an HTTP retry of a failed request. Source, action, evidence or authority changes require a new snapshot. All such calls still go through the same central port transport implementation.

## First executable vertical slice

The native/engine owner should compose these interfaces before broad product migration:

1. Capture a host-owned immutable action/input snapshot, current authority/scope revisions, actual evidence, and legal continuation/condition choices.
2. Ask the shared Jev port with lifecycle cancellation and live authority checks before each transport attempt. Relay its operational waiting notifications unchanged to product progress.
3. Have Jev select the semantic outcome and applicable offered reference. Construct the receipt using actual host IDs and actual recorded Jev call IDs; do not fabricate lineage or promote an uncertain legacy reading to `act`.
4. Validate the receipt against the captured snapshot. At the execution boundary, validate it again against live context and atomically claim the decision/action in the native execution ledger.
5. Route `revise` to the selected autonomous next step, `defer` to its registered condition and a fresh later reading, `reject` to a refusal receipt, and `act` to the exact gated action. Products render these typed states.

Acceptance fixtures for that slice must prove: invalid or unavailable Jev produces zero actions; eventual recovery produces one current action; cancellation/supersession/revocation during backoff produces zero actions; old input/action/scope/authority revisions are rejected; unknown or stale evidence/steps/conditions are rejected; repeated delivery cannot execute twice; `revise`/`defer` never execute the original action; no human approval UI or synthesized permission result is created.

This module supplies the common contract and structural/binding fixtures. The ledger, condition owner, central retry implementation, semantic evaluator and product composition are required consumers, not functionality silently provided by the schema.

## Legacy migration map

The old `Outcome = act | confirm | escalate` remains readable for historical batteries, logs and persisted data. It is not the autonomous consumer contract. Do not rename those enum values in old records or convert `confirm`/`escalate` into `act`.

- `packages/judgment/src/readings/bands.ts`: historical confidence-band vocabulary. New autonomous evaluations decide how to reconsider, gather evidence, defer or refuse instead of opening an approval flow.
- `packages/engine/sdk/src/platform/gate/` and `permissions/manager.ts`: replace semantic approval dispatch with current autonomous decisions while preserving deterministic boundaries, grant scope/revocation and current execution ownership.
- `packages/engine/sdk/src/platform/contract/{planner,escalation,steps}.ts`: replace owner-reply correction/escalation loops with autonomous correction/evidence/refusal outcomes. Never write an owner confirmation or mark criteria met without evidence.
- Decision log/query APIs, daemon wire contracts and generated product facades: version/migrate explicitly; add new semantic receipts and operational progress without recasting historical readings.
- TUI, Agent and Web UI: render the shared decisions and port progress, remove semantic human approval wait paths only when their engine/native owners are migrated and proven.

The presence of this additive contract does not mean those paths are already autonomous. Their migration is a release gate, not a fallback mode.

### Settings evidence migration seam

`gate/policy/settings-write-evidence.ts` exposes `readSettingsWriteEvidence(args, port, signal)` for the central admission owner. It asks the existing settings-hazard battery about a protected-format-checked, immutable, complete invocation and returns the hazard/request observations plus the actual recorded call ID when the port supplies one. The observations do not grant permission. The autonomous owner must require recorded provenance, bind that evidence to its current prepared action/authority/scope, and claim a fresh semantic `act` before execution.

The legacy settings policy now requires both `requested.verdict === 'yes'` and `requested.outcome === 'act'`; a yes/confirm observation at probability 0.75 cannot allow a hazardous setting. Its wrapper also executes the immutable arguments it checked, rather than rereading borrowed arguments after the asynchronous judgment. This closes the historical confidence and argument-mutation bypasses; it does not itself supply the autonomous capability/claim protocol. The legacy denial text and standalone policy explanation remain historical consumers until the central admission capability is wired through them. They must not be presented as an autonomous settings workflow or used as a human-approval fallback in that workflow.
