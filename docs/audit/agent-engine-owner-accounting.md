# Agent canonical engine-owner accounting

## Scope and qualified source

This accounting-only change resolves exactly the two production HOIST rows for
`src/runtime/execution-ledger.ts` and `src/runtime/tool-permission-safety.ts`.
It changes no source, tests, inventory dispositions, policy, or runtime behavior.
The qualification source is commit
`94d5753a045ea17ad1ae6efe00169939e6c9c26d`, tree
`d2c80586fe6f9a3a54f7e264362d02d70661a52e`. The focused checks below were freshly
run on that source on 2026-10-08 using Bun 1.3.14 and the canonical owned runner.
The public package's Bun exports resolved to this isolated checkout's source.

The original [engine gate requirement](../../goodvibes-jev-intent.md#platform-subsystems)
and [Agent HOIST requirement](../../goodvibes-jev-intent.md#the-agent-productsagent-from-goodvibes-agent)
(intent lines 101 and 255) assign these owners to the engine. The authoritative
[Agent inventory](../inventory/agent.md) rows remain HOIST; none of their
criteria is removed by this record correction.

## Execution ledger

Canonical target:
[`packages/engine/sdk/src/platform/gate/policy/execution-ledger.ts`](../../packages/engine/sdk/src/platform/gate/policy/execution-ledger.ts)
(blob `6ebbd0908a3dfa322e7111a016b612dbcdbdf3b3`).
The [product compatibility module](../../products/agent/src/runtime/execution-ledger.ts)
(blob `ccf090b97ad4e88c2a186b7753e25d92f655399f`) only re-exports the public engine
entrypoint. [Runtime services](../../products/agent/src/runtime/services.ts)
construct that exported class on the real runtime bus; the
[execution-history consumer](../../products/agent/src/tools/agent-harness-execution-history.ts)
reads its snapshots. The
[composition regression](../../products/agent/src/test/runtime/execution-ledger-adoption.test.ts)
asserts constructor identity, exercises the actual history projection and runs
`executeToolCalls` through the composed permission/event/ledger path without an
approval callback.

The owner preserves the 500-record default, newest-received-first retention,
status/phase/timestamps, permission, argument keys and previews, command/target
previews, result summary, failure/cancellation text, subscriptions and counts.
Buffer/preview caps, event-enum dispatch, presence checks and the exec command
contract remain code. `engine.gate.ledger-arg` reads credential and target roles;
`engine.gate.side-effect` reads route kind. There is no retained tool-name route
ladder, credential-key regex or target-key list. Full-tree name-only role reads
and immutable input capture precede value-bearing route judgment. Failed or
uncertain credential-role readings withhold values; uncertain route readings
remain `other` with explicit diagnostics. Terminal
lifecycle states are absorbing; cancellation, eviction and disposal prevent
late enrichment or cache refill. These criteria are covered by the freshly run
[owner](../../packages/engine/test/gate-execution-ledger.test.ts),
[lifetime](../../packages/engine/test/gate-execution-ledger-lifetime.test.ts),
[batch lifetime](../../packages/engine/test/gate-execution-ledger-batch-lifetime.test.ts)
and [input-boundary](../../packages/engine/test/gate-judgment-input.test.ts) suites.
See the [shared-ledger audit](agent-shared-execution-ledger.md) for the existing
recovery and negative-control history, separately from this fresh proof.

## Permission lifetime guard

Canonical target:
[`packages/engine/sdk/src/platform/gate/policy/tool-permission-safety.ts`](../../packages/engine/sdk/src/platform/gate/policy/tool-permission-safety.ts)
(blob `015f60055337a14736937553b4b7489e81b7a227`).
The [product compatibility module](../../products/agent/src/runtime/tool-permission-safety.ts)
(blob `d299f1f1a49d37b1ee247dcefe66a6e344523d09`) only re-exports the shared guard.
[Bootstrap](../../products/agent/src/runtime/bootstrap-core.ts) directly imports
the public implementation and installs it on the actual graph manager through
`composeAgentPermissionManager`, then passes that manager into runtime execution.

The [engine guard tests](../../packages/engine/test/gate-tool-permission-safety.test.ts)
and [actual Agent composition tests](../../products/agent/src/test/runtime/tool-permission-safety.test.ts)
verify manager failures/unavailable judgment cannot admit a fake action, both
check methods preserve complete arguments, attribution and execution options,
and cancellation settles a non-cooperative pending check without accepting its
late approval. Reported revocation propagates, and successful/failed real
judgment paths retain their corresponding decision-log provenance. Category
readings are explanation only, never substitute authority. The
[explanation-posture tests](../../products/agent/src/test/tools/agent-policy-explanation-posture.test.ts)
retain explicitly unevaluated permission. The
[shared-guard audit](agent-shared-permission-gate.md) records the existing repair
and its separate shared-policy dependencies.

Both owners are exported by the supported
[public policy entrypoint](../../packages/engine/sdk/src/platform/gate/policy/index.ts)
and [package subpath](../../packages/engine/package.json).

## Fresh focused qualification

From the repository root, with unchanged canonical runner ceilings and no timeout
overrides:

```sh
bun packages/engine/scripts/test.ts \
  test/gate-execution-ledger.test.ts \
  test/gate-execution-ledger-lifetime.test.ts \
  test/gate-execution-ledger-batch-lifetime.test.ts \
  test/gate-judgment-input.test.ts \
  test/gate-tool-permission-safety.test.ts
# 112 pass, 0 fail; 839 assertions; five files

bun packages/engine/scripts/test.ts --cwd ../../products/agent \
  src/test/runtime/execution-ledger-adoption.test.ts \
  src/test/runtime/tool-permission-safety.test.ts \
  src/test/runtime/bootstrap-shutdown-graph-disposal.test.ts \
  src/test/tools/agent-policy-explanation-posture.test.ts
# 55 pass, 0 fail; 403 assertions; four files
```

These tests use synthetic judgment providers and nonexecuting tool fixtures,
with the real composition, authority, event and history paths specified above.
They establish focused ownership/adoption and lifetime behavior; they are not
live semantic calibration or full Agent aggregate acceptance. Prior aggregate
logs that later hit their ceiling are not substituted for this fresh proof.
No project compiler, package build, API extraction, live provider or external
publication was run for this accounting change. The manifest-regression suite
uses its existing tiny isolated build/compiler fixtures; those do not qualify
project build or type correctness.

## Accounting validation and review

`bun packages/engine/scripts/test.ts test/product-workspace-contract.test.ts
test/pre-commit-product-gates.test.ts` ran 26 tests: 25 passed and the matrix CLI
probe failed with `ETIMEDOUT` at its unchanged internal 10,000 ms child budget.
The single bounded, name-filtered retry of that same matrix probe passed
(1 pass, 22 filtered out, 0 fail; 19,617.81 ms for the test, 20.56 s for the
runner). No budget, validator or source was changed. The initial failure is
retained as a timing limitation; the first combined run was not all green.

Direct checks on the same accounting change also passed:

- `bun packages/engine/scripts/product-workspaces.ts check`: four present,
  zero pending; 8.812743 s elapsed, exit 0.
- `bun packages/engine/scripts/product-workspaces.ts matrix`: exactly
  `["daemon","tui","agent","webui"]`; 9.706259 s elapsed, exit 0.
- Exact before/after JSON assertions establish the partition and unchanged
  records described below; all relative evidence links resolve.
- `git diff --check` passes.

Independent read-only review verified the exact two-row diff, canonical owners,
actual adoption, source/blob identifiers, original criteria, count conservation
and preserved exclusions. It corrected an audit overstatement: terminal
success/failure remain absorbing lifecycle outcomes but may still receive safe
pending enrichment; cancellation, eviction and disposal prohibit late
publication. No production change was required.

## Count conservation and exclusions

The [migration mappings](../../products/agent/migration.json) and
[unresolved accounting](../../products/agent/source-reconciliation.json) change
from 1,157 mapped + 445 unresolved to **1,159 + 443 = 1,602** baseline paths.
Both sets remain unique and disjoint, and their union is the pinned baseline.
Only the two named HOIST rows move: the unresolved buckets become 223
public-engine-successor rows + 220 deleted-successor-review rows; unresolved
dispositions are 176 PORT + 44 JEV + 223 HOIST.

The 248-entry upstream-deleted list remains unchanged and overlaps unresolved
accounting: 220 deleted-review rows + 28 HOIST test rows. The 296 added-source
reviews, historical `recoveredBlob`/materialization ledger and all 207 pending
mapped JEV rows are unchanged. Historical retention digests are not rewritten
as current-source digests. Migration status remains `partial`, and all existing
remaining obligations are preserved.

The permission-safety **test** row remains unresolved: its JSON HOIST disposition
conflicts with the authoritative inventory's PORT row and needs separate review.
`agent-exec-posture.ts` also stays unresolved because its product-local constant
has not adopted the canonical owner. This record does not close separate
history-search/verification readings, general raw-output sanitization, shared
retry/fresh-authority-generation requirements, tool-declared confirmation
wording, live parity or whole-Agent acceptance. No human-approval loop is added.
