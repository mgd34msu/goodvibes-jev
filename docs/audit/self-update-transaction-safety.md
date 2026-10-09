# Self-update transaction safety qualification

## Scope

This local repair changes the shared self-update mechanism and the callers needed
to preserve its outcome and cancellation contract. It does not select a release
repository/channel, change update defaults, supply an update artifact to a host,
activate an updater, publish a release, or run downloaded programs.

The verified preparation owns a copy of the caller's target cohort, effect-bearing
options, adapter methods, and downloaded bytes before later asynchronous work can
change them. Conflicting checksum entries fail before filesystem effects. Release
discovery accepts only a manual redirect to a valid SemVer tag on the configured
origin and repository release path. SemVer precedence shares its implementation
with dist-tag alignment, including numeric prerelease ordering and ignored build
metadata. The comparison API retains short-core compatibility (`1.2 == 1.2.0`);
release tags must have a complete, valid, safely representable three-part core.

## Transaction and recovery contract

- Each normalized target reserves its complete namespace, including `.previous`,
  `.update-download`, `.update-previous`, `.rollback-exchange`, and
  `.update-transaction`. Duplicate and overlapping namespaces fail before writes.
- Exclusive claim files contain the operation and complete cohort paths. Existing
  claims and recovery files are never overwritten or automatically discarded.
- Every payload downloads and verifies before staging. Every payload is staged
  and chmodded before a live rename. A final synchronous admission/cancellation
  check occurs after staging.
- Commits record successful renames. Failure runs inverse renames in reverse
  order, refusing an occupied undo destination. Independent targets can recover
  even if another target's undo is blocked. Preexisting `.previous` bytes remain
  parked until the entire cohort commits.
- A clean compensation restores the exact prior live/backup state and allows a
  retry. Incomplete compensation or cleanup retains claims and recovery material.
  `UpdateTransactionError.receipt` distinguishes `committed`, `recoveryRequired`,
  phase, cohort, retained paths, and recovery errors. A cleanup error can describe
  an already committed cohort; it must never be treated as permission to reapply.
- Rollback uses the same ownership and compensation mechanism across its cohort.
  There is no separate unsafe three-rename exception.
- An adapter that supports only the old `UpdateFileIo` members remains TypeScript
  source compatible, but mutation fails closed until it implements atomic
  `writeExclusive` and missing-file-tolerant `remove`. Owned callers and fixtures
  forward these capabilities. Custom adapters must honor the documented rename
  contract: either succeed, or throw without changing either path.

A recovery fence is a request for inspection, not an automatic repair recipe.
The retained claim identifies all cohort paths. Inspect the current live, previous,
and transaction files and establish the intended cohort before any manual recovery
or removal of a fence. This repair deliberately does not guess which bytes should
win after a process crash, an occupied undo destination, or a failed cleanup.

## Limits that remain explicit

Individual same-filesystem renames are atomic. The cohort is not filesystem-wide
atomic, and parking a live file before installing its replacement creates a brief
path-absence window. Compensation handles observed I/O failures; this is not a
power-loss-durable journal and does not promise crash-atomic installation. Install
directories and adapters must be trusted; unrelated writers, parent symlink
replacement, storage corruption, and arbitrary adapter side effects are outside
this ownership boundary.

Daemon downloads and response bodies have a finite, cancellable whole-check budget.
Late completion of a noncooperative fetch cannot enter staging. The synchronous
transaction runs outside the asynchronous cancellation race so an abort cannot
hide a committed or recovery-required receipt. Closed request scopes abort their
owned transport signals and remove timers/listeners. An asynchronous admission
callback is refused, and its rejected promise is consumed rather than orphaned.

Exclusive claims serialize staging/commit; they do not provide release-level
idempotency. Repeated successful calls, including two callers that discovered the
same release while still running an older version, are distinct transactions and
can rotate `.previous` again. Preventing stale-generation reapplication requires
caller admission plus an installed generation/cohort identity check. The daemon's
single updater owner latches successful commits and committed-cleanup failures;
this repair does not invent cross-process release-generation policy.

The daemon's final idle check is a fresh snapshot, not a work-admission lease.
There is no demonstrated host mechanism that prevents new session work throughout
commit and graceful handover. That remains a requirement before claiming fully
safe automatic host updates. Existing production host artifact wiring remains
unchanged and unarmed in the qualified workspace.

The Agent's exported low-level `applyUpdate` still commits its binary, then its
optional native addon, then its browser-driver directory separately
(`products/agent/src/input/commands/update-runtime.ts`). The directory swap has its
own mechanics. This repair does not make that larger product cohort transactional.
The Agent and TUI `/update` handlers and their normal launch wiring are guarded by
`IS_WORKSPACE_DISTRIBUTION` in this checkout: both manifests are private and depend
on the engine via `workspace:*`. Their exported helpers remain directly callable;
a future non-workspace distribution must not mistake generic helper safety for
whole-product cohort safety. Linux runtime `.bun`/metadata/license artifacts and
release-cohort policy also remain outside this repair.

## Local evidence

Tests use injected memory filesystems/fetch responses and temporary filesystem
fixtures only. The matrix covers staging write/chmod faults, every commit and undo
rename, first install, existing backups, retry, cleanup/claim failures, stale
fences, ambiguous namespaces, late caller mutation, retained buffer mutation,
conflicting checksums, malformed/untrusted release responses, SemVer precedence,
final admission refusal, asynchronous admission rejection, cancellation/deadline,
and truthful caller receipts. Daemon lifecycle tests cover terminal recovery
retention/status and avoid any real service action. The final qualification log
records the exact focused suites, full typecheck, API/source gates, and their
results. Live update activation, downloads/execution of release binaries, and
hosted release publication were not performed.

### Qualification results (2026-10-09)

Base: `709ac53566dae671e82e3e958dfc58fb4d9c30be`.

| Check | Result |
| --- | --- |
| Final affected engine suites | 354 tests, 8 files, 1,981 assertions passed |
| Subsequent test-only fixture typing / copied-snapshot assertions | Affected 183 tests, 2 files, 1,313 assertions passed; overlaps the previous row |
| TUI update / discovery / launch consumers | 59 tests, 3 files, 152 assertions passed |
| Agent update / launch / off-switch consumers | 34 tests, 3 files, 84 assertions passed |
| Emitted-JavaScript Node consumers | Passed shared-helper failure/retry/rollback and daemon committed-cleanup/fencing/snapshot smoke; injected I/O only |
| Root typecheck | Production solution emitted; standalone type tests and all nine product configurations passed; original combined command correctly failed on two new test-fixture Buffer generic diagnostics |
| Corrected engine test project | Passed after explicit `Map<string, Buffer>` typing; this correction changed no production source |
| Final daemon option-ownership correction | Affected SDK production and engine-test type projects passed again; focused and emitted-JavaScript mutation regressions passed; no duplicate full/product compilation |
| API extraction and subpath equality | Passed after canonical `prepare:sdk`; 177 SDK subpaths / 10,570 exports, 4 terminal-shell subpaths / 212 exports |
| Public surface comparison | No removed exported names or changed required interface-member sets; five additive self-update exports |
| Source/contract/documentation gates | Passed credential classification, product inspection, judgment lint, zero-any, version/error/internal-ID, temporary-file architecture, platform-console, exports, contracts/freshness, generated docs, browser compatibility and package metadata |

The initial subpath capture correctly failed because a compiler-only build does
not copy the handwritten `sql-js.d.ts` distribution asset. The standard
`prepare:sdk` step supplied it; API extraction/capture/equality then passed.
The original typecheck and missing-asset failure logs are retained. API Extractor
reported non-failing bundled-TypeScript/dependency/ambient-declaration warnings;
metadata reported the preexisting missing/stale README-reading advisories.

Independent review exercised 320 tests with 1,867 assertions, excluding one
real-filesystem smoke by that reviewer's read-only scope. Its concrete findings
were corrected and retested: borrowed payload buffers, asynchronous admission
rejection ownership, caller intent/signal forwarding, and lifecycle recovery
retention. A subsequent narrow review reproduced mutable daemon constructor
options redirecting an install during the HEAD await. Constructor callback/identity
snapshots and per-check bound I/O corrected it; independent rerun passed 183 tests
with 1,374 assertions and reproduced the original case against the repaired source.
These counts overlap the final suites and must not be summed.

The final option-ownership change is confined to the daemon updater and its tests.
The affected SDK and engine-test projects were rerun after it; the earlier passing
standalone/product projects retain their unchanged-public-interface qualification.
The TUI's final edit only corrected two atomicity comments. The final subpath
snapshot was refreshed because the updater's private declaration members changed;
its public member set and signatures did not change.

This is bounded local qualification, not a full `validate`, all-workspace runtime,
all-platform artifact, live service, hosted CI, or release-publication pass. No
remote write or production activation was performed.
