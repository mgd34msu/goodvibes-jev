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

Fresh checks on the recovered main479ab70f-based source pass 101 shared-ledger/
input-boundary tests and 126 Agent composition/history/disposal tests. Negative
controls against main479ab70f fail all 12 new shared lifetime/privacy probes and
all 3 Agent composition probes. Prior pre-replacement results are not used as
evidence for the recovered bytes. Forced solution checks and both Agent source
and test TypeScript projects pass on the recovered bytes. Official SDK asset
preparation and all three API Extractor reports complete successfully. Extractor
retains existing bundled-TypeScript/gaxios/duplicate sql.js declaration warnings;
these warnings did not fail extraction. The subpath snapshot also reflects a
semantically identical inferred ownerReply union-order change.
Heavy TypeScript/API checks use the shared compiler lock and an explicit
4096 MiB Node heap ceiling instead of the aggregate wrapper's 16384 MiB override.


## Independent review: failed argument batches

Review exposed an additional lifetime case: `mapLimit` rejects promptly when
one argument fails, while sibling requests may remain pending. Retiring the
call's pending entry at that point previously orphaned those siblings, allowing
late role-cache writes or queued requests after cancellation/disposal.

Each argument batch now owns an abort controller linked to its call's signal.
A failing worker aborts the batch before propagating the failure. Pre-ask and
post-await checks use the batch signal, so non-cooperative siblings cannot
publish late readings and queued workers cannot start requests. Settlement
remains prompt; no retry or manual-approval fallback is introduced.

All three independent reviewer probes are preserved as typed regressions.
The unchanged external probes show aborted sibling signals, a fresh subsequent
role request, and a queued request count remaining 8 rather than growing to 10.
Restoring the pre-fix ledger makes all three regressions fail. The combined
post-fix tests pass 101 engine/input-boundary and 126 Agent tests.

## Callback lifetime and full-suite fixture isolation

A second review probe disposes the ledger synchronously from the decision
recorder's `recordAction` callback. An additional post-callback abort check now
precedes role-cache insertion. The regression expects two name readings across
the disposed first ledger and a fresh second ledger; pre-fix code made only one.

The first PR CI run's sole Agent failure was test-fixture reuse: the runtime
helper module had already been imported by an earlier file, so its module-level
reset hook was not registered for the ledger test file. That file disposed the
runtime but left the helper's memo pointing at it. The next protected-input
probe therefore saw the previous succeeded record. Running fleet-attention
before ledger adoption reproduces the exact failure. Local beforeEach ownership
of a fresh runtime and afterEach release of the memo fix the issue without
weakening any lifecycle or privacy assertion.

The repaired full Agent run reports 6157 pass, 1 skip, and 10 failures locally.
A same-host full run of published head 4190a217 reports the same failures plus
the ledger fixture regression (6156 pass, 1 skip, 11 failures). Seven remaining
failures are explicit missing-tmux/bubblewrap host limits; the other three
child/profile assertions also occur on that unchanged baseline. Both profile
assertions pass in isolation. This is not a claim of a green full local suite;
the targeted before/after reproduction and fresh remote CI remain distinct.
