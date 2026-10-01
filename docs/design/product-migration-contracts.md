# Product migration contracts and gates

The four products are ports of the existing products. They retain their screens,
commands, styles and behavior. Their composition, input and rendering remain in
the product; shared platform behavior is hoisted into the engine. The later
per-file inventory rulings control: legacy migration modules carry forward,
and WRFC/permission views are adapted to the contract runner and gate rather
than discarded merely because an earlier scope paragraph called them DROP.

## Applied source accounting and forward targets

`docs/inventory/product-sources.json` records the complete tracked-file list used
by the current inventory and migration mappings. These are accounting baselines,
not a claim that the products are complete. The product gate compares every
inventory row against these snapshots, in both directions. No upstream repo is
modified.

| Product | Source revision | Tracked files |
|---|---|---:|
| daemon | `443e5ee4d6cda0d36d57e2886398d0836074a4a9` | 281 |
| tui | `0d69500f598a90f0f4aecae213b0e003764899dd` | 1618 |
| agent | `9e225a349667632bb550e9c270d922b985848eaa` | 1602 |
| webui | `9856cba64bb7df5677859c846a80eeb5c2da67c0` | 608 |

The October 1 platform refresh is recorded separately in
[`../inventory/upstream-targets.json`](../inventory/upstream-targets.json), with
the exact content snapshots in `docs/inventory/upstream/`. The implementation
sequence and unapplied differences are in
[`upstream-reconciliation.md`](upstream-reconciliation.md). Advance a product's
accounting baseline when its inventory and migration mappings have been
reconciled to that source. A target pin alone does not apply its behavior.

The original WebUI inventory described `9856cba`. An earlier metadata change
named `5050483`, which has the same paths but different content in six files.
That discrepancy is corrected here; both remain documented history, and the
authorized forward target is now the redesigned `dadf577` tree.

## Workspace boundary

Each real product lives in `products/<name>`, is named
`@goodvibes-jev/<name>`, and depends on `@goodvibes-jev/engine` through
`workspace:*`. Imports use the declared public engine exports, for example:

- `@pellux/goodvibes-sdk/platform/config` becomes
  `@goodvibes-jev/engine/sdk/platform/config`
- `@pellux/goodvibes-terminal-shell` becomes
  `@goodvibes-jev/engine/terminal-shell`
- `@pellux/goodvibes-daemon-sdk/remote-routes` becomes
  `@goodvibes-jev/engine/daemon-sdk/remote-routes`
- The same package-to-subpath mapping applies to contracts, errors, operator
  and peer clients, transports and toolchain

Legacy package dependencies/imports, undeclared engine subpaths and relative
imports crossing a product boundary fail validation. Historical names in prose
are not imports. A missing export is an explicit integration change, not a
reason to reach into the engine's source tree.

Every product supplies real `build`, `test` and `typecheck` scripts, an actual
source entrypoint, test sources and TypeScript configurations. Script references
must exist; empty-success commands and empty entrypoints fail. Every owned
TypeScript source/test/tooling file outside fixture data must belong to a
TypeScript project. The whole-tree type gate compiles every product tsconfig
directly and also runs its declared `typecheck` and `typecheck:*` scripts, so
existing coverage checks remain active.

## Module accounting

A product's `migration.json` has this shape:

```json
{
  "sourceRevision": "the full pinned upstream commit",
  "entrypoints": ["src/main.ts"],
  "mappings": [
    {
      "source": "src/example.ts",
      "disposition": "PORT",
      "targets": ["products/example/src/example.ts"]
    }
  ],
  "verification": {
    "parity": "docs/audit/example-parity.md",
    "proof": "docs/audit/example-proof.md",
    "patternAudit": "docs/audit/example-patterns.md"
  }
}
```

Use actual product names and paths. Each mapping must match its inventory's
disposition. PORT targets stay in that product, HOIST targets live in the
engine, and JEV mappings identify the rewritten implementation. A permitted
DROP has no target and names its reason. All targets must be existing files
inside the workspace. Incremental ports can leave mappings unfinished, but
cannot invent dispositions or targets.

## Checks and completion

- `bun run products:check` verifies source accounting and every product that
  actually exists; it reports missing products as pending
- Root `build`, `test` and `typecheck` run the corresponding product checks
  automatically; the Bun CI leg also runs `products:test`
- `bun run migration:complete` additionally requires all four products, every
  source-file mapping and nonempty parity, runnable-proof and pattern-audit
  evidence files

The strict gate is a structural completion check. It does not establish that
an evidence file's claims are true, that a live proof ran, or that two UIs match.
Those still require the actual commands, side-by-side checks and evidence
review required by the intent. Do not add placeholder products to make this
gate green. Ordinary checks can be useful while ports are in progress without
claiming that the migration is finished.

Product test runners must preserve their existing per-file isolation and
local fixture behavior while adopting the shared test environment/network
guard. Live proofs remain separate, explicitly configured runs. No new live
provider call is implied by adding a product to the workspace.
