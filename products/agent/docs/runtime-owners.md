# Agent execution and session owners

Agent composes shared execution machinery through public engine entrypoints.
Product compatibility exports do not create independent policy owners.

## Execution ledger

[`runtime/services.ts`](../src/runtime/services.ts) constructs the public
`AgentExecutionLedger` on the real runtime bus; the execution-history tool reads
its snapshots. The owner preserves the 500-record default, newest-received-first
retention, status/phase/timestamps, permission, argument keys and previews,
command/target previews, result summaries, failure/cancellation text,
subscriptions and counts. Buffer/preview caps, event-enum dispatch, presence
checks and the exec command contract remain structural code.

`engine.gate.ledger-arg` reads credential/target roles, and
`engine.gate.side-effect` reads route kind. Immutable full-input capture and
full-tree name-only role reads precede value-bearing route judgment. Failed or
uncertain credential readings withhold values; uncertain routes remain `other`
with explicit diagnostics. There is no tool-name ladder, credential-key regex or
target-key list substituting for those readings.

Terminal success/failure states are absorbing but may still receive safe pending
enrichment. Cancellation, eviction and disposal prohibit late enrichment, cache
refill or resurrection. See the retained [shared-ledger contract](runtime-and-packaging-contracts.md#shared-execution-history)
for input, privacy, provenance and batch-lifetime details.

## Permission composition

Bootstrap imports the public guard and installs it through
`composeAgentPermissionManager` on the actual graph manager. `check` and
`checkDetailed` preserve complete arguments, attribution, execution options,
result/error identity and cancellation. They cannot manufacture permission or
provenance after a failed/unavailable manager judgment. Category readings explain
posture; they are never substitute authority.

Direct guard-method tests and real composed execution establish different
boundaries. The direct cases prove signature/result/error forwarding. The
composed `executeToolCalls` pipeline uses the shared executor's `admitAutonomous`,
proving preparation/admission, failure, revocation, cancellation and recorded
success. It does not establish that the wrapper methods implement autonomous
admission. Failed admission reaches no fake action; cancellation cannot accept a
late approval. Actual successful admission retains supplied goal/criteria and
its decision provenance without a human approval callback. The
[shared-guard contract](runtime-and-packaging-contracts.md#shared-permission-wrapper-and-explanations)
retains the full privacy and explanation boundaries.

## Session-spine connection selection

The public session-spine entrypoint owns `SessionSpineClient`, REST register/close,
probe and receipt machinery. Agent retains `createSpineConnectionResolver` and
connected-host token selection, as required by the accepted
[extraction decision](../../../packages/engine/docs/decisions/2026-07-05-session-spine-sdk-extraction.md).
Engine transport code does not acquire Agent token files.

Agent services supply the local resolver, explicit `recordKind: 'agent'`, public
transport, plain liveness probe and receipt consumer. Register, close, probe and
receipt operations resolve the connection anew each time. Product token selection
retains environment precedence, host-bound paired credentials and fail-closed
unknown/unavailable pairing handling. Memory CLI wiring uses the same resolver
with public probing and its memory transport.

Bootstrap registers and heartbeats the current session; resume reopens explicitly.
Legacy folding and adoption-edge receipt consumption remain in product bootstrap.
Frequent liveness probes do not consume receipts. Shutdown closes/disposes the
client, with graph-owned disposal also registered by services. Receipt buffering
and deduplication do not grant execution authority.

## Focused verification

Use the [owned test procedure](testing-and-validation.md) from the repository root
with installed prerequisites. Active engine suites include ledger/lifetime/batch
lifetime, `gate-judgment-input`, `gate-tool-permission-safety`,
`session-spine-rest-transport` and `session-spine-client`. Active product suites
include ledger adoption, permission safety/cancellation, bootstrap disposal,
policy explanation, host pairing, daemon receipts and memory-spine adoption.
For example:

```sh
bun packages/engine/scripts/test.ts test/session-spine-rest-transport.test.ts test/session-spine-client.test.ts
bun packages/engine/scripts/test.ts --cwd ../../products/agent src/test/runtime/agent-host-pairing.test.ts src/test/runtime/daemon-receipts.test.ts src/test/runtime/memory-spine-adoption.test.ts
bun packages/engine/scripts/test.ts --cwd ../../products/agent src/test/runtime/tool-permission-safety.test.ts src/test/runtime/tool-permission-cancellation.test.ts src/test/tools/agent-policy-explanation-posture.test.ts
```

Synthetic providers, homes, tokens and nonexecuting tools establish the named
composition and lifetime boundaries, not live semantic calibration, compiled
acceptance or full Agent parity. The historical one-off session-spine probe stays
review evidence in [THE-63](https://linear.app/the-artificery/issue/TA-63/port-the-redesigned-agent-and-preserve-cancellation-authority);
it is not an active suite and must not be silently added to the workspace.
