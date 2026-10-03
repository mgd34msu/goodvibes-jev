# Agent task-route consumer adoption

Scope: the live `route` tool and `agent_harness mode:"route_decision"` now await
`planTaskRoute` from the public `@goodvibes-jev/engine/sdk/platform/routing`
entrypoint. Runtime bootstrap supplies the same live channel plugin registry to
both consumers. The existing runtime-installed judgment port owns the readings;
this adapter neither creates provider authority nor installs a default reader.

## Evidence-backed successor mappings

- `agent-route-planner-candidates-setup.ts` → engine task-route `catalog-setup`,
  `route-selector`, and `slots`
- `agent-route-planner-candidates-surfaces.ts` → engine `catalog-surfaces`,
  `route-selector`, and `slots`
- `agent-route-planner-candidates-work.ts` → engine `catalog-work`,
  `route-selector`, and `slots`
- `agent-route-planner-helpers.ts` → engine `named-ids`, `slots`, and `text`
- `agent-route-planner.ts` → engine `planner`, `route-selector`, and `slots`
- `agent-route-tool.ts` → product adapter of the engine task-route tool/planner
  contract, retaining Agent registration and status presentation

The four legacy builder/helper files remain physically retained for source
accountability. Their only imports are within that disconnected legacy group;
neither live consumer imports or invokes its substring predicates or hand-set
scores. This is six scoped HOIST mappings, not full Agent parity or permission to
retire unrelated upstream source.

## Product composition

Named model IDs come from the current ProviderRegistry through the engine's
`modelProviderNamedIds`; channel IDs come from the current ChannelPluginRegistry
through `channelTargetNamedIds`. External-memory IDs use the existing Agent
provider catalog, including awaited live records and receipt-backed additions.
No named-ID list is inferred from request text or copied from engine fixtures.
An absent channel/provider listing remains absent rather than inventing IDs.

Workspace and harness catalogs are listed without a query filter. The public
`gateJudgmentRegistry` supplies the existing `engine.tools.registry-rank`
reranker; its probabilities order matches. The adapter guards the registry
entry's rerank capability and uses no internal engine import or duplicate
battery/band. Catalog failures are awaited outside the SDK planner's optional
catalog catch, so unavailable readings fail the Agent request honestly rather
than silently returning an empty match list. No match executes an action.

Both consumers await completion and forward caller cancellation. Planning
preserves preferred/alternatives, routesConsidered, missing fields, confirmation
boundary, matching catalog records, optional scores, and status/usage outputs.
Scores are now engine fit probabilities and confidence is an engine reading
outcome. The direct tool rejects unavailable readings; the existing harness
error envelope reports them as `success:false`.

## Verification (2026-10-03)

All commands used the normal guarded test runner and explicit local fixture
readers. No live provider calls or network-guard relaxations were used.

- Agent route adapter, engine integration, and harness mode catalog suites:
  **87 passed, 0 failed, 303 assertions** across four files.
- Actual runtime/bootstrap composition fixture asserts the existing installed
  settings-driven judgment port identity, replaces only its ask I/O boundary
  with local readings, then invokes both bootstrap-registered consumers using
  real provider and channel registries. The binding stays installed throughout.
- Existing engine task-route suite: **35 passed, 0 failed, 107 assertions**.
- All 49 existing route-adapter tests retain their original assertions, now
  supplied with explicit local selector/slot/named-ID/catalog readings.
- Eighteen both-caller regressions exercise reading-vs-keyword disagreement,
  output schema, reading-ranked real catalog IDs, async completion, forwarded
  signals, missing/failed readers, catalog reading failure, live channel registry
  mutation and invented-ID rejection, actual ProviderRegistry candidate IDs,
  and cancellation before/during reading.
- Changed TypeScript syntax and unbound-name checks passed. These are bounded
  source checks, not a full compiler pass.
- `products:check` passed: three products present, TUI remains pending.
- Full Agent test typechecking was attempted once by the fixture worker and
  terminated with Node heap OOM (exit 134, approximately 2 GiB). No retry.
- Full build, aggregate Agent tests, connected/live parity, and CI were not run
  for this change. They are not implied by the focused checks.

## Accounting limits

The original baseline pin `9e225a349667632bb550e9c270d922b985848eaa` and refresh
pin `f05fe636c120baa469037efe7d7391c3d9503635` are unchanged. All 1,650 refreshed
source paths remain present. Only modified source materialization rows are
refreshed, and only the six proven task-route mappings leave the unresolved
list: 1,157 mapped / 445 unresolved, including 197 retained HOIST rows and 248
upstream-deleted rows. No upstream-deleted file is marked DROP. Other JEV/HOIST
obligations, native UI work, PR56, and ledger-to-runner admission are outside
this change. No command execution or permission policy changed.
