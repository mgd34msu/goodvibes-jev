# Daemon backend dispatcher and route-service hoist

THE-18 moves the backend factory, dispatcher and host route adapter from the
pinned daemon source `443e5ee4d6cda0d36d57e2886398d0836074a4a9` into
`packages/engine/sdk/src/platform/runtime/remote/host/`. Source pins are not
refreshed by this slice. Newer upstream releases need separate reconciliation.

## Preserved contracts

- The factory supplies local-process, Docker, SSH and cloud-terminal backends,
  keyed by their declared closed backend kind. Construction never executes a
  provider/child command or resolves a credential; owned scratch scans remain
  metadata-only.
- The dispatcher routes from persisted peer configuration, rejects missing
  peers/backends, passes command/payload through, preserves explicit async queue
  attribution, caps stdout/stderr previews at 4,096 characters and hashes the
  entire returned stdout. No semantic interpretation or fallback is introduced.
- HostDistributedRuntime implements the existing daemon-sdk route-service
  contract: 15 manager pass-through methods and invokePeer through the host
  dispatcher. Route authorization remains in the existing SDK route handlers.
  The source header's claimed method count was stale; behavior is unchanged.
- Local commands remain argv-only with the configured allowlist; remote command
  strings keep their existing shell behavior. No route or operator provisioning
  endpoint is invented.

## Lifecycle corrections

The unchanged imported dispatcher plus original and new tests ran 13 pass and
7 fail. The regressions showed that first dispatch did not wait for a cold
registry, initialization failures were bypassed, repeated/reentrant shutdown
reran cleanup, a synchronous teardown throw skipped subsequent backends, shutdown
returned while accepted dispatch/enqueue was pending, and close during startup
could still execute work.

The dispatcher now initializes before lookup, checks admission after startup,
closes admission synchronously, stores one teardown promise before invoking
hooks, starts all backend stops before awaiting accepted work, and preserves
best-effort shutdown while logging only a fixed message and backend kind on
cleanup failure. Caller-owned registries are never closed. Already accepted
queue writes are awaited; this does not claim to cancel durable queued work.
An injected backend without cancellation can delay shutdown until its accepted
work settles. There is no arbitrary shutdown deadline that loses ownership.

Local/Docker adapters now use the same BackendLifetime and process AbortSignal
as SSH/cloud. Teardown stops and waits for the owned child, refuses future work,
and prevents a late Docker credential lookup from launching a command. Docker
resolver/child errors use fixed messages; exact known resolved host bytes are
masked in returned stdout/stderr. This is literal byte replacement, not a claim
to detect transformed, fragmented or unrelated secrets. Plain configured socket
addresses and command/env construction retain their existing behavior.

## Verification

Original dispatcher/service tests are preserved. Ten dispatcher lifecycle cases
cover cold persisted registry, validation before opening, initialization retry,
reentrancy, cleanup fan-out, pending dispatch/enqueue, close during initialization,
missing-backend refusal and construction without execution. Seven local/Docker
cases cover child kill/reap, post-close refusal, late lookup, safe resolver errors
and exact credential output masking. Focused port run: 47 pass. The broader
guarded remote set passes 161 tests across 14 files (387 assertions). Build,
API extraction, architecture, line-cap and judgment-lint checks also pass.

All external CLI/provider calls are mocked. Existing owned process-runner tests
use local fixture processes. No live provider account, real credential directory,
SSH host or Docker socket is used. Tests do not prove the still-missing operator
registration path: paired manager records and host backend records remain
separate, as described in the remote peer-registry audit and THE-18 follow-up.
