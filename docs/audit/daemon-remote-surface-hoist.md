# Daemon remote surface composition

THE-18 hoists `src/daemon/handlers/remote/index.ts` and its tests from daemon
`443e5ee4d6cda0d36d57e2886398d0836074a4a9` into the engine runtime remote host
module. This keeps the pinned source; later upstream changes remain a separate
reconciliation gate.

The composition still connects PeerRegistry, the four-backend RemoteDispatcher,
HostDistributedRuntime and the existing distributed manager queue. It authors
no catalog descriptors, route schemas or operator-registration endpoint.
`RemoteSurfaceContext` narrows dependencies to the directories, resolveRef-only
credential store and logger actually consumed. The historical manager path
`.goodvibes/tui/remote/distributed-runtime.json` is retained unchanged.

## Lifecycle contract

The synchronous registration now exposes:

- `ready`: await before exposing synchronous route reads. Async service calls
  wait for readiness themselves. A failure is explicit
  `REMOTE_SURFACE_START_FAILED`, with no raw initializer exception in logs.
  Synchronous reads before readiness refuse with `REMOTE_SURFACE_NOT_READY`.
- `close()`: closes admission immediately and returns one shared promise. It
  stops backend work, waits for both actual initializers and all accepted
  service calls, drains the owned manager's write queue and closes the registry.
  An accepted queue write may finish; shutdown does not pretend to cancel
  durable work. Closed service calls refuse with `REMOTE_SURFACE_CLOSED`.
- `unregister()`: preserves the old synchronous interface but explicitly
  observes close rejection. Product shutdown integration must await `close()`;
  merely calling unregister is not proof cleanup has finished.

The dispatcher retains its historical best-effort backend-cleanup policy,
reporting a fixed warning per failed backend. Other cleanup failures reject
close with `REMOTE_SURFACE_CLEANUP_FAILED` after registry cleanup. An already
failed startup stays failed; retry uses a fresh registration. Immediate close
before initialization begins does not create stores. Close after initialization
has begun waits for both sides even if one fails, so a late initializer cannot
reopen a released registry.

An injected manager remains caller-owned. The surface neither starts it nor
drains/disposes it. `managerReady` may explicitly describe its startup; without
that option, the caller is responsible for supplying an already usable manager.
The option is rejected without an injected manager. Accepted calls through this
surface are still awaited during close. Other concurrent users of a borrowed
manager remain the creator's responsibility.

## Verification and limits

The four original composition assertions remain, with explicit ready/close
instead of a 50 ms sleep and fire-and-forget teardown. Lifecycle tests cover
sync readiness refusal, borrowed ownership, accepted work, early close, paired
initializer failure, safe startup errors and unchanged corrupt JSON evidence,
owned write drain, observable cleanup failure, and cancellation that waits for a
mocked default-backend child to actually exit.

Real-manager fixture tests pin the known usability gap: a peer registered only
in the host SQLite store is still refused by the paired-peer work queue. When
both stores contain explicit fixture records, async work is persisted and
survives manager restart with attribution intact. No credential or pairing token
is created by these fixtures. This is fixture integration evidence, not a
production operator registration path or completed remote product parity.

All stores are test-owned temporary paths. External processes/providers are
mocked, apart from the retained original local printf assertions. The four
products and their shutdown callers are not yet ported; wiring their startup to
ready and shutdown to close remains product integration work.

The selected guarded remote suite passes 177 tests across 16 files (445
assertions). Build, API extraction, architecture and line-cap checks pass.
