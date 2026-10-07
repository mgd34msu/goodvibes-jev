# Hosted session explicit termination ownership

The real manager/floor/store probe on main
`ada8e3a677bb32a68a44c6285aab5e7b764a382e` reproduced two explicit-kill
races. Holding the first save, or holding initial spine registration with the
unmodified real store, allowed kill to resolve `terminated` before creation
returned `idle`, published `hosted-session-created`, and left an idle disk
record. This repair retires that exact lifecycle deferral from the provider
preload audit; it does not broaden THE-18 acceptance.

## Ownership and ordering

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

## Callback contract

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
persistence. No provider-turn durability guarantee is added. This change does
not claim to drain arbitrary in-flight provider turns, delivery lanes, every
other application write, or synchronous floor disposal beyond their existing
contracts.

## Controlled proof

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
