# Core turn and strategy readings (THE-16)

## Implemented scope

- `engine.core.turn-shape`: typed chat/task/project intent, an independent specification/plan-needed yes/no reading, and the existing request-risk rubric
- `engine.core.execution-strategy`: task-grounded choice among single/cohort/background/remote. Display rankings are returned probabilities, not a point ladder
- Explicit owner overrides and pinned modes stay structural. An uncertain automatic choice is recorded as held and raises `PlannerJudgmentError`; unavailable remote/background capabilities cannot be invented by the reading
- `classifyIntent`, `AdaptivePlanner.select`, `shouldDecompose`, `proposeWorkstream`, and `prepareConversationForTurn` are asynchronous. Callers await them; no synchronous heuristic backup survives
- The complete turn text is read once for intent/plan/risk. Planner telemetry consumes that same reading, including actual risk, then asks the separate strategy question with the full task
- The generic protected-input boundary runs before these new judgment requests

## Turn lifecycle and contract ownership

The orchestrator reserves the turn and starts its cancellation/queue fence before asynchronous judgment. The submitted user message remains in the transcript when judgment fails or is cancelled. Judgment errors are already typed, so their display does not recursively ask the unavailable judgment service to interpret them. All failures pass through the normal submission finalizer.

A newer message queues even if an abort has already cleared the displayed thinking state but the earlier reading is still settling. It cannot replace the earlier turn's controller or submission key. The cancellation transcript boundary is captured immediately after the user message is added, before awaiting judgment.

Plan priming waits for contract intake. A request consumed by the contract runner, or executing as a session-mode contract unit, does not receive a competing legacy project-plan instruction. An ordinary conversation can be primed by yes at act, unless an execution plan already exists. Uncertainty does not inject a guessed plan.

## Deterministic evidence

The focused suites cover retrospective documentation, short project requests, contrary-to-old-keyword readings, empty text, uncertain planning, missing/failed/cancelled ports, protected input, owner overrides, stale choices after overrides, unavailable strategies, probability-based history, existing plans, multimodal fallback, no provider spend before judgment, retry after failed preflight, cancellation and queued follow-ups. Existing decomposition, workstream, hosted contract and compaction behavior is exercised with explicit recorded readings.

Commands from the repository root:

- `bun packages/engine/scripts/test.ts test/intent-classifier.test.ts test/adaptive-planner.test.ts test/plan-decomposition.test.ts test/workstream-planner-inputs.test.ts test/workstream-services.test.ts test/hosted-session-turn.test.ts test/hosted-session-contracts.test.ts test/hosted-session-exec-posture.test.ts test/compaction-manager-session-bootstrap.test.ts`
- `bun run judgment:lint`
- `bun run typecheck`
- `bun run api:extract && bun run api:subpath && bun run api:check`

The first focused run after integrated lifecycle changes passed 86 tests across nine files. Final compiler, API and broader contract results must be evaluated on the final commit. The baseline contract registration lint findings are an independent integration lane, not silently waived here.

## Live calibration status

The new decisions are registered in `sdk/src/platform/core/judgment-registry.ts`, with fixtures covering every answer and a 0.90 accuracy floor. No live result is claimed: this execution environment has no configured System One endpoint/key.

Once securely configured, run:

`bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/core/judgment-registry.ts`

The deterministic fake readings prove execution behavior and failure handling, not semantic accuracy. Live calibration and the final integrated CLI/hosted-session proof remain required before declaring the full project finished.
