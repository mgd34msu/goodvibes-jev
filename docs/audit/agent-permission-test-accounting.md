# Agent permission composition test accounting

## One adapted test row

This docs/metadata-only reconciliation resolves
`src/test/runtime/tool-permission-safety.test.ts` against base
`5f2c76640ca8f193a4106433dd278391e13354c7` (tree
`4a092973eb47b4665d61ebf297a7f074126997da`). No production source, test behavior,
validator, inventory disposition or runtime policy changes.

The authoritative [Agent inventory](../inventory/agent.md) already marks this
test **PORT**, describing its real Agent composition coverage. The unresolved
JSON still called it HOIST. Its truthful target is the retained
[Agent suite](../../products/agent/src/test/runtime/tool-permission-safety.test.ts),
blob `e47ba9b786f02fbac31aac7ff1a4e361e82c2a8c`, not an adjacent engine export.
The mapping explicitly records `adapted-authoritative-permission-composition`;
it does not claim byte-identical retention or restored table-driven behavior.
The production permission owner remains HOIST, already accounted for separately
in the [engine-owner review](agent-engine-owner-accounting.md).

## Pinned original and adapted obligations

The [original test](https://github.com/mgd34msu/goodvibes-agent/blob/9e225a349667632bb550e9c270d922b985848eaa/src/test/runtime/tool-permission-safety.test.ts)
was retrieved at the exact inventory baseline
`9e225a349667632bb550e9c270d922b985848eaa`. Its bytes hash to Git blob
`86cb6d99692db50834ee43d1966b37a95c625686`, also recorded by the refreshed
[upstream manifest](../inventory/upstream/agent.json). All four original tests
were read, including their action/mode cases and detailed-result assertions.

The [intent](../../goodvibes-jev-intent.md) assigns permission ownership to one
engine gate and hoists the production guard. The current authoritative inventory
and [shared-guard repair](agent-shared-permission-gate.md) specify the adapted
contract: side-effect classification is a Jev reading, never substitute permission
authority. Preserve the authoritative decision or typed failure; do not convert
an outage into either a local approval or a synthetic denial. This necessarily
supersedes the original test's exception-based approval and fabricated provenance.

| Original obligation | Meaningful current assertion and boundary |
| --- | --- |
| Override a generic delegate category by local tool/action tables; classify fallback tool families explicitly. | The [engine suite](../../packages/engine/test/gate-tool-permission-safety.test.ts) asks the typed `kind` question at the declared site, verifies category/confidence mapping and uncertain reads, preserves `getCategory` authority, and asks no category question while forwarding a working manager's decision. Classification has moved to shared Jev readings; old vocabulary lists are not retained as semantic authority. The [Agent explanation suite](../../products/agent/src/test/tools/agent-policy-explanation-posture.test.ts) asserts uncertain/unevaluated permission and propagation of unavailable category judgment. |
| Recover stable categories when the underlying category lookup throws. | The shared guard no longer catches or replaces category authority. Engine assertions retain the original `getCategory` function identity, and product explanation assertions propagate unavailable category readings. No product-local replacement category is represented as permission. |
| Let table-named reads execute after a throwing check; deny side effects, missing modes and unknown modes locally. | These local decisions are deliberately superseded. Product direct tests assert exact unavailable/ordinary error identity for both `check` and `checkDetailed`. Its real graph admission tests show failed/unavailable/missing judgment never reaches fake `read`/`fetch` bodies, reported authority revocation remains a failure, and typed Jev approval alone reaches the requested fake action. Engine tests separately preserve boolean denial and detailed denial provenance without a new category reading. |
| Fabricate approved/denied detailed results with `permission-manager-exception`, `config_deny` and guessed risk. | Product direct tests return the exact authoritative detailed result object and boolean outcome. Both methods preserve frozen nested argument identity, attribution and complete options, including signal, hook owner and an extra option. Real failed judgment records failure entries without fabricated `config_allow` or wrapper-site provenance; successful admission records gate decisions and the supplied autonomous goal/criteria. |

The product suite additionally proves cancellation settles a non-cooperative
pending admission before its late answer, with no fake action before or after
release and a failed autonomous-gate decision-log entry. Idempotent guard
installation and category-read cancellation/input capture are separately asserted
by the engine suite.

The separate [Agent cancellation suite](../../products/agent/src/test/runtime/tool-permission-cancellation.test.ts)
also calls both `check` and `checkDetailed` on a real manager. It asserts attribution
and the captured cancellation signal across pending readings and the existing
legacy prompt boundary, rejects late approval/failure after cancellation, performs
no late file read and persists no remembered grant. That legacy prompt fixture
checks cancellation compatibility; it neither adds a semantic approval route nor
establishes migration of that separate policy surface.

## Actual composition, without overstating the call path

[Bootstrap](../../products/agent/src/runtime/bootstrap-core.ts) imports the public
guard and installs it through `composeAgentPermissionManager`, then wires that
same graph manager into the Agent orchestrator. The product suite checks the
compatibility implementation identity and bootstrap seam, constructs actual
`createRuntimeServices` graphs and calls `executeToolCalls` with nonexecuting
fixture tools.

There are two distinct proof layers. The direct guard cases invoke `check` and
`checkDetailed`, proving signature/result/error forwarding. The real composed
pipeline now follows `admitAutonomous` in
[the shared executor](../../packages/engine/sdk/src/platform/core/orchestrator-tool-runtime.ts),
proving Agent adoption, preparation/admission, failure, revocation, cancellation
and recorded success. It is not evidence that the direct wrapper methods are
the executor's autonomous admission implementation. The fixture supplies explicit
goal/criteria, and the successful pipeline has no human approval callback.
Neither the guard nor this accounting introduces an alternative human semantic
approval loop. This is not a claim that every other Agent confirmation surface
has migrated.

## Fresh focused proof, 2026-10-08

Bun 1.3.14, canonical owned runner, unchanged budgets and no timeout overrides:

```sh
bun packages/engine/scripts/test.ts \
  test/gate-tool-permission-safety.test.ts
# 9 pass, 0 fail; 32 assertions; 1 file

bun packages/engine/scripts/test.ts --cwd ../../products/agent \
  src/test/runtime/tool-permission-safety.test.ts \
  src/test/tools/agent-policy-explanation-posture.test.ts
# 40 pass, 0 fail; 346 assertions; 2 files

bun packages/engine/scripts/test.ts --cwd ../../products/agent \
  src/test/runtime/tool-permission-cancellation.test.ts
# 12 pass, 0 fail; 54 assertions; 1 file
```

The public package resolved to this isolated checkout's source. Judgment providers,
tool bodies, homes and workspaces were synthetic; there were no live providers,
real credentials or external tool effects. The focused runs prove the adapted
contract above, not live semantic calibration or whole-Agent acceptance. Prior
negative-control history in the shared-guard audit was not rerun or counted as
fresh evidence here.

Metadata qualification also passed on its first run:

```sh
bun packages/engine/scripts/test.ts \
  test/product-workspace-contract.test.ts test/pre-commit-product-gates.test.ts
# 26 pass, 0 fail; 161 assertions; 2 files
```

The matrix CLI probe passed with its unchanged internal 10,000 ms budget for
each child; no retry or ceiling change was needed. The complete metadata suite
took 34.15 seconds. Its tiny isolated compiler/build fixtures are not a project
compiler/build qualification. Direct `product-workspaces.ts check` passed with
four present products and zero pending. Exact JSON comparisons and the canonical
inventory parser independently verified the partition, dispositions and preserved
ledgers below. `git diff --check` passes and all relative evidence links resolve.
Independent read-only review confirmed the original and adapted obligations,
actual call-path distinction, source/blob identities and exact sole-row change;
it found no blocking gap and no required runtime/test edit.

## Exact accounting and limits

The actual arrays advance from 1,160 mapped + 442 unresolved to
**1,161 mapped + 441 unresolved = 1,602** pinned baseline paths. They remain
unique and disjoint, and their union equals the baseline exactly. The only moved
row corrects the unresolved HOIST label to the authoritative PORT disposition.
The remaining unresolved buckets are 221 public-engine-successor rows and 220
upstream-deleted-review rows; dispositions are 176 PORT + 44 JEV + 221 HOIST.

All inventory rows remain unchanged, with parsed counts 1,119 PORT / 252 JEV /
229 HOIST / 2 DROP. The target row was the sole mapping/unresolved disposition
mismatch at this base; no unrelated mismatch was corrected. The earlier
engine-owner audit's counts and explicit test exclusion describe its own earlier
checkpoint and remain historical; this record resolves that named exclusion.

Exact comparisons preserve every unrelated mapping/unresolved row, all 248
upstream-deleted entries, 296 added-source reviews, 1,650 historical coverage
entries, recovery/materialization metadata, 207 pending mapped JEV rows,
remaining-obligation text and `status: partial`. The historical recovered test
blob `f20d3f24571c7f1eacd264b6456b7450aaada03f` is not rewritten as a current
digest. No production or test source changes are needed for this correction.

Shared retry/fresh authority-generation coverage, tool-declared confirmation
semantics, genuine connected/live parity, aggregate/native acceptance and release
qualification remain separate obligations. No project compiler, package build,
API extraction, heavy containment, full Agent aggregate, external publication,
Linear write or pending approval-card action was performed.
