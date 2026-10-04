# Native durable contract admission

This additive engine seam binds a native work attempt to the existing contract runner. It does not implement the native semantic ledger, action journal/outbox, or another Jev retry loop. Jev semantic decisions remain the native owner's responsibility; no approval prompt or heuristic fallback is added.

## Host composition

`ContractRunner.startDurable({ key, binding, input })` atomically admits an immutable request. The key is `{ workId, criteriaId, criteriaRevision, attemptId }`; `binding` is the shared `JevDecisionBinding`; `input` is the exact `StartContractInput`. For native work whose criteria are an ordered array without their own ID, use `criteriaSetIdForWork(workId)`. It returns `criteria:` plus SHA-256 of the work ID. Changing the criteria array or order must change `criteriaRevision`; it must not change this stable criteria-set ID.

The runner assigns `contractId` and `ownerAgentId`. Its key-addressed atomic envelope contains the immutable receipt and authoritative contract checkpoint together; the contract-ID snapshot is a compatibility copy, never a split admission commit. The native outbox must bind the returned IDs, not reserve a parallel engine ID. The canonical request SHA-256 is `payloadRevision`. Any relevant payload, input, action, authority, or scope revision change with the same key is a conflict. A new intentional attempt requires a new native attempt ID and a current Jev decision.

The result contains a metadata-only admission receipt (no duplicate raw input), the ordinary contract view, and an explicit state:

- `prepared`: a full checkpoint and immutable receipt exist; no runner launch has been claimed.
- `launch-claimed`: the launch claim was durably written before invocation. This includes possibly-launched/unknown after a crash. It does not assert that a tool effect happened or that an acknowledgement was delivered.
- `terminal`: the existing contract ended. Replaying the key never resurrects it.

Exact `startDurable` replay always returns that same binding. It never launches again, including when the previous caller lost the acknowledgement.

Composed admission receipt version 2 additionally freezes resolved isolation and worktree placement before owner hooks. This preserves `auto`/omitted configuration at the original admission and rejects changed placement during resume or reentrant launch. Version-1 receipts remain inspectable by replay, but a nonterminal v1 receipt cannot explicitly resume because its resolved placement was never immutably bound. The host must recover through a freshly admitted intentional attempt, preserving the old history.

The trusted runner dependency is:

```ts
const runner = createContractRunner({
  // Existing runner dependencies are unchanged.
  durableAdmission: {
    async withCurrent(admission, launch) {
      await ledger.withTransaction(async (transaction) => {
        // The engine receipt and full frozen request already exist on disk here.
        // Bind the native outbox to these exact runner-owned IDs before launch.
        await transaction.bindRunner(admission);
        launch(() => {
          // Synchronous, using live state protected by this same transaction lock.
          // Validate exact frozen input/action/criteria/target/actor, current grants,
          // scope and revocation, real Jev lineage/evidence, and native claim ownership.
          transaction.assertCurrent(admission);
        });
      });
    },
  },
});
```

The sketch illustrates the ownership boundary; it does not prescribe a ledger implementation. `withCurrent` may await acquisition of the native lock. Once acquired, it invokes the supplied launch exactly once with a synchronous validator. It must hold the lock through launch invocation. Lock order is engine key ownership, then native ledger transaction; do not hold a non-reentrant native ledger lock while awaiting `startDurable`/`resumeDurable` and then reacquire it in this callback. Never retain launch, call it after releasing the lock, pass an async validator, or interpret the engine receipt as authority. The engine rejects missing/repeated/reentrant/expired callbacks.

All owner, creation, queue, and borrowed persistence hooks precede the final validator. The claim checkpoint is flushed before that validator; there is no await or outward callback between validation and invoking the existing runner. The same host boundary also wraps the existing AgentManager unit executor and wake path after spawning notifications. It releases the native lock after executor invocation, not after the entire executor lifetime. Tool-level gates must continue to check their own exact action binding and lifecycle cancellation; a contract admission cannot authorize arbitrary later effects.

## Crash recovery and cancellation

`resumeAll()` deliberately skips native-bound contracts. Only `resumeDurable(key)` can resume their existing checkpoints, and it requires the same composed host boundary and fresh live validation. It preserves the original contract/owner IDs. AgentManager records restored from disk cannot independently wake contract units: their nonserialized authority callbacks must first be re-established through contract resume. A strict cross-process execution lease prevents two runners from executing the binding concurrently; a live holder is never displaced based only on age. A dead process's lease can be reclaimed. Durable starts/resumes require join-capable agent and orchestration adapters. Disposal releases ownership only after actual work drainage, including when the host boundary throws or rejects after invoking an executor. Explicit cancellation durably stores a terminal checkpoint before releasing the lease. If terminal persistence fails, the process retains the fence rather than permitting an unpersisted cancellation to relaunch.

A host seeing `launch-claimed` must reconcile its native journal/outbox before explicitly resuming. Unknown effect status is not permission to replay an effect. The native validator must reject unresolved or revoked attempts. The runner may restart incomplete planning or unit work from an existing checkpoint; exactly-once arbitrary external side effects require idempotency/reconciliation at the native action ledger and effect destination. This seam guarantees one durable runner admission and excludes concurrent runner execution, not transactional exactly-once delivery to arbitrary third parties.

The standalone admission checkpoint used contract snapshot schema 2. The composed native/captured-input runner writes schema 5: the old native schema-4 reader otherwise ignores durable admission and could resume it as ordinary work. Valid historical snapshots remain readable under the composed validators. Admission receipts and bound terminal checkpoints are not automatically reaped. Forgetting their binding would permit old delivery to create another attempt. Corrupt/missing/inconsistent receipts or checkpoints fail closed. Snapshot import cannot create, overwrite, or strip a native binding, even with force. No raw frozen input or binding is included in admission error messages.

## Evidence

The focused suite uses real child-process exits after persistence/before launch and after launch invocation/before acknowledgement. It exercises exact and concurrent replay, changed payload/revisions, delayed queue validation, cancellation/revocation in reentrant hooks, actual unit-spawn revocation, explicit fresh resume, a second live runner, callback misuse, corrupt receipts, terminal retention, and import bypass refusal. Existing runner, restart, settlement, and agent/phase seam suites cover the unchanged executor integration.

## Draft publication scope

This checkpoint publishes the durable admission interface for integration planning. Independent review was interrupted by a platform restriction and remains incomplete. Local regression/type/API checks are evidence for this source checkpoint, not independent clearance or authorization to merge. The established split-publication, missing settlement, post-launch failure drainage, and compatibility-import identity findings were repaired and have regression coverage.

It does **not** replace inherited `awaiting-owner` semantics in `planner.ts`, `escalation.ts`, `steps.ts`, or `resume.ts`. Normal-turn `createContractIntake` still routes to `runner.reply`/`runner.start`; Agent/TUI `/work` discovery still relies on `projectPlanning.status`. The product integration owner must supply one native goal intake/start/status/cancel path and native project lookup, then switch those entrypoints.

Native-source preservation and autonomous semantic continuation are now composed with this seam and PR56 input authority; see `native-durable-contract-composition.md`. Native source metadata must match the admission binding and criteria key, and the checkpoint retains the original source. Do not downgrade composed schema-5 records or reconstruct missing requirements from generated plans. Product adapters, authenticated host composition and external-effect reconciliation remain separate ownership; this code alone does not establish a product cutover.
