# TUI canonical HOIST accounting, 2026-10-08

This current reconciliation moves exactly three original HOIST source rows from
unresolved to mapped. It changes no runtime or tests. The original inventory pin
`0d69500f598a90f0f4aecae213b0e003764899dd`, historical audit hashes and historical
retained-review statuses remain unchanged. Rows 1, 21 and 22 of
`tui-retained-rename-review-2026-10-02.json` describe their stated old baseline;
this document records the later implementation rather than rewriting that history.

The reviewed implementation is main
`925c0d87d7e9841d2a54c95b993f075bbc96d1df`. The accounting branch starts at
`beb4a2553d7d6379ef678d6ea7d53d3fe76aa093`, preserving the separate, already
recorded memory-consolidation-gateway mapping and its receipt implementation.
All three rows' owner and caller files below are byte-identical to reviewed main.
Memory receipt and other native/fleet or passive-context obligations are outside
this accounting change.

## Exact source responsibilities and production callers

### src/panels/eval-registry.ts

Original HOIST purpose: engine observe owns latest suite/gate results, running
state, last-run time and subscriptions. Exact suite-name matching stays code.

- Owner: `packages/engine/sdk/src/platform/observe/eval-registry.ts`, blob
  `e0aa0e57372742bffcd5298ff5d64a36a701aa2e`.
- `products/tui/src/views/eval-registry.ts:5` directly re-exports the public engine
  constructor, without a local implementation or subclass.
- `products/tui/src/runtime/bootstrap-command-parts.ts:421` constructs one
  canonical registry per production command context.
- `products/tui/src/input/commands/eval.ts` reads that context for run, gate and
  compare; `input/command-registry.ts:404` names the public owner type.
- `products/tui/src/test/input/eval-command.test.ts:92` onward covers the actual
  composition factory and built-in eval runner, shared retained state and context
  isolation, identity, suite/gate replacement, clock, running notifications and
  unsubscribe. Engine evidence also lives in `observe-hoists.test.ts`,
  `runtime-eval-runner.test.ts` and `platform-eval-smoke.test.ts`.

See `tui-eval-registry-adoption-2026-10-08.md` for the implementation's focused
local verification. Built-in scenarios establish composition, not live-provider
performance.

### src/panels/provider-health-domains.ts

Original HOIST purpose: all eight typed health-domain summaries, including
maintenance delegation and auth/settings/remote/MCP/intelligence/continuity/
worktree posture, details and next steps.

- Owner: `packages/engine/sdk/src/platform/runtime/ui/provider-health/domains.ts:36`,
  blob `ed2e630d3d50594dc5a926ceccd6608e65e976ed`.
- `products/tui/src/views/provider-health-domains.ts:2` is a compatibility
  re-export of `sdk/platform/runtime/provider-health`.
- `views/builtin-modals.ts:66` registers the production factory at line 237,
  composing real runtime inspection and the live read-model snapshots.
- `views/modals/provider-health-modal.ts:128` calls the canonical domain builder
  and renders its Domains tab.

### src/panels/provider-health-routes.ts

Original HOIST purpose: normalize declared/legacy auth routes, fixed priority,
configured/usable distinctions, preferred/active route, freshness, issues and
repair hints. This does not replace runtime routing or provider-ID classification.

- Owner: `packages/engine/sdk/src/platform/runtime/ui/provider-health/routes.ts`,
  blob `8abdc4972c6cb33c59d5f97d6977f3e4f518e901`.
- `products/tui/src/views/provider-health-routes.ts:2` re-exports the canonical
  public functions without another local algorithm.
- The same production builtin factory reaches
  `views/modals/provider-health-modal.ts:111`, which calls `buildAccountPosture`
  and renders canonical route details while retaining selected-provider repairs.

Both provider-health rows have engine evidence in
`packages/engine/test/provider-health-posture.test.ts`, including execution of a
bundled browser public-name consumer. Product evidence in
`products/tui/src/test/views/modals/provider-health-ownership.test.ts` covers the
real factory, runtime inspection and ConfigModal rendering, missing/null metadata
versus explicit no-auth, unavailable domain data, repair dispatch, narrow-width
keyboard navigation and refresh/close/reopen ownership. These controlled inputs
prove real composition; they do not claim live-provider acceptance. See
`tui-provider-health-canonical-ownership-2026-10-08.md` for the earlier focused
implementation review, whose then-pending shared-stack qualification is distinct
from the later hosted receipt below.

## Exact-main hosted qualification

GitHub check-run readback for `925c0d87d7e9841d2a54c95b993f075bbc96d1df` on
2026-10-08 found 45 successful checks; auto-release was skipped. Relevant receipts
from [workflow 37730235426](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37730235426):

- [TUI product tests](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37730235426/job/113157816424)
- [Validation](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37730235426/job/113157458242)
- [Build](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37730235426/job/113157458064)
- [Exports-map resolution](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37730235426/job/113160922236)

These are existing exact-main receipts, not newly run tests or CI for this
accounting-only commit or the memory-receipt successor.

## Derived accounting and limits

Starting branch: 1,096 mapped and 522 unresolved, including its separate single
memory-gateway mapping. Three exact HOIST entries are added to mappings and
removed from unresolved: **1,099 mapped / 519 unresolved / 1,618 total**.
`samePathMappings` stays 1,027; the existing additional-mapping counter
`verifiedRenameMappings` becomes 72. All unrelated entries and dispositions are
preserved. Source accounting remains partial; no original test row, DROP decision,
whole-product parity or THE62 acceptance is inferred.

## Accounting-only verification

- Lightweight product-workspace check: passed, four products present and zero pending.
- Exact manifest comparison: only the three named rows move; all 1,618 source
  identities remain unique, conserved and disjoint across mapped/unresolved sets;
  the independent memory row, original source pin and historical audit are retained.
- Whitespace check: passed.

The first product check required unavailable local TypeScript resolution; a
short-lived link to existing dependencies supplied it without installation. The
check then caught product caller paths incorrectly listed as HOIST targets. Those
paths now live in provenance, with only canonical engine owners in `targets`;
final product checking passed. The dependency link was removed. No build or
product test rerun is claimed for this accounting-only change.
