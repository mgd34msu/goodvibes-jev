# Current-main TUI recovery: incomplete draft

Base: `b6cd286c1cf7c1328844fb680d4582cbde538e59` (tree `d428ef7156c8b9bdbe538efb08a216b6fc33c740`).
Recovered product: `562a206326af716a0da29b40b71a62abbabc4e6f`, exact original product subtree `641413f32e3c0840cfe60709d00fdd42bc79d2f2` (1,592 files).
Only this product subtree was imported; recovery ancestry and held engine planning/persistence changes were not merged. The original checkpoint remains unchanged.

## Shared provenance

- Canonical event bridge is already on main (THE96); no duplicate bridge implementation.
- `df9c4d1`: exact shared-only adoption of reviewed Agent native packaging change from `4eb3863f8c8651d1722595c4a270faa4940c73fe`.
- `12bfdc3`: additive public `readCommandNeeds`/`CommandNeeds` export and tests from reviewed `d594a8c7389cf542d93ebb6b3ca55e6f876a1bae`. Current-main API snapshot regenerated. No classifier/policy change.
- `de0099a`: declared engine-owned native addon lookup. Exact names, pinned target versions and payload containment remain enforced. Independent review found ancestor shadowing; corrected by `9fbd633` and `08a4732`. Final independent review passed 47 resolver/build tests / 109 assertions plus 14 extra probes, with no remaining blocking code findings.

## Local validation

- Engine build and prepared subpath API check pass.
- Product structural check passes: daemon, webui and TUI present; Agent absent from this isolated tree.
- Shared reader and original packaging tests: 18 passing tests / 44 assertions. Final extended packaging: 27 / 59, including red-before/green-after ancestor shadowing regressions.
- Import-only fixture repairs: 19 passing startup/notification tests / 53 assertions. Public workspace resolution points to this worktree, not old engine source.
- Standard `build:linux-x64` passes with the actual installed shared CLI and addon. Actual private package check passes (604 packed files).
- Actual freshly built launcher PTY reaches frame and help, dismisses/exits with status 0, and records zero network violations. This is explicitly synthetic metadata coverage: only the three pre-approved exact GET fixtures; unchanged guard for every other URL.
- Native staged sqlite-vec extension loads successfully in an in-memory database.

## Explicit failed / unrun boundaries

Source types fail with 13 diagnostics, all held planning API dependencies: `ProjectPlanningRevision`, `ProjectPlanningStateExpectation`, `ProjectPlanningStateResult.revision`, `ProjectPlanningService.applyStateAction`, and two cascading callback parameter types. No stubs or held implementation imported.

Final full test types fail with 15 diagnostics, all held-planning references (including test fixture); ordinary fixture diagnostics are zero. Commit `4c27255` adds exact synthetic payment-key readings and awaits public redaction results, plus explicit throwing-getter return types. All non-reading, CVV, reference and address assertions remain; 45 tests / 177 assertions pass under the unchanged guard. Unknown synthetic keys/questions reject and the judgment port is restored.

Strict guarded scope: 484 files, 473 pass, 11 fail. Ten failures remain network-guard-only; one planning store test explicitly times out and its file is killed at the 120-second ceiling. Completed file summaries report 5,816 passing tests and 26,140 assertions. At least one explicit failing test is visible; the killed planning file has no aggregate summary, so totals are incomplete. This first invocation retained 12 conservative exclusions. Three notification/payment files were subsequently classified as unrelated to the stopped authority work and passed in a separate 45-test run. Composite scope is 487 files: 476 passing, 11 failing; 5,861 completed passing tests / 26,317 assertions, at least one failure, with the planning remainder unverified. Nine conservative exclusions remain unrun. These are two explicitly separate runs, not a full suite pass.

Migration accounting is partial: 1,027 same-path location mappings of 1,618 inventory rows; 591 unresolved rows are listed separately. Mapping existence does not prove semantic migration or parity. The recovered source archive differs from the original pinned inventory; missing files must be reconciled with upstream, hoisted equivalents and explicit retirement coverage before completion.

Original tmux E2E remains unrun (tmux unavailable). No live provider coverage, multi-platform build, publication or migration-complete claim.

## Composition changes to recovered product

Five test imports plus three local fixture helpers were adapted to product workspace boundaries; the later classified fixture-only batch is described above. Profile-runtime changes only the old package namespace to the current public contract package. Runtime-notifier privacy changes only its polling-helper import; its assertions and stopped authority implementation are untouched. The canonical event samples use the public event types. Environment isolation is copied unchanged with its literal runner flag.

Standard prebuild regenerated the command reference and operator contract artifact against current main. These generated deltas are included, rather than retaining stale engine metadata. No renderer source or golden changes.

The 22-line lock addition preserves existing resolutions and adopts only the previously verified TUI workspace, alias and Fuse resolution. Dependencies reuse the installed cache with every workspace link explicitly rebound here; no live installation was performed.

## Offline fixture and postinstall follow-up (2026-10-02)

Checkpoints `6992fc5`, `b939fea`, `00dc612`, and `d2a1e64` build on safeguarded `994856e` in an isolated branch.

The ten earlier strict guard failures are resolved without intercepting fetch: runtime/CLI fixtures seed the current exact benchmark, catalog, model-limit and gateway-pricing cache envelopes under their own temporary homes. Metadata-dependent behavior is not claimed by these fixtures. The postinstall product bug is repaired by recognizing the exact private source workspace contract and declared root layout; standalone download/checksum behavior remains unchanged. Independent review reproduced 34 tests / 54 assertions, 25 extra malformed/boundary cases and four offline actual-main install layouts, including checksum failures and download-file cleanup.

All nine formerly excluded tests were classified from their descriptions and public imports as ordinary profile, file-selection, permission-presentation or PR51 modal revision tests. They do not exercise the stopped original-path authority/symlink-race mechanics. Permission presentation fixtures now carry explicit public risk-family facts, with a generic unread control; no classification or permission policy is changed.

The final strict source run uses zero exclusions and the unchanged network guard: **498 files, 497 passed, one failed, zero network-violation files**. Completed summaries contain **6,001 passing tests and 26,737 assertions**. The remaining planning-store file reports one explicit 60-second test timeout and is killed at the 120-second file ceiling without an aggregate summary; remaining tests in that file are unverified. Separate built-binary E2E tests remain outside this source runner. Original tmux E2E remains unavailable.

Final source-plus-test TypeScript has **15 diagnostics, all held planning API references**, and zero ordinary diagnostics. No held PR57 implementation was adopted. Inventory accounting remains partial at 591 unresolved rows.

Standard Linux build, actual 605-file private package check, fresh launcher frame/help/dismissal/exit-zero PTY and staged sqlite-vec load pass. PTY metadata remains the explicitly bounded three-URL synthetic fixture proof. However, **standard smoke:tui fails the unchanged eager-namespace artifact scanner**: it reports 25 zod namespace schema-constructor reads despite preceding initializer calls. Actual startup success does not waive that gate. Emitted initialization evidence is preserved; checker/source remediation and independent review remain outstanding. This checkpoint is not full acceptance.
