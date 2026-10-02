# Current-main TUI recovery: incomplete draft

Base: `b6cd286c1cf7c1328844fb680d4582cbde538e59` (tree `d428ef7156c8b9bdbe538efb08a216b6fc33c740`).
Recovered product: `562a206326af716a0da29b40b71a62abbabc4e6f`, exact original product subtree `641413f32e3c0840cfe60709d00fdd42bc79d2f2` (1,592 files).
Only this product subtree was imported; recovery ancestry and held engine planning/persistence changes were not merged. The original checkpoint remains unchanged.

## Shared provenance

- Canonical event bridge is already on main (THE96); no duplicate bridge implementation.
- `df9c4d1`: exact shared-only adoption of reviewed Agent native packaging change from `4eb3863f8c8651d1722595c4a270faa4940c73fe`.
- `12bfdc3`: additive public `readCommandNeeds`/`CommandNeeds` export and tests from reviewed `d594a8c7389cf542d93ebb6b3ca55e6f876a1bae`. Current-main API snapshot regenerated. No classifier/policy change.
- `de0099a`: declared engine-owned native addon lookup. Exact names, pinned target versions and payload containment remain enforced. Independent review pending at this checkpoint.

## Local validation

- Engine build and prepared subpath API check pass.
- Product structural check passes: daemon, webui and TUI present; Agent absent from this isolated tree.
- Shared reader and original packaging tests: 18 passing tests / 44 assertions. Extended packaging: 22 / 49.
- Import-only fixture repairs: 19 passing startup/notification tests / 53 assertions. Public workspace resolution points to this worktree, not old engine source.
- Standard `build:linux-x64` passes with the actual installed shared CLI and addon. Actual private package check passes (604 packed files).
- Actual freshly built launcher PTY reaches frame and help, dismisses/exits with status 0, and records zero network violations. This is explicitly synthetic metadata coverage: only the three pre-approved exact GET fixtures; unchanged guard for every other URL.
- Native staged sqlite-vec extension loads successfully in an in-memory database.

## Explicit failed / unrun boundaries

Source types fail with 13 diagnostics, all held planning API dependencies: `ProjectPlanningRevision`, `ProjectPlanningStateExpectation`, `ProjectPlanningStateResult.revision`, `ProjectPlanningService.applyStateAction`, and two cascading callback parameter types. No stubs or held implementation imported.

Full test types fail with 26 diagnostics: 15 held-planning references (including test fixture), plus 11 existing conservative-boundary fixture diagnostics. Five import-only repairs preserve test assertions; the remaining behavioral fixture changes are not part of this checkpoint.

Strict guarded scope: 484 files, 473 pass, 11 fail. Ten failures remain network-guard-only; one planning store test explicitly times out and its file is killed at the 120-second ceiling. Completed file summaries report 5,816 passing tests and 26,140 assertions. At least one explicit failing test is visible; the killed planning file has no aggregate summary, so totals are incomplete. The same 12 conservative excluded files remain unrun. This is not a full suite pass.

Migration accounting is partial: 1,027 same-path location mappings of 1,618 inventory rows; 591 unresolved rows are listed separately. Mapping existence does not prove semantic migration or parity. The recovered source archive differs from the original pinned inventory; missing files must be reconciled with upstream, hoisted equivalents and explicit retirement coverage before completion.

Original tmux E2E remains unrun (tmux unavailable). No live provider coverage, multi-platform build, publication or migration-complete claim.

## Composition changes to recovered product

Only five test imports plus three local fixture helpers were adapted to product workspace boundaries. Profile-runtime changes only the old package namespace to the current public contract package. Runtime-notifier privacy changes only its polling-helper import; its assertions and stopped authority implementation are untouched. The canonical event samples use the public event types. Environment isolation is copied unchanged with its literal runner flag.

Standard prebuild regenerated the command reference and operator contract artifact against current main. These generated deltas are included, rather than retaining stale engine metadata. No renderer source or golden changes.

The 22-line lock addition preserves existing resolutions and adopts only the previously verified TUI workspace, alias and Fuse resolution. Dependencies reuse the installed cache with every workspace link explicitly rebound here; no live installation was performed.
