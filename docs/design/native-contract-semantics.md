# Native contract semantic ownership

Durable admission and PR56 input authority compose as described in `native-durable-contract-composition.md`. Native host/product entry points remain host-owned. Engine semantics do not provide a transactional claim for arbitrary external effects.

## Shared evaluator

`gate/autonomous-decision.ts` extracts the recorded semantic evaluator from the tool-admission implementation. `decideAutonomousTool` remains an actual tool-specific adapter. Native contract calls use their own `contract.native.<stage>` sites and registered operation catalogs; they do not manufacture tools or call a tool wrapper with fake arguments.

Every receipt uses `JevDecision` (`act`, `revise`, `defer`, `reject`), exact current source/action/authority/scope bindings, offered evidence/continuation/condition references and actual recorded Jev call IDs. An uncertain act candidate receives at most one further non-executing reading. If refusal is the only permissible outcome, a recorded high-stakes yes/no refusal question is used instead of an invalid one-choice choice request. An unsettled refusal is an operational failure, never a fabricated answer. The evaluator executes nothing and its claim method records provenance; the existing action owner still owns execution/idempotency.

## Native host seam

A native source-bearing start requires `ContractRunnerDeps.nativeDecisions`. Configuring this owner makes the runner native-only: source-less starts/agent-owner intake are refused, old source-less records are held for inspection without resuming, and the legacy text/owner-reply intake cannot activate. Existing runners without this opt-in retain legacy behavior for legacy records until their host is migrated; they hold native records for inspection instead of attempting to execute them without a native owner. This trusted composition object supplies:

- `authorityOf(contract)`: current authenticated principal/authority and project/scope identity/revisions
- `conditions(contract, stage, targetId)`: optional registered external evidence/resource changes, each with an immutable reference, current-reference reader and cancellation-aware wait
- `onRetry(contractId, progress)` and `onDecision(contractId, record)`: optional typed observer notifications

Do not parse authority or callbacks from model output. A condition may not represent owner approval or Jev availability. Its wait must honor cancellation and may resolve only after the registered revision changes. The engine rebuilds the catalog and obtains a fresh semantic decision after that change; neither a deferred receipt nor a restart authorizes execution.

`Contract.nativeDecisions` stores separately versioned receipt history, deferred references, retained planner outputs and monotonic spent counters. `nativeProgress` is semantic activity. `nativeWaiting` is a distinct versioned list of credential-free central transport backoff records. No transport outage becomes a semantic defer or a human prompt. The host should display these typed fields/notifications rather than interpret legacy confidence-band proposal fields as native decisions.

## Actual callers

- An unresolved request shape gets a native semantic decision. Original shape readings remain unchanged; `withOwnerWritingDecision` is never used. Existing delegation constraints continue to determine session mode.
- Initial and repaired native plans require a semantic act on the exact structurally/semantically checked plan. Invalid plans expose only a bounded registered repair, real external conditions or refusal. Original goal and ordered roots never change.
- Evidence exhaustion produces `native-decision`, not the legacy `await-owner` event result. Unchanged unshown evidence is routed using its recorded findings rather than repeatedly asking until probability changes.
- Unit, group, deliverable and merge correction are admitted against current limits. A fresh-worker revision gets a fresh exact-action decision with the selected route before starting. No path resets fix rounds, fresh-worker counts or planner limits.
- Fix planners retain their exact last output and spent attempts. The accepted fix group gets a fresh act before scheduling; exhausted repair budget has no approval fallback.
- Best-of-N keeps historical proposal readings inspectable, then semantically chooses only actual passing candidates. Selecting an alternative revises the candidate and obtains a fresh act before integration. Native callers do not emit a legacy confirm/escalate selection event or invoke owner/operator picking.
- Native replies and amendments are rejected, including direct legacy reply helpers. Native intake ignores historical owner questions. Legacy step overrides cannot replace native semantic steps.

All native reads, including model routing, share the run signal, live before-attempt authority checks and central port progress. The only transport retry implementation remains the shared judgment port. Scope/authority revocation cancels the pending native operation without minting a refusal receipt. Cancellation remains available during backoff or an external-condition wait.

Unit-failure classification also uses that native port and the run/unit lifetime. Its owned `readFailure` call bypasses the global wording memo so another caller's source, authority or cancellation cannot be borrowed. Unchanged-evidence reuse includes quality-only uncertainty as well as goal and criterion uncertainty.

Native route selection carries a structural `originalSource` alongside the display or derived brief. Request-tier and model-choice readings receive the complete goal and ordered criteria without the ordinary brief truncation; the source is never concatenated into or replaced by the display ask. Model-capability tier caching remains about published model facts, independently of the work request.

## Persistence and restart

The standalone semantic checkpoint used snapshot schema 4, after source-preservation schema 3. The composed checkpoint uses schema 5 because the old v4 reader did not understand durable ownership. Historical v2 records now pass the composed captured-input/durable validators rather than the prerequisite's blanket v2 refusal.

Native receipt/counter writes use the existing authoritative contract store synchronously before a budgeted continuation or selected action can start. Failure stops that operation; no alternative storage or admission path is substituted. This is not a replacement for the native action ledger or external-effect reconciliation.

Resume returns a pending run instead of blocking host startup on a condition or a Jev outage. It reinstalls the registered condition, waits for a real change and freshly evaluates the stored operation. Retained plan/fix-plan output is rechecked without resetting spent attempts. Historical native owner waits are preserved for inspection, while the executable path moves to fresh native evaluation. Unshown readings are never marked met by an affirmative reply or by repeating unchanged evidence.

A registered external condition may change its evidence revision, but it cannot transfer the pending operation to a different authority or scope. Live deferral retains the original identity across the wait; restart compares the current host against the persisted deferred receipt before and after waiting. Any authority/scope identity or revision change cancels before a new reading or execution.

## Composition requirements and limits

Wintermute's native host/product composition must supply real authority/scope ownership, condition registration and source snapshots, drive session-mode work without creating a delegation bypass, and render the native semantic/progress fields. This checkpoint does not retrofit source-less legacy product calls with fabricated empty criteria.

The union retains source, semantic, captured-input and durable store/restore validation and writes schema 5. Do not infer missing original source from generated legacy criteria, replay old native receipts, or adopt one branch's generated API report without regenerating the union. Product deployment and external-effect ledger ownership remain outside this checkpoint.

## Verification focus

Tests exercise original-source preservation; act/revise/reject; registered defer and changed-revision reentry; stale/unknown continuations; missing native ownership; real shared-transport recovery/cancellation/revocation; correction and fresh-worker budgets; actual best-of-N integration; invalid fix-plan exhaustion; deferred plan and fix-plan restart; and historical owner-wait migration without synthetic met criteria.
