# Native Vibecheck entry-point cutover

Historical October 4 inspection. Native project discovery, submission, execution
controls and autonomous intake have since shipped. The current explicit legacy
import workflow is documented in [native legacy import and recovery](../../products/agent/docs/legacy-ledger-migration.md). The historical gaps below are not a
current acceptance checklist; active planning retirement and remaining hosted
ingress are separately qualified.

Inspected public main `5325a16d` on October 4, 2026. The cited legacy planning/intake implementations have identical contents in reconstructed import checkpoint `d58fdfa4`; its Agent command runner and TUI bootstrap additionally wire the reconstructed read-only import path. This is an implementation map, not a claim of a working native execution flow. No live provider, source migration or remote mutation was performed.

## Practical gaps

1. TUI `/project-plan` still runs a local planning interview and records human approval. Agent/TUI `/work` only open native ledger readers. Reconstructed `/work-import` only supports protected preparation/status and historical recovery storage. None creates and autonomously runs a first-class Vibecheck.
2. Both native readers discover their project through `projectPlanning.status`; removing legacy planning without replacing this host discovery seam would break native work selection.
3. Both products compose the shared `createContractIntake`. Normal turns still route to `runner.start` or to `runner.reply` for an open owner escalation. Changing a slash-command label would not replace the actual detection and execution path.
4. The native execution draft supplies a journal/verifier boundary, but not the real autonomous evaluator and durable runner adapter. Shared decision parsing does not fill that gap.

## Smallest coherent product change

### TUI

- `src/input/commands/planning-runtime.ts:64`: replace the new-goal, approve and answer workflow with a native Vibecheck command using the selected authenticated host. Keep legacy `list`/`show` as explicitly historical reads; prevent legacy `executionApproved` from authorizing native dispatch. The separate `/plan` permission-posture command at the bottom is a different subsystem and must not be accidentally renamed with project planning.
- `src/input/submission-router.ts:12`: replace the special project-plan/planning composer classification with the new native command identity. This parser can recognize explicit command names; interpreting free-form task intent belongs to the shared Jev intake reader, not another product keyword detector.
- `src/views/modals/planning-modal.ts:147,291,328,389`: remove approve-execution and suggested/custom-answer dispatch as runtime authority. Replace the active view with native work/attempt/check progress and autonomous decision states. Historical question/answer and approval fields remain readable as source claims.
- `src/views/builtin-modals.ts:179` and `src/runtime/bootstrap-shell.ts:216`: register the native surface and route old planning deep links to archival display instead of the old actionable modal. Preserve independent existing native read projections.
- `src/runtime/native-work-ledger-host.ts:59`: obtain project identity from the native host binding/discovery contract, not `projectPlanning.status`.

### Agent

- `src/input/commands/agent-workspace-runtime.ts:16` and `src/runtime/native-work-ledger-host.ts:24`: retain `/work` inspection while adding the first-class native goal entry and native host discovery. A request to start work must not be implemented as importing historical planning state.
- `src/tools/agent-harness-personal-ops-lanes.ts:193` currently advertises `agent_work_plan action:"create"`; `src/tools/agent-operator-briefing-tool.ts:39,175` reads `projectPlanning.workPlan.snapshot`. Move active-work routing/briefing to native work and execution receipts, while preserving a separate historical source view.
- `src/tools/agent-harness-command-runner.ts`: both model and human entry paths should reach the same host authorization/gate. Payload `confirm` or `explicitUserRequest` flags do not grant native authority; a blanket model ban is also incorrect. The reconstructed read-only import path already avoids these flags.

### Shared intake and execution

- Agent `src/runtime/services.ts:1046` and TUI `src/runtime/services.ts:201` install `createContractIntake`; their bootstraps feed it to `sdk/platform/core/orchestrator-turn-loop.ts:276`.
- `sdk/platform/contract/intake-route.ts:66–98` implements legacy owner-reply/request-to-runner dispatch. Replace that shared dispatch once, preserving originating input and session identity, rather than adding independent Agent/TUI detection.
- `sdk/platform/tools/agent/index.ts:160` also starts contracts directly; `tools/agent/manager.ts` has owner/spawn contract-start paths. Native work must not bypass durable admission through those secondary entrances. Coordinate this with the runner owner rather than patching around it in a renderer.
- Agent and TUI still construct local `ProjectPlanningService`/`WorkPlanStore`. Retain storage readers for history, but stop making them the active-work authority once the native host path is complete. Do not delete historical records or reinterpret their approval/verification claims.

## Required host interface, without guessing method names

The public import/read surface currently offers `workLedger.snapshot`, `history`, `prepareLegacyImport` and `importLegacy`. It is insufficient for the new workflow. The coordinated host contract must supply:

1. Native selected-project/store discovery and a construction-owned authenticated principal with current grant and scope generations. Current `auth.current` identity/admin/scope strings do not establish revoke-and-restore generation equality.
2. Idempotent native goal intake with immutable goal/criteria/input evidence, expected ledger revision, request identity and returned durable work/attempt identity. Product inputs must never contain authoritative actors or verifier grants.
3. A real recorded Jev evaluator yielding the shared `JevDecision` against host-owned `JevDecisionContext`, with complete action/input binding and authentic decision-log IDs. Registered continuation/condition owners must execute `revise` and observe `defer`; `reject` refuses; no outcome asks a person or silently promotes uncertainty to act.
4. The single shared judgment-availability retry service, with cancellation/revocation/shutdown fencing and observable pending progress. Judgment retry must not repeat external effects.
5. Durable runner admission/start/resume tied to work, criteria revision and attempt. The discussed `startDurable`/`resumeDurable` and `withCurrentAdmission` ownership contract must be implemented by the runner owner; the product cannot recreate it from ordinary `runner.start`.
6. Native execution status/history/subscription and cancellation, plus authentic criterion evidence and atomic current-target publication. A client cannot set verified status from legacy fields or fabricated receipts.
7. For historical import, host-owned semantic admission on the already-persisted exact command, durable decision provenance and fresh current authority on replay. An unknown request must not be re-prepared or assigned another request ID.

Minimum acceptance is one real Agent and one real TUI entry flowing through the same host-owned admission and durable runner path: permitted work completes unattended; valid revise/defer/reject performs only its offered outcome; availability loss remains pending; cancellation/revocation prevents late effects; edited targets invalidate old results; restart/replay produces no duplicate execution. Readable legacy records and protected provenance must remain intact.
