# Self-update transaction safety

Shared update mechanics do not select a release repository/channel, change
update defaults, activate a product updater, supply host artifacts or authorize
publication or downloaded-program execution.

Preparation owns a copy of the caller's target cohort, effect-bearing
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
or removal of a fence. The transaction deliberately does not guess which bytes should
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
this mechanism does not invent cross-process release-generation policy.

The daemon's final idle check is a fresh snapshot, not a work-admission lease.
There is no demonstrated host mechanism that prevents new session work throughout
commit and graceful handover. That remains a requirement before claiming fully
safe automatic host updates. Actual product activation remains a separate owner; generic transaction safety
must not be interpreted as an enabled automatic-update policy.

The Agent's exported low-level `applyUpdate` still commits its binary, then its
optional native addon, then its browser-driver directory separately
(`products/agent/src/input/commands/update-runtime.ts`). The directory swap has its
own mechanics. The shared transaction does not make that larger product cohort transactional.
The Agent and TUI `/update` handlers and their normal launch wiring are guarded by
`IS_WORKSPACE_DISTRIBUTION` in this checkout: both manifests are private and depend
on the engine via `workspace:*`. Their exported helpers remain directly callable;
a future non-workspace distribution must not mistake generic helper safety for
whole-product cohort safety. Linux runtime `.bun`/metadata/license artifacts and
release-cohort policy also remain outside the shared transaction.

## Validation

Tests use injected memory filesystems/fetch responses and temporary filesystem
fixtures only. The matrix covers staging write/chmod faults, every commit and undo
rename, first install, existing backups, retry, cleanup/claim failures, stale
fences, ambiguous namespaces, late caller mutation, retained buffer mutation,
conflicting checksums, malformed/untrusted release responses, SemVer precedence,
final admission refusal, asynchronous admission rejection, cancellation/deadline,
and truthful caller receipts. Daemon lifecycle tests cover terminal recovery
retention/status and avoid any real service action.

Keep full type/API/source gates, public consumer validation and canonical SDK
preparation separate from these fixtures. Compiler emit alone does not copy the
authored ambient `sql-js.d.ts` asset. Check emitted JavaScript consumers with
injected I/O as well as source tests; preserve immutable target/options/callback
and buffer snapshots through discovery awaits. Declaration regeneration must
retain unrelated public entries and distinguish additive exports from changes to
required interface members. These tests do not activate live updates or execute
release binaries.
