# Runtime resource lifetimes

## ACP and hosted-intake callers

- TUI bootstrap supplies the recorded canonical permission owner to AcpManager.
- Admitted delegate tool execution supplies currentExternalOperationSource; the manager captures the original goal/criteria and rejects changed authority. Generated child task prose is never a source fallback.
- Both direct `/remote dispatch` variants carry the exact original terminal command through the private direct-owner marker and explicit session/manager lifetime. Model/source-less invocations refuse before spawning. Pairing replacement commands preserve the raw input through that same boundary.
- AcpConnection uses admitExternalRequest and AcpPermissionWire: protocol privacy capture, exact original option IDs, no widening from once to always, final synchronous wire claim, cancellation/config/source fences, and no human callback fallback.
- Hosted intake uses captureJudgmentFailure and readFailureTransience over the actual failure. The attempt ceiling applies only after retry eligibility. Failed readings retain collected inputs and retry classification without resending the input. Unsafe evidence never reaches the reader or becomes a redelivery.
- Stop/fence prevent stale classification effects. Successful turns still finish their existing shutdown drain. Reader exception observability uses fixed text and source identities without raw exception wording.

Validate actual spawned ACP stdio peers through the optional SDK, canonical
recorded PermissionManager and original protocol option IDs. Check the
originating manager source independently of generated task prose. Hosted intake
fixtures cover opposite semantic outcomes, bounded retries, structured-status
fast paths, captured-port isolation, stop/fence, failed-read retry, immutable
original failures, privacy rejection and secret-bearing reader exceptions.
Actual direct-command-to-subprocess and raw pairing-replacement fixtures preserve
terminal authority. These are controlled tests, not live provider evidence.

## Cluster acquisition and shutdown

### Shared lifecycle ownership

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

### Validation

The regression suite includes clean restart, failed partial cleanup and retry,
stop before acquisition, stop during acquisition, pending housekeeping drain,
stale callback refusal, error observation and the existing membership, rotation,
replication, election, spread and handoff suites. All use guarded test execution,
in-memory transport/clock and owned temporary state.

The product integration boundary is the real product `createRuntimeServices` and
`DaemonServer` fixture on loopback with awaited complete shutdown. In-memory lifecycle tests do not establish complete daemon boot or live provider proof.

Keep group signatures, replay checks, membership, replication, election ranking
and borrowed transport semantics in their existing owners. The lifecycle's
shared pending state must prevent early second-start success, late acquisition
after stop and false stopped state following failed cleanup.

## Hosted-session explicit termination

### Initialization, parking and terminal order

Each known session owns admitted initialization, restored composition, shutdown
parking, and one terminal completion. Explicit kill synchronously fences the
session and spine registration admission. Its shared terminal operation then
waits for those admitted operations and every admitted registration, including
periodic heartbeat registration, before runtime teardown, final persistence,
spine close, and terminal publication. A held callback keeps kill pending.
Repeated kills, detach during termination, and shutdown join that completion,
even when the visible record is already fenced as terminated.

Creation rechecks admission after registration and initial persistence, before
publication, and after the synchronous created-event callback before the initial
prompt or return. Interrupted creation rejects rather than returning an idle
record. Attach and other runtime consumers recheck after their composition
awaits. Concurrent restored consumers share one composition; a late floor is
released without admitting a runtime after termination.

A survive-policy shutdown keeps its existing idle/restorable behavior. Its
parking write is owned before callbacks run. If an external kill arrives while
that write is held, kill waits for it, writes termination last, and suppresses
the late detached notice. Shutdown rechecks terminal ownership after composition
and registration drains and joins any explicit termination, preserving its
reason. Shutdown still cleans up after native-close failure and exposes that
original failure to external close callers.

### Callback reentry

A synchronous or asynchronous callback that belongs to a session's admitted
initialization, composition, persistence, registration, close, or parking cannot
await that same session's kill: the call rejects with
`HostedSessionUnavailableError` explaining that a lifecycle callback cannot
await its own termination. It does not request termination or falsely return a
completed terminal record. Callers outside that active invocation join the real
completion. Callbacks can kill unrelated sessions, and detached descendants of
an invocation that has already settled are ordinary external callers.

The standalone exported spine intake similarly rejects same-session recursive
close/drain from registration or close callbacks before fencing. Its broker
registration and close failures retain their existing logged, best-effort
behavior. Manager shutdown keeps the existing request-only callback semantics;
its actual drain runs outside only that manager's owned live/floor/intake
callback scopes, retaining unrelated ownership contexts.

Native initialization still requires a durable first save and rejects with the
original persistence failure. Failure cleanup starts after the owned initial
save settles, avoiding self-await; ordinary initialization keeps best-effort
persistence. No provider-turn durability guarantee is added. This ownership does
not promise to drain arbitrary in-flight provider turns, delivery lanes, every
other application write, or synchronous floor disposal beyond their existing
contracts.

### Validation

`hosted-session-explicit-kill.test.ts` uses real client runtime floors with model
discovery skipped, synthetic spine callbacks, and real temporary disk stores.
Barriers cover initial registration/save for ordinary and native sessions;
repeated kill and kill/survive shutdown through held final saves/closes;
synchronous/asynchronous same-session reentry; unrelated-session kills;
expired detached callback contexts; periodic registration; attach and restored
composition; callback-requested shutdown; explicit kill during restored
shutdown or held parking; publisher-triggered kill; normal creation and initial
save failures. Runtime disposal, live-turn bindings, final disk records,
publication order, and suppressed initial prompts are checked.

`hosted-session-spine-intake.test.ts` also exercises direct intake callback
reentry and expired invocation context. Existing creation/shutdown, manager,
floor, spine intake, and heartbeat-starvation suites remain regression evidence.
The fixtures call no provider, use no credentials, change no user settings, and
perform no release operation.

## Legacy IMAP byte/literal framing

The daemon's `runtime/mail-composition.ts` provides `nodeEmailTransport` through
`withSurfaceEmailConfig`. Its service graph reaches the email inbox routes and
`EmailService`, which constructs the richer `email/ImapClient`. The inbound
watcher's `email/inbound/connection.ts` also constructs that client. Both use
one persistent `ImapSession` for the lifetime of their connection.

The session receives bytes and reuses the intake reader's byte framer,
extracted into `email/imap-wire-frames.ts`. It isolates the declared octets
before text decoding, retains literal kind separately from syntax, and keeps
partial frames until complete. Oversized or invalid literal lengths fail the
connection. Only syntax outside a literal can complete a tagged command.

The internal `commandFrames` path reaches envelope batches, previews, full
message headers/parts/fallback, the body-capability probe and LIST folder
selection. FETCH readers reuse the canonical framed parser, including UID
identity after the payload. BODYSTRUCTURE literals become escaped quoted
values for the existing S-expression reader; marker discovery is confined to
actual FETCH syntax, outside quoted/literal values and other server prose.
LIST uses the complete literal folder name instead of treating it as an atom.

Public client results and existing string command/IDLE listener shapes remain
unchanged. String parser inputs remain supported for scripted callers. The
historically lenient multiline-quoted section reader is used only after a
failed canonical parse with no literal values present, so that compatibility
path never flattens a transport literal back into syntax. Socket framing does
not infer message charset; existing text decoding behavior remains unchanged.

### Validation

An in-memory byte transport drives the actual legacy client and session. It
models sockets that decode only if explicitly requested. Regressions cover quote/NIL/whitespace-leading text, zero and multiple literals, non-UTF-8
bytes, partial multibyte peeks, arbitrary byte splits, trailing UID, forged
FETCH/completion text, full reads, body-capability truth, and quoted structure
filenames. They also cover timeout/cancellation, literal bounds, buffered
notifications, synchronous subscriber reentrancy and early completions.

Retain email/inbound cursor attribution and IDLE lifecycle suites alongside the
newer intake framing tests. Build, types, API and actual composed-caller gates
remain required; byte-transport fixtures do not establish live mailbox behavior.
