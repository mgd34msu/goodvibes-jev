# Bounded TUI memory receipt ownership adoption

Base: `925c0d87d7e9841d2a54c95b993f075bbc96d1df`.

This closes only the original HOIST source responsibility for
`src/panels/memory-consolidation-gateway.ts`, described by the exact inventory
row in `docs/inventory/tui.md` and row 13 of the pinned retained-rename review.
The historical audit remains unchanged; this is current implementation evidence,
not a retroactive rewrite of its findings or full THE62 acceptance.

## Ownership and live caller

- `packages/engine/sdk/src/platform/knowledge/consolidation-gateway.ts` owns the
  receipt result/proposal/gateway types, unavailable connection branch, typed
  `memory.consolidation.receipts` invocation, and SDK-error 404/501 versus other
  failure classification. The existing public knowledge subpath exports it.
- `products/tui/src/views/memory-consolidation-gateway.ts` only adapts the
  product's trusted operator connection and existing error wording. It no longer
  selects the receipt verb or classifies statuses.
- `builtin-modals.ts` still supplies a fresh gateway factory on each Memory
  modal fetch. `memory-modal.ts` consumes the canonical types and classifier
  through this adapter. No dead replacement or new local behavior owner was added.
- Daemon receipt/proposal production, credentials, connection selection, rendering,
  and stale-result/closed-view handling are unchanged. Classification is a protocol
  fact, as specified by the original inventory's code decision, not new judgment.

## Local proof

Repository test-runner commands:

- `bun packages/engine/scripts/test.ts test/memory-consolidation-gateway.test.ts`
  passed 12 tests and 19 assertions.
- `bun packages/engine/scripts/test.ts --cwd ../../products/tui src/test/views/memory-consolidation-gateway.test.ts src/test/views/modals/memory-modal.test.ts`
  passed 31 tests and 104 assertions.
- TUI `tsconfig.json` and `tsconfig.test.json` no-emit typechecks passed with zero
  diagnostics, serialized under the shared compiler lock at a 4096 MiB heap.
- A focused engine-test no-emit typecheck, including the SDK ambient declarations,
  passed under the same lock and heap limit. `bun run products:check` passed
  with all four product workspaces present.
- Independent review reran all 43 tests and found no correctness blocker against
  the bounded original HOIST requirement.

The engine tests use the real SDK's typed route and response validation, check
all three proposal kinds, preserve injected error descriptions, and distinguish
SDK 404/501 from 401/403/500, network errors, and status-shaped ordinary objects.
The product integration exercises synthetic loopback HTTP through the production
adapter into the actual Memory modal: disabled then enabled on refresh, populated
receipts, 404 unavailable, 401 error, then genuinely empty proposals. Existing modal
fixtures preserve 501 behavior, proposal jump/correlation, compact rendering, and
obsolete/closed fetch protections. No live account or production credential is used.

## Exact current accounting delta and limits

Move this one HOIST source from `migration-unresolved.json` to `migration.json`:
1,095 to 1,096 mapped rows; 523 to 522 unresolved; 68 to 69 verified rename
mappings. Product status remains partial; no unrelated source/test row closes.

This proof is local source adoption and review. Integrated declaration/subpath API
snapshot refresh, final aggregate/hosted checks, publication, and merge are still
required separately. It does not claim released or hosted acceptance.
