# Daemon remote process runner hoist

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`,
`src/daemon/handlers/remote/backends/process-runner.ts`.

The shared helper now lives at engine
`sdk/src/platform/runtime/remote/host/backends/process-runner.ts`. It retains
the Bun runtime requirement, argv/cwd/environment/stdin inputs, stdout/stderr
capture, actual exit status and timeout flag. It remains an internal dependency
for the forthcoming backend port; no public route or new API export is added.

## Deadline and cleanup corrections

The imported implementation passed four basic behavior tests and failed four
new regressions: a blocked stdin end prevented its timer from starting, input
and output failures did not stop the owned child, and inherited pipes kept a
1 s timeout waiting past 2 s. The fixture programs do no network I/O.

The port starts the deadline immediately after spawning, drains output while
writing input, and races the complete operation against the deadline. On
timeout or I/O failure it stops the owned child, cancels its stream readers and
awaits its real exit. A late stdin rejection remains handled. The timer is
cleared on every terminal path.

On POSIX, Bun 1.3.14's documented detached option creates a separate process
group. The runner stops that owned group, including ordinary descendants that
retain its pipes, whether the immediate parent is still alive or has exited.
Tests use a delayed marker file to prove the grandchild did not continue doing
work after timeout, not just that the caller stopped waiting.

This is not a security sandbox. Deliberately detached/new-session descendants
can escape the group. Windows retains direct-child termination, without a new
claim to process-tree containment. Normal completion leaves intentional
background work unchanged. Credential-bearing external CLIs and production
hosts are not exercised by these tests.

The later credential-lifecycle prerequisite adds an optional AbortSignal to
the internal runner: pre-aborted work never spawns, and active cancellation
uses the same owned-child cleanup before rejecting with AbortError.

The final process and registry run passes 40 guarded tests across three files,
including nine process-runner tests.

## Decision review

Argv emptiness, runtime method existence, stream done/chunk flags, actual exit
status and deadline expiry are protocol/runtime facts. POSIX versus Windows is
an explicit runtime platform branch. No prose meaning, ranking, guessed
permission or heuristic fallback is added. The backend and route admission
contracts remain work for their subsequent slices.
