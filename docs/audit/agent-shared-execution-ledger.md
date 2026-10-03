# Agent shared execution-ledger adoption

## Live composition

`products/agent/src/runtime/services.ts` constructs `AgentExecutionLedger`
from the public `@goodvibes-jev/engine/sdk/platform/gate/policy` entrypoint. The
old Agent module is a compatibility export for existing UI/history consumers;
its keyword route table, credential regex, and target-key list are removed.
The runtime-services composition test asserts constructor identity and passes
its ledger through the actual execution-history projection. Another probe runs
`executeToolCalls` with the composed permission manager and a synthetic no-op
registry tool, proving the production event path records execution once without
an approval callback.

The shared ledger retains status/phase/timestamps, permission flag, argument
keys, target/command previews, result summary, failure/cancellation text,
subscriptions, count summary, and newest-received-first retention. Records now
appear immediately as value-withheld placeholders while Jev reads. Subscribers
receive both receipt and enrichment updates. History exposes safe reading-error
diagnostics. The registered exec tool uses `commands[].cmd`, supported by the
shared shell extractor alongside `command`/`cmd`. No registered tool uses the
local legacy `script` preview shortcut; no Agent-only key table recreates it.

## Judgment and privacy boundaries

- The full-size immutable `snapshotJudgmentInput` captures at event delivery,
  before the ledger's first await. RuntimeEventBus dispatches asynchronously
  by contract. This is **not** a guarantee against mutation before that bus
  invokes the subscriber.
- Declared credential/card material is refused before any judgment.
- The existing Jev ledger-argument battery sees tool/argument names only across
  the full captured tree, including beyond UI depth/key/array preview limits.
- Only a confident non-credential reading permits an argument value into the
  shared side-effect-kind reader. Other values become `[redacted]`. Failed
  role reads withhold all values and skip route judgment.
- Command and target previews use those same semantic roles. Uncertain route
  answers remain `other` with an explicit uncertainty diagnostic.
- Provider/subscriber exception text never enters ledger logs or diagnostics.
  No retry, classification table, or approval fallback was introduced; the
  shared provider retains transport-retry ownership.
- Existing event result/error/cancellation text remains the upstream event
  producer's already-safe summary contract. This is not a new general-purpose
  raw-tool-output sanitizer.

## Lifetime and provenance

Lifecycle events apply immediately in delivery order while judgment is pending.
Terminal states are absorbing. Cancellation, eviction, and disposal abort the
reader signal and release settlement even when a synthetic provider ignores
abort. Late results cannot enrich a cancelled, evicted, or disposed record,
repopulate role cache after cancellation, or resurrect execution. Receipt order
and retention are independent of model latency.

The optional `autonomousDecision: JevDecision` passes through permission/result
events, result-summary conversion, ledger records, and Agent history. Detached
receipts are display provenance only, never execution authority or permission.
The upstream orchestrator/manager owns creating and forwarding real receipts.
An `act` receipt cannot override `approved: false` or execute work.

## Verification

Providers are synthetic; no real credentials, live model calls, or external
effects are used. Tests cover normal lifecycle, failed/uncertain judgments,
name-only ordering, full-tree redaction, protected inputs, immutable capture
after delivery, out-of-order completions, retention, cancellation in both
judgment phases, late completion, no late cache refill, disposal, subscribers,
exact cache keys, detached receipts, and real Agent runtime/history/execution.

Fresh checks on the recovered main479ab70f-based source pass 98 shared-ledger/
input-boundary tests and 126 Agent composition/history/disposal tests. Negative
controls against main479ab70f fail all 12 new shared lifetime/privacy probes and
all 3 Agent composition probes. Prior pre-replacement results are not used as
evidence for the recovered bytes. Final TypeScript/API checks are recorded
separately after completion.
Heavy TypeScript/API checks use the shared compiler lock and an explicit
4096 MiB Node heap ceiling instead of the aggregate wrapper's 16384 MiB override.
