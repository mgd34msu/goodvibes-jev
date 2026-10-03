# TUI renamed-source accounting and retirement proposal

This is a bounded accounting update, not product completion. The implementation
checkpoint is `7f35938ad4dfaf6d8a1d5f4dc080d525274584fc`. The applied accounting
baseline stays `0d69500f598a90f0f4aecae213b0e003764899dd`; the authoritative UI
forward target stays `ec057c33979839be84a1d8d2399f9c69f0c2a5aa`.

## Proven renamed paths

The companion `tui-rename-reconciliation-2026-10-02.json` reviews all 40 remaining
PORT candidates that equal the forward source after the documented public-package
namespace adaptation. It records pinned, forward and current Git blobs/SHA256,
inventory purposes, individual semantic reconciliation, current test boundaries
and exact passing receipts. Twenty-four source rows and fifteen test rows qualify;
only those **39 mappings** are added. No runtime or test source is changed.

The review distinguishes substantive forward changes from renames: local-auth
now opens a masked prompt, tool links open Agents, palettes/badges refresh on theme
changes, and title/search padding follows the current renderer. Those are the
approved forward UI target and have current behavioral tests; the old pane APIs
are not restored. Source-registration evidence does not imply that dependent
planning transactions work. Four additional off-tree pure-helper probes pass
31 assertions, supplementing exact current per-file receipts. Full source evidence
still has the separately held planning timeout and 15 planning type diagnostics.

One row remains blocked: `src/test/panels/diff-review.test.ts`. Its five model tests
survive, but three former interaction tests were removed upstream. Current model
coverage alone does not prove attach/send, duplicate-free batch send and source
label preservation at the interaction boundary. This is an identified coverage
or supported-behavior reconciliation question, not a reason to invent a mapping
or restore a retired private class. A separate current-boundary investigation is
required before that row can close.

Accounting changes from 1,030 mapped / 588 unresolved to **1,069 mapped / 549
unresolved**: 1,027 same-path locations and 42 verified rename mappings. The
remaining 549 are 49 retained rename obligations, 437 paths deleted by the forward
source history, and 63 other reconciliation obligations. Existing same-path
locations are still not a blanket assertion of completed HOIST/JEV semantics.

## What the repository actually supports for retirements

`docs/design/product-migration-contracts.md` requires mapping dispositions to match
the inventory, existing targets for PORT/HOIST/JEV, and a reason with no target for
an already-permitted DROP. `product-workspace-contract.ts` enforces the same rule,
requires migration and source pins to agree, and checks source snapshots against
inventory rows in both directions. There is no `retired` disposition or automatic
exemption for a path absent in a later upstream tree.

The documented mechanism is **reviewed content reconciliation followed by a
coordinated accounting-baseline advance**. The daemon precedent is
`docs/audit/daemon-upstream-reconciliation-2026-10-01.{md,json}`: each old/new blob
has a ruling and reason, surviving mappings are preserved, seven old rows are
retired while added/modified rows are reconciled, and source snapshot, inventory
and migration pin advance together. Real lifecycle/authority outcome tests
replace obsolete source-scraping checks where their guarantees still matter.
Remaining executable/packaging proof stays deferred rather than declared complete.

For TUI, the companion `tui-retirement-candidates-2026-10-02.json` is **provenance
only**: 437 original paths, exact pinned blobs/deletion commits and open review
status. It corrects the apparent 440 Git deletions: three heavily changed paths
survive through renames; two other paths were renamed and subsequently deleted,
so they belong in the 437. Pure path categories are 370 test sources, 55 other
source paths and 12 non-source paths; these are not semantic retirement rulings.
The testing-overhaul commit `d0a785d6` accounts for 300 deletions, but its broad
commit message cannot discharge any individual inventory purpose.

## Proposed next treatment, with explicit evidence obligations

1. For an obsolete quality/source-text assertion, record its exact former guarantee,
   why the authoritative current test contract retires that assertion form, and
   which owned behavioral/API/package/isolation gate now protects the meaningful
   guarantee. Do not infer irrelevance from a filename or upstream deletion alone.
2. For a deleted pane/runtime source, identify its exact current modal, lane, command
   or canonical engine successor; compare inputs/actions/refusals/confirmations,
   lifecycle ownership and rendering. Keep any missing supported behavior open.
3. For old tests of canonical SDK behavior, map the intended guarantee to actual
   engine tests and public integration coverage, or explicitly retain missing
   product-boundary tests as debt. Do not duplicate SDK internals to close a row.
4. Only after per-row reconciliation, propose a reviewed baseline advance to the
   exact forward snapshot. Both trees have more than deletions: 528 old paths are
   absent and 483 new paths appear; known retained renames explain 91 of each.
   Thus roughly 392 genuinely new paths, plus changed retained files, also need
   inventory/mapping review. A deletion-only pin update would omit new obligations.
5. Keep old pins, blob/rename/deletion history and unresolved behavior in the ledger.
   Do not change the original PORT rows to DROP merely to satisfy the checker.

No accounting pin, original disposition, runtime behavior, stopped original-path
pre-access authority/symlink-race implementation or held planning implementation
is changed by this batch. No publication is included.

## Reviewed follow-up to the initially blocked row

The historical 39-row ruling above is preserved. Independent public-token testing
proved that the Changes comment interaction still exists in the authoritative
forward target and exposed an upstream-carried draft-restoration bug. The narrow
reviewed fix `7065b310` and its current-boundary tests now close the remaining row
with both model and interaction targets. See
`tui-changes-comment-flow-2026-10-02.md`; accounting is now 1,070 mapped / 548 unresolved.
Retirement proposals and other unproven obligations remain open.
