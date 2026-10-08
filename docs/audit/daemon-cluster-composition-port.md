# Daemon cluster composition port

Source pin: `443e5ee4d6cda0d36d57e2886398d0836074a4a9`.

The two real product adapters (`runtime/cluster-composition.ts` and
`runtime/cluster-group-composition.ts`) retain their PORT dispositions. The
coordinator remains the one owner of election decisions; the group layer
supplies the signed borrowed transport and reads actual surface holdings and
mastership through late-bound closures. Each inbox account retains its own
election surface. No semantic decision or authority rule has changed.

Optional injected transport/clock seams leave production UDP/system-clock
defaults intact. The original three holdings assertions now run real elections
on MemoryClusterBus/FakeClusterClock, preserving the exact elected surface,
reason and account-name privacy assertions. Tests start the group before the
coordinator and close both owners. They open no UDP sockets.

## Reproduced lifecycle corrections

The original product wrapper resolves a second start before actual group
readiness and retains a failed start as success. Two regressions fail against
that wrapper even after the engine lifecycle fix. The port shares startup and
shutdown promises through the return announcement. Shutdown cancels the runtime
first, so an admission waiting for peers is abandoned before waiting for startup;
then it awaits accepted startup and transport cleanup. Explicit restart is
allowed after clean shutdown, and cleanup failures remain observable.

A returning-member test additionally reproduces a retained admission deadline
after stop. The narrow engine `group-admissions.ts` correction retains and cancels
that deadline on settlement. It also handles synchronous settlement during send,
which can happen on an in-memory transport before a timer handle is assigned.
Four independent deadline cases fail on the original code: abandon, failed send,
synchronous settlement and housekeeping expiry. Natural expiry remains intact.
No join/rejoin authentication, membership, key handling or reply policy changes.
Fixtures keep dummy cryptographic material only in memory and owned state roots.

## Remaining integration

The new gate contract tests prove actual start/stop completion is awaited and
that group startup precedes election. The original `cluster-inbox-gating` suite
was unmapped at this slice. Its current registration-boundary restoration is now recorded separately in
`docs/audit/daemon-cluster-inbox-registration-proof.md`; these gate-only tests
are not its substitute. That restoration uses synthetic adapters and does not
remove production Slack/email cluster refusals.

The complete daemon runtime and original `testing/daemon-fixture.ts` are not yet
ported. First boot acceptance remains actual createRuntimeServices plus
DaemonServer, ephemeral loopback HTTP/gateway requests and awaited full shutdown.
This slice does not claim complete product parity or a live Jev/provider proof.
