# Agent task-route consumer adoption

Scope: the live `route` tool and `agent_harness mode:"route_decision"` now await
`planTaskRoute` from the public `@goodvibes-jev/engine/sdk/platform/routing`
entrypoint. Runtime bootstrap supplies the same live channel plugin registry to
both consumers. The existing runtime-installed judgment port owns the readings;
this adapter neither creates provider authority nor installs a default reader.

## Legacy compatibility boundary

The legacy builder/helper group is disconnected from both live consumers;
neither live consumer imports or invokes its substring predicates or hand-set
scores. Product adapters retain Agent registration and status presentation.

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

## Validation

Use the normal guarded test runner and explicit local fixture readers, without
live provider calls or network-guard relaxations. Cover the Agent route adapter,
engine integration, harness mode catalog and existing engine task-route suites.
The runtime/bootstrap composition fixture must assert the installed settings-driven
judgment port identity, replace only its ask I/O boundary with local readings,
and invoke both bootstrap-registered consumers through real provider and channel
registries while the binding remains installed. Preserve route-adapter assertions
with explicit local selector/slot/named-ID/catalog readings.

Both-caller controls cover reading-vs-keyword disagreement, output schema,
reading-ranked real catalog IDs, async completion, forwarded signals, missing or
failed readers, catalog reading failure, live channel registry mutation and
invented-ID rejection, actual ProviderRegistry candidate IDs, and cancellation
before/during reading. Keep syntax/unbound-name, product-boundary, full Agent test
typechecking, build and aggregate test gates. Focused checks do not establish
connected/live parity or exact-head CI, and bounded syntax checks are not a full
compiler pass.

## Effect boundary

Task routing does not change command execution or permission policy. Native UI,
PR56 and ledger-to-runner admission have separate contracts.

## Cancellation review repair (2026-10-03)

Independent review found that an asynchronous external-memory catalog snapshot
could leave either tool pending after caller cancellation, before the engine
readings had begun. The adapter now passes its signal into the existing memory
catalog reader. That reader stops waiting on abort, removes its abort listener,
checks cancellation before each source and after each snapshot, and rethrows
cancellation rather than treating it as an ordinary unavailable source.

These legacy snapshot APIs do not expose a cancellation option. This change
cancels the planning wait, **not the underlying source I/O**. Its eventual result
or rejection remains observed and discarded, with no subsequent source reads,
route readings, or successful plan publication after cancellation. The public
engine named-ID listing is synchronous, so dynamic catalog materialization
still precedes planning; no keyword gate or heuristic shortlist was added.

Both callers have pre-aborted-source and held-source regressions, including
late fulfillment and late rejection. The four held-source tests fail with the
old no-signal planner call as a negative control. Preserve the route adapter,
engine integration, actual bootstrap, mode catalog and existing memory-tool
regressions alongside syntax/unbound-name and whitespace checks. Full type,
build, aggregate, CI and live validation remain separate from focused controls.
