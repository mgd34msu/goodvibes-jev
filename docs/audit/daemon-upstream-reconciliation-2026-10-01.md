# Daemon content reconciliation after the platform update

The reviewed upstream range is `443e5ee4d6cda0d36d57e2886398d0836074a4a9`
through `254699bf5d834cdca41436211ada1ae32bf89258` (four commits, 41 changed
files). The companion JSON records both full tree IDs, every changed file's
old/new Git blob and its individual ruling. The applied source-accounting pin
now advances to the reviewed target with seven added, seven retired and 27
updated inventory rows. All 86 existing mappings remain valid; three added
mappings cover the landed wire, version and adapted contract-lifecycle tests
(89 total). The contract test preserves lifecycle intent rather than restoring
the removed WRFC engine. This is a partial
migration: five native-binary/release/compiled-hosting deferrals remain open after
the emitted CLI-dispatch acceptance was mapped on October 7.

The four upstream commits update dependencies to SDK 2.1.0, own the WRFC fix
engine's disposal, replace coverage/style/source-text gates with behavioral
tests, and correct the source-run package version. Pairing, web serving,
wake provisioning, configuration and executable dispatch source are unchanged.
All seven held setup source/test blobs still match the original baseline.

## What this integration carries

The previously reviewed setup slice is reapplied on Jev main
`5957c2be53b6fd5f393885ca00403a9eb4ff8ac6`. The earlier work remains preserved.
Its intentional differences from upstream remain: valid IPv6 origins, one
validated daemon-file settings update, refusal before any partial listener
transition, and explicit handling of the default pairing URL when listener
posture changes. Those fixes were not superseded by an upstream change.

Jev already composes and owns one contract runner and store, including failed
startup cleanup. It does not recreate the legacy WRFC engine. The new real
daemon graph regression holds an actual contract reading, holds its pending
disk debounce beyond the test ceiling, and verifies that close cancels the
reading, flushes the contract snapshot and detaches further agent admission.
The existing boot, rollback and interval-ownership tests remain in place.

The source-version correction is already implemented for Jev's own package
identity and covered by real imported-source fixtures. The upstream package
version does not replace the private Jev daemon version. HTTP `/status`
continues to report the SDK/platform version. This partial product directly
uses its package version in CLI rendering and cluster identity; the pairing
adapter takes a caller-supplied version. Wiring that version into startup
banners, pairing and the binary update artifact remains the future
executable's responsibility, as it is in the complete upstream daemon.

Two timeout tests adopt the upstream outcome-based approach. The service test
must prove it invoked its absolute-path owned stub and refused after timeout;
the remote process test must return a timed-out, nonzero child exit. The
service stub eventually prints `active`, so omitting the synchronous spawn
timeout changes the refusal reason. It is a direct Bun process with no
descendant sleeper. The remote async child outlives its test ceiling if merely
waited out. Neither needs a separate loaded-host speed threshold. Existing descendant, pipe, retirement, read-only and
failure-receipt regressions are preserved.

The follow-on `daemon-wire-proof.md` records the now-adapted real WebSocket,
SSE replay and hosted streaming session tests for the configured graph. Its
fixture input boundary is explicit; it does not establish production default
intake or binary readiness.

## Remaining acceptance from this upstream range

The original `src/test/daemon/cli-dispatch.test.ts` acceptance is now mapped to
`products/daemon/src/test/cli/entrypoint.test.ts`: the emitted dispatcher proves
package version, misspelled-command exit 2 with help, sessions help, exact
`Unknown command: doctor`, and `--daemon-home ... send hello` first-word refusal.
Each child exit has an owned deadline and bounded cleanup; an interrupted
held-poll child proves forced termination and listener closure. This closes
only that test row, not the whole `src/daemon/cli.ts` source mapping.

- Compiled binary boot and hosted-session proof, including saved reply text,
  and package/version/release preparation suited to this monorepo.
First/queued-continuation conversational-tool authority is covered by merged
PR30 / THE65 (`ef9baadd`), including real provider probes for explicit owner-channel
grants and denied reads/acknowledgments; see `sdk-channel-capabilities.md`. The
retired personal-capture source-scraping test is not restored. Remaining SDK
dependency integration stays separately tracked; no legacy heuristic or WRFC
code is copied over Jev's typed decisions.

Upstream deleted structural and coverage filler is not a parity requirement.
The monorepo keeps its own reviewed test isolation, real containment proof,
package contents, exported API and platform-resolution checks. Applied daemon
accounting now reflects this reviewed range; other products retain their own
explicit applied baselines and forward targets.
