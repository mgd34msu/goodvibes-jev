# Native contract source preservation

Scope: additive source preservation. Autonomous decision dispatch, durable launch fencing and product entry points have separate owners. Legacy owner-reply flows are not an autonomous fallback.

## Input and persisted authority

`StartContractInput.nativeSource` and `Contract.nativeSource` carry a `NativeContractSource`:

- `sourceId`, `sourceRevision`, `inputRevision`: the host source identity and exact immutable source/input generations
- `criteriaId`, `criteriaRevision`: the host-owned ordered criteria-set identity and generation
- `goal`: the complete original goal, exactly as supplied
- `criteria`: the complete nonempty ordered original string array, exactly as supplied

The native owner supplies those fields from its captured authoritative input. References are nonempty printable ASCII strings, at most 256 characters; goal/criteria text is not trimmed, summarized, truncated, deduplicated or concatenated into `ask`. Duplicate criteria remain separate ordered entries. Missing/empty criteria, holes, accessors, proxies, unknown fields and malformed revisions are refused before spawning the owner. A changed goal, criterion or criterion order requires a new host source/input revision and a new contract. These identity fields do not authenticate the caller, grant capabilities, or claim execution.

The source is detached and frozen before `start`/`startFromPlan` can spawn an owner. The persisted root goal and criteria exist immediately, including while queued or shaping. Root criterion IDs are stable `c1`, `c2`, and so on in original array order; both `text` and `quote` equal the source criterion exactly. Those root identities, their order and their `judged` disposition are locked. Evidence readings and verification status remain mutable.

## Planning, correction and verification

The planner receives the complete source as a separate structured section in every initial, repaired and owner-instructed planning request. It can derive groups, units, dependencies and subordinate criteria. Its root goal and ordered criteria must echo the source exactly; structural problem `native-source-changed` rejects replacement, omission, addition and reordering before semantic checks. Legacy plan approval cannot waive that problem. `acceptPlan` keeps the existing native roots rather than installing the planner's root array.

For native plans, exact structural source fidelity replaces the legacy checks that infer quoted requirements from the display `ask`. The ordinary topology, linkage, coverage-by-count and semantic unit-scope checks still run. Native root criteria are never excluded or silently marked met by a generated topology disposition; final verification judges all of them. Native criterion checkability failures cannot be repaired by rewriting the source.

Unit briefs, repair prompts and derived-work amendment prompts retain the complete source. A deliverable amendment cannot change native roots; the caller must correct derived work or begin a newly versioned contract. Planned fix groups do not replace the root criteria. Final verification reads the original full goal and ordered criteria, and its evidence plus evidence digest include the captured source identities/revisions.

The persisted envelope is version 3. Version 2 is already reserved by the separate durable-admission implementation; reusing 2 here would let that intermediate reader accept native records and then overwrite their roots. Both version-1 runners and the intermediate durable version-2 runner reject version 3 as a future version. Version-1 snapshots without a native source remain readable. This source-only prerequisite refuses version-2 snapshots because it does not yet own durable restore semantics. Snapshot reads validate source shape and exact root correspondence, then reinstall source/root immutability. A malformed or inconsistent native snapshot is refused and follows the existing quarantine path, rather than replanning a different task. Old snapshots and callers with no `nativeSource` keep their existing legacy ask-derived behavior; no native source is synthesized for them.

## Native admission integration seam

`captureNativeContractSource(unknown)` validates, copies and freezes the host input. `nativeContractSourceForAdmission(contract)` returns a frozen `{ goal, criteria }` projection structurally compatible with the shared autonomous tool-source input. It throws for legacy contracts, and never uses a generated unit brief, summarized goal or fake empty criteria array as authority.

The compose-time store must preserve version 3 and combine both validators: the durable receipt/checkpoint validator and the native source/root validator. Remove the standalone version-2 refusal only when the durable restore owner is present; then migrate its version-2 snapshots explicitly. Keep the durable reader's bound-resume, import and retention handling. The shared runner `create` path must capture and bind `input.nativeSource` for durable starts too, and durable checkpoint restore must reinstall source/root locks before any planner or verifier runs. Regenerate public API snapshots from the combined implementation, rather than selecting one branch's generated report. This prerequisite alone must not be presented as support for durable native execution.

The native composition owner should supply `nativeSource` with `StartContractInput`, then use that projection when preparing native tool admission. It must bind the exact current source/input/criteria revisions to its own execution receipt and durable boundary. Source preservation alone does not dispatch admission or wire product execution.

## Verification

Fixtures cover exact/long/unicode source capture and borrowed mutation; invalid/empty/holey source refusal; generated goal or altered/dropped/reordered/added roots; immutable persisted roots with mutable evidence; inconsistent snapshot refusal; correction and legacy-amendment protection; and a real runner restart from planning through final verification. Legacy contract regression remains required.
