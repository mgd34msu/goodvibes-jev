# Captured runtime permission snapshot cost (THE-103)

The default captured contract REPL admits the optional Node/npm runtime when
its command shape requires conservative admission. That runtime remains
available to authorized nested commands. The Bun-only fixture adjustment in
PR #118 did not change this production behavior.

## Profile and bounded correction

On Linux x64 with Bun 1.3.14 and the installed real Node/npm closure, the actual
temporary-Git contract → AgentManager → AgentOrchestrator → default REPL →
scripted provider case took 54.4 seconds on main `67565d44` with optional
Node/npm authorized (repeat: 50.8 seconds). It retained the existing 60-second
settlement observation and 90-second test deadline.

A metadata-tapped run performed 42,507 npm `realpath` and 46,454 `lstat` calls.
The corresponding candidate took 26.0 seconds with exactly the same counts.
These are local measurements, not a cross-host timing guarantee. No timing
assertion replaces the deterministic authority checks.

`createPermissionConfigReader.getSnapshot()` previously cloned every config
domain through `ConfigManager.getRaw()` for each permission read. It now binds
the existing manager-owned `getAutonomousPermissionSnapshot()` accessor at
construction and calls it afresh for each snapshot, returning its detached
permissions value. That accessor copies the same owned permissions state
without consulting observers. Legacy readers lacking the accessor still use a
fresh full snapshot. Failure of an available accessor propagates; it never
selects a broader fallback after a failed read.

This removes unrelated configuration copying, not runtime admission work.
There is no permission-result cache, shared runtime tree, skipped original
path or alias check, delayed revocation, changed-file exemption, host runtime
fallback, or deadline increase. Node/npm source identity, captured authority,
projection isolation and final delivery checks are unchanged. Ordinary
noncaptured permission readers use the same fresh snapshot semantics.

## Regression evidence

- Real-manager tests reject any full-config clone while proving fresh values
  after settings change, nested snapshot detachment, same-directory owner
  isolation, construction-pinned accessors, legacy compatibility, failure
  propagation, and live stored path denials.
- The real default contract matrix retains the Bun-only positive and two
  revocation controls and adds an optional-runtime-enabled positive control.
  That control invokes real `node`, `npm` and `npx` from the contained Bun
  evaluation with file-backed stdio under the existing no-socket boundary.
- Existing runtime tests exercise changed executable and package identity,
  source/canonical/alias denial, forged and cross-owner tokens, current
  revocation, cancellation, late policy completion, and direct real Node/npm
  plus TypeScript/ESLint commands. Those boundaries are not replaced by the
  snapshot tests.

Broader captured-tool parity and the remaining THE-103 acceptance matrix stay
open. This correction is one bounded production performance increment.
