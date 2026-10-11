# Contract attempt picker ownership

The FleetActs flow lists the selected contract unit's recorded held attempts,
previews one candidate, and applies it only after the owner confirms.

## Behavior repaired

The candidate-list and preview awaits previously had no modal/request ownership.
Escape, F2 close, filter dismissal, and close/reopen could be followed by stale
picker or Changes-preview publication. Repeated Enter admitted concurrent reads
and previews. A retained confirmation callback could submit an apply twice.

`FleetActs` now gives each picker request a distinct identity. Cancellation clears
that identity before closing its preview. Superseded success and failure results
cannot publish UI. Reads and previews are coalesced while owned work is pending;
Escape and current preview failures leave a usable subsequent flow. The current
public contract unit, attempt group, candidate membership, and terminal state are
rechecked after awaits and before confirmation. Existing engine/daemon permission
and qualified-target boundaries remain authoritative.

`AgentsModal` revokes ownership on close, Escape, newer list selection, archive/search/follow/hosted navigation, competing
list interactions and deep links. Confirmation is one-shot. An already admitted apply still reports its real
success/refusal/error receipt after dismissal; its completion cannot close or
clear the newer picker. Dismissal is not represented as remote cancellation.

## Validation

`src/test/input/fleet-pick-ownership.test.ts` drives the public process registry,
real AgentsModal input/rendering, SurfaceModalHost and real ChangesModal
preview/confirmation with local synthetic gateway responses. Preserve deferred
success/failure, repeated input, stale contract state, retry, selection changes,
stale confirmation callbacks and late admitted apply completion. Include archive
navigation and opening search while the list read is pending. Controls must
expose missing ownership behavior rather than cover only happy paths. No provider
or live daemon calls are needed.

Run the guarded fleet suites and full test-program typecheck from `products/tui`:

- `bun scripts/run-tests.ts fleet- --jobs 2`
- `node --max-old-space-size=4096 ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json`

Do not weaken guard or runner-admission configuration to obtain a passing result.

## Acceptance boundaries

Full zero-exclusion product tests, current native binary/PTY and live-provider
parity, and exact-head CI have their own acceptance requirements. Focused synthetic
UI tests do not establish compiled-shell or live-provider acceptance, or PR56
filesystem/security behavior.
