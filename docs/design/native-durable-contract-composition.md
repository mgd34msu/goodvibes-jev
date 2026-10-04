# Native contract composition for product hosts

This checkpoint composes the native source/semantic runner, durable admission, shared autonomous tool evaluator, and PR56 captured-input execution. It is an engine handoff for Agent/TUI and hosted-session owners, not a product entry-point cutover or a new external-effect ledger.

## Runnable host surface

Use `createContractRunner` and types from `@goodvibes-jev/engine/sdk/platform/contract`. Supply the existing runtime dependencies plus both trusted owners:

- `nativeDecisions.authorityOf(contract)` returns the current authenticated authority and project scope IDs/revisions. `conditions`, when provided, registers actual external changes and cancellation-aware waits. Never register approval or Jev availability as a semantic condition.
- `durableAdmission.withCurrent(admission, launch)` uses the host's existing ledger transaction and synchronous live assertion to admit that exact durable operation. See `durable-contract-admission.md`; this composition does not replace that owner.
- `readAccessFilter` remains the original owner's read authorization. Captured input paths do not confer permission. Use the existing runtime AgentManager, AgentOrchestrator, recorded judgment port, and PermissionManager with coherent autonomous configuration.

Call `runner.startDurable({ key, binding, input })`. `input.nativeSource` is required when the runner has a native semantic owner. It contains the complete original goal, ordered criteria, source ID/revision, input revision, and criteria ID/revision. `input.ask` may be a short display summary and is never substituted for those requirements.

The request must satisfy:

- `nativeSource.sourceId === binding.sourceId`
- `nativeSource.inputRevision === binding.inputRevision`
- `nativeSource.criteriaId === key.criteriaId`
- `nativeSource.criteriaRevision === key.criteriaRevision`

`key.workId` identifies the owning work and may differ from the original source ID. `criteriaSetIdForWork` is available when the host's ordered criteria do not already have a stable set ID. The host supplies real revisions; the runner does not infer them from generated plans.

Keep the returned `admission.contractId` and `admission.ownerAgentId`. Exact delivery replay returns the same record without another execution. A changed payload under the same key is a conflict. After a restart, use `resumeDurable(key)` for the same attempt; `resumeAll()` holds durable records for inspection and does not launch them. Read status through `get`/`list`; after acceptance, cancel through `cancel(contractId, reason)` and wait for `join(contractId)` when drainage matters.

New admission receipts use version 2 and pin the resolved execution placement: isolation, branch, worktree path and base branch. `auto` or omitted isolation is resolved once before borrowed owner hooks, never recomputed from later configuration. Checkpoints must match this placement before launch/resume and every native reading/tool admission. The established no-delegation rule may deliberately enter shared session mode only with its corresponding shape and no worktree placement. Invalid isolation enums and arbitrary placement changes are refused before planning or tools.

Historical version-1 admission receipts have no immutable resolved-placement baseline. Exact replay remains available for inspection and does not launch. **Explicit resume of a nonterminal v1 admission is refused** rather than inferring its original execution scope from a mutable checkpoint. Recovery requires the host's current decision and an intentional new attempt; do not overwrite the old receipt or discard its original source/evidence/history.

Native `startForOwner`, legacy owner replies, and legacy text intake cannot manufacture an original source. Product hosts must route native work through this source-bearing seam. A source-less legacy record remains inspectable under a native owner and cannot activate the old approval loop.

## Planner, member and tool handoffs

Initial and corrective native planners receive both the complete immutable source and PR56's construction-owned input authority. They read the admitted/frozen directory, revalidate it around asynchronous planning and checking, and cannot fall back to the live project directory. `prepareInputAuthority` remains attached to member workspaces. The actual phase spawn carries both `inputReadAuthority` and `withCurrentExecution` into AgentManager.

Native planner/member tool execution also carries a nonserialized source getter through construction binding. AgentOrchestrator invokes the existing shared `orchestrator-tool-runtime` prepared-call path with the real PermissionManager. It does not call a fake tool or a second decision dispatcher. Only a recorded `act` may claim the exact prepared body; revision/defer/reject do not execute that original body. A native member without this construction-owned source fails closed. Legacy background execution remains on its compatibility path.

The original source is checked by the same privacy boundary before transmission. Protocol IDs stay structured; catalog descriptions do not interpolate UUIDs into raw content and accidentally classify them as payment-card text.

## Snapshot migration: version 5

Composed writes use envelope version **5**. Version 2 was independently used by captured-input and durable-admission checkpoints. Native source-only/semantic checkpoints used versions 3 and 4. Crucially, the old native version-4 reader ignores `durableAdmission`: reusing version 4 would allow that reader to auto-resume work without the durable owner. The actual old version-2 and version-4 readers reject version-5 envelopes as future versions; a counterfactual version-4 envelope reproduces partial acceptance by the old native reader.

The new reader validates historical source, semantic, captured-input and durable data using their respective validators. Original source and ordered criteria are never reconstructed from generated roots. Native semantic state remains separately versioned at 1. Valid historical records remain inspectable; explicit durable resume obtains current ownership and fresh semantic decisions after real condition changes. Retained evidence, planner output, receipts and spent budgets survive migration. Historical worktree runs without the recorded captured-input receipt require recovery and are not silently recaptured from today's owner tree.

## Product integration still owned by the host

Agent/TUI/hosted-session adapters must supply the authenticated owners, persist their admission/action bindings, project semantic versus transport progress, and drive legitimate session-mode work without overriding delegation constraints. These changes do not add new product wire verbs, deploy a native host, or certify arbitrary external-effect reconciliation.
