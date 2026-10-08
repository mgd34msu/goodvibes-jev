# TUI provider-health canonical ownership

Scope: retained-rename review rows 21 and 22 on baseline
`dfe395031e14542ac21d35fb89336886fbdacffd`. This is a bounded source/consumer
implementation, not whole-product acceptance or a change to the provider-ID
classification inventory decision.

## Why retirement was insufficient

`/accounts` already uses the engine's credential-backed provider-account
registry, but that registry has a different route vocabulary and responsibility.
It does not replace generic provider-declared `secret-ref`, `anonymous`, or
`none` descriptors and their repair hints. `/health` covers many individual
findings, but its MCP lifecycle report does not replace the eight-domain typed
summary or the security snapshot's `allow-all`/quarantine findings. The original
HOIST obligations therefore remain useful responsibilities rather than DROP
candidates.

## Ownership and real production adoption

- `packages/engine/sdk/src/platform/runtime/ui/provider-health/domains.ts` owns
  all eight typed domain summaries. Maintenance still delegates to the existing
  engine evaluator. All posture decisions use typed flags, counts and reported
  states; provider prose is only displayed.
- `packages/engine/sdk/src/platform/runtime/ui/provider-health/routes.ts` owns
  original descriptor normalization, fixed route priority, configured/usable
  selection, freshness, issues and repair hints. It does not change actual
  runtime route selection or the credential-backed account registry.
- The declared public `sdk/platform/runtime/provider-health` export is pure and
  browser-safe. Types are imported without loading runtime services, config
  managers, provider implementations or credential stores.
- The two retained TUI helper paths are compatibility re-exports, with no local
  algorithm owner.
- `registerBuiltinModals` calls `createBuiltinProviderHealthModalSurface`, which
  composes the existing real runtime inspection query and live read models.
  Existing Health/Accounts provider rows and Enter repair dispatch remain.
  Routes and Domains are read-only tabs carrying canonical detail. The Routes
  tab is deliberately separate from the selectable repair list: mixing long
  informational blocks with selectable provider rows made trailing details
  unreachable. Existing host line wrapping/scrolling is reused.

## Bounded honesty corrections

1. Unknown maintenance context is `info`, retaining the explicit unavailable
   summary, instead of the old fall-through `good` level.
2. `providers/runtime-snapshot.ts` no longer fabricates `auth.mode = none` when
   runtime metadata is absent or null. The console labels absence unavailable; a provider's
   explicit declaration of no-auth still stays healthy. Models/usage fallback
   data and declared auth semantics are unchanged.
3. A failed inspection refresh identifies retained cached data as last-known.
   Refresh generations discard superseded results and work from a closed modal.
   Automatic ticks coalesce pending reads so slow metadata still publishes.
   Missing domain input reports unavailable rather than fabricating healthy
   counts.

## Source verification

- Engine posture suite: 28 tests. Covers eight-domain ordering and decisions,
  trust/quarantine, maintenance unknown/failure/pressure, descriptor synthesis,
  priority, usable/configured distinctions, hints, missing auth and a real
  runtime-snapshot typed call. Its browser test bundles a public-name consumer
  and executes the emitted functions; a successful build flag alone is not
  treated as executable proof.
- Existing engine fallback-chain suite: 4 tests.
- TUI production ownership suite: 9 tests. Uses the real builtin factory and
  runtime inspection composition, actual ConfigModal renderer, missing and null
  metadata, explicit none/unconfigured, unavailable domains, stale refresh and
  overlapping refresh/close/reopen generations and slow automatic polling. Traversal
  uses the keyboard dispatcher at wrap widths 30, 18 and 60, reaching the last
  wrapped hint after resize and closing through Escape.
- Existing provider/settings modal suite: 5 tests.
- Existing ConfigModal live-update suite: 3 tests.
- Existing provider repair command-row suite: 3 tests.
- Local TUI source and test TypeScript checks passed under the shared compiler
  lock with a 4 GiB heap. Final shared-stack qualification remains authoritative.
- Independent review verified canonical ownership, production composition,
  browser execution and navigation. Its initial inaccessible-details and
  optional-property contract findings were fixed and re-reviewed.

## Final shared-stack gates

No engine rebuild, generated API snapshot mutation, hosted CI or publication is
part of this local source pass. The coordinated shared stack must generate
engine declarations and check/update `packages/engine/etc/subpath-api-surface.json`,
measure/add the new `./platform/runtime/provider-health` bundle budget, and run
API, bundle, declaration and aggregate type gates on the final composed head.
Migration counters and historical review snapshots have not been rewritten to
imply that these final shared-stack gates have already passed.
