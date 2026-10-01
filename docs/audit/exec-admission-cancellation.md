# Exec admission cancellation (THE-84)

A cancelled exec call could remain blocked on its catastrophic or owner-terminal
reading. If the latter eventually allowed a detached command, exec then called
`ProcessManager.spawn` after cancellation. Even after that policy boundary,
ProcessManager could wait for credential-name readings and launch after the
caller had aborted. Controlled registered readings and intercepted launch
boundaries reproduced all four cases without running a host command.

The caller signal is captured once. Catastrophic, owner-terminal and retry
readings receive it, race unresponsive readers, and reject late results before
recording an execution decision. Exec checks cancellation before file operations
and command admission, stops cancellable retry delays, and reports a typed
cancelled result. Existing calls without a signal retain their signatures and
behavior.

ProcessManager's optional `SpawnOptions.signal` applies only to admission. An
aborted caller settles immediately while the underlying shared credential read
remains owned by the manager and is drained by `close()`. The captured signal is
checked after that read and immediately before `Bun.spawn`, after caller-owned
environment and stdin accessors have run. Mutating the original options object
cannot replace the signal. Successful spawn removes the abort listener; later
caller cancellation does not change the detached process lifetime, close
ownership or descendant cleanup policy.

Focused proof covers deferred allow/deny, exact signal forwarding, typed
cancellation after execution-options mutation, pending retry cancellation,
pre-aborted file operations, credential-await cancellation, replaced/removed
admission options, reentrant env/stdin cancellation, retained shutdown drain and
post-spawn lifetime. Existing process close, process-group cleanup, timeout and
retry tests are retained and pass. All judgment responses are explicit offline
fixtures; the four incident reproductions intercept launch.

PR48's full engine CI exposed three existing callers that read cancellation
from `JSON.parse(result.output).cancelled`. The new early-abort catch initially
returned only the top-level field. All three unchanged compatibility tests
reproduced the failure. The catch now retains the serialized cancellation marker
as well as the typed field, without reading aborted arguments or inventing a
command, exit status, timeout or retry count before those facts exist. Pending
policy, pre-file-operation and mutated-options tests assert both representations.
The combined compatibility and admission proof passes 29 tests / 75 assertions;
the existing no-retry and detached-lifetime assertions remain unchanged.

This is a bounded admission repair. It does not claim to implement every other
remaining exec cancellation seam: the existing `until` path explicitly defers
external signals, and foreground sandbox/credential/interactive prelaunch waits
and in-progress multi-file operations require separate continuation work. No
permission, containment or owner-terminal policy has been weakened.
