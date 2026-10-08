# Read-only native integration inspection

Native Work's authenticated status response provides ephemeral per-unit integration facts. It is a supported successor for the live inspection responsibilities retained from Fleet worktree detail. It does not add durable per-unit history, change completion accounting, or make the former Agents modal's historical rendering a native execution authority.

## Ownership and access

Native executions use a separate lazy runner from the ordinary Fleet registry. The consumer therefore uses the existing `workLedger.execution.status` method, not `fleet.conflicts.list`. Its body remains project/work/attempt identity plus expected revisions. Clients cannot supply a contract ID, unit ID, source, decision or authority.

The route retains current paired-owner authorization and both `read:work-ledger` and `write:fleet`, including checks before and after lazy host acquisition. The native host validates the exact paired principal/incarnation, granted scopes, project and workspace generation. Only its existing authenticated receipt can select `ContractRunner.inspectIntegration(contractId)`. The native runner capability includes that read-only method; it gains no Fleet controller, conflict-resolution session or repair callback.

Inspection is optional on the public base `ContractRunner` and its native attachment shape, preserving older custom runners. The actual `createContractRunner` return guarantees the real read implementation. An authenticated active execution attached to a legacy runner without this capability reports `unavailable/unsupported-runner`; it never consults another runner, derives item facts from progress, or gains mutation authority.

## Recorded facts and current unit state

`inspectIntegration` reads the actual live `ContractRun` and its engine. It returns detached, schema-checked data, never a live object reference. Each row has the real unit/group identity, optional actual attempt identity, current unit status and the latest recorded unit check's ID, time, trigger and result.

An engine item is included only when its `contractId` is the inspected contract, its `contractUnitId` is a real unit, and its owning workstream matches that unit's group. Missing, foreign, ambiguous or mismatched joins are unavailable. Branch names, titles, blocked-reason prose and neighboring rows cannot establish identities. A best-of-N plan unit without its own item is not applicable; its actual attempt units carry their own rows.

Recorded item facts remain separate from the current unit check:

- `unrecorded`, `pending`, `merged` or `conflict` integration
- Actual merge hash, when recorded on a merged item; a merged item without a hash means no changes
- Recorded worktree path, branch and kept flag
- Structured `conflictFiles` only, preserving absent versus recorded-empty lists

Jev can repair a failed native unit and pass its `fix-passed` check while the original engine item still records a conflict. The display keeps both facts. It neither invents a successful merge nor asks the user to resolve the old item. A genuine engine remerge is a separate observation and only changes the display when the engine changes its records.

## Availability and bounds

- An active owned worktree run with an engine supplies live rows.
- Shared isolation and session mode report not applicable.
- Missing engines/items report unavailable, without recovering or synthesizing them.
- Terminal, cancelled, aborted or disposed runs have no live projection.
- A restarted host reports recovery-required without starting or resuming execution.
- A stale attempt/revision cannot acquire another attempt's current integration facts.
- No receipt means no invented contract/unit/item identities. Pending intents have no integration field.

The existing status response limit remains 16,384 UTF-8 bytes, including the entire execution envelope. The producer reserves envelope space with a 12,288-byte projection cap and bounded row/path counts. Oversize observations return `unavailable/limit`; no path or row is silently truncated. The route also replaces an oversize integration projection with the bounded limit result. If the inherited status envelope itself still exceeds the limit, its existing unavailable error remains; adding integration does not enlarge that limit or bypass validation. Older hosts may omit the optional integration field; the consumer reports that absence explicitly.

This is an observation only. There are no new persistent ContractUnit fields, contract-store schema versions, durable execution columns or receipt fields. Reading performs no admission, recovery, automation, resolution or cleanup.

## Native Work consumer

The actual Native Work modal has a separate read-only Integration tab. Its rows use injective structured identity keys and the existing scrollable informational-line renderer. Long paths wrap; terminal/bidirectional controls are escaped. The section is independent of the eleven reserved execution-summary rows. Close/reopen, host changes and late responses remain fenced by the existing native client/model generations.

The Integration tab has no start, resume, cancel, winner-selection, resolve, repair or discard action. Existing Work controls retain their established meanings. Jev continues owning runtime decisions.

## Retained responsibilities

Original Fleet formatting and workspace/application status remain with their existing production surfaces. The remaining live per-item detail obligation from original retained rows 5, 6 and 30 is implemented through this explicit native status/inspection path. Terminal or restart per-unit history is unavailable by design; it is not claimed as unchanged historical Agents-modal parity.

The orphan `products/tui/src/views/fleet-worktree-detail.ts` renderer and its sole `products/tui/src/test/views/fleet-worktree-detail.test.ts` consumer are retired. Neither had a production importer. Their replacement is supported by `native-integration-lifecycle.test.ts` and `native-integration-live.test.ts`: actual source-bound runner/engine facts pass through the paired REST route and operator client into the production Native Work modal, including repair retaining the original conflict. The exact union also passes the original same-root concurrent-contract test with the separate THE-905 runtime repair. Pure WorkItem fixtures or projection unit tests alone did not establish this replacement. Historical audit records and completion accounting are unchanged; any accounting update requires separate acceptance review.

## Verification boundaries

Focused projection tests cover detached facts, validated joins, identical local IDs across contracts, actual attempt parentage, recorded absence, lifecycle and byte limits. Protocol tests cover strict requests/responses, forged identities, paired scope/incarnation/project fences, post-acquisition checks and recovery without effects. Native Work renderer tests cover truthful repaired/conflicted rows, long hostile paths, more than eleven rows, scrolling, resize and lifecycle fencing.

Source-bound native tests must additionally establish actual conflicting worktree units at Jev's repair boundary, repair passing while another unit keeps the contract live, genuine remerge separately, and native host/wire/modal observations. Qualification and independent acceptance results are recorded with the reviewed feature checkpoint; this design document is not itself a completion claim.

The same-repository concurrent-contract acceptance exposed the separate [THE-905 worktree namespace defect](https://linear.app/the-artificery/issue/THE-905/namespace-native-worktree-resources): two actual contracts using `g1/u1` collide on `ws/g1/u1`. The original same-root regression remains in the acceptance suite. A separate reviewed runtime repair must make that case pass; separate-root fixtures do not substitute for it. The inspection implementation does not change worktree allocation.
