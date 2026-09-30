# Daemon routing registration hoist

Pinned source: daemon `443e5ee4d6cda0d36d57e2886398d0836074a4a9`, `src/daemon/handlers/routing/index.ts`, its registration test and shared fixture helper.

The actual `channels.routing.list/assign/delete` handlers now live beside the previously hoisted RouteStore and resolver in `channels/host-routing/registration.ts`. They reuse canonical catalog descriptors and the shared host confirmation wrapper. Response projections, exact/surface/explicit-any precedence, required fields, query bounds, logging metadata, path layout and persisted assignment identity remain unchanged. Optional fields are omitted rather than explicitly passed as undefined to satisfy the engine's strict input types.

## Readiness and ownership

Construction remains lazy and does not open SQLite. Catalog methods initialize as needed. A product using the synchronous `resolveProfileId` or resolver handles must first await `initialize()`; this makes routing ready before intake leadership begins, without a warm-up catalog call or an invented default profile. Initialization failures remain retryable. Shutdown during initialization rejects that readiness request rather than reporting a stopped surface ready.

`close()` immediately detaches catalog admission and refuses new resolver/initialization calls, drains accepted handlers through persistence, then awaits the owned RouteStore close. It restores the original canonical descriptors handler-less so a replacement can reuse the catalog. Repeated old teardown cannot erase replacement handlers. A caller must await close before transferring ownership; direct advanced store handles remain the caller's responsibility and must not be used after shutdown begins. Legacy `unregister()` starts the same close, reports fixed-value cleanup diagnostics, and keeps failures observable to awaiters.

## Verification

All 13 original registration tests pass. Three new regressions fail against the imported wrapper: teardown during an accepted cold read, teardown during an accepted assignment, and descriptor loss on replacement. Additional tests cover lazy explicit readiness, closing an unused surface without file creation, startup cancellation, persisted assignment across close/reopen, failed initialization retry, refused post-close resolution and ignored legacy teardown with observable cleanup failure. The focused set includes the existing route store/resolver tests. Fixtures use owned temporary SQLite stores and local spies; no live channels or credentials are accessed.

This is a boot prerequisite. Actual product handler aggregation, provider/triage wiring, full runtime startup/shutdown, parity, upstream reconciliation and combined/live gates remain pending.
