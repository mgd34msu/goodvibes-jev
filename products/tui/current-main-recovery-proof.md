# Current-main TUI recovery: incomplete draft

## Latest public runner boundary qualification (2026-10-02)

The independently accepted source is `43e5d4efdecc25eb2200d0ff41ead2718b1cbd47`.
The TUI now imports `@goodvibes-jev/engine/toolchain/test-runner`; its single owned
child implementation and complete preload/runtime closure ship under toolchain
source/dist, with compatibility shims at the old private script paths. No lifecycle
body or network guard was duplicated or weakened. The earlier cross-workspace
architecture blocker below is resolved through the public boundary.

A real offline normalized tarball proves Node import safety, complete declarations,
Bun invocation and guard activation, including a caught forbidden-I/O attempt that
still fails the owned child. Author checks passed 102 focused tests /402 assertions;
independent packed runtime review passed five tests /34 assertions. Toolchain build
and narrow types passed at 2,048 MiB, as did product and temporary-file architecture
checks. Source/export/validation evidence is recorded in
[`tui-public-test-runner-boundary-2026-10-02.json`](../../docs/audit/tui-public-test-runner-boundary-2026-10-02.json).

The final actual public-import product command ran all **519 source files** in
5m52s: **518 passed /1 failed**, exit 1, no filters or timeout overrides. Completed
summaries contain **6,249 passing tests, five existing skips and 29,213 assertions**,
with zero network-violation reports. The retained planning test failed its existing
60-second timeout; the 120-second file watchdog ended/reaped it and printed the
final aggregate summary. The final 2,560 MiB full type pass completed in 43.55s
with exactly the same **15 legacy planning diagnostics**, no new errors. Earlier
heap exhaustion, original failed aggregates and pre-correction architecture
failure remain in the historical evidence.

Two ordinary product-command tests still leave synthetic fixture trees outside the
runner-owned scratch; they were preserved intact outside source before the final
product architecture check passed. No scanner exception was added. Windows
child-tree cleanup and native ledger product integration remain incomplete. PR76's
published work-ledger export and this tooling export are distinct additive keys;
only metadata compatibility has been checked, not an unreviewed source union.

## Historical private-import runner qualification (2026-10-02)

Reviewed source `f276eaf460287b22653d0276aa98f8efae91b3f9` adds owned per-file
POSIX teardown, bounded output drain and accurate timeout diagnostics to the actual
TUI test command. Shared output/lifecycle repairs and the product runner were
independently reviewed; the focused product matrix passed 41 tests /145 assertions.
Exact source hashes, dependency origins and limits are in
[`tui-test-runner-lifecycle-2026-10-02.json`](../../docs/audit/tui-test-runner-lifecycle-2026-10-02.json).

The actual unchanged-guard product command ran all **519 source files**, with two
workers and no timeout override/filter: **518 passed /1 failed**, exit 1, in 5m56s.
Completed summaries contain **6,249 passing tests, five existing skips and 29,213
assertions**, with zero network-violation reports. The retained legacy planning
case failed its existing 60-second test timeout, then the 120-second per-file
watchdog ended and reaped it. The runner printed the final aggregate summary and
removed its owned scratch. No test was skipped to avoid the planning failure.

A full type pass at 2,048 MiB hit explicit V8 heap exhaustion. The single authorized
2,560 MiB retry completed in 44.21s with exactly the **15 pre-existing planning
diagnostics**, byte-for-byte identical to the 7ff baseline, and no new diagnostics.
This remains a failing full-type gate, not a green typecheck.

The shared 720-second ceiling applies to each file invocation, not to the entire
product queue. Existing longer test declarations have reviewed file allowances;
the effective earlier shared/file ceiling wins, and CI's job budget remains the
outer wall-clock limit. Direct product commands do not acquire the workspace lock;
this qualification explicitly used the canonical lock. Windows child-tree cleanup
remains unresolved, so this is a Linux/POSIX-qualified draft. An earlier independent
shared backpressure timeout remains unexplained and retained alongside passing
final monitored replays.

The final architecture check currently blocks the runner’s direct cross-workspace
import of the shared owner. A supported public tooling boundary is required before
accepting that integration; the rule has not been waived. Generated fixture trees
were moved intact into evidence, leaving only this real source-boundary diagnostic.

No product runtime source changed after the parser checkpoint below. Its native
build/package/startup evidence is inherited, not claimed rerun here. Accounting
remains **1,095 mapped /523 unresolved**; native ledger UI integration, legacy
planning replacement and broader live/E2E acceptance remain incomplete.

## Historical parser checkpoint evidence (2026-10-02)

The sections below retain historical checkpoints and their failures. The latest
validated runtime is `ce235ce02f50447a68b5cb52e6303e5b8a9668e6`, following reviewed
PR73 repair `7ff101e9e5864b91361a0b225ecb6839c4e04de1` on main `2c181f51` history.
Exact affected source hashes and scope are recorded in
[`tui-parser-readiness-2026-10-02.json`](../../docs/audit/tui-parser-readiness-2026-10-02.json).

Hosted origin/attachment ownership, outer and bootstrap shutdown, compiled HTML
compatibility, steering receipts and Fleet hints/cost corrections are separately
reviewed. The latest four-line renderer fix waits for memoized parser readiness
before grammar loading. Controlled initialization reproduced the old golden
failure; the fix restores the entire committed frame without golden changes or
sleep-based timing assumptions.

The full unchanged-guard source run now passes 516 of 517 files, with zero
exclusions or network violations. Completed summaries contain 6,232 passing tests,
five existing skips and 29,109 assertions. The only failing file is the retained
legacy planning timeout (60-second test / 120-second file watchdog, exit 137).
The source/test compiler retains exactly 15 legacy planning diagnostics. The prior
7ff run (514/516, including the golden failure) remains preserved as failed evidence.

Fresh engine preparation/build, standard Linux native build and strict smoke pass.
Actual compiled shell/settings opt-in and revocation exit normally with zero
violations using only the three established synthetic metadata responses. This is
not a live provider, full hosted daemon restart or original tmux E2E claim. The
engine tree is unchanged from 7ff, preserving its canonical API evidence.

Accounting remains **1,095 mapped / 523 unresolved**, with no closure from this
readiness fix. Historical per-item integration/conflict presentation and other
migration responsibilities remain open. The branch includes reviewed ledger
foundation source, but native workflow product composition is still incomplete;
legacy planning failures are not hidden or repaired by importing old integration.


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


## Three byte-identical upstream renames accounted

The authoritative forward target remains `ec057c33`; the pinned `0d69500` inventory remains the accounting baseline. Three PORT rows now map to their verified renamed locations: modal-theme tokens, modal-surface test helpers, and the agent-ledger JSONL fixture. Their current Git blobs equal the pinned source blobs exactly. Inventory purposes remain unchanged; relative imports still resolve to the same renderer/input modules and the ledger fixture is consumed by the passing fleet-transcript test. No behaviors or assertions were removed to close these rows.

Accounting is now 1,027 same-path locations plus three verified renames, with **588 unresolved rows**. Later upstream deletions are provenance only, not permission to mark pinned PORT rows DROP. The other renames and HOIST/JEV obligations remain open for semantic reconciliation.

## Reviewed checker and truthful approval explanations

Shared checker commit `e55bb65` is adopted path-only as `5b48fcb`. The constructor-call exception now requires emitted synchronous initializer dominance, exported-function ownership and unmodified bindings/initializers; ordinary aliases remain failures. Independent review reproduced and then verified fixes for four replaced-initializer negative controls. The owned full toolchain suite passes 240 tests / 487 assertions, and the rebuilt owned CLI's **standard smoke now passes**. Earlier scanner failures remain recorded rather than erased.

Product source commits `6050c4a` and `d6e33c5` correct status, doctor and onboarding approval descriptions using public preset facts. Broad automatic-approval warnings remain. Real gate controls prove critical ASK, boundary ASK under autoApprove and the actual autoApprove override ALLOW. Doctor now reports the returned decision source and gate facts instead of an invented ordered walk; all nine public source variants are labeled. Independent final review passes 39 tests / 154 assertions, and the gate/permission implementations are unchanged.

The exact `6050c4a` full non-E2E source run covers 499 files: 498 pass, one held planning file times out, **zero exclusions and zero network-violation files**. Completed summaries contain 6,007 passing tests / 26,778 assertions, plus one explicit failure; the killed planning file has no complete totals. The subsequent two-file doctor fix is separately validated with 38 tests / 136 assertions and independent review. It is not represented as a new whole-suite invocation.

At `d6e33c5`, full source/test types still report only 15 held planning API diagnostics. Fresh standard native build, standard smoke, actual launcher PTY and 606-file private package verification pass. Source/metadata fixtures remain offline; live provider and tmux E2E acceptance are not claimed.

Remaining work includes the held planning API dependency, 588 unresolved source-accounting rows, whole-composition review, and a confirmed host-owned notification setting gap: the schema-driven TUI settings UI currently assumes `behavior.notificationsMetadataOnly` is an engine schema key, but that key belongs to the host and is absent. Runtime delivery remains restrictive; a product-local settings adapter is pending separately.

## Reviewed host-owned notification setting (2026-10-02)

The frozen `6ced4cd` checkpoint is preserved separately. The isolated follow-up composes current main `46a3201` through merge `a14f361`, preserving the entire prior TUI and toolchain postimages and adding the reviewed provider-watcher drain. Standalone SDK host-setting candidate `ea413219` is adopted as `75c3d4e`: all eight source/test postimages match; the generated API union additionally retains the reviewed public `CommandNeeds` / `readCommandNeeds` export and provider `closeWatching`.

TUI commit `36db0c8` resolves the host-owned settings gap through one immutable restrictive-default descriptor registered at both TUI-owned ConfigManager construction sites. Its wrapper only calls the public constructor. Instance schema enumeration exposes the real setting; ordinary modal toggle/reset and public managed locks remain authoritative. Host-row source/lock metadata refreshes after writes and the public subscription refreshes an already-open row on revocation, with close/reopen ownership cleanup. Precise boolean help distinguishes metadata-only true from explicit details-consent false. Shared schema/defaults and notification enforcement are unchanged.

Independent review accepts the exact nine-file product patch and tree `724af042cbfc9162f6d645bfdf4c7d07d4bad431`: **81 tests / 584 assertions** reproduced, plus **seven adversarial tests / 52 assertions**, including real polling watcher deletion/invalid/malformed revocation, open search-row refresh, typed delivery, listener ownership, descriptor isolation and project fallback. Eight actual-renderer frames at 80x24 and 120x40 were visually reviewed; all encoded/plain frames match independently. These are synthetic renderer proofs, not live terminal screenshots.

The exact `36db0c8` full guarded non-E2E source run covers **501 files: 500 pass, one held planning file times out, zero exclusions, zero network-violation files**. Completed summaries contain **6,022 passing tests / 26,907 assertions**; the planning file reports the same delayed-approve test timeout and is killed at the unchanged file ceiling without complete totals. The SDK's public failed-load refusal is preserved while notification details are revoked.

`products:check` passes after preserving two leftover synthetic product-command fixture directories outside the source tree. `migration:complete` still fails: source accounting, other product absence/evidence and parity obligations remain open. No mapping rows were changed for this integration. Final exact types/build/API/package/PTY proof follows below when completed; the prior 15 held planning diagnostics remain an explicit dependency, not an approved implementation import.

Final exact source/test TypeScript retains **15 held planning diagnostics and zero new diagnostics**. Owned engine build, SDK preparation, canonical `api:check` union verification, standard Linux-x64 build and standard smoke pass. The actual private package check passes with **607 packed files** using a writable synthetic npm home/cache (the first attempt's missing `/home/agent/.npm` environment error is retained).

A fresh actual compiled-launcher PTY proof navigates the supported targeted `/config behavior.notificationsMetadataOnly` command, displays the host row, persists explicit false with Enter, revokes back to true with repeated Enter, dismisses and exits zero. The unchanged guard records zero violations; only the three previously approved exact metadata endpoints receive synthetic fixtures. Initial harness selection/unsupported `/settings`-argument assumptions are retained separately; no production behavior was changed to satisfy them. The staged sqlite-vec library loads and reports v0.1.9. Binary SHA256: `d8e921ce7b6535db6ddcd19a257c32226afd0db4d4c7acd7061cd190b8088755`; addon SHA256: `5923730861b86c707cca5602b5f91092f9e52a46706dbc6e269fd4bb9c4498e8`.

This closes the reviewed host-settings gap locally. Held planning source/types/test acceptance, original tmux E2E, incomplete source accounting and whole-product migration review remain open. Nothing here authorizes or claims publication of the separately frozen checkpoint or this follow-up.

Final owned shared regression run (host settings, provider watcher drain, public command-needs reader and the entire toolchain suite) also passes: **289 tests / 645 assertions across 20 files**. API Extractor completes with its existing TypeScript-version, gaxios/Bun-fetch and duplicate ambient sql-js warnings retained in the log; the canonical committed API comparison succeeds.

## Later accounting and Changes interaction follow-up

The later PR69 peer findings place the historical 7f35938 host integration back on
hold pending corrected canonical SDK source and revalidation; green local gates
are not current dependency acceptance. No unreviewed SDK repair is adopted here.

Documentation-only 1024e810 reconciles 39 exact forward PORT renames with per-row
purpose, source hashes and passing behavior evidence, reducing unresolved rows
to 549. The one blocked diff-review test row led to a real public ChangesModal
bug: Enter restored the draft after attachment instead of exiting composition.
Reviewed two-file fix 7065b310 now preserves the intended attach-then-send flow.
Independent 176 pass / 1 existing skip / 427 assertions plus 8 adversarial tests / 61 assertions pass;
exact pre-fix replay fails 10 of 12 tests. Types remain 15 held planning diagnostics.
The separate successor-coverage mapping names both unchanged model tests and the
new actual modal-host token tests, bringing unresolved accounting to 548. No new
compiled-E2E/full-suite claim is made for this source fix. See the detailed audit
and retirement proposal under docs/audit/tui-*-2026-10-02.*.

## Retained rename review after 7c09

The bounded 48-row review closes 18 proven mappings, leaving 530 obligations
(30 retained rename rows, 437 deleted-path reconciliations and 63 other rows).
See `docs/audit/tui-retained-rename-review-2026-10-02.{md,json}` for exact semantic
and test evidence. Passing helper tests did not conceal actual modal gaps:
Work Plan contract navigation, pending spawn cancellation, ACP receipt labels,
footer eligibility and unpriced cost remain explicit until separate fixes pass
independent review. This accounting change contains no runtime edits, source-pin
advance, held dependency adoption or publication. Host SDK PR69 remains blocked.

## Corrected typed host integration and coherent local source

Reviewed source e47a8f7862f63be130a8793c63eaf0735397d874 includes the corrected host SDK
on main f16dcf76, the independently accepted typed TUI consumer, Work Plan contract
navigation and FleetSpawn ownership fixes. All reviewed source postimages and the
API union are preserved. The host review passed45 tests/775 assertions and inspected
14 styled renderer frames. The ordinary full test-program diagnostics are gone;
exactly15 legacy planning diagnostics remain byte-identical to the recorded baseline.

The zero-exclusion guarded source aggregate ran506 files:504passed, one stale mock
failed4cases, and the legacy planning transaction timed out. The mock was corrected
with an empty registered-host schema and independently passed unchanged daemon-write
routing assertions. Runtime bytes did not change. Aggregate raw evidence retains
6,080passing tests/27,763 assertions from complete summaries; the planning file has
no complete summary. This is not a full green aggregate or native-workflow acceptance.

Owned engine/terminal build, SDK prepare, canonical API check, standard Linux-x64
build, strict standard smoke and private package check all passed. Package inspection
saw607 files; staged sqlite-vec loaded as v0.1.9. Shared regressions passed319 tests/
833 assertions across21 files, including the complete toolchain. Actual compiled
launcher startup opened Settings; Enter persisted literal false, repeated Enter
revoked it, and normal exit returned 0. Network guard violations were zero; only
three previously approved exact synthetic metadata URLs answered locally. This is
synthetic compiled-shell coverage, not a live provider/daemon or original tmux E2E.

Binary SHA256: 9dc40492c054634aad299b8a089c5c86ca79358839a6256f69b5a9439c0f84c3.
Native addon SHA256: 5923730861b86c707cca5602b5f91092f9e52a46706dbc6e269fd4bb9c4498e8.

The native vibecheck direction supersedes the old planning-interview integration
plan. Public engine ledger/evidence types and actor/revision/receipt semantics are
pending; existing planning failures remain explicit until successor code/tests
resolve them. No new planning implementation, plugin internals or destructive legacy
data migration is included. Current accounting 1092/526 remains partial. ACP receipt
labels, actual footer eligibility and unknown-cost display are separate known gaps.
No publication is authorized by this local checkpoint.

Dependency caches in the four recent TUI worktrees use audited read-only donor
aliases after inode recovery. No package-manager install/remove/update or dependency
mutation may run through those aliases; restore a private representation first.
Verified archives and restoration receipts are retained in the proof directory.
