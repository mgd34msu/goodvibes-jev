# Integrating the October 1 platform refresh

The owner asked us to inspect the newly published platform commits, integrate
them, and continue the Jev project to completion. This replaces the temporary
upstream hold. The existing Jev behavior, privacy boundaries, operator authority
and contract runner remain the destination architecture. Upstream UI changes are
the new product-parity target; we are not designing another interface.

The October 3 [autonomous Jev decision contract](autonomous-jev-decisions.md)
supersedes older runtime approval/escalation semantics, including those in
upstream UI descriptions. Preserve provisioning/login and deterministic
authority boundaries while migrating runtime decisions to Jev and outage
waiting to the one shared retry implementation. The [root status](../../README.md#status)
records unfinished admission, grant/revocation and consumer migration; source
parity alone does not prove autonomous execution.

## Exact sources

These are the pinned October 1 comparison commits, not merely release tags or a
claim about today's upstream heads. The historical revisions, trees and snapshots
are accessible in Git at `c480b01e:docs/inventory/upstream-targets.json` and its
referenced snapshot paths; those inventory files are absent from the current tree.

| Repository | Comparison base | Forward target | Commits | Changed paths | Pinned tracked files |
| --- | --- | --- | ---: | ---: | ---: |
| goodvibes-sdk | `b4192497` (2.0.23 release) | `17eae838` | 24 | 357 | 3858 |
| goodvibes-daemon | `443e5ee4` | `254699bf` | 4 | 41 | 281 |
| goodvibes-tui | `0d69500f` | `ec057c33` | 27 | 1425 | 1573 |
| goodvibes-agent | `9e225a34` | `f05fe636` | 22 | 822 | 1650 |
| goodvibes-webui | `9856cba6` | `dadf5770` | 16 | 537 | 666 |

The SDK release is a comparison reference for the imported 2.0.23 source, not
a new claim that every current engine file is byte-identical to that release.
The engine already contains substantial Jev-specific work. The other bases are
the original product inventories. The WebUI metadata later named `5050483`
(1.13.20), while its inventory still described `9856cba` (1.13.19). Their paths
are identical, but package/schema/settings content differs. That historical
discrepancy is retained here. The applied WebUI source record and partial
workspace now use `dadf577` (2.0.0), with all 666 tracked paths accounted for;
its remaining semantic replacements and full product parity are still open.

The ecosystem index and adjacent app, Home Assistant, plugin, Codex and desktop
repositories were checked. Their latest published source changes predate this
refresh. They remain outside the five-repository port scope. No new product is
silently added because it shares the GoodVibes name.

## What changes in the implementation

### Engine and daemon

Buzz owns deliberate SDK/daemon integration, starting with the shared theme
engine, tree-glyph settings and config exports. Subsequent slices carry over
channel conversational-tool restrictions, context-window provenance and unknown
values, whole-message compaction, turn-notification ownership/deduplication,
process completion state and panel-state cleanup. Upstream worktree reliability
changes must be compared with the Jev runner's existing fixes.

Wholesale source replacement would reintroduce WRFC and semantic heuristics
already removed from Jev. Preserve the new product behavior through the current
contract runner and judgment interfaces. In particular, a conversation channel
must not regain write/edit/exec tools through a follow-up turn.

The daemon remains pinned to `254699bf` (281 source paths). The accessible
historical map, `c480b01e:products/daemon/migration.json`, contains 190 distinct
source mappings. Of the other 91 paths, 29 have direct files under
`products/daemon`; the remaining 62 have the inspected dispositions below:
26 hoisted, 26 replaced and 10 retired. The former 89-mapping count is obsolete.
The historical map and direct-file count establish source accounting, not a
current 281-path behavioral acceptance ledger.

#### Daemon relocations and retirements

Paths in the first column are relative to the pinned daemon repository. `HOIST`
uses a shared owner, `REPLACE` preserves the supported obligation through the
current architecture, and `RETIRE` removes an unused wrapper or superseded policy.
The linked callers and test sources expose the boundaries to verify; their
existence does not establish passing tests, compiled execution or live parity.

| Pinned paths | Disposition and current owner | Current test or verification source |
| --- | --- | --- |
| `.github/workflows/{ci,release}.yml` (2) | HOIST to the [root CI](../../.github/workflows/ci.yml) and [release](../../.github/workflows/release.yml) product/native matrices. | [Workflow shape](../../packages/engine/test/workflow-shape.test.ts); actual CI and release execution remain separate. |
| `CHANGELOG.md` (1) | RETIRE old public-package/WRFC release claims. The private daemon has no active changelog; [explicit preparation](../../products/daemon/scripts/release-prepare.ts) can omit one. | [Preparation transactions](../../products/daemon/src/test/scripts/release-prepare.test.ts). |
| `bin/launcher-support.js`, `scripts/postinstall.{js,d.ts}` (3) | REPLACE automatic downloads with explicit [acquisition](../../products/daemon/scripts/acquire-native.ts), [installation](../../products/daemon/src/cli/native-installation.ts) and [launch](../../products/daemon/src/cli/native-launch.ts). The product has no postinstall hook. | [Acquisition](../../products/daemon/src/test/scripts/acquire-native.test.ts), [installation](../../products/daemon/src/test/scripts/install-native.test.ts) and [native launch](../../products/daemon/src/test/scripts/native-launch.test.ts). |
| `docs/{configuration,getting-started,hosted-sessions,service-and-deployment,updates-and-rollback}.md` (5) | REPLACE the standalone layout with the current [README](../../products/daemon/README.md), [CLI/package contracts](../../products/daemon/docs/cli-and-package-contracts.md), [validation procedure](../../products/daemon/docs/testing-and-validation.md), [runtime ownership](../contracts/daemon-runtime-ownership.md) and [update transactions](../contracts/self-update-transactions.md). | [Entrypoint](../../products/daemon/src/test/cli/entrypoint.test.ts), [hosted composition](../../products/daemon/src/test/runtime/hosted-sessions-parity.test.ts), [service lifecycle](../../products/daemon/src/test/daemon/service-manager-runtime.test.ts) and [update transactions](../../packages/engine/test/self-update-transaction.test.ts). Documentation replacement is distinct from those behaviors. |
| `scripts/boot-smoke.ts` (1) | REPLACE with [actual binary verification](../../products/daemon/scripts/verify-binary.mjs) and [hosted-session proof](../../products/daemon/scripts/hosted-session-proof.mjs). | [Boot diagnostic reader](../../products/daemon/scripts/boot-smoke-reading.test.mjs), [memory evidence](../../products/daemon/scripts/boot-smoke-memory.test.mjs) and [hosted protocol](../../products/daemon/scripts/hosted-session-protocol.test.mjs). Synthetic script tests do not qualify a new binary. |
| `scripts/{check-architecture,check-workflows}.ts` (2) | HOIST to [runtime import/layer checks](../../packages/engine/scripts/daemon-architecture-check.ts) and [workflow structure](../../packages/engine/scripts/workflow-structure.ts). | [Import architecture](../../packages/engine/test/runtime-import-architecture.test.ts) and [workflow structure](../../packages/engine/test/workflow-structure.test.ts). Removed quotas stay removed. |
| `scripts/{ci-publish,publish-check,publish-github-mirror}.ts` (3) | HOIST public publishing to [root staging](../../packages/engine/scripts/publish-packages.ts); REPLACE product checks with [workspace validation](../../packages/engine/scripts/product-workspaces.ts); RETIRE standalone scoped-registry mirroring for the private daemon. | [Publish races](../../packages/engine/test/toolchain/publish-package.test.ts) and [native package boundaries](../../products/daemon/src/test/scripts/native-packaging.test.ts). |
| `scripts/{release,verify-release-tag-version}.ts` (2) | REPLACE local release preparation with the [explicit product command](../../products/daemon/scripts/release-prepare.ts); HOIST tag checks to the [root release verifier](../../packages/engine/scripts/verify-release-tag-version.ts). | [Release preparation](../../products/daemon/src/test/scripts/release-prepare.test.ts) and the actual root release workflow. No publication is implied. |
| `scripts/prebuild.ts` (1) | REPLACE implicit writes with [version-drift refusal](../../products/daemon/scripts/check-version.ts) and [in-memory compile compatibility](../../packages/engine/toolchain/src/lib/bun-compile-compat.ts), called by the product compile driver. | [Installed operations/prebuild refusal](../../products/daemon/src/test/deps/installed-source-parity.test.ts) and [preparation locking](../../products/daemon/src/test/scripts/build-preparation-lock.test.ts). |
| `scripts/sdk-dev.ts` (1) | RETIRE external-checkout overlay discovery; the [product manifest](../../products/daemon/package.json) uses the installed `workspace:*` engine. | [Installed dependency operations](../../products/daemon/src/test/deps/installed-source-parity.test.ts). |
| `scripts/{stale-tmp-sweep,test-temp-manifest,workspace-lock}.ts` (3) | HOIST the [owned-root sweep](../../packages/engine/toolchain/src/test-runner/stale-tmp-sweep.ts) and [workspace lock](../../packages/engine/scripts/workspace-lock.ts). RETIRE child-authored deletion lists; the [owned runner](../../packages/engine/toolchain/src/test-runner/owned-test-child.ts) controls cleanup authority. | [Temp lifecycle/foreign-path refusal](../../packages/engine/test/temp-cleanup.test.ts) and [lock generations](../../packages/engine/test/workspace-lock-lifecycle.test.ts). |
| `src/daemon/cli.ts` (1) | REPLACE with [entrypoint](../../products/daemon/src/cli/entrypoint.ts), [dispatch](../../products/daemon/src/cli/run.ts), [serve composition](../../products/daemon/src/cli/serve.ts) and owned process lifecycle. | [Parser](../../products/daemon/src/test/cli/parser.test.ts), [actual entrypoint](../../products/daemon/src/test/cli/entrypoint.test.ts) and [graph startup/shutdown](../../products/daemon/src/test/runtime/daemon-fixture-boot.test.ts). |
| `src/daemon/handlers/inbox/{index,mapping}.ts` (2) | HOIST registration/account ownership to [engine intake](../../packages/engine/sdk/src/platform/intake/index.ts) and the [production factory](../../products/daemon/src/runtime/production-inbox-composition.ts). REPLACE partial regex scrubbing with complete [protected previews](../../packages/engine/sdk/src/platform/intake/protected-preview.ts). | [Registration](../../packages/engine/test/daemon-inbox-registration.test.ts), [mapping](../../packages/engine/test/intake-mapping-source-parity.test.ts) and [multi-owner composition](../../products/daemon/src/test/runtime/multiowner-inbox-composition.test.ts). Canonical whole-source holds supersede legacy partial card/token outputs. |
| `src/daemon/handlers/triage/{index,integration}.ts`, `src/daemon/handlers/triage/tagger/{discord,imap,index,shared,slack}.ts` (7) | REPLACE the wrapper with [owned persisted triage](../../packages/engine/sdk/src/platform/intake/triage/owned.ts); HOIST provider protocol taggers to engine intake. [Product tagging](../../products/daemon/src/runtime/tagged-inbox-composition.ts) retains independent effect authority. | [Wrapper integration](../../packages/engine/test/intake-triage-integration-source-parity.test.ts), [tagger protocols](../../packages/engine/test/intake-triage-tagger-source-parity.test.ts), [IMAP](../../packages/engine/test/intake-triage-imap-source-parity.test.ts) and [actual native triage callers](../../products/daemon/src/test/runtime/native-inbox-triage-enrichment.test.ts). |
| `src/test/daemon/fatal-boot-report.test.ts`, `src/test/daemon/fixtures/daemon-fatal-boot-{entry,legacy-entry}.ts` (3) | REPLACE the old tiny compiled-fixture test with real descriptor/privacy/startup controls; HOIST fixture source to engine tests. Keeping a fixture file does not prove it was compiled or executed. | [Actual descriptors](../../packages/engine/test/fatal-boot-descriptors.test.ts), [emitted production startup](../../products/daemon/src/test/cli/startup-diagnostics-executable.test.ts) and actual binary verification. |
| `src/test/daemon/inbox/mapping.test.ts` (1) | HOIST adapted normalization/privacy controls to engine intake. | [Complete-source mapping](../../packages/engine/test/intake-mapping-source-parity.test.ts). |
| `src/test/daemon/{server,service-manager}.test.ts` (2) | REPLACE legacy graph scaffolding with the [owned daemon fixture](../../products/daemon/src/testing/daemon-fixture.ts) and actual product service composition. | [HTTP/WebSocket/server parity](../../products/daemon/src/test/daemon/server-parity.test.ts) and [manual child/platform service controls](../../products/daemon/src/test/daemon/service-manager-runtime.test.ts). |
| `src/test/daemon/triage/{helpers.ts,imap-client.test.ts,integration.test.ts,tagger.test.ts}` (4) | REPLACE cast-made handler contexts with explicit native credential/loopback fixtures; HOIST the three protocol/integration suites. | [IMAP](../../packages/engine/test/intake-triage-imap-source-parity.test.ts), [integration](../../packages/engine/test/intake-triage-integration-source-parity.test.ts) and [taggers](../../packages/engine/test/intake-triage-tagger-source-parity.test.ts). |
| `src/test/deps/dependency-check.test.ts` (1) | REPLACE pin/import-only and obsolete fuzzy/overlay checks with actual installed SQL, ZIP, AST and WASM operations. | [Installed-source operations](../../products/daemon/src/test/deps/installed-source-parity.test.ts). |
| `src/test/helpers/{disposables.ts,disposables.test.ts,project-temp.ts,project-temp.test.ts,provider-cache.ts,session-surface.ts}` (6) | HOIST shared helper semantics to engine test helpers; surface identity remains product-owned. | [Disposal](../../packages/engine/test/disposables.test.ts), [owned allocation](../../packages/engine/test/project-temp.test.ts), [provider cache](../../packages/engine/test/provider-cache-fixture.test.ts) and [session surface](../../packages/engine/test/session-surface.test.ts). |
| `src/test/helpers/{temp-cleanup.test,temp-registry}.ts`, `src/test/preload/temp-cleanup.ts` (3) | REPLACE cloned preload/cleanup with the actual engine owned runner and temp registry. | [Real child/descendant/late-write cleanup](../../packages/engine/test/temp-cleanup.test.ts) and [containment](../../packages/engine/test/test-tmp-containment.test.ts). |
| `src/test/helpers/{authenticated-websocket,liveness,settings-control-plane,runtime-services,test-managers}.ts`, `src/test/setup.ts` (6) | RETIRE daemon-only copies and implicit global service/reset/chat fixtures. The server suite owns its WebSocket helper; [per-case graphs](../../products/daemon/src/testing/daemon-fixture.ts) own config and awaited shutdown. Renderer liveness remains [TUI-owned](../../products/tui/src/test/helpers/liveness.ts); other products retain independent helpers. | [Real daemon graph lifecycle](../../products/daemon/src/test/runtime/daemon-fixture-boot.test.ts), actual server parity and [TUI frame liveness](../../products/tui/src/test/renderer/liveness-contract.test.ts). |
| `src/test/runtime/{hosted-exec-posture,hosted-sessions}.test.ts` (2) | REPLACE legacy fixtures with actual [hosted composition](../../products/daemon/src/runtime/hosted-session-composition.ts) and the shared session manager. | [Exec posture](../../products/daemon/src/test/runtime/hosted-exec-posture-parity.test.ts) and [trust/detach/turn/persisted restart](../../products/daemon/src/test/runtime/hosted-sessions-parity.test.ts). |

The three native provider factories now call `createOwnedTriagedInboxSource` with
their exact account adapter/read lease. They preserve the original mirror
filename and outer physical lock; the private triage store has its own scoped
lock. Plain reads remain available without scoring authority, while explicit
scoring refuses. Neither processing-backend screening nor caller flags supply a
triage/tag-write grant. Configured standalone startup still requires genuine
backend and account/source authorization; the setup and live-provider
qualification remain separate from this source crosswalk.

The five formerly deferred release/toolchain rows have current successors: the
root release workflow, `verify-binary.mjs`/`hosted-session-proof.mjs`,
`release-prepare.ts`, its native product tests and `toolchain.config.json`.
Source mechanics no longer justify calling those rows deferred. Exact artifact
qualification, platform execution and release availability still need their own
receipts.

### WebUI

Wintermute owns the port at `dadf577`. The redesigned app has four primary
places: Chat, Work, Library and Personal. It introduces a shared shell/UI kit,
settings dialog and responsive list/detail flows. Its 18 SDK import paths and
contract/presentation bridge implementations remain unchanged, so the real
application can be ported against the existing public engine exports before
the independent terminal-oriented SDK work completes.

Retarget imports, build and package tooling to the monorepo. Preserve navigation,
assets, themes, PWA and auth/connection behavior. Reconcile new and removed
inventory paths, including semantic status-tone decisions that moved to shared
helpers. Work and former approval views must render the shared autonomous
contract/gate states and waiting progress, without human semantic approval.

The real workspace, browser-safe theme/payment imports, nullable-context
rendering and pairing-lifetime repair have landed. Synthetic browser and LAN
proof cover the implemented flows. The authenticated palette caller and fixed
status catalogs now include reviewed auth-lifetime guards, while production
authority/reference installation and the dynamic-error caller remain open.
Complete contract/gate actions and connected-daemon/live-provider parity remain
separate completion work. Unknown/null context windows must stay honest, without
invented percentages or model-name-based window guesses.

### TUI

Wintermute owns the port at `ec057c33`. Preserve the new surface kit, themes,
modal host, conversation lane graph, throbber, notifications/history and
full-screen agent/process views. The first coherent milestone is a runnable
shell with startup/first-turn behavior and a contract-tree adapter where work
is shown, followed by complete actions, usage/session persistence and current
built-binary scenarios.

Removing pane state does not remove the existing panel command contract:
`IntegrationHelperService` still uses a `panelManager` adapter to serve
`panels.list/open` and `/api/panels/*` through modals. Preserve this adapter.
New upstream work-tree wiring reads WRFC roles and verdicts; project contract
units and their typed judgments instead. New output/tool inference in the
lane renderer requires explicit semantic decisions, not inherited PORT labels.

### Agent

Wintermute owns the port at `f05fe636`. Preserve the new themes/modal surfaces,
lane graph, full-screen work views, notifications, context/status controls,
isolated delegation and profile/knowledge boundaries. First-start workspace
registration defaults to decline, Escape declines, and the next complete
prompt remains available.

The latest source also fixes cancellation: every tool wrapper forwards the
execution options/AbortSignal through policy, boundary and MCP wrappers.
Verify the real tool registry reaching exec, not only an isolated wrapper.
Preserve the lane UI while replacing newly added WRFC behavior with the Jev
runner. Semantic result/tool/status guesses still need inventoried judgments.

## Source verification

Generate a snapshot from an explicit local Git commit:

```sh
bun packages/engine/scripts/upstream-source-snapshot.ts \
  --source-dir /path/to/goodvibes-webui \
  --commit dadf57700668fe4500b17b0b0b4520715ab25ef4 \
  --snapshot /path/to/snapshot/webui.json
```

Repeat with `--check` to compare the recorded tree and every path, mode, object
type and object identity with that exact commit. This reads local Git objects;
it does not fetch, run upstream code or trust the checkout's current HEAD.
Snapshots establish source provenance, not product parity or successful live
operation. Normal CI remains independent of external clones and services.

## Completion sequence and ownership

1. THE-58 records immutable targets, corrects the historical WebUI metadata and
   verifies source content rather than file names alone.
2. THE-30 ports the new WebUI while Buzz advances THE-13/THE-18 SDK and daemon
   prerequisites. Coordinate shared manifests and exports before editing them.
3. THE-62 and THE-63 port TUI and Agent through the resulting public seams.
   Every changed/new/deleted source module gets a reasoned disposition; a
   replacement or removed test does not silently erase its behavioral contract.
4. Complete remaining engine judgments, product mappings and connected parity
   under THE-12/13/14, then genuine endpoint calibration and final proof under
   THE-15/35. The persisted failover patch remains preserved and live-gated.

Use coherent reviewed increments and exact-head CI. Keep one published PR per
owner at a time where dependencies allow. Buzz owns branch cleanup. Do not
restore SBOM, arbitrary line limits, coverage quotas, source-spelling checks or
other removed filler infrastructure. Preserve tests that catch actual behavior,
security boundaries, persistence, cancellation and compatibility failures.
