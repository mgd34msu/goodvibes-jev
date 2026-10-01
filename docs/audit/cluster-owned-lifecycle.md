# Cluster acquisition and shutdown ownership

This is a bounded lifecycle correction needed by the daemon composition port.
It does not alter group signatures, replay checks, membership decisions,
replication policy, election ranking or the borrowed election transport contract.

## Reproduction

Before the patch, four in-memory tests fail against `ClusterGroupRuntime` and
four against `GroupWireRouter`:

- A second start resolves while the first acquisition is still pending.
- Stop resolves before a previously accepted start completes.
- That late start can leave a running transport and armed periodic timers.
- Failed acquisition is retained as an already-started success; a failed wire
  stop is similarly retained as already stopped, preventing a real retry.

The runtime tests hold a dummy secret read or a transport acquisition promise;
the router tests use only an in-memory transport. They do not open UDP sockets,
read actual credentials, provision access or invoke external services.

## Ownership contract

The internal `ClusterOwnedLifecycle` publishes shared pending promises before
calling acquisition/release callbacks. Concurrent starts await the same actual
readiness, and concurrent stops await the same cleanup. Stop aborts pending
startup and waits for its partial acquisition to be cleaned. The start caller
receives its startup/cancellation error; the stop caller observes cleanup errors.
A clean stopped instance may restart explicitly. Start while stopping is refused.
Failed cleanup remains dirty and must be retried before restart; startup and
cleanup failures are preserved together when both fail.

Existing public `start`, `ensureStarted` and `stop` signatures remain
`Promise<void>`. Consumers must await them and handle cancellation when another
owner requests shutdown. Callbacks must not await their own containing lifecycle
promise; arbitrary recursive promise cycles are not a supported use.

`ClusterPeriodicTasks` cancels future ticks, rejects stale timer callbacks by
ownership, and drains automatic work already accepted by a tick before the router
closes. Task failure is locally observed with a value-free warning rather than an
unhandled rejection. It is not an assertion that all unrelated manually invoked
RPCs or inbound handlers are universally drained; their caller/daemon ownership
still needs final composition tests.

## Verification

The regression suite includes clean restart, failed partial cleanup and retry,
stop before acquisition, stop during acquisition, pending housekeeping drain,
stale callback refusal, error observation and the existing membership, rotation,
replication, election, spread and handoff suites. All use guarded test execution,
in-memory transport/clock and owned temporary state.

Final acceptance remains the real product `createRuntimeServices` and
`DaemonServer` fixture on loopback with awaited complete shutdown. This repair
alone is neither full daemon boot nor live provider proof.
