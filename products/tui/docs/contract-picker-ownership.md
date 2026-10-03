# Contract attempt picker ownership (THE-108)

This bounded THE-62 parity repair starts from main `6b8f84e7`. The inventoried
FleetActs flow lists the selected contract unit's recorded held attempts, previews
one candidate, and applies it only after the owner confirms. The corresponding
source obligation is retained in `docs/audit/tui-retained-rename-review-2026-10-02.json`.
This patch does not declare that entire obligation or the TUI migration complete.

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

## Evidence

The new test file is `src/test/input/fleet-pick-ownership.test.ts`. It drives the
public process registry, real AgentsModal input/rendering, SurfaceModalHost and
real ChangesModal preview/confirmation with local synthetic gateway responses.
It covers 20 cases / 103 assertions, including deferred success/failure, repeated
input, stale contract state, retry, selection changes, stale confirmation callbacks
and late admitted apply completion. Independent review additionally reproduced
and drove fixes for archive navigation and opening search while the list read
was pending. No provider or live daemon calls are made.

The initial ten regressions all failed on the unchanged main source. Independent
review also replayed the subsequent 13-test ChangesModal harness on main: 12 failed
and one existing retry behavior passed. This distinguishes missing behavior from
new happy-path coverage.

The unchanged guarded product runner passes all 21 `fleet-` files: 312 tests /
1,429 assertions. Run from `products/tui`:

- `bun scripts/run-tests.ts fleet- --jobs 2`
- `node --max-old-space-size=4096 ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json`

The full test-program typecheck passes with the larger heap. The first invocation
hit Node's default roughly 2 GiB heap ceiling; that failure is retained separately
rather than described as a passing run. No guard or runner-admission configuration
was changed. No source-disposition row was relabeled and no legacy responsibility
was retired by this patch.

## Remaining acceptance

Independent exact-commit review, full zero-exclusion product tests, current native
binary/PTY and live-provider parity, exact-head CI and the remaining source
inventory remain separate gates. Focused synthetic UI tests are not compiled-shell
or live-provider acceptance. This local repair does not include publication,
merging, release, or PR56 filesystem/security work.
