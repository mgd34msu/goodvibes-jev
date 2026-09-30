# Daemon service commands and legacy unit migration

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`.

The product ports `daemon/service-commands.ts`,
`runtime/legacy-daemon-migration.ts`, and `runtime/legacy-daemon-reconcile.ts`,
plus the two original service command suites. These five mappings remain PORT,
as the inventory's later owner ruling explicitly preserves migration and
reconciliation. They use the canonical engine `PlatformServiceManager` rather
than introducing a separate host-service implementation.

The seven subcommands preserve their argument contract, structured status
exit codes, local service definition, login-home versus state-home split,
legacy-unit detection and explicit migration consent. A new unit must report
healthy before retirement of the old unit is attempted; unsuccessful startup
rolls back the new unit. An unidentified process occupying a port is reported
without being killed. Unattended reconciliation retains its canonical liveness,
self-supervision, legacy-running, configured-endpoint and installer-marker
guards, plus per-call and cumulative deadlines. This port does not execute any
of those operations on the development host.

The inventory already requires compiled-binary recognition to use exact
basename equality. Three new regressions reproduce why: the pinned substring
test incorrectly accepts an interpreter in a `goodvibes-daemon` directory and
similarly named helper executables. The port checks the declared artifact name
exactly. Explicit environment override and packaged-launcher precedence are
unchanged.

## Fixture safety and evidence

All original assertions are preserved. Unit/config filesystem writes use owned
temporary homes through the guarded test runner. Systemctl and loginctl calls
are injected, and TCP, process-liveness, cgroup and synthetic unit-file reads
are fixture-backed. The cumulative-deadline test now supplies its absolute
stub executable instead of depending on an in-process PATH mutation that Bun
does not honor. The hanging-runner fixture uses `exec sleep` so its bounded
timeout does not leave a separate sleep descendant. Unconfigured synthetic
unit removal throws instead of falling back to a real filesystem path.

The original 84 tests pass. The three basename cases fail against the pinned
recognizer and pass after the required correction. Assertions cover dry-run
nonmutation, healthy-new-before-old ordering, name collisions, rollback,
active/unknown/self-supervised refusal, timeout reinspection, a cumulative
deadline, and fixed 0/3/4 service-status results.

Only temporary unit files and fake service command results are exercised.
No real service, user config, system security setting or network setting is
changed. Actual platform installation, the executable dispatcher, packaging,
upstream reconciliation and complete daemon parity remain outstanding.
