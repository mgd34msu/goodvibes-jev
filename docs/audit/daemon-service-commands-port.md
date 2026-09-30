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

The initial port preserved the original assertions. Unit/config filesystem writes use owned
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

## Incomplete retirement preserves recovery state

An additional injected-runner probe reproduced an inherited defect: failed
legacy stop/disable commands still invoked unit-file removal and returned
success. The repair stops retirement when either command does not positively
report success, including timeout or missing status. It retains the old
definition, reports the new healthy unit and the unconfirmed legacy state,
and asks the operator to verify before retrying. No diagnostic text is parsed
to infer that an unsuccessful command meant the unit was already stopped.

The original test that accepted removal after failed stop is intentionally
replaced with a preservation assertion. Additional tests cover failed/unknown
stop and disable results, removal exceptions including empty or absent error
messages, and failed reload after removal. Removal failure and reload failure
produce nonzero incomplete receipts instead of a false success. Completed
steps remain explicit; the new healthy unit is not rolled back after legacy
retirement has begun.
Thrown runner errors, including a thrown undefined value, produce the same
unknown/incomplete receipt; a reload exception after removal cannot hide the
steps that already completed. These cases use synchronous fixture outcomes
and require no timing thresholds or real host commands.

The separate unattended reconciliation path now uses one completion function
for both successful disable and timeout followed by confirmed disable. A
removal exception returns `failed` / `remove-failed`; it no longer reports
`removed` / `retired`. A failed or thrown reload returns `failed` /
`reload-failed` and states that removal already completed. This preserves the
machine-readable outcome as well as the prose. The focused service and
retirement selection passes 115 tests with 523 assertions before integration
with the separate read-only preparation and existing-target repair.

Only temporary unit files and fake service command results are exercised.
No real service, user config, system security setting or network setting is
changed. Actual platform installation, the executable dispatcher, packaging,
upstream reconciliation and complete daemon parity remain outstanding.

## Read-only preparation and ownership-safe rollback

Service manager construction now uses the canonical `ConfigManager` with an
explicit read-only option. The same defaults, layer order and pure migration
transformations are applied in memory; configuration files, migration receipts
and quarantine state are not written. Mutating config methods refuse in this
mode. The product no longer eagerly runs persistent config migration before a
dry run, rejected endpoint flags or status request; actual daemon boot retains
the separate migration entrypoint.

The service status query no longer deletes a stale PID file. Explicit stop and
uninstall still own that cleanup. Fixture tests cover manual and Windows
status with malformed PID files without invoking any host process operation.

Migration refuses a managed target that already has a definition or reports
an active runtime, before installation or rollback. Failed setup cleans up
only the newly attempted target and retains recovery state when stop/disable
cannot be confirmed. Tests include custom target names and thrown install or
start failures. Original runners now model an initially inactive target that
becomes active only after enable, so retirement tests reach their intended
phase rather than falsely declaring a preexisting runtime.

The combined five-file service selection passes 135 tests / 619 assertions;
87 engine migration/service tests pass with 310 assertions. Final compiler,
API and aggregate evidence is recorded on the repair commit and PR.
