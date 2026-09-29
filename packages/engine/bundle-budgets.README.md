# bundle-budgets.json: methodology and exclusions

This document explains the structure of `bundle-budgets.json` so that file can stay machine-focused with entries and per-entry rationales.

## Methodology

`gzip_bytes = max(ceil(actual_gzipped_bytes * 1.2), actual_gzipped_bytes + 50)` for the last accepted dist/ baseline.

- For entries below ~250 B, the **+50 B floor** dominates the 1.2x multiplier. This is intentional. Tiny facades get a flat +50 B headroom regardless of size.
- The **1.2x multiplier** only matters for entries larger than ~250 B.
- This keeps tiny facade entries from failing over a handful of bytes while retaining tight proportional budgets for larger entry points.

## Updating after a legitimate bundle-size change or new entry

1. Run `bun run bundle:check` to see the current actual sizes.
2. Set `gzip_bytes` to `max(ceil(actual * 1.2), actual + 50)` for each changed entry.
3. Update the per-entry `rationale` with the new measurement and the release or commit at which it was taken.
4. Keep entry rationales free of stale wave/date-specific narrative. Anchor to a concrete release or commit.

Entry keys must match the `./sdk/*` keys of the `exports` map in `packages/engine/package.json` exactly, with `./sdk` read as `.`.

## Tracked aggregates (budgeted here, deliberately)

- **`./events` barrel and domain entries.** `package.json` declares the root
  `./events` entry and explicit `./events/<domain>` entries. `bundle-budgets.json`
  tracks the root barrel because it is the public aggregate entry consumers
  import when they want the event type/guard facade, and it also tracks each
  explicit per-domain entry so every public import path has a budget.
  The aggregate's `domains` array enumerates the in-scope domain identifiers for
  human reference; `scripts/bundle-budget.ts` verifies that list against the
  actual event-domain files.

## Intentional exclusions (not budgeted here)

- **`./contracts/operator-contract.json` and `./contracts/peer-contract.json`.** Static JSON artifacts. Their size is governed by the contract refresh process at `scripts/refresh-contract-artifacts.ts`.
- **`./package.json`.** Metadata only, not a runtime bundle.
- **Generated JSON/static assets** that do not resolve to JavaScript from the
  package export map. Every explicit JavaScript export, including platform
  subsystem entries such as `./platform/knowledge` and `./platform/runtime/ui`,
  must have a budget.

## Recorded raises and additions

- **`./platform/contract`, raised at contract runner part R.11.** The budget was last set at R.5 (2024 B). R.6 to R.10 added the runner surface the design names: the steps a host may take over through `ContractRunnerDeps.steps` (correction, completion, escalation, amendment, answers, plan sync), best-of-N, resume, turn intake, fleet controls, the route selector and the external bridge, with their batteries. That is required code, so the budget follows it. What was not surface was taken out of the barrel instead: `engineItem`, `checkSummaries`, `queueSessionNudge`, `resumeStatus`, `resumeStepOf` and `findZombieCause`, internal helpers no consumer imported. Measured 2858 B, budget 3430 B.
- **`./platform/runtime/client-services`, not raised at R.11.** R.10's runner composition put it 1 B over. The native-agents-only fleet probe that it and `agent-graph-composition.ts` each built inline is now `nativeAgentFleetCapacity` in `runtime/contract-composition.ts`, which brought it to 5765 B, under the existing 5852 B budget.
- **`./platform/routing`, added at R.11.** The routing subsystem's entry was exported by ledger task E.4 without a budget. Measured 805 B, budget 966 B.

## Validation

`scripts/bundle-budget.ts` compares `bundle-budgets.json` keys to `package.json` exports. CI fails on missing or unknown entries. To add a new export, add it to `package.json/exports` AND `bundle-budgets.json/<key>` in the same PR.

```bash
bun run bundle:check          # includes build step
bun run bundle:check:strict   # skips build, uses existing dist/
```
