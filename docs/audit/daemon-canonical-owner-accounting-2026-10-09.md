# Daemon canonical-owner and complete residual accounting

Pinned upstream: `mgd34msu/goodvibes-daemon` at
`254699bf5d834cdca41436211ada1ae32bf89258`, tree
`f11b13cea45cd108e50e66c6a5ae3c72c07dc048`.
Baseline: `edf6f5d8e87c81c0959e5e58348c9dce1f6d6e44`, with 165 mappings.
This continuation examines **every one of the 116 residual source rows**.
It neither changes the pin nor claims that all original behavior is complete.

## Exact accounting and ownership

- Original inventory remains 281 files: PORT 184, JEV 3, HOIST 94, DROP 0;
  all six inventoried semantic decisions remain intact.
- Baseline: 165 mapped / 116 unmapped (PORT 89, HOIST 75, JEV 1 mapped).
- This delta: 25 new mappings (PORT 21, HOIST 4), no removed/reclassified mapping.
- Current: **190 mapped / 91 unmapped**, with mapped PORT 110, HOIST 79, JEV 1.
- Residual 91: 64 partial, 17 missing, three incomplete policy replacements,
  and seven complete source copies in another product that are not daemon/shared
  adoption. Missing proof is not a claim that the underlying feature is broken.

The [machine-readable complete residual crosswalk](daemon-remaining-source-crosswalk-2026-10-09.json)
contains all 116 original paths and exact blobs, original disposition, current
successors, actual caller/assertion evidence, adaptations and concrete remaining
requirements. It records the first read-only classification separately where new
proof later closed a row. Together with the 165 baseline mappings, it covers all
281 identities without treating uncertainty as completion or silently dropping a
file. Historical first-pass qualification remains in
[the previous accounting receipt](daemon-source-accounting-2026-10-09.md).

`canonicalOwner` explicitly records an existing shared engine or root-workspace
owner for an original PORT row. It does **not** rewrite the original disposition.
Twelve new mappings name engine ownership and two name workspace ownership.
The other eleven retain normal product/HOIST targets. No wrapper copies or DROP
labels are manufactured to satisfy directory rules.

Validator commit `85c8f2e24fc43b4c560e7065ab056f04af889363` admits only the exact
scope/reason/evidence keys, a nonempty rationale and distinct existing nonempty
contained evidence files. Both lexical and real paths must belong to the owner;
workspace scope excludes all products/packages. Non-PORT overrides, unknown
scopes/keys, missing/empty/escaped evidence and targets, wrong owners and symlink
scope substitution refuse. Source identity/disposition equality, original-row
completeness and independent parity/proof/patternAudit gates remain unchanged.
Metadata presence is structural validation, never behavioral proof. The root
independently reviewed this change; 51 contract tests/178 assertions and the
engine scripts/test type project passed before its commit.

## Existing canonical owners credited

### Runtime helper and behavioral suites

- The original update-check detector body is retained by engine
  `runtime/install-kind.ts`; lifecycle calls it. Shared `self-update.ts` already
  owns the original version/tag operations used by the updater. The fallback
  formatter now accepts an explicit package name; a pure historical-name fixture
  proves the old output without selecting a package, release source or activation
  policy. Three new tests exercise install kinds, fallback strings and canonical
  version/tag helpers. No update command executes.
- Cluster commands retain all 26 original cases, with stronger literal clipboard
  bytes, and have a real daemon CLI caller.
- Control-route status/auth assertions and safe-serve failure/success/disclosure
  assertions are retained in their existing engine suites; actual daemon HTTP and
  host constructors consume those owners.
- Localhost fetch approval keeps first request/persist/reload/no-second-ask and
  denial/no-write proof. Workspace-trust approval retains every pinned assertion
  with actual attributed broker resolution instead of an unowned boolean.
- Personal capture preserves the pinned 46-line pure-helper obligations under
  explicit `ownerChannels` authority and tests real first/queued provider requests.
  The reviewed graph spread is **not a demonstrated served-runtime bug**: facade
  construction replaces that continuation runner before listener admission; no
  ordinary pre-facade completion caller was found. Default routing cannot replace
  tools. This row does not claim an untested arbitrary pre-facade path.

### Tooling and test infrastructure

- Root setup action preserves pinned Bun, lock-keyed cache and frozen install;
  cache restore/save are explicitly separated. This is source accountability,
  not a fresh hosted-CI execution receipt.
- Root `bun.lock` is the explicitly authorized independent workspace lock,
  including the daemon workspace. Obsolete standalone resolutions are not copied.
- The actual pinned bunfig contains only temp cleanup. The parent-owned guarded
  runner replaces that preload and the standalone run-tests/test-pattern modules
  under the already documented monorepo policy. Recursive discovery, explicit
  selections, owned deadlines/failure propagation and parent cleanup are retained;
  old per-file `--jobs`/changed-selection semantics are not promised. This does
  not credit the separate unused legacy registry's cleanup lifecycle.
- All seven original Bun compile compatibility patch families are present in the
  shared toolchain driver, now installed-owner resolved, in-memory and fail-closed.
  The actual daemon compile driver uses it. Existing native/compiled-HTML receipts
  support this source mapping; no redundant binary build was run here.
- `release-prepare --no-bump --no-changelog` performs the original project-surfaces
  fallback/badge synchronization with validation and compensated writes. Its
  real explicit caller and no-bump/idempotence fixtures are already qualified.
  Automatic prebuild/release ownership remains a different, unmapped obligation.
- Engine's config-manager stub retains the complete helper body and actual
  workstream callers. The daemon no-emit project legitimately merges the original
  separate test tsconfig, including all source/tests/scripts; no duplicate config
  is needed.

## Missing assertions restored through actual callers

Runtime test commit `1d9e21319fcd89a290f6cf39590e714ec6f29efe` adds
`products/daemon/src/test/runtime/composition-source-parity.test.ts`:

- No-source memory-fold zero-import/zero-failure/report attribution, repeat and
  actual production boot caller; existing boot fixtures retain positive import.
- Real scoped session/pairing stores, actual pairing write/reopen, shared workspace
  writer/daemon reader agreement, and absence of both unscoped orphan paths.
- All original notification component cases plus real graph pressure reaching its
  existing webhook, close detachment and retained no-panel source assertions.
- Combined delivery/gateway/unserved-slash plugin through production boot, exact
  served router/catalog identities, actual invocation and cleanup without changing
  the enabled preference.

Its focused source run passed five tests/41 assertions. Qualification found a
single typed fixture invocation missing its response generic; the initial daemon
no-emit failure is recorded below and the correction does not weaken an assertion.

Provider/policy/inbox test commit `122f4c2124516c05258d490322be6808d65446a1` restores:

- Real registry repeated/overlapping discovered-provider counts and membership.
- Exact original HTTP-policy owner, full principal, wildcard scope and complete
  elevated/config-denial response checks. An SDK helper with a similar name was
  deliberately not substituted for the original public policy owner.
- Canonical descriptor equality before/after attachment and teardown; real product
  registered-handler query-string pagination/cursor and matching REST page;
  malformed cursor code/status/message through invoke and HTTP; exact provider
  failure and numeric lastSyncAt checks.

The new engine tests passed five tests/16 assertions; product inbox source proof
passed two tests/31 assertions. Adjacent policy/inbox/provider suites passed
150 tests/339 assertions. These are selected, separately attributed results.

### Resolver-to-item proof and bounded runtime restoration

Commit `0981c9de5e14bf9e3d9412fbedb1403396b53188` connects the existing canonical
routing bridge to the actual Slack/email inbox factories. The optional public
ports are additive: Slack owner context may carry `resolveRouteId`, and
`EmailInboxOwnerOptions` gains optional `resolveRouteId`. Existing callers without
the port keep their no-route behavior. The required product routing registration
is not replaced with an invented fallback.

Only provider/kind/sender digest reaches the resolver. Owner-authored persisted
bindings choose the profile; no message text, semantic classifier or new default
policy does. Email rechecks source/account/observation lifetime after awaiting the
resolver; Slack keeps its existing adapter and owner fences. Closed/failed optional
routing does not fabricate a binding. Revocation during a held callback cannot
persist a stale item.

`products/daemon/src/test/runtime/inbox-route-composition.test.ts` proves actual
persisted assignment through both factories into returned item.routeId, absence,
other-provider/wildcard/closed resolution, and source/account/credential revocation.
Two older multiowner fixtures falsely cast an empty object as the required routing
registration; they now supply truthful explicit no-route registrations. No
production fallback was added to accommodate the tests.

The new route cases first failed on the old source and pass after the bounded
caller restoration. Final route/multiowner/protected/cluster selection passed
39 tests; engine owner regressions passed 64, and the separate existing email
selection passed 23. The earlier 37-test route/email run overlaps these and is
not added to the totals. Independent source review checked metadata inputs,
optional contract compatibility and lifetime fences.

Original inbox aggregator/register dispositions remain HOIST. Their mapping
targets name the actual canonical engine suites. **Whole original assertion
coverage additionally requires both product files** `inbox-source-parity.test.ts`
and `inbox-route-composition.test.ts`, named explicitly in each crosswalk row;
the engine target list alone is not the product invocation proof.

## Qualification and exact source boundaries

The pure update-check test existed before frozen qualification began. Production
source and restored tests were frozen at `0981c9de` plus that uncommitted pure
helper test; only documentation/accounting changed during compilation. The
separate provider-tagger work was outside this checkout and is excluded.

- Existing-owner selected engine suites: 105 tests/nine files/420 assertions.
- Setup-pin, discovery, temp containment and config-stub consumers: 42 tests/five
  files/124 assertions.
- SDK production emit, engine scripts/tests and public consumer types passed.
- Initial daemon no-emit run **failed** at composition-source-parity.test.ts:129
  because a fixture invocation defaulted to undefined instead of its actual
  `{ok:boolean}` response. No runtime source changed for that correction.
- The explicit fixture response generic was committed as
  `c0be1ab6e57c4a1df3d6dfaae7bb38a54b84aa2b`; its five tests/41 assertions passed again.
- Corrected daemon no-emit and production emit, all three API extractors, subpath
  generation and subpath check passed on that source plus the pure update-helper
  test. SDK production, engine scripts/tests and public consumer qualification
  preceded only this test-type correction and documentation edits. The helper was
  already present before the engine test type project ran.
- API surface retains 177 SDK subpaths/10,570 exports and four terminal-shell
  subpaths/212 exports. Exactly two signatures gain optional resolver ports:
  `EmailInboxOwnerOptions.resolveRouteId` and the `createSlackInboxOwner` context
  Pick. No existing exports or required members were removed. API Extractor's
  existing TypeScript-version, gaxios fetch and duplicate sql.js warnings were
  non-fatal; they are not represented as warning-free qualification.
- Ordinary product-workspace structural checks and whitespace checks pass.
  Strict completion intentionally still refuses the 91 unmapped rows and missing
  whole-product parity/proof/pattern-audit records.

No all-workspace validate, current-source native rebuild, live provider/Jev
calibration, supported-platform/service execution or release/publication result
is implied. Earlier compiled acceptance remains bound to its historical artifact,
not this later routing source delta.

## Concrete unresolved work remains visible

The complete 91-row residual is in the linked JSON, not hidden behind an arbitrary
mapping target. It includes whole CLI activation/release policy, configured inbox
and local privacy authority, production Discord catalog/history, provider tagger
and wrapper/barrel responsibilities, broader real-product gateway/server/device
and hosted composition assertions, unused legacy test cleanup lifecycle, partial
workflow/Tarjan architecture checks, sibling-only helper copies, and release/
package/platform policy. Current typed scoring, source-free historical compiled
proof and completed startup maintenance are not relabeled absent.

The strict migration-complete gate must remain red until all original rows and
independent whole-product evidence are genuinely complete. All six semantic
decisions, privacy/account authority, live calibration and release activation
boundaries remain open as applicable.

## New mapping table

The complete machine crosswalk supplies exact original blobs and per-row evidence.

| Original source | Original disposition | Current owner | Canonical targets |
|---|---|---|---|
| `.github/actions/setup/action.yml` | PORT | workspace | `.github/actions/setup/action.yml` |
| `bun.lock` | PORT | workspace | `bun.lock` |
| `bunfig.toml` | PORT | engine | `packages/engine/scripts/test.ts`, `packages/engine/toolchain/src/test-runner/test-run-tmp.ts`, `packages/engine/toolchain/src/test-runner/owned-test-child.ts` |
| `scripts/bun-compile-compat.ts` | PORT | engine | `packages/engine/toolchain/src/lib/bun-compile-compat.ts`, `packages/engine/toolchain/src/lib/bun-compile.ts` |
| `scripts/project-surfaces.ts` | PORT | daemon | `products/daemon/scripts/release-prepare.ts` |
| `scripts/run-tests.ts` | PORT | engine | `packages/engine/scripts/test.ts`, `packages/engine/scripts/test-discovery.ts`, `packages/engine/toolchain/src/test-runner/owned-test-child.ts`, `packages/engine/toolchain/src/test-runner/test-run-tmp.ts`, `packages/engine/toolchain/src/test-runner/test-isolation.ts` |
| `scripts/test-pattern-rule.ts` | PORT | engine | `packages/engine/scripts/test.ts`, `packages/engine/scripts/test-discovery.ts` |
| `src/runtime/update-check.ts` | PORT | engine | `packages/engine/sdk/src/platform/runtime/install-kind.ts`, `packages/engine/sdk/src/platform/runtime/self-update.ts` |
| `src/test/cluster/commands.test.ts` | HOIST | engine | `packages/engine/test/cluster-commands.test.ts` |
| `src/test/daemon/control-routes.test.ts` | PORT | engine | `packages/engine/test/daemon-sdk.test.ts` |
| `src/test/daemon/http-policy.test.ts` | PORT | engine | `packages/engine/test/daemon-http-policy-source-parity.test.ts` |
| `src/test/daemon/inbox/aggregator.test.ts` | HOIST | engine | `packages/engine/test/daemon-inbox-aggregation.test.ts`, `packages/engine/test/daemon-inbox-composite.test.ts`, `packages/engine/test/daemon-inbox-registration.test.ts` |
| `src/test/daemon/inbox/register.test.ts` | HOIST | engine | `packages/engine/test/daemon-inbox-registration.test.ts`, `packages/engine/test/daemon-inbox-aggregation.test.ts`, `packages/engine/test/daemon-inbox-composite.test.ts` |
| `src/test/daemon/provider-registration.test.ts` | PORT | engine | `packages/engine/test/daemon-provider-registration-source-parity.test.ts` |
| `src/test/daemon/safe-serve.test.ts` | PORT | engine | `packages/engine/test/daemon-safe-serve.test.ts` |
| `src/test/helpers/config-manager-stub.ts` | PORT | engine | `packages/engine/test/_helpers/config-manager-stub.ts` |
| `src/test/runtime/control-plane-store-location.test.ts` | PORT | daemon | `products/daemon/src/test/runtime/composition-source-parity.test.ts` |
| `src/test/runtime/control-plane-store-writes.test.ts` | PORT | daemon | `products/daemon/src/test/runtime/composition-source-parity.test.ts` |
| `src/test/runtime/localhost-fetch-approval-wiring.test.ts` | PORT | engine | `packages/engine/test/fetch-localhost-approval.test.ts` |
| `src/test/runtime/memory-fold.test.ts` | PORT | daemon | `products/daemon/src/test/runtime/composition-source-parity.test.ts`, `products/daemon/src/test/runtime/boot-composition.test.ts` |
| `src/test/runtime/notification-dispatch.test.ts` | PORT | daemon | `products/daemon/src/test/runtime/notification-component.test.ts`, `products/daemon/src/test/runtime/composition-source-parity.test.ts` |
| `src/test/runtime/personal-capture-wiring.test.ts` | PORT | engine | `packages/engine/test/personal-information-capture.test.ts`, `packages/engine/test/daemon-channel-continuation-tools.test.ts` |
| `src/test/runtime/plugin-composition.test.ts` | PORT | daemon | `products/daemon/src/test/runtime/boot-composition.test.ts`, `products/daemon/src/test/runtime/boot-graph.test.ts`, `products/daemon/src/test/runtime/composition-source-parity.test.ts` |
| `src/test/runtime/trust-gated-approvals.test.ts` | HOIST | engine | `packages/engine/test/workspace-trust-approval.test.ts` |
| `tsconfig.test.json` | PORT | daemon | `products/daemon/tsconfig.json` |
