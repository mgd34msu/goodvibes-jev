# Daemon startup maintenance callers

THE-18 remains **In Progress**. This bounded slice restores three original
startup calls, without completing service/update policy, live service adoption,
provider authority, cross-platform execution, release or publication acceptance.

## Source and ownership

The original `mgd34msu/goodvibes-daemon` CLI at
`254699bf5d834cdca41436211ada1ae32bf89258`, blob
`5e8e7aff5a82fbdc604d3a0d637078a35497e058`, calls shared token pruning at
lines 687–715, guarded unattended legacy reconciliation after boot, and the
shared `ensurePublicBaseUrl` owner before its pairing banner at lines 841–867.
The imported `cli.ts` disposition remains partial.

The admitted CLI now calls `pruneStaleOperatorTokens` after acquiring its
canonical companion identity. Both original workspace candidates come from
`workspaceOperatorTokenCandidates`; the selected daemon-home token is never a
pruning candidate when it aliases either location. The shared pruning owner
compares resolved paths and filesystem device/inode identity, including directory
symlinks in either direction and hard links. Unresolvable or unavailable identity
fails closed. Missing candidates are noops; failed removals produce a
credential-free warning. Token overrides remain runtime-only and do not replace
persistent identity.

After listener boot and restart settlement, Linux startup invokes the existing
`reconcileRedundantLegacyUnit`. It reads a fresh, read-only client configuration
from the selected home/surface, excluding runtime overrides, honors the configured
service name and uses the login home for unit paths. Relocated GoodVibes homes
never enter automatic host service reconciliation. Existing canonical-active,
live-mainpid, self-supervision, running-legacy, configured-endpoint, installer
marker, timeout and retirement-outcome guards remain authoritative. The process
owner aborts reconciliation on close; a late async endpoint probe cannot admit
retirement. The process lifecycle awaits startup settlement and graph drainage.
Refusals/failures have structural receipts; reconciliation failure is non-fatal.

## Public URL policy

The original shared helper's **empty-only, stable-name-only** policy is retained.
An explicit URL and the shipped nonempty placeholder are not overwritten. The
separate explicit `webui enable` placeholder/posture policy is unchanged.
Persistence requires an enabled readable served bundle and a settled binding
matching declared host/port/TLS configuration. Runtime-origin endpoint/bundle
inputs and ephemeral/drifted ports are not frozen into settings. The shared
helper now accepts the observed binding, including its actual HTTPS scheme.
The existing ConfigManager persistence owner writes the selected daemon tier;
failed writes retain its rollback behavior and produce a non-fatal warning.
This happens independently of interactive pairing output. Loopback/IP fallbacks
remain unpersisted because the canonical host resolver does not call them stable.

## Verification boundary

Owned temporary homes and synthetic service runners exercise selected identity
preservation, both stale candidates, alias protection, repeated pruning, runtime
versus persisted endpoint/name, overridden-home refusal, cancellation before and
during probe, served stable-origin persistence and no-write cases. Actual CLI
host tests establish admitted caller ordering, settled observed binding and no
post-shutdown persistence/readiness. Existing service guard/outcome and startup
pairing/diagnostic tests remain regression coverage. No real host unit is
installed, started, stopped, disabled, or removed by this verification.

Source tests are contribution evidence. Full combined-batch compiled artifact,
API/contract generation and aggregate qualification are separate required gates.

The alias-safety correction passed 53 focused engine tests (shared pruning,
atomic token publication, rotation, and pairing origins) and 61 focused daemon
tests (startup maintenance, actual-listener diagnostics, and legacy retirement
outcomes). The directory-symlink regressions preserve the same readable token
through repeated startup cleanup and confirm unrelated stale files are removed.
