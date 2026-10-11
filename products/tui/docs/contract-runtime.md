# Contract runtime ownership

The TUI obtains `contractRunner` from `createClientRuntimeServices` in
[`src/runtime/services.ts`](../src/runtime/services.ts). The same runner feeds
the public contract operator and intake and supplies terminal-inclusive
snapshots. There is no separate TUI persistence adapter or planned-fix callback.

The shared [client floor](../../../packages/engine/sdk/src/platform/runtime/client-services.ts)
composes the runner and invokes `resumeContracts`.
[Contract composition](../../../packages/engine/sdk/src/platform/runtime/contract-composition.ts)
binds `ContractStore`, `createContractRunner`, the actual agent manager, bus,
orchestration engine, and pricing/route dependencies.

## Persistence and agent-tool boundary

The public [ContractStore](../../../packages/engine/sdk/src/platform/contract/store.ts)
uses one versioned file per contract under `.goodvibes/contracts/`. It owns
atomic/debounced writes, snapshot validation and quarantine, terminal retention,
and import protection. Public
[runner resume](../../../packages/engine/sdk/src/platform/contract/resume.ts)
owns resumption and zombie handling. The old `wrfc-chains.json` snapshot format
is not compatible by implication: retiring the old adapter neither reads nor
deletes those user snapshots.

The public [agent tool](../../../packages/engine/sdk/src/platform/tools/agent/index.ts)
sends default spawn/batch work through the contract runner. A direct ordinary
agent requires `outsideContract: true`.
[AgentManager](../../../packages/engine/sdk/src/platform/tools/agent/manager.ts)
emits `AGENT_SPAWNING.taskContract`. Retired WRFC owner promotion, batch collapse,
role flags, English-keyword routing, `ORCHESTRATION_NODE_ADDED`, and the private
`wrfcController.fixWorkstreamRunner` API are not compatibility requirements for
this boundary. The [autonomous decision contract](../../../docs/design/autonomous-jev-decisions.md)
continues to govern execution authority.

## Fleet receipts and presentation

ACP and direct-wake acceptance leave delivery unknown; they are not native
message-bus queued receipts. A native-bus timeout or target end likewise cannot
prove non-delivery: the runner may already have consumed steering before its
acknowledgement arrives. Preserve exact identity as one receipt per tab until
replacement or tab retirement. Render unknown/consumed states honestly and retain
later errors rather than turning acceptance into a delivery claim.

Stop/discard hints must use the same eligibility helper as the actual list and
full-view controls, without changing execution or confirmation handlers. Unpriced
cost remains unknown rather than `$0.00`; known subtotals do not make a partial
total complete. Do not invent per-item isolation/integration or conflict-path
fields when the public `ContractUnitView` does not provide those facts.

## Meaningful verification

[`src/test/tools/agent.test.ts`](../src/test/tools/agent.test.ts) constructs the
public manager, tool, message bus, archetype loader, runtime event bus, contract
store and runner over a controlled pending executor. Its obligations include:

- Direct spawn/get preserve task, template, execution state and no contract binding;
  direct reviewer role and per-child batch restrictions remain intact.
- Child tools obey the parent's capability ceiling and preserve requirements.
- `AGENT_SPAWNING` carries the execution contract; list returns manager records
  and applies cohort filtering.
- Cancel aborts the manager signal and status/wait report cancellation; message
  reaches the actual bus and appears in message detail.
- Invalid spawn/get/cancel/message/mode requests create no agents.

Run focused checks from the repository root using installed prerequisites and
[the canonical owned runner](testing-and-validation.md):

```sh
bun packages/engine/scripts/test.ts --cwd ../../products/tui src/test/tools/agent.test.ts
bun packages/engine/scripts/test.ts test/contract/store.test.ts
bun packages/engine/scripts/test.ts test/contract/correction.test.ts
```

The store suite protects versioned round trips, invalid/future snapshot refusal
and quarantine, bounded retention, import protection, event-triggered writes,
and pending-write flush on detach. The correction suite exercises the shared
runner's fix creation, fix-group execution and completion re-check, exhausted
budgets and rejected fixes; it is not a private TUI callback-wiring test.
Retained legacy owner-escalation cases do not add an autonomous approval route.

These controlled fixtures do not verify live providers, a complete TUI session,
contract planning/provider execution, or migration of historical WRFC snapshots.
Historical retirement decisions and source-bound receipts are preserved in
[THE-62](https://linear.app/the-artificery/issue/TA-62/port-the-redesigned-tui-onto-jev-engine-contracts).
