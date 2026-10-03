# Background process listing completion

This bounded SDK adaptation takes the `ProcessManager.list().done` addition
from goodvibes-sdk `bbfa3ac0bf21ca7ddc0fd792945dc1dbfd70316a`, retained in
the pinned SDK target `17eae838461a6529135fe2cad41332d2dc46cb27`, onto Jev
source-review base `3fa2f14e1719b92497084b34ee3cbad851563f4f`. The reviewed
source was composed onto canonical main
`cef1a3d529797d63ddb8e95f48904ec76c638dca` after PR53, then
`22805dbd6328d9408793893adfc03a4d4a168615` after PR49. Both compositions
retain the reviewed runtime/test blobs and the intervening API additions.

Each list row now projects the existing authoritative `BackgroundProcess.done`
boolean. `bg_list` serializes the same rows. Consumers can distinguish running
work from any settled exit, including a signal or timeout, without parsing the
display-only `status` string. An elapsed timeout with `kill_on_timeout: false`
is not completion. This is a PORT of process state, with no judgment or new
heuristic.

The change does not import the upstream lifecycle implementation. Jev retains
its admission-signal checks from PR48, shared close ownership, process-group
termination and bounded output drain. An exited group leader still reports
`done: false` until the owned descendant cleanup and output collection settle.
Explicit stop still removes the tracked row immediately; no stopped-record
retention behavior is changed.

## Verification

The focused suite exercises actual processes through both `list()` and
`bg_list`: live work, normal zero/nonzero exit with final stdout/stderr, signal
termination, watchdog termination, and a timeout deliberately allowed to keep
running. A real owned descendant acknowledges TERM and holds the inherited
pipes until explicitly released, proving the leader's exit alone does not
report completion. A controlled child-handle fixture independently holds each
output stream open after exit, proving both streams drain before completion.
All real jobs are closed in `finally`; the controlled handle never signals a
host PID. Credential readings use the existing offline fixtures.

Removing just the new `done` projection reproduces the missing-field failure
in the live-to-normal-exit test. Adjacent close, process-group, timeout and
admission-cancellation suites are retained. The two existing fleet list fixtures
now project their record's completion state too, as required by the additive
public type and the upstream change. On the final composed base, the eight
focused/adjacent files pass 88 tests and 410 assertions.

Current and baseline declarations are each emitted from a checked transitive
graph of 78 repository source files under the SDK's strict type options, using
the repository's TypeScript-extension handling for imported judgment sources.
The repository's API snapshot generator reproduces the canonical baseline
`ProcessManager` entry exactly from that checked baseline declaration. Applying
the same generator to the checked current declaration produces only the new
`done: boolean` field. Only this generated row replaces its baseline; all other
API entries are preserved. This bounded proof does not claim a full workspace
build or typecheck.

The normal, merged credential-only commit hook is retained; full build,
typecheck and integration/API gates remain required on the exact PR head in CI.
Final gate results are reported separately from focused proof, and a successful
local commit alone does not establish merge readiness.
