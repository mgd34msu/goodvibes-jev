# Retired TUI WRFC adapters

Local acceptance base: `6c91bcc6855a7c03047572d89ad589d202a1d8b6`.
This change removes two unused adapters for SDK APIs that no longer exist. It
retains ordinary agent-tool coverage against the current public API. It does
not reintroduce WRFC routing or migrate historical WRFC snapshots.

## Removed scope and reference evidence

- `src/runtime/wrfc-persistence.ts`: depended on removed `WrfcChain`,
  `WrfcState`, `WorkflowEvent`, `WrfcController.importChain`, and `WORKFLOW_*`
  events. The only importing files were
  `src/test/runtime/wrfc-persistence.test.ts` and
  `src/test/runtime/wrfc-schema-version.test.ts`; both tested that retired
  snapshot implementation and were removed with it.
- `src/tools/wrfc-agent-guard.ts`: rewrote tool requests into removed WRFC
  review modes/owner roles and depended on removed SDK routing helpers. Its
  imports were confined to `src/test/tools/wrfc-agent-guard.test.ts` and the
  mixed `src/test/tools/agent.test.ts`. The guard-only test was removed; the
  mixed test was rewritten around ordinary current agent operations.
- A post-change search for the removed module names and their factory/wrapper
  symbols found no imports or executable call sites. Two historical comments
  in `src/core/wrfc-notice-titles.ts` and its test still mention the old
  persistence file; those files are outside this retirement's scope.

## Current production successors

The TUI obtains `contractRunner` from `createClientRuntimeServices` in
[src/runtime/services.ts](src/runtime/services.ts). It exposes the public
contract operator/intake and reads terminal-inclusive contract snapshots;
there is no production call to either retired adapter.

The SDK client floor composes the runner and invokes `resumeContracts` in
[client-services.ts](../../packages/engine/sdk/src/platform/runtime/client-services.ts).
[contract-composition.ts](../../packages/engine/sdk/src/platform/runtime/contract-composition.ts)
binds the actual `ContractStore`, `createContractRunner`, agent manager, and
pricing/route dependencies. This is the existing successor, not a second TUI
persistence implementation.

The public [ContractStore](../../packages/engine/sdk/src/platform/contract/store.ts)
uses one versioned file per contract under `.goodvibes/contracts/`. It owns
atomic/debounced writes, snapshot validation and quarantine, terminal retention,
and import protection. Public
[runner resume](../../packages/engine/sdk/src/platform/contract/resume.ts)
owns resumption and zombie handling. The old `wrfc-chains.json` format is not
claimed compatible: this change neither reads nor deletes user snapshots in
that retired format.

The public [agent tool](../../packages/engine/sdk/src/platform/tools/agent/index.ts)
now sends default spawn/batch work through the contract runner. A direct,
ordinary agent is explicitly requested with `outsideContract: true`. The
[AgentManager](../../packages/engine/sdk/src/platform/tools/agent/manager.ts)
emits `AGENT_SPAWNING.taskContract`; the removed
`ORCHESTRATION_NODE_ADDED` event is not recreated. Old WRFC owner promotion,
batch collapse, role flags, and English-keyword routing assertions therefore
have no current API to assert and were retired rather than imitated.

## Preserved mixed coverage

`src/test/tools/agent.test.ts` constructs actual public `AgentManager`,
`createAgentTool`, `AgentMessageBus`, `ArchetypeLoader`, `RuntimeEventBus`,
`ContractStore`, and `createContractRunner`. Its executor is a synthetic,
controlled pending run; routing/planning boundaries throw if unexpectedly used.
No real provider, model, network, or git operation is needed. Config readers
are injected using the repository's existing typed fixture helpers, without
writing global settings.

The nine cases retain or add meaningful current behavior:

1. Direct spawn/get keep task, template, execution state, and no contract binding
2. A direct reviewer keeps its requested role
3. Batch spawn propagates each tool restriction
4. Child tools obey the parent's capability ceiling and preserve requirements
5. The actual `AGENT_SPAWNING` event carries the execution contract
6. List returns the manager's records and filters by cohort
7. Cancel aborts the manager-owned signal; status/wait report cancellation
8. Message reaches the actual bus and appears in get's message detail
9. Invalid spawn/get/cancel/message/mode requests create no agents

## Verification and limits

Focused guarded commands, run from the repository root:

```sh
PATH=/workspace/shared/gv-recovery-tools/bin:$PATH bun packages/engine/scripts/test.ts --cwd ../../products/tui src/test/tools/agent.test.ts
PATH=/workspace/shared/gv-recovery-tools/bin:$PATH bun packages/engine/scripts/test.ts test/contract/store.test.ts
```

Results: the TUI agent suite passed 9 tests / 50 assertions. The unchanged SDK
store successor suite passed 27 tests / 87 assertions, including versioned
round trips, invalid/future snapshot refusal/quarantine, bounded retention,
import protection, event-triggered writes, and pending-write flush on detach.
These are focused results, not a full TUI or SDK validation claim.

The existing SDK contract runner/resume suites are the source of broader
lifecycle coverage; they were inspected but not rerun here. Contract planning,
provider execution, and historical WRFC-format migration are not claimed
verified by the ordinary-agent fixture. No compiler, source-authority/security
work, engine/service changes, dependency changes, commits, or publication are
part of this retirement. The earlier frozen notification patches are unchanged.

## Retired private WRFC fix-runner assertion

The old `src/test/runtime/wrfc-fix-runner-wiring.test.ts` asserted a private
`wrfcController.fixWorkstreamRunner` property and passed it a WRFC review with
no issues, expecting the legacy `nothing-to-fix` response. That controller and
review protocol no longer belong to this product, so retaining the private
property would restore a removed API rather than check current wiring.

The relevant composition boundary now lives in the shared client floor:
`services.ts` obtains `contractRunner` directly from `createClientRuntimeServices`
and passes that same runner to the public operator and intake services.
`client-services.ts` returns `contracts.runner`; `contract-composition.ts`
constructs it through `createContractRunner` with the real agent manager, bus,
store and orchestration engine. There is no separate TUI planned-fix callback
to attach or forget.

Behavioral successor verification is `packages/engine/test/contract/correction.test.ts`,
which runs the real contract runner with scripted external boundaries. It
asserts planned-fix creation, fix-group execution, completion re-check and a
passing result for units, groups and the deliverable; it also checks exhausted
fix budgets, rejected fix plans and owner escalation. The guarded local run
passed 14 tests / 83 assertions. This verifies the current shared runner
boundary, not a live provider or full TUI session. Existing TUI runtime and
compiled acceptance remain separately scoped evidence.
