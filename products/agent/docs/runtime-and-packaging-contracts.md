# Agent runtime ownership and packaging

## Shared execution history

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
subscriptions, count summary, and newest-received-first retention. Records
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

## Ledger validation

Providers are synthetic; no real credentials, live model calls, or external
effects are used. Tests cover normal lifecycle, failed/uncertain judgments,
name-only ordering, full-tree redaction, protected inputs, immutable capture
after delivery, out-of-order completions, retention, cancellation in both
judgment phases, late completion, no late cache refill, disposal, subscribers,
exact cache keys, detached receipts, and real Agent runtime/history/execution.

## Failed-batch and callback lifetime

Each argument batch owns an abort controller linked to its call signal. A failing
worker aborts the batch before propagating failure. Pre-ask/post-await checks use
that signal, so non-cooperative siblings cannot publish late readings and queued
workers cannot start requests. Settlement stays prompt, with no product retry or
manual-approval fallback. Preserve regression assertions for aborted sibling
signals, a fresh subsequent role request and queued request count staying at eight
instead of growing to ten in the bounded concurrency fixture.

A synchronous disposal from the decision recorder's `recordAction` callback is
an ownership boundary too: check cancellation again before role-cache insertion.
Validate two name readings across a disposed first ledger and fresh second one,
so a late cached answer cannot suppress the second lookup. Each test owns a fresh
runtime and clears its helper memo afterward; prior imports must not leave a
disposed runtime cached across files. Keep lifecycle/privacy assertions intact.

## Shared permission wrapper and explanations

- Bootstrap installs the existing shared wrapper through its actual
  `composeAgentPermissionManager` seam. The former local implementation is only
  a compatibility re-export; all local tool/action classification tables are gone.
- The shared wrapper preserves complete method arguments and an execution-options
  snapshot, including signal and hook ownership, and races cancellation through
  the existing shared permission lifetime helper. It returns only the manager's
  decision. It does not recover authority from a second category reading, fabricate
  a permission result, retry locally, or request human approval.
- The policy-explanation consumers await the existing shared Jev category reader.
  Category confidence is exposed separately from permission, which remains
  unknown/not evaluated. Unavailable readings propagate. An uncertain reading is
  explicitly described as uncertain and never certifies approval. Both callers
  forward cancellation through the shared category reader into the side-effect
  battery; an abort-ignoring reader cannot return a late explanation. The complete
  explanation input is detached and validated by the existing full-size judgment
  boundary before lookup or await. Its same immutable tool arguments feed every
  later analysis, guard, confirmation, and display consumer; accessors are refused
  without invocation. The harness
  keeps this judgment outside its generic error-to-display-text catch.

The Agent regression builds real `createRuntimeServices` graphs, invokes the same
permission composition as bootstrap, and routes `executeToolCalls` into
nonexecuting fake `read`/`fetch` bodies. Judgment responses are typed fixtures;
there are no live providers, credentials, network tools, or file-reading tools.

- Throwing and unavailable manager checks never reach either fake body.
- A real manager with missing judgment never approves a read.
- Cancellation settles an abort-ignoring check and discards its eventual approval.
- Revocation reported by the authority while waiting is propagated, not replaced
  by a fallback approval.
- Both actual explanation callers resist nested argument mutation during pending
  judgment and refuse outer/nested getters without invoking them or Jev.
- Both public check methods preserve attribution, full execution options, hook
  ownership, and immutable argument identity.
- Successful real Jev readings retain decision-log entries; failed readings retain
  failure entries without synthetic `config_allow` provenance.
- Reinstating the old local wrapper in the bootstrap composition makes both
  throwing read/fetch controls fail by executing the fake action.
- Reinstating the old shared wrapper makes both full-signature controls fail by
  dropping attribution and execution options.

The wrapper delegates to the shared manager's current-authority and availability
owners; it adds no independent retry or fallback permission. A category is not
permission, and tool-declared `confirm`/`explicitUserRequest` presentation fields
are not autonomous authority. Preserve explicit effect confirmations where their
actual API requires them, while following the
[autonomous decision contract](../../../docs/design/autonomous-jev-decisions.md)
for semantic admission. Wrapper adoption alone does not grant a capability.

## Product composition and presentation

Consume published engine, terminal-shell, toolchain and daemon exports and the
root workspace lock. Standalone retained release records are not an installed
workspace release authority. Help, version, completion and parser errors use the
original parser/help renderer before loading the interactive graph.

The actual client graph supplies contract runner, operator, intake, judgment and
session snapshot. Preserve orchestrator manager/hooks/foreground permission and
recorded handler dependencies. Canonical preset store events drive live updates;
turn-budget and compaction notices remain typed. Process liveness follows the
public `done` field, never descriptive status text.

Contract views use consistent group/unit/check identities for unmet checks,
consumed nudges, explicit correction work and passing rechecks. Preserve recorded
outcomes, attempt/check details and commit notes. Legacy outcomes stay unknown;
failed application is a display warning distinct from a passed contract lifecycle.
Restored owners remain visible without a live Agent record; retain fold/header
restoration. Old owner-question/reply fields remain historical display content,
not a new autonomous approval loop. Fleet CLI uses real attempt controls and
qualified IDs; one-shot calls skip background model-data refresh.

Await public memory ranking, VIBE import, usage-credit, card and outward-effect
readers. Prompt text and its receipt share one ranking. Passive workspace paints
read capped queue cardinality without starting semantic ranking when the public
queue ranks rather than filters. Preserve operation-signal caching for readers.
Legacy bus notifications remain metadata-only; detailed notifications use their
current authenticated source/privacy contract, never restored content leakage.

## Private workspace launch and packaging

Without a separate published Agent update channel, launch, periodic polling and
`/update` return checkout/rebuild guidance before host/config inspection. The
source launcher runs the checked-out package; private compiled launch skips
upstream release probing. Shared download/swap mechanics remain available for
synthetic tests, not an implicit adoption of upstream artifacts.

Resolve native addons from the installed dependency owner, validate requested
package/version/payload and stage the exact host addon beside the executable.
Resolve an SDK export subpath to its enclosing engine manifest; do not require a
flat installation symlink. The binary launcher invokes the CLI declared by its
installed workspace engine and fails explicitly when unbuilt, without a registry
fallback through `bunx`.

Keep standard native artifact/version smoke, dependency-owner sqlite-vec loading
and vector-distance behavior. Foreign-platform downloads in fake execution
fixtures do not establish real cross-platform execution. Bounded source/native
terminal tests preserve first frame, complete prompt, Escape declining initial
registration, `/help` and natural exit; they are not live first-turn or provider
acceptance. Failed setup or provider attempts remain failures.

## Isolation and cancellation validation

Retain security tests and real registry-to-exec cancellation, timeout distinction,
same-registry reuse, held policy/permission operations, late remembered answers
and zero post-cancel execution. A host unable to create the required sandbox
must not disable containment or count that test as a pass.

Use the canonical owned runner with credentials removed, isolated home and
unexpected non-loopback requests blocked. Metadata fixtures intercept only exact
synthetic catalog GETs and explicit unavailable responses for known loopback
model probes. Unknown requests fail even if production catches the exception.
Heavy TypeScript/API checks use the shared compiler lock and an explicit
bounded 4096 MiB Node heap rather than an aggregate 16384 MiB override.
Card containment inspects the actual exported support bundle. Preserve public
refusal wording/evidence checks, nonempty quoted evidence and source membership
under display ellipsis, together with zero-send assertions. Use product-local
fixtures/public APIs rather than private cross-workspace test helpers.
