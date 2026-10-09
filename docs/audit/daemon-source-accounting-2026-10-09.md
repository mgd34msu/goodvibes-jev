# Daemon source accounting, October 9

Reviewed local source: `86682ccb0bcabe7b0cc75e5ebe159563b4cdd587`.
Pinned original: `mgd34msu/goodvibes-daemon` at
`254699bf5d834cdca41436211ada1ae32bf89258`, tree
`f11b13cea45cd108e50e66c6a5ae3c72c07dc048`.
The first pass is an accounting-only change. The continuation adds synthetic
assertions and records a separately qualified historical-artifact run. Neither
pass establishes remote delivery, runtime activation, release acceptance or a
new full current-source compile/binary receipt.

## First-pass accounting (commit b7c45277)

- Original inventory: **281** rows; PORT 184, JEV 3, HOIST 94, DROP 0, six decision points. Unchanged.
- Before: **103** mapped (PORT 84, HOIST 18, JEV 1); **178** unmapped.
- Added: **54** mappings (PORT 2, HOIST 52). No existing mapping is removed or reclassified.
- After: **157** mapped (PORT 86, HOIST 70, JEV 1); **124** unmapped.
- Every new source is in the pinned inventory; every target is a tracked current file.
  No new source identity, DROP disposition, or blanket completion claim is introduced.
- The prior two release-preparation mappings are already in the 103-row baseline;
  they are not counted again here.

The original blobs are available in the local Git object database. The existing
inventory records full source/check dispositions and the linked audits record
intentional behavior adaptations. Of these 54 sources, only
`src/test/daemon/remote/backends.test.ts` changed between the earlier `443e5ee4`
audit pin and the current pin: blob `dff1329610ec4f035db69e6f866bf09b83d0cb09`
to `0f82cf71aba65f9bc7e60e1c6cfd21f5f3d54269`. Its timeout proof moved from an
elapsed-speed assertion to awaited timeout/nonzero child exit under a test
ceiling. The mapping includes the actual current process-runner suite containing
that proof. No older-source equivalence is inferred for a changed file.

## Current callers and evidence boundaries

### Store

The shared `HandlerSqliteStore` is consumed by the actual remote peer registry,
routing and intake stores. Its original recovery assertions remain in
`daemon-handler-sqlite-recovery.test.ts`. The
[store audit](daemon-handler-store-hoist.md) documents ordered persistence,
quarantine refusal, schema separation and the process-local coordination limit.
The two mappings credit that shared implementation and original recovery suite.

### Intake

`platform/intake/registration.ts` constructs the actual `InboxCursorStore` and
`InboundPoller`, and invokes `aggregateInbox`; it is composed through the daemon's
owned inbox factories. The four primitive files and original cursor/poller suites
preserve mirror/cursor/provider contracts with the documented lifecycle fixes:
[cursor](daemon-intake-cursor-hoist.md), [poller](daemon-intake-poller-hoist.md),
[aggregation](daemon-intake-aggregation-hoist.md).
The Slack adapter is called by `providers/slack-owner.ts`, used by the product's
explicit account-owned Slack composition. Its full offline transport/paging tests
pass. The Discord private adapter is exercised by real poller/store fixture
composition, not a production catalog. Its required host catalog replaces the
unsupported inferred bot DM-listing assumption; mapping the adapter does not
claim that production Discord membership/history is supplied. See
[Slack](daemon-slack-inbox-adapter.md), [Discord](daemon-discord-inbox-adapter.md),
and [production bootstrap](daemon-production-bootstrap.md).

### Payments

`products/daemon/src/runtime/payments-composition.ts` builds the real stores,
address adapter, notifier and checkout registration; handler composition owns
its returned surface and reply inbox. The original six store/registration tests
and gateway-payment suite are mapped to their existing engine suites. The
[composition audit](daemon-payment-composition.md) describes canonical merchant
judgment, authenticated reply ownership and awaited shutdown. These mappings
credit existing local implementations, not a live checkout, payment, provider
calibration or new permission to perform one.

### Routing

`products/daemon/src/runtime/daemon-handler-composition.ts` supplies the actual
`registerRoutingMethods` before inbox acquisition. Registration uses the mapped
route store, resolver and bridge, retaining exact owner bindings, persisted
assignments and explicit null/no-binding behavior. The original store/resolver
suites plus current product assembly establish the call path. See
[routing hoist](daemon-channel-host-routing-hoist.md) and
[handler assembly](daemon-handler-assembly.md). No text heuristic selects a route.

### Remote

The same product composition supplies the real `registerRemoteSurface`, whose
surface constructs the registry/dispatcher/backends and shared service. The
original six remote suites map to their current engine counterparts, with the
pinned process-runner delta included separately. The existing
[process](daemon-remote-process-hoist.md), [basic backends](daemon-remote-basic-backends-hoist.md),
[SSH](daemon-ssh-hoist.md), [cloud terminal](daemon-cloud-terminal-hoist.md),
[peer registry](daemon-remote-peer-hoist.md), [dispatcher](daemon-dispatcher-hoist.md)
and [surface](daemon-remote-surface-hoist.md) audits explain literal secret
handling, owned child/temporary-file lifetime, awaitable close and intentionally
changed dead-owner cleanup fixtures. Production operator backend/manager peer
registration usability is not established merely by these component mappings.

### Cluster

The terminal-shell public entry exports both helpers; actual daemon command
adapters call `callDaemonWsVerb` and `callDaemonRoute`. The original two transport
suites retain protocol/envelope assertions with additional one-shot/late-frame
and loopback regressions. See [cluster transport](daemon-cluster-hoist.md).

### Boot/plugins

`products/daemon/src/runtime/daemon-host.ts` actually passes
`createDaemonBootOperations` into runtime acquisition. `services.ts` owns the
controller; the host starts it after facade initialization and drains it on
shutdown. The original six boot steps are split between `boot-tasks.ts` and
`boot-composition.ts`: memory fold, provider watching, shared webhook owner,
queue notifier, configured-service synchronization and plugins. Shared live
metadata-only notification policy and awaited acquisition replace the original
unowned effects, not those steps. The plugin adapter retains actual registries
and explicitly unserved slash/tool registration semantics.
The real graph/plugin HTTP and boot shutdown tests pass; see
[boot ownership](daemon-boot-task-ownership.md) and
[notification ownership](daemon-boot-notification-ownership.md).

## New mapping crosswalk

Each source below is a whole-file disposition within the component boundary
above. Targets are implementations/test adaptations, not simply similarly named
imports. Original source identity is pinned by the Git blob column.

| Original source | Disposition | Original blob | Current targets | Receipt group |
|---|---|---|---|---|
| `src/test/daemon/sqlite-store-recovery.test.ts` | HOIST | `12ab40fc2e1d741c97f3a593c2361f279cc87730` | `packages/engine/test/daemon-handler-sqlite-recovery.test.ts` | Store |
| `src/daemon/handlers/sqlite-store.ts` | HOIST | `7f3829a9d2f4978918674cd507cb99c9009b15cb` | `packages/engine/sdk/src/platform/state/daemon-handler-sqlite-store.ts` | Store |
| `src/daemon/handlers/inbox/aggregator.ts` | HOIST | `1f1f2a80f9a3e234d29073241a429fbdfd9a88d6` | `packages/engine/sdk/src/platform/intake/aggregator.ts` | Intake |
| `src/daemon/handlers/inbox/cursor-store.ts` | HOIST | `5193f15fbddf29e0c209c461d15d525e36cc4f95` | `packages/engine/sdk/src/platform/intake/cursor-store.ts` | Intake |
| `src/daemon/handlers/inbox/poller.ts` | HOIST | `78c94d269c3c809dd5984f89d2096fb42ed64dc2` | `packages/engine/sdk/src/platform/intake/poller.ts` | Intake |
| `src/daemon/handlers/inbox/provider-adapter.ts` | HOIST | `ffe4fadf8e84f5dfa9ee3692a0a41c9067284b8f` | `packages/engine/sdk/src/platform/intake/provider-adapter.ts` | Intake |
| `src/daemon/handlers/inbox/providers/discord.ts` | HOIST | `d14cfa423c37ca8eb5fc182e47c73907fc058a3c` | `packages/engine/sdk/src/platform/intake/providers/discord.ts` | Intake |
| `src/daemon/handlers/inbox/providers/slack.ts` | HOIST | `644a8dfe7f4f9f5f90af671498bc8a58292547f8` | `packages/engine/sdk/src/platform/intake/providers/slack.ts` | Intake |
| `src/test/daemon/inbox/cursor-store.test.ts` | HOIST | `3f5ec1f7bb5ea024ce18299d162115b08df22286` | `packages/engine/test/daemon-inbox-cursor-store.test.ts` | Intake |
| `src/test/daemon/inbox/poller.test.ts` | HOIST | `0c2a31e633923ef0d3703c0c82d057f784988897` | `packages/engine/test/daemon-inbox-poller.test.ts` | Intake |
| `src/daemon/handlers/payments/address-store.ts` | HOIST | `143c8fe649e7b0b871a0f7a8967fd033c5234f53` | `packages/engine/sdk/src/platform/payments/host/address-store.ts` | Payments |
| `src/daemon/handlers/payments/approval-store.ts` | HOIST | `47f23e8dacef796034cbd3e5ee207c7961ed9b53` | `packages/engine/sdk/src/platform/payments/host/approval-store.ts` | Payments |
| `src/daemon/handlers/payments/budget-store.ts` | HOIST | `e10530829ae052dc3ae34ce55a249230eded913a` | `packages/engine/sdk/src/platform/payments/host/budget-store.ts` | Payments |
| `src/daemon/handlers/payments/card-store.ts` | HOIST | `a34099ac5c672b75849e5ce8b048e127307a0c54` | `packages/engine/sdk/src/platform/payments/host/card-store.ts` | Payments |
| `src/daemon/handlers/payments/checkout-handlers.ts` | HOIST | `7c27b8c8022ea92ba946d461a65526df2bc3c07f` | `packages/engine/sdk/src/platform/payments/host/checkout-handlers.ts` | Payments |
| `src/daemon/handlers/payments/checkout-journal-store.ts` | HOIST | `c9fddb02c78f3dc72248cc8775553d9342510bd4` | `packages/engine/sdk/src/platform/payments/host/checkout-journal-store.ts` | Payments |
| `src/daemon/handlers/payments/index.ts` | HOIST | `2f289152658518e07a005694f8b500d3c99f2955` | `packages/engine/sdk/src/platform/payments/host/index.ts` | Payments |
| `src/daemon/handlers/payments/notifier.ts` | HOIST | `e9291eaf64e63b1c5cb7249e42ded718bcc36e5b` | `packages/engine/sdk/src/platform/payments/host/notifier.ts` | Payments |
| `src/daemon/handlers/payments/purchase-ledger.ts` | HOIST | `cc4d72b7630f6ad14d72bff96d4aefa267f1946e` | `packages/engine/sdk/src/platform/payments/host/purchase-ledger.ts` | Payments |
| `src/test/daemon/payments/approval-store.test.ts` | HOIST | `050ebe96d26d319762f2401ef51ddb142403ac26` | `packages/engine/test/payments-host-approval-store.test.ts` | Payments |
| `src/test/daemon/payments/budget-store.test.ts` | HOIST | `3ef00b3e376f4f08c3908c75225ae09fbd92650a` | `packages/engine/test/payments-host-budget-store.test.ts` | Payments |
| `src/test/daemon/payments/card-store.test.ts` | HOIST | `008524851983259a5fdb43c762ac5b42fbf89a89` | `packages/engine/test/payments-host-card-store.test.ts` | Payments |
| `src/test/daemon/payments/checkout-journal-store.test.ts` | HOIST | `3a8bb62cc8c593df18fe0f58079db054f5763e57` | `packages/engine/test/payments-host-checkout-journal-store.test.ts` | Payments |
| `src/test/daemon/payments/purchase-ledger.test.ts` | HOIST | `d2c8195fc86abc64620d15945009a5df9b4310bd` | `packages/engine/test/payments-host-purchase-ledger.test.ts` | Payments |
| `src/test/daemon/payments/register.test.ts` | HOIST | `918d2bf2fcfc8573687cc24a3dbdad2e28e31d0c` | `packages/engine/test/payments-host-register.test.ts` | Payments |
| `src/test/daemon/gateway-payments-verbs.test.ts` | HOIST | `862f7ee68bbc9064e10a0bf0c65e6acec65a3070` | `packages/engine/test/payments-host-gateway-verbs.test.ts` | Payments |
| `src/daemon/handlers/routing/inbox-bridge.ts` | HOIST | `87008aed9aed51331bd4fdb6e77f33cbce6a963d` | `packages/engine/sdk/src/platform/channels/host-routing/inbox-bridge.ts` | Routing |
| `src/daemon/handlers/routing/route-store.ts` | HOIST | `83d53b9c391c3c88623cf72e48e70107f4404989` | `packages/engine/sdk/src/platform/channels/host-routing/route-store.ts` | Routing |
| `src/daemon/handlers/routing/routing-resolver.ts` | HOIST | `9d167a614566aa7d3260b06d80630ec492498507` | `packages/engine/sdk/src/platform/channels/host-routing/routing-resolver.ts` | Routing |
| `src/test/daemon/routing/route-store.test.ts` | HOIST | `44ad0ea64dfacd3069de86e16e2daeef7ea14494` | `packages/engine/test/daemon-channel-route-store.test.ts` | Routing |
| `src/test/daemon/routing/routing-resolver.test.ts` | HOIST | `f32ecc1d992f777ddb3208dec8f4dd970dc9476d` | `packages/engine/test/daemon-channel-routing-resolver.test.ts` | Routing |
| `src/daemon/handlers/remote/backends/cloud-terminal.ts` | HOIST | `520f9429972cc85f203c2180444e8141865fb952` | `packages/engine/sdk/src/platform/runtime/remote/host/backends/cloud-terminal.ts` | Remote |
| `src/daemon/handlers/remote/backends/docker.ts` | HOIST | `e1c1f073a35bf5907e2efa799a73f68b123ac25d` | `packages/engine/sdk/src/platform/runtime/remote/host/backends/docker.ts` | Remote |
| `src/daemon/handlers/remote/backends/index.ts` | HOIST | `1418061f09c2d3294363e2a3750eb2b282cf15ea` | `packages/engine/sdk/src/platform/runtime/remote/host/backends/index.ts` | Remote |
| `src/daemon/handlers/remote/backends/local-process.ts` | HOIST | `adfc5e3e23aea98b9d447d83224dae67660b75d2` | `packages/engine/sdk/src/platform/runtime/remote/host/backends/local-process.ts` | Remote |
| `src/daemon/handlers/remote/backends/process-runner.ts` | HOIST | `bd15f0cfd7e00f9d581f6cd2cd5a3b21968146ec` | `packages/engine/sdk/src/platform/runtime/remote/host/backends/process-runner.ts` | Remote |
| `src/daemon/handlers/remote/backends/ssh.ts` | HOIST | `bc8fa7c84d754878df11b1ba2b159d9faaedc7b3` | `packages/engine/sdk/src/platform/runtime/remote/host/backends/ssh.ts` | Remote |
| `src/daemon/handlers/remote/backends/types.ts` | HOIST | `8b7434bf4faa2c2b7c0124140e73149a2463e67c` | `packages/engine/sdk/src/platform/runtime/remote/host/backends/types.ts` | Remote |
| `src/daemon/handlers/remote/dispatcher.ts` | HOIST | `75ce18c68969694f0172cae184a094ec2da54b13` | `packages/engine/sdk/src/platform/runtime/remote/host/dispatcher.ts` | Remote |
| `src/daemon/handlers/remote/index.ts` | HOIST | `5038a232f268e98535da66b8a22127b0260f096f` | `packages/engine/sdk/src/platform/runtime/remote/host/surface.ts` | Remote |
| `src/daemon/handlers/remote/peer-registry.ts` | HOIST | `3e222bbe355f87d3fcd3ff580f7fdeb1c8c7d7bf` | `packages/engine/sdk/src/platform/runtime/remote/host/peer-registry.ts` | Remote |
| `src/daemon/handlers/remote/service.ts` | HOIST | `ccce4752bea426a00192bfe7f7cef1c5776dfffc` | `packages/engine/sdk/src/platform/runtime/remote/host/service.ts` | Remote |
| `src/test/daemon/remote/backends.test.ts` | HOIST | `0f82cf71aba65f9bc7e60e1c6cfd21f5f3d54269` | `packages/engine/test/daemon-remote-backends-port.test.ts`, `packages/engine/test/daemon-remote-process-runner.test.ts` | Remote |
| `src/test/daemon/remote/dispatcher.test.ts` | HOIST | `586499dd5e6ef90a29d56e9e630a7413f7f84d2d` | `packages/engine/test/daemon-remote-dispatcher.test.ts` | Remote |
| `src/test/daemon/remote/index.test.ts` | HOIST | `6904036449c06bbbdf00f19e8bd203cbc3f7b94f` | `packages/engine/test/daemon-remote-surface.test.ts` | Remote |
| `src/test/daemon/remote/peer-registry.test.ts` | HOIST | `90f81784dc0334a66ec2c8052f41f671e3bb202b` | `packages/engine/test/daemon-remote-peer-registry.test.ts` | Remote |
| `src/test/daemon/remote/route-gating.test.ts` | HOIST | `31c6eb98b748ee8fcba66799457bf523c47a17ae` | `packages/engine/test/daemon-remote-route-gating.test.ts` | Remote |
| `src/test/daemon/remote/service.test.ts` | HOIST | `a8a4fbee593bb1519ca3f8781634a2a27ece567d` | `packages/engine/test/daemon-remote-service.test.ts` | Remote |
| `src/cluster/daemon-ws-call.ts` | HOIST | `190e25d5cc3b98e51010cb89dc0860b53f978a7b` | `packages/engine/terminal-shell/src/daemon-ws-call.ts` | Cluster |
| `src/cluster/raw-reply-route.ts` | HOIST | `cc258725701febee9f5919706afa79c64bda8dac` | `packages/engine/terminal-shell/src/raw-reply-route.ts` | Cluster |
| `src/test/cluster/daemon-ws-call.test.ts` | HOIST | `f5b57982a053038c0ae17cd3fe4545e8b80b963b` | `packages/engine/test/daemon-cluster-ws-call.test.ts` | Cluster |
| `src/test/cluster/raw-reply-route.test.ts` | HOIST | `f674d0afaf17dad3d8585ab11152ad32f151efcc` | `packages/engine/test/daemon-cluster-raw-reply.test.ts` | Cluster |
| `src/runtime/boot-tasks.ts` | PORT | `a4294bfae7191874423751deec7c7e368fabd866` | `products/daemon/src/runtime/boot-tasks.ts`, `products/daemon/src/runtime/boot-composition.ts` | Boot/plugins |
| `src/runtime/plugin-composition.ts` | PORT | `dba941695dde97226667b55cd7cd27ab373cf470` | `products/daemon/src/runtime/plugin-composition.ts` | Boot/plugins |

## Local verification on the reviewed source

All tests used the guarded `packages/engine/scripts/test.ts` runner, absolute
Bun from the installed tool directory, synthetic inputs and runner-owned temporary
files. No live account, user credential store, external provider or real service
installation was used. No runtime source changed during this accounting pass.

| Selection | Result |
|---|---|
| 20 mapped engine test targets plus aggregation/registration/Slack/Discord fixture suites | 507 passed, 24 files, 5,109 assertions |
| Process runner, cloud terminal and basic backends | 41 passed, three files, 107 assertions |
| Product boot composition/graph/shutdown/controller and plugin drain | 34 passed, five files, 217 assertions |

The product-workspace inspection and `git diff --check` also pass. A structural
check confirms all 157 sources are unique pinned rows, all targets are tracked,
and every mapping disposition matches the original inventory.

These are disjoint selected source suites, not a full-workspace test result.
The initial product invocation used the wrong runner-relative `--cwd` and failed
with ENOENT before tests. The corrected `--cwd ../../products/daemon` invocation
passed without source changes. No full compile was required for this JSON/docs
change. Historical batch/compiled results remain attributed to their original
source in [the integration receipt](product-daemon-semantic-integration-2026-10-09.md).

## First-pass evidence and remaining parity

The six-row assertion continuation below supersedes the first-pass triage/core
and hosted-script deferrals in this section. Other boundaries remain open.

- Startup token pruning, guarded legacy reconciliation and stable empty-only
  public-URL persistence have admitted callers and fixture evidence, as recorded
  in [startup maintenance](daemon-startup-maintenance-callers.md). Earlier
  October 8 wording saying those callers are absent is stale. Actual host-service
  adoption/platform behavior and product update policy are not thereby complete.
- The compiled Linux binary has actually passed synthetic configured-model/Jev
  streaming, persisted assistant history, restart, cancellation, failure and
  owned shutdown proof. The integration receipt states exact tested source and
  payload hashes. This pass does not rerun it or imply live Jev calibration.
  The original whole `scripts/hosted-session-proof.ts` row remains unmapped here:
  its persisted config/default-versus-override detach-policy checks, explicit
  kill/live-versus-terminated listing and relative-workspace rejection are not all
  asserted in the current compiled proof. Strong new tests do not erase those
  original assertions.
- Owned triage scoring/read enrichment is implemented with actual source and
  daemon HTTP fixtures. Original triage `integration.ts` and `index.ts` additionally
  expose the provider tagger; they are not fully accounted by scoring alone.
  The scorer/pipeline/types and original test files also require an explicit
  adaptation crosswalk before whole-file credit (legacy heuristic/custom-threshold
  expectations must not silently survive or be declared unchanged).
- Standalone send is implemented; the old command/wire test obligations span
  current product and shared delivery suites, with intentional structural
  diagnostics instead of provider-prose disclosure. Their whole original test
  rows remain unmapped pending the full assertion crosswalk, not because send
  implementation is absent.
- `src/daemon/cli.ts`, inbox `index.ts`, privacy `mapping.ts` and its tests remain
  partial. Unconfigured production membership does not supply configured trusted
  local authority, retention/revocation provenance or a Discord DM catalog/history
  policy. No regex privacy fallback or hosted raw-content fallback is introduced.
- `.github/workflows/release.yml`, whole hosted-session proof and
  `toolchain.config.json` remain unmapped. The separately mapped local
  release-preparation source/test mechanics do not resolve product version policy,
  releaseCut/publish/perJobGreen, authenticated updates or release activation.
  Supported-platform/service acceptance, live calibration (THE-35) and
  whole-session transport bounds remain open.

### Current-only files are not extra pinned source rows

Examples of authored target additions absent under the original pinned paths are
`products/daemon/src/runtime/boot-composition.ts`,
`products/daemon/src/cli/startup-maintenance.ts`,
`products/daemon/src/cli/production-runtime.ts`, and
`products/daemon/scripts/hosted-session-proof.mjs`. These are target-side owners or
proof adaptations; they do not enlarge the 281-row denominator or automatically
complete the source file whose responsibilities they partially implement.
Only actual existing targets are used in migration.json. The pinned upstream
manifest and October 1 reconciliation records are preserved unchanged.


## Assertion-crosswalk continuation

Reviewed parent `b7c45277f4d612cbc400406e7462ec0dda625f60` includes hosted verifier
commit `f1d2898755f2ae239ed9a3dcaa92af032cc6a37b`. The supplemental triage test is
new test-only source. No runtime behavior changes in this continuation.

Six further original rows are now mapped: five typed triage source/test rows and
one compiled hosted-proof row. **At this checkpoint: 163 mapped, 118 unmapped** of the
same 281 pinned files (PORT 87, HOIST 75, JEV 1). Across both passes the delta is
60 mappings, PORT 3 and HOIST 57. Original inventory dispositions are unchanged.

### Typed triage adaptation and original assertions

The inventory expressly replaces weighted lexicons, custom per-call thresholds,
message-shape guesses and sigmoid scores with the registered pinned-model spam
and urgency battery. It expressly removes the old custom-threshold/extra-lexicon
test and turns determinism into recorded-reading replay. Those removals are the
required Jev adaptation, not missing implementations or restored heuristics.

The scorer now returns typed settled/held/unavailable receipts for a batch;
`labelToTag` and exact precedence/rounding live in `evidence.ts`. The original
inbound-item and conversation-kind types are represented by `TriageInput` and its
closed conversation-kind union; labels remain spam/priority/normal. Canonical
receipts add explicit evidence and lifetime boundaries. `pipeline.ts` calls the
scorer, owns or borrows the real SQLite store, and reads/enriches exact matching
semantic inputs. The former one-ID read is expressible as a one-item batch;
storage construction is the public `SqliteTriageStore` instead of the old factory.
These are API adaptations, not byte-for-byte or old-signature compatibility.

The old metadata reader deduplicated arbitrary IDs. The canonical reader accepts
complete semantic inputs and refuses duplicate IDs before any judgment/storage
operation, preventing ambiguous input-to-evidence binding. This intentional
stricter contract is preserved and explicitly tested; no silently deduplicating
compatibility path is added. Old unvalidated/stale labels are not carried over.
Missing evidence still preserves the unscored semantic item; stale incoming
triage fields are removed and valid current evidence is returned under `triage`.
The real owned inbox caller projects those receipts to the established wire
fields and uses these exact scorer/pipeline/type owners.

`intake-triage-source-parity.test.ts` adds eight synthetic code assertions:
all three exact provider tags; spam/urgency tie and precedence; full receipt replay;
two-decimal score/signal rounding; full-batch persistence and ID re-score;
one batch metadata read; unscored enrichment preservation; empty/dry borrowed
ownership; and duplicate semantic-ID refusal. Existing suites cover every label,
held/unavailable/model errors, input privacy, atomic SQLite persistence/reopen,
read ordering, revocation and owned-source shutdown. The four-file combined run
passes **70 tests, 317 assertions**, including the eight new tests/44 assertions.
This supersedes the overlapping earlier 62-test three-file run; do not sum them.
Public consumer type contracts already live in `test/types/intake-triage-public.ts`;
this pass did not rerun the whole type project.

The actual caller is `platform/intake/triage/owned.ts`, which invokes
`runInboxTriage` and `readTriageMetadataBatch` under admitted account/grant leases.
Its source suite is included in the result above. Existing daemon
`owned-triage-http.test.ts` establishes returned scoring API plus authenticated
HTTP read-enrichment; no automatic polling score or provider tag write is implied.
Original triage `integration.ts`, `index.ts`, tagger files and their whole suites
remain separate; the missing provider tagger is not replaced by core score tags.

### Hosted proof source parity and artifact attribution

Original blob `7e32e247090130563e08930cde2b45caee7d0b20` is now adapted by
`products/daemon/scripts/hosted-session-proof.mjs` (verifier blob
`04c2a183ec53b4ab54aac52a0a22e6fe0a901a70`, SHA-256
`f9c0614b60f3fbe62e122050cd2e7f8eb7336b2edc3f6f040d9f8be8e4ef6c7d`).
The full original behavioral groups are asserted through real control methods:
persisted config.set/get and maxSessions; inherited kill/survive defaults;
creation/listing; sessions.steer and stored model reply; two-watcher final-detach
kill with detached reason; surviving detach/reattach; per-session kill overriding
survive; explicit kill and retained exact termination reasons; empty live list
versus includeTerminated; and relative-workspace refusal. Current stronger
streaming/authentication/restart/cancellation/failure/shutdown checks remain.
The valid `sessions.steer` HTTP 202 is asserted explicitly, rather than forcing
all successful calls to HTTP 200.

The committed verifier passed against the **historical** Linux-x64 artifact built
at `0aaa247b15b8b3ef54bc29e12ea394f6fa061604`, tree
`4ee732be54f0a07e640dbd5b71e97fb937c16819`. All five payload hashes were checked
before and after; the app hash remains
`cb3baf7dc79a290945f245dd5a88225eccd1f61c1109b4f993ebe1b0edd61657`.
The run produced five model requests, 950 synthetic judgment requests with 481
unique identities, and two stream deltas. No request identity occurred more than
twice over two boots. Protocol helper tests passed four of four; syntax and diff
checks passed. Isolated temporary homes, allowlisted environment, read-only
artifact mounts and synthetic loopback peers were used.

Scoped byte/mode comparison confirms unchanged `products/daemon/src/cli`,
`products/daemon/src/runtime` and `packages/engine/sdk/src/platform/hosted-sessions`
between the historical artifact source and verifier parent. This is **not** a
transitive dependency or full production-source equivalence claim: engine
updater/handover files changed. There is no new current-head native build,
live calibration, cross-platform/service proof or release/activation acceptance.
The whole proof script's source disposition can be credited without claiming
those independent outcomes. Only the release workflow and toolchain of the
original five deferred rows now remain unmapped; release policy remains open.

### Additional mapping crosswalk

| Original source | Disposition | Current targets |
|---|---|---|
| `src/daemon/handlers/triage/scorer.ts` | HOIST | `packages/engine/sdk/src/platform/intake/triage/scorer.ts`, `packages/engine/sdk/src/platform/intake/triage/battery.ts`, `packages/engine/sdk/src/platform/intake/triage/evidence.ts` |
| `src/daemon/handlers/triage/pipeline.ts` | HOIST | `packages/engine/sdk/src/platform/intake/triage/pipeline.ts`, `packages/engine/sdk/src/platform/intake/triage/store.ts` |
| `src/daemon/handlers/triage/types.ts` | HOIST | `packages/engine/sdk/src/platform/intake/triage/types.ts` |
| `src/test/daemon/triage/scorer.test.ts` | HOIST | `packages/engine/test/intake-triage.test.ts`, `packages/engine/test/intake-triage-source-parity.test.ts` |
| `src/test/daemon/triage/pipeline.test.ts` | HOIST | `packages/engine/test/intake-triage.test.ts`, `packages/engine/test/intake-triage-store.test.ts`, `packages/engine/test/intake-triage-source-parity.test.ts` |
| `scripts/hosted-session-proof.ts` | PORT | `products/daemon/scripts/hosted-session-proof.mjs`, `products/daemon/scripts/hosted-session-protocol.mjs` |


## Send assertion completion and final counts

Send implementation/test restoration commit `55051ba7bcd132ab0ca32186f9baa8f206acc3b6` closes the two
remaining candidate test crosswalks. **Final accounting in this pass: 165 mapped,
116 unmapped** (PORT 89, HOIST 75, JEV 1) of the same **281** pinned rows.
Net change from the original 103 mapped/178 unmapped baseline: **62 new mappings**,
PORT 5 and HOIST 57. No original mapping was removed or reclassified. No new
runtime owner, privacy fallback, release action or source-inventory row was added.

The original `send-command.test.ts` 32-case obligation is covered by the current
command suite plus `send-wire.test.ts`; the original nine-case wire obligation
is covered by the new real transport suite plus the delivery/executable suites.
The latter use actual selected configuration, real default/moved daemon-tier
fixture secret stores, `createSendStack`, canonical router and real strategies.
Only external fetch is captured; there are no real provider calls or user secrets.

The crosswalk covers channel/default/ambiguity/disabled/gate refusals without
redirection; explicit recipient/title and argument-terminator bytes; both Google
Chat spellings; every advertised transform and unverified-transform refusal;
Discord masked links, bold/spoiler/quotes/mentions; Slack/Google Chat entities;
Mattermost and WhatsApp markup; Matrix/Signal plain text; Telegram token lookup,
wire destination/body and absence of parse_mode; ntfy configured/override topic,
unchanged defaults, title and newline/header safety. Existing ownership tests
retain held stdin, credential/fetch/body drainage, no hidden retry and repeated
explicit sends. `--list` retains addressing vocabulary, default and override help.

Comparison found genuine omitted original behavior, rather than treating every
current expectation as authoritative. The worker restored:

- Configured-ready suggestions on refusal, publishing only fixed catalog IDs,
  never destination values, hostile input or provider prose. "Ready" here means
  enabled with a configured destination; it does not verify credentials/provider
  availability. Explicit choices still refuse instead of redirecting.
- The fixed default-selection preamble and unique-destination reason.
- `--list` default/`--to` guidance.
- Exactly the original stdin-only terminal-LF removal (`/\n+$/`). Interior
  newlines, spaces and carriage returns are preserved. Explicit argument bytes
  are untouched. Actual emitted stdin-send expectations now agree with that
  original contract. This is not general whitespace trimming.

Original provider-prose disclosure assertions are intentionally adapted to
nonzero structural status diagnostics with no borrowed prose, token URL or
unvalidated identifier disclosure, as already specified by
[the standalone-send audit](daemon-standalone-send.md). No secret-detection regex
or meaning heuristic is restored. This is the explicit existing diagnostic
projection, not a claim that the old error text remains unchanged.

Independent review confirmed the production delta is limited to those original
structural behaviors, preserving admission and privacy fences. After actual
daemon emit, the final selected send/script run passed **105 tests, eight files,
635 assertions**, including 18 new wire tests. Daemon no-emit typecheck and
production TypeScript emit passed. The no-emit check preceded only the final
test expected-LF string correction; production source was unchanged, and emit
and the 105-test run include the final correction. A repeated supplemental triage suite passed
eight tests/44 assertions; it overlaps the earlier 70-test triage result and is
not an additional count. These checks do not constitute a full workspace,
current-head native artifact, live calibration or release acceptance run.

| Original source | Disposition | Current targets |
|---|---|---|
| `src/test/daemon/send-command.test.ts` | PORT | `products/daemon/src/test/daemon/send-command.test.ts`, `products/daemon/src/test/daemon/send-wire.test.ts` |
| `src/test/daemon/send-wire.test.ts` | PORT | `products/daemon/src/test/daemon/send-wire.test.ts`, `products/daemon/src/test/daemon/send-delivery.test.ts`, `products/daemon/src/test/daemon/send-executable.test.ts` |


Final structural checks preserve all 281 inventory identities/dispositions and
all 103 baseline mappings, reject duplicate/foreign sources, and verify current
target paths. Product inspection and whitespace checks pass. The strict
`migration:complete` gate remains red for unresolved original rows and missing
whole-product parity/proof/pattern-audit evidence. Partial status, trusted-local
privacy/account authority, Discord catalog, product policy, live calibration,
platform/service/release activation and publication gates remain open.
