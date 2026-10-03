# Agent task-route uncertainty repair

Baseline: `645431c7`. Scope follows the later per-check rulings in `docs/inventory/agent.md` for the Agent route planner and the engine task-route implementation.

## Runtime defect and repair

The Agent catalog adapter retained every rerank entry except `no`, then discarded its reading and decision ID. Both `route` and `agent_harness mode:route_decision` therefore exposed synthetic probability 0.5 as ordinary catalog matches. The engine additionally labeled weak selections and uncertain slot readings `ready`, including a main-conversation fallback when the selected route did not fit.

The adapter now passes the public `Ranked` readings with their original decision IDs. Engine composition preserves selector, slot, named-target and catalog evidence in `judgment`. An unresolved required reading produces a discriminated `uncertain` plan without `preferred`, ordinary matches or executable recommendations. Ready catalog matches require an actionable yes, and ready alternatives omit non-actionable fits while retaining those readings in diagnostics. Missing catalogs remain optional; a supplied catalog's failure propagates instead of becoming a successful empty result. A live named-ID listing change during a pending pass rejects publication. Cancellation is checked before readings and before publication.

This patch uses the current judgment outcome contract without adding foundation outcome types, retry behavior, human approval, or escalation flows. The shared judgment/gate redesign owns future outcome/retry semantics. Existing route effect boundaries remain unchanged. These route tools plan only; they do not dispatch returned routes.

## Verification

Using local scripted provider answers, actual public judgment patterns and SQLite decision logging; no live provider or credentials:

- Engine task-route tests plus Agent route-tool, engine-integration and actual service/bootstrap tests: 120 passed, zero failed.
- Old-source/new-test control at baseline: 11 failed, 24 passed. Failures cover 0.5 and 0.57 catalog judgments, uncertain effect slots, weak selector fallback, stale live channel target, and actual registered Agent composition.
- Restored repaired source: all 120 pass (425 assertions).
- Actual registered tools preserve catalog/selection decision-log evidence and perform zero downstream tool dispatches for an uncertain plan.
- Existing unavailable-provider, catalog-failure, pre-abort, pending-abort and late-result controls continue to pass.

Final validation also passed, serially with a 4096 MiB compiler cap:

- Engine composite including engine tests, and a final incremental recheck.
- Agent source typecheck and complete Agent test/script typecheck.
- Public subpath API generation/check: only the eight expected routing type declarations changed.
- Independent review cleared source `39ce2a18` / tree `751ce80091bbfb7f91813599a7aa9d0d39d252ba`, repeating 120 tests / 425 assertions and adding three reviewer probes / 16 assertions.

No live-provider smoke test was run; all provider I/O used deterministic local fixtures.
