# The contract runner: implementation design

This is the build design for ledger task R, the contract runner that replaces WRFC. It is written so that engineers can build it in the parts listed in section 12 without making further design decisions. Every file path and function named here was read in the ported engine on 2026-09-26. Where the design adds something new, it says so and names the file it goes in.

Sources of scope: `goodvibes-jev-intent.md` (the contract runner section, and the engine table rows for core, agents and orchestration, hosted sessions, sessions and embed) and `docs/inventory/wrfc-to-jev.md`, which is the specification. Section 11 places every row of that inventory.

Paths below are relative to `packages/engine/sdk/src/platform/` unless they start with `packages/` or `docs/`.

## 1. What the runner does, in one pass

1. Work arrives: a person's turn that intake dispatch reads as contract work, an `agent` tool spawn or batch-spawn from the conversation model, a CLI `run`, a hosted session turn, a launched plan proposal, or an external dispatch.
2. Jev reads the shape of the request (does the user forbid delegation, ask for parallel agents, forbid writing, ask for several attempts).
3. The planning model (a read-only planner sub-agent) writes a plan: the goal, the acceptance criteria with the user's words each one comes from, and groups of units, each unit with its own goal, brief and criteria.
4. Code validates the plan's structure. Jev checks the plan: each criterion traces to the user's words, no stated requirement is missing, each criterion is checkable and not an agent-layout requirement, each unit's role, and no unit narrows the goal. Problems go back to the planner for repair, and then to the owner.
5. Each group runs as a workstream on the ported orchestration engine. Each unit is one work item, run by one sub-agent chosen by the route selector.
6. While a unit's sub-agent works, Jev reads its work against the unit's criteria and a quality battery. When the agent finishes a turn that changed files, and again when it tries to finish, the runner collects evidence (diff, claim verification, gate output, the agent's output), asks Jev, and either lets the agent finish or holds it open and sends it a nudge naming what is wrong. The agent fixes it and Jev checks again. This repeats until every criterion reads met. Work that is not passing is never accepted.
7. When nudging stops making progress, the runner turns the remaining problems into planned-fix units, gives the unit a fresh agent, or escalates to the owner with the unmet criteria named.
8. When every unit of a group has passed, Jev judges the group. When every group has passed, Jev judges the deliverable. Failures at either level become planned-fix units and are judged again.
9. When the deliverable passes, the runner commits the contract's work, delivers the answer to the person and the status to operator surfaces, and records everything in the contract tree and the decision log.

## 2. Where the runner lives, and its public API

### 2.1 Module layout

A new platform module, `contract/`, exported at the engine subpath `@goodvibes-jev/engine/sdk/platform/contract` (a new line in `packages/engine/package.json` beside `./sdk/platform/orchestration`, pointing at `./sdk/src/platform/contract/index.ts`). The barrel is a curated named-export list, the convention `orchestration/index.ts` uses.

| File | Holds |
|---|---|
| `contract/index.ts` | Curated named exports |
| `contract/types.ts` | The data model (section 2.3): Contract, ContractGroup, ContractUnit, Criterion, readings history, checks, nudges, escalations, decisions, status unions and transition tables |
| `contract/config.ts` | `readContractConfig(configManager)` and one getter per setting (section 9.1); replaces `agents/wrfc-config.ts` |
| `contract/runner.ts` | `createContractRunner(deps)`: the lifecycle, queue and state transitions; replaces the lifecycle half of `agents/wrfc-controller.ts` |
| `contract/planner.ts` | Runs the planning model and the repair loop (section 3) |
| `contract/plan-schema.ts` | The plan JSON schema, `parseContractPlan`, `validateContractPlan` (code checks) |
| `contract/plan-checks.ts` | Runs the Jev plan checks and folds them into a plan verdict |
| `contract/workstreams.ts` | Maps groups and units onto the orchestration engine: `unitPhases()`, `groupWorkstreamInput()`, one engine per contract |
| `contract/brief.ts` | `buildUnitBrief(contract, group, unit)`; replaces `buildSubtaskEngineerTask`, `buildCompoundIntegrationTask` and the engineer addendum |
| `contract/agent-hooks.ts` | `ContractAgentHooks`: the completion hold and turn-end hook the sub-agent loop calls (section 4.2) |
| `contract/evidence.ts` | Collects a unit's, group's or deliverable's evidence and trims it to the Jev request budget |
| `contract/claims.ts` | `parseUnitCompletionReport`, `verifyUnitClaims` (moved from `agents/wrfc-reporting.ts` `parseEngineerCompletionReport` and `verifyEngineerClaims`) |
| `contract/gates.ts` | `runContractGates`, `executeGateCommand`, `getSkippedGateReason`, `loadPackageScripts` (moved from `agents/wrfc-gates.ts` and `agents/wrfc-gate-runtime.ts`) |
| `contract/check.ts` | One check: evidence in, Jev readings, outcome out (section 4.4 to 4.6) |
| `contract/progress.ts` | Regression and stall detection over the readings history, in code |
| `contract/nudge.ts` | `buildNudge(...)`: the nudge text built in code, and delivery |
| `contract/steps.ts` | `createContractSteps`: the correction, completion and escalation steps put together for the runner |
| `contract/correction.ts` | Stall routing, planned-fix groups, fresh-agent retries; replaces `orchestration/fix-workstream-runner.ts` and the fix paths of the controller |
| `contract/fix-plan.ts` | The fix planner's prompts, the code checks on a fix plan, and building the fix group into the tree |
| `contract/completion.ts` | Group and deliverable judging, integration, scoped commit, answer and status, cancel |
| `contract/escalation.ts` | Owner escalations and reading the owner's reply |
| `contract/amendment.ts` | An owner's amendment: the planner rewrites a target's criteria as instructed |
| `contract/best-of-n.ts` | Candidate selection over attempt siblings; replaces `orchestration/judge.ts` |
| `contract/usage.ts` | Usage roll-up: unit, group, contract, and judgment usage |
| `contract/plan-sync.ts` | Execution-plan items and project work-plan tasks follow units; replaces `agents/wrfc-plan-sync.ts` and `upsertWrfcWorkPlanTask` |
| `contract/store.ts` | `ContractStore`: persistence of the contract tree (section 7.1) |
| `contract/resume.ts` | Resume and zombie reaping at startup (section 7.2) |
| `contract/watchdog.ts` | Silence watchdog over unit agents |
| `contract/events.ts` | Emit helpers for the contract event domain (section 8) |
| `contract/answer.ts` | `renderContractAnswer`, `describeContractOutcome`, `describeCommitOutcome` (from `agents/wrfc-chain-answer.ts`) |
| `contract/external.ts` | The external work seam (from `agents/wrfc-external-adapter.ts`) |
| `contract/intake-route.ts` | The request-route dispatch and `toolResultStartedContract` (from `core/wrfc-routing.ts`) |
| `contract/cli.ts` | `runContractCli(argv, io, deps)` (section 10.1) |
| `contract/testing.ts` | `createContractRunnerForTest` (from `agents/wrfc-controller-test-support.ts`) |
| `contract/batteries/*.ts` | One file per battery or pattern instance (section 5) |
| `contract/judgment-registry.ts` | `export const registry = new BatteryRegistry()` with every contract decision registered, the shape of `packages/engine/errors/src/judgment-registry.ts`, for `bun run calibrate --registry` |
| `packages/engine/sdk/src/bin/goodvibes-contract.ts` | The CLI entry, registered as `bin.goodvibes-contract` in `packages/engine/package.json` |

Every Jev read in `contract/` goes through `judgmentPort(site)` from `packages/engine/errors/src/judgment-port.ts`. There is no read path without an installed port: a missing port throws `JudgmentPortMissingError`, which fails the contract with `failureKind: 'judgment-unavailable'` and the error's message. Outage handling is the provider failover chain behind the port, not a heuristic.

Each file stays under the engine's line cap (`scripts/line-cap-grandfather.ts` loses its `wrfc-controller.ts` entry; nothing new is grandfathered).

### 2.2 Public API

```ts
export interface ContractRunner {
  /** Starts a contract from an ask. Returns at once with the contract and its owner agent record. */
  start(input: StartContractInput): StartedContract;
  /** Starts from a plan someone already drafted (plan proposal, workstream draft). The plan checks still run. */
  startFromPlan(input: StartFromPlanInput): StartedContract;
  /** Called by AgentManager.spawn for a non-outside-contract spawn (the old createChain seam). */
  startForOwner(ownerRecord: AgentRecord): StartedContract;
  get(contractId: string): ContractView | null;
  list(filter?: { readonly sessionId?: string; readonly includeTerminal?: boolean }): ContractView[];
  cancel(contractId: string, reason: string): boolean;
  /** An owner's free-text reply to an open escalation, read with the reply pattern. */
  reply(contractId: string, escalationId: string, text: string): Promise<OwnerReplyOutcome>;
  resumeAll(): Promise<ResumeReport>;
  importContract(snapshotJson: string, force?: boolean): boolean;
  serializeContract(contractId: string): string | null;
  hooks(): ContractAgentHooks;            // installed into AgentOrchestrator and the core turn loop
  on(listener: (event: ContractEvent) => void): () => void;
  dispose(): void;
}

export interface StartContractInput {
  readonly ask: string;                   // the person's words, verbatim; the authority for criteria
  readonly sessionId: string;
  readonly origin: 'turn' | 'agent-tool' | 'cli' | 'hosted' | 'external' | 'proposal';
  readonly projectRoot: string;
  readonly proposedUnits?: readonly { readonly task: string; readonly template?: string }[]; // agent-tool batch or AgentInput.proposedUnits
  readonly parentAgentId?: string;        // the conversation agent that asked, when there is one
  readonly budget?: BudgetCeiling;        // orchestration/types.ts
  readonly isolation?: 'auto' | 'worktree' | 'shared';
}

export interface StartedContract {
  readonly contract: ContractView;
  readonly owner: AgentRecord;            // the owner record parents wait on (section 6.5)
}
```

`createContractRunner(deps: ContractRunnerDeps)` takes:

| Dependency | Type | Used for |
|---|---|---|
| `agentManager` | `Pick<AgentManager, 'spawn' \| 'getStatus' \| 'list' \| 'cancel' \| 'wakeWithSteer' \| 'getConversationSnapshot' \| 'registerCancellationSignal' \| 'releaseCancellationSignal'>` | owner records, planner agent, wake |
| `messageBus` | `Pick<AgentMessageBus, 'send' \| 'registerAgent'>` | mid-run nudges |
| `runtimeBus` | `RuntimeEventBus` | agent events in, contract events out |
| `configManager` | `Pick<ConfigManager, 'get' \| 'getCategory'>` | settings |
| `projectRoot`, `surfaceRoot?` | `string` | trees and state |
| `routeSelector` | `ContractRouteSelector` (required) | the model for each unit and the planner (section 6.1) |
| `createEngine` | `(input: ContractEngineInput) => OrchestrationEngine`, the input being `{ projectRoot, stateRoot, stateNamespace, contractUnitSettlement, fleetCapacity, judgeAttempts }` | one orchestration engine per contract (section 7.4); the runner hands the engine its settlement of unit items (section 7.5), the fleet ceiling, and its best-of-N judge (section 6.2) |
| `decompositionRunner` | `DecompositionRunner` (`core/plan-decomposition.ts`) | the planner agent (section 3.2) |
| `steps?` | `Partial<ContractSteps>` (`contract/steps.ts`) | individual correction and completion steps a host takes over; every other step is the runner's own, built by `createContractSteps` from the runner's dependencies: stall routing, owner escalation (including `attemptsUndecided`, section 6.2), merge conflicts, group and deliverable judging, commit; they act through `ContractRun` and its `RunControl` |
| `fleetCapacity` | `FleetCapacityFn` (`orchestration/elastic-pool.ts`) | the global unit ceiling |
| `priceUsage`, `priceProvenance` | from `buildPricingSeams` (`runtime/cost/pricing-seams.ts`) | cost roll-up |
| `workPlanService?` | `Pick<ProjectPlanningService, 'createWorkPlanTask' \| 'updateWorkPlanTask'>` | work-plan sync (added with R.6) |
| `planManager?` | `Pick<ExecutionPlanManager, 'getActive' \| 'updateItem'>` | execution-plan sync (added with R.6) |
| `store` | `ContractStore` | persistence |
| `now?` | `() => number` | tests |

`ContractRouteSelector` replaces `WrfcChildRouteSelector` (`agents/wrfc-types.ts:77-91`), and is required:

```ts
export type ContractRouteSelector = (request: {
  readonly purpose: 'planner' | 'unit' | 'fresh-unit' | 'integration';
  readonly contract: ContractView;
  readonly unit?: ContractUnitView;
}) => Promise<UnitRoute>;

export interface UnitRoute {
  readonly model: string; readonly provider: string;
  readonly fallbackModels?: readonly string[];
  readonly routing?: AgentProviderRoutingPolicy;          // tools/agent/schema.ts:251
  readonly reasoningEffort?: AgentRecord['reasoningEffort'];
  readonly reason: string;                                 // recorded on the unit
}
```

### 2.3 Data model (`contract/types.ts`)

Ids: `ctr-<8 hex>` for contracts, `g<n>` and `u<n>` inside a contract (planner-assigned, validated unique), `c<n>` for contract criteria, `<unitId>.c<n>` for unit criteria, `<groupId>.c<n>` for group criteria. The group id is also the id of the orchestration workstream that runs it; the unit id is also the work item id. That one-to-one mapping means `fleet.graph.get`, `fleet.attempts.*` and `fleet.conflicts.*` keep working with the group id as their `workstreamId`.

```ts
export type ContractStatus =
  | 'queued'          // waiting for an active-contract slot
  | 'shaping'         // reading the request shape
  | 'planning'        // planner agent running, or repairing
  | 'checking-plan'   // Jev plan checks
  | 'running'         // groups executing
  | 'judging'         // deliverable check
  | 'fixing'          // a deliverable-level planned-fix group is running
  | 'committing'
  | 'awaiting-owner'  // an open escalation blocks progress
  | 'passed' | 'failed' | 'cancelled';

export type GroupStatus = 'pending' | 'blocked' | 'running' | 'judging' | 'fixing' | 'awaiting-owner' | 'passed' | 'failed' | 'cancelled';

export type UnitStatus =
  | 'pending' | 'blocked'          // blocked: waiting on dependencies or budget (mirrors WorkItemState)
  | 'running'                      // agent working, no check pending
  | 'checking'                     // a check is in flight
  | 'held'                         // agent is held at its completion point while a check runs
  | 'nudged'                       // a nudge was delivered; waiting for the agent's next turn
  | 'fixing'                       // a planned-fix group for this unit is running
  | 'awaiting-owner'
  | 'held-merge'                   // best-of-N sibling that passed, waiting for selection
  | 'passed' | 'failed' | 'cancelled';

export type ContractFailureKind =
  | 'transport' | 'max_turns' | 'planning' | 'budget' | 'owner-rejected'
  | 'judgment-unavailable' | 'zombie' | 'other';

export type CriterionOrigin =
  | 'stated'       // contract criterion traced to the user's words (quote required)
  | 'derived'      // unit or group criterion that serves one or more contract criteria
  | 'integration'  // integration unit criterion
  | 'fix'          // planned-fix unit criterion, covering criteria of the unit, group or deliverable it repairs
  | 'owner';       // added or reworded by an owner amendment

export interface Criterion {
  readonly id: string;
  text: string;
  readonly origin: CriterionOrigin;
  readonly quote?: string;              // 'stated' only: the user's words, verbatim
  readonly serves: readonly string[];   // ids of the criteria this one serves (empty for 'stated')
  /** 'excluded' only for topology-only criteria the plan cannot satisfy; 'structure' when the plan's shape meets it. */
  disposition: 'judged' | 'excluded' | 'met-by-structure';
  dispositionReason?: string;
  status: 'unread' | 'met' | 'unmet' | 'unshown';
  readings: CriterionReading[];         // every reading, oldest first
}

export interface CriterionReading {
  readonly checkId: string;
  readonly at: number;
  readonly probabilityUnmet: number;    // the judge's yes/no probability (yes = fails)
  readonly verdict: 'met' | 'unmet' | 'unshown';
  readonly outcome: Outcome;            // act | confirm | escalate from the band
  readonly severity?: 'critical' | 'major' | 'minor';
  readonly decisionId: string | undefined;
}

export interface UnitCheck {
  readonly id: string;                  // `${unitId}.k${n}`
  readonly at: number;
  readonly trigger: 'turn-end' | 'completion' | 'agent-failed' | 'fix-passed' | 'resume' | 'owner-amend';
  readonly claims?: { readonly kind: ClaimVerificationKind; readonly summary: string };
  readonly gates?: readonly QualityGateResult[];
  readonly goal: { readonly probabilityUnmet: number; readonly outcome: Outcome };
  readonly quality: Readonly<Record<QualityItem, { readonly verdict: 'yes' | 'no'; readonly outcome: Outcome }>>;
  readonly result: 'pass' | 'nudge' | 'await-owner' | 'stall' | 'recorded';
  readonly decisionIds: readonly string[];
  readonly evidenceDigest: string;      // hashState of the evidence (packages/judgment log/index.ts)
}

export interface Nudge {
  readonly id: string;
  readonly checkId: string;
  readonly at: number;
  readonly kinds: readonly ('unmet' | 'unshown' | 'regression' | 'quality' | 'gate' | 'claims')[];
  readonly criterionIds: readonly string[];
  readonly text: string;
  readonly delivery: 'hold' | 'bus' | 'wake';
  readonly agentId: string;
  consumedAt?: number;
}

export interface ContractUnit {
  readonly id: string;
  readonly groupId: string;
  title: string;
  goal: string;
  brief: string;
  readonly role: 'implement' | 'research' | 'design' | 'integration';
  readonly dependsOn: readonly string[];
  readonly files: readonly string[];
  readonly attempts: number;            // 1 unless best-of-N
  criteria: Criterion[];
  status: UnitStatus;
  agentIds: string[];                   // every agent that ever ran this unit
  activeAgentId?: string;
  route?: UnitRoute;                    // with its reason
  checks: UnitCheck[];
  nudges: Nudge[];
  fixRounds: number;
  freshAgents: number;
  transportRetries: number;
  touchedPaths: string[];
  baseline?: { readonly head: string | null; readonly dirty: Readonly<Record<string, string | null>> }; // shared mode only
  usage: WorkItemUsage;                 // orchestration/types.ts
  answer?: string;                      // the unit's completion summary
  failureReason?: string;
}

export interface ContractGroup {
  readonly id: string;
  title: string;
  goal: string;
  readonly kind: 'work' | 'fix' | 'integration';
  readonly repairs?: { readonly scope: 'unit' | 'group' | 'deliverable'; readonly targetId: string; readonly criterionIds: readonly string[] };
  readonly dependsOn: readonly string[];
  criteria: Criterion[];
  unitIds: string[];
  status: GroupStatus;
  checks: UnitCheck[];
  fixRounds: number;
  usage: WorkItemUsage;
}

export interface Contract {
  readonly id: string;
  readonly schemaVersion: number;       // CURRENT_CONTRACT_SCHEMA_VERSION = 1
  readonly sessionId: string;
  readonly origin: StartContractInput['origin'];
  readonly ask: string;
  readonly ownerAgentId: string;
  readonly parentAgentId?: string;
  readonly projectRoot: string;
  readonly isolation: 'worktree' | 'shared';
  readonly branch?: string;             // worktree mode: contract/<short>
  readonly worktreePath?: string;
  readonly baseBranch?: string;
  goal: string;
  criteria: Criterion[];                // contract-level, all origin 'stated' or 'owner'
  groups: ContractGroup[];
  units: ContractUnit[];
  shape: RequestShape;                  // section 3.1
  status: ContractStatus;
  checks: UnitCheck[];                  // deliverable checks
  fixRounds: number;
  escalations: Escalation[];
  decisions: ContractDecision[];
  usage: WorkItemUsage;
  judgmentUsage: { calls: number; inputTokens: number; outputTokens: number };
  plannerAgentIds: string[];
  answer?: string;
  statusLine?: string;
  commit?: { readonly status: 'committed' | 'applied' | 'skipped' | 'failed'; readonly hash?: string; readonly note: string };
  failureKind?: ContractFailureKind;
  error?: string;
  readonly createdAt: number;
  completedAt?: number;
}

export interface Escalation {
  readonly id: string;
  readonly at: number;
  readonly scope: 'plan' | 'unit' | 'group' | 'deliverable' | 'shape';
  readonly targetId: string;
  readonly reason: 'plan-unresolved' | 'stalled' | 'unsettled' | 'fix-rounds-exhausted' | 'writing-unclear' | 'attempts-undecided' | 'owner-decision-needed';
  readonly question: string;            // built in code, section 6.3
  readonly unmetCriterionIds: readonly string[];
  resolvedAt?: number;
  reply?: { readonly text: string; readonly reading: ReplyReadingName; readonly outcome: Outcome; readonly decisionId: string | undefined };
}

export interface ContractDecision {    // replaces WrfcOwnerDecision (agents/wrfc-types.ts:63)
  readonly id: string; readonly at: number;
  readonly action:
    | 'created' | 'queued' | 'shaped' | 'planned' | 'plan-repaired' | 'plan-accepted' | 'spawned' | 'checked'
    | 'nudged' | 'woke' | 'regressed' | 'stalled' | 'fix-planned' | 'fresh-agent' | 'escalated'
    | 'owner-replied' | 'transport-retry' | 'silence-retry' | 'attempts-selected' | 'group-passed'
    | 'committed' | 'passed' | 'failed' | 'cancelled' | 'resumed' | 'reaped';
  readonly targetId: string;
  readonly reason: string;
  readonly decisionIds: readonly string[];  // decision-log ids of the Jev readings behind it
  readonly route?: UnitRoute;
}
```

`ContractView`, `ContractGroupView` and `ContractUnitView` are read-only projections of the same shapes (`Readonly` deep), returned by `get` and `list` and carried by events. The transition tables `CONTRACT_TRANSITIONS`, `GROUP_TRANSITIONS` and `UNIT_TRANSITIONS` live in `types.ts` in the style of `VALID_TRANSITIONS` (`agents/wrfc-controller.ts:91`); an illegal transition throws, as `WrfcController.transition` does.

**Usage roll-up.** Unit usage is the phase runner's `WorkItemUsage` for the unit's work item (`usageFromRecord`, `orchestration/phase-runner.ts:177`), merged with `mergeWorkItemUsage` (`orchestration/types.ts:175`) across every agent the unit ever ran. Group usage is the merge of its units. Contract usage is the merge of its groups plus the planner agents. `judgmentUsage` sums `usage.inputTokens` and `usage.outputTokens` from every Jev result the contract caused (the `result` field of battery runs and pattern results). The owner record's `usage` and `toolCallCount` are set from the contract totals when the owner completes, which is what `aggregateChainUsage` and `aggregateChainToolCallCount` (`agents/wrfc-controller.ts:2756,2800`) did, and the fleet adapter reprices the owner node from its children as `repriceWrfcOwnerNode` did.

**Route reason.** `ContractUnit.route.reason` is the selector's reason string; it is copied onto the unit agent's record as `AgentRecord.routeReason` (renamed from `wrfcRouteReason`, `tools/agent/manager.ts:157`) and appears in the `spawned` decision and the `CONTRACT_UNIT_SPAWNED` event.

## 3. Planning

### 3.1 Reading the request shape (before planning)

Battery `contract.request-shape` (`contract/batteries/request-shape.ts`), four yes/no questions asked in one request about the state `{ request: <ask> }`:

| Question | Wording | Band | What code does |
|---|---|---|---|
| `forbids_delegation` | Does the user forbid handing this work to other agents or sub-agents, or ask that it be done without delegating? | yes side `STAKES_BANDS.medium`, no side `STAKES_BANDS.high` | yes at act or confirm, or escalate: the contract runs in session mode (section 6.6); no at act: delegation allowed |
| `requests_parallel_agents` | Does the user ask for separate agents working in parallel, or one agent per item? | `STAKES_BANDS.low` both sides | yes at act: the planner is told to put independent units in one group and the plan validator requires it (3.3) |
| `forbids_writing` | Does the user forbid changing files, or ask only for a design, plan or report without edits? | yes side `medium`, no side `high` | yes at act: every unit is read-only; no at act: implementation units keep write and exec; escalate or confirm on either side: an escalation `writing-unclear` asks the owner before planning |
| `asks_for_attempts` | Does the user ask for several independent attempts at the same work so the best one can be picked? | `low` both sides | yes at act: the planner may set `attempts` above 1; otherwise every unit has `attempts: 1` unless `contract.defaultAttempts` is above 1 |

The readings are stored as `Contract.shape: RequestShape` (the four conclusions plus decision ids). This battery replaces `userProhibitsDelegation` (`core/wrfc-routing.ts:47`), `userRequestsParallelFanout` (`tools/agent/wrfc-batch-policy.ts:57`) and the `NO_WRITE_RE` and `DESIGN_ONLY_ACTION_RE` regexes in the same file.

### 3.2 The planning model

`contract/planner.ts` runs the planner as a read-only sub-agent through the existing `DecompositionRunner` seam (`core/plan-decomposition.ts:124`) implemented by `agents/planner-decomposition-runner.ts` (template `planner`, tools `PLANNER_DECOMPOSITION_TOOLS`, spawned with `outsideContract: true`, bounded by wall clock, tokens and turns). The runner calls it directly; it does not call `decomposeGoal`, so there is no heuristic path. The model and provider come from `routeSelector({ purpose: 'planner' })`.

The planner's system prompt is a new function `buildContractPlannerPrompt()` in `contract/planner.ts`. It asks for exactly one fenced JSON block of this shape:

```json
{
  "goal": "one sentence: what the whole task delivers",
  "criteria": [ { "id": "c1", "text": "checkable requirement", "quote": "the user's exact words it comes from" } ],
  "groups": [
    {
      "id": "g1", "title": "...", "goal": "...", "dependsOn": [],
      "criteria": [ { "id": "g1.c1", "text": "...", "serves": ["c1"] } ],
      "units": [
        {
          "id": "u1", "title": "...", "goal": "...", "role": "implement",
          "brief": "what to do, where, and how it fits the whole",
          "dependsOn": [], "files": ["src/a.ts"], "attempts": 1,
          "criteria": [ { "id": "u1.c1", "text": "...", "serves": ["c1"] } ]
        }
      ]
    }
  ]
}
```

The user prompt carries the ask verbatim, the request shape conclusions, any proposed units (from an agent-tool batch or `AgentInput.proposedUnits`), a repository map summary (the planner's read tools find the rest), and on a repair, the list of problems from 3.3 and 3.4 with the previous plan.

`parseContractPlan(text)` extracts the last fenced JSON block and parses it; `validateContractPlan(plan, ask, shape)` returns a list of `PlanProblem { code, targetId?, message }`. A parse failure is a problem with code `unparseable`.

### 3.3 Code checks on the plan (`validateContractPlan`)

All deterministic, no Jev:

1. Ids are unique and match the formats in 2.3; every `dependsOn` names an existing group or unit in the same scope; neither the group graph nor any unit graph has a cycle (the cycle test is `wouldCreateCycle` from `orchestration/graph-dynamics.ts:40`, applied edge by edge while building).
2. At least one contract criterion. Every unit has at least one criterion. Every unit and group criterion has a non-empty `serves` list naming contract criteria.
3. Coverage by counting: every contract criterion is served by at least one unit criterion. The uncovered ids are the problem's targets.
4. Every contract criterion's `quote` is a substring of the ask after `normalizeForMatch` (`packages/judgment/src/patterns/fidelity.ts`). A missing quote is problem `quote-not-found`. (The fidelity checker makes the same check itself and reports `fabricated`; running it in code first saves the call and gives the planner a precise repair message.)
5. A plan with more than one unit ends with exactly one group of kind `integration` that depends on every other group and holds one unit with `role: 'integration'`. A single-unit plan has no integration group. This is the default plan shape for a single-unit task (the replacement for `engineerReviewPhases` and `fromChainSpec`).
6. When `shape.requests_parallel_agents` is yes at act and the plan has more than one unit, at least one group has two or more units with no dependency between them.
7. `attempts` is 1 unless `shape.asks_for_attempts` is yes at act or `contract.defaultAttempts` is above 1; it never exceeds `MAX_ATTEMPTS` (`orchestration/types.ts:418`).
8. The total unit count is at most `contract.maxUnits`.
9. When `shape.forbids_writing` is yes at act, no unit has role `implement` or `integration` that needs writes (the brief is re-marked read-only by code; this is enforced, not checked).

### 3.4 Jev checks on the plan (`contract/plan-checks.ts`)

Run after the code checks pass, all concurrently (they are separate requests because each asks about a different item). Each is a named decision with fixtures, registered in `contract/judgment-registry.ts`.

| Check | Decision and pattern | Asked of | Question(s) | Band stakes | Problem when |
|---|---|---|---|---|---|
| Criteria trace to the user's words | `contract.criterion-trace`, `defineFidelityChecker` | each contract criterion: claim = `The user requires: <text>`, source = the ask, quote = its quote | the fidelity relation choice (supports, contradicts, says nothing) | `STAKES_BANDS.medium.confidence`, with `perOption.supports` at `high` | fidelity is not `supported` at act |
| No stated requirement missing | `contract.plan-coverage`, `defineBattery` | the plan: `{ request, criteria: [texts] }` | `uncovered_requirement`: Does `request` state a requirement, limit or preference that none of `criteria` covers? | yes side `medium`, no side `high` | yes at any outcome, or no below act |
| Criterion is checkable and not topology-only | `contract.criterion-shape`, `defineBattery` | each contract criterion: `{ request, criterion }` | `checkable`: Can `criterion` be confirmed or refuted from the finished work: its files, its output, or commands run against it? `topology_only`: Can `criterion` only be satisfied by a particular arrangement of agents (how many run, whether in parallel, one per item) rather than by the work itself? | both `medium` | `checkable` no at act or confirm; `topology_only` handled below |
| Role classification | `contract.unit-shape`, `defineBattery` | each unit: `{ goal, criteria, unit: { title, goal, brief } }` | `role`: choice over implement (changes files or produces the deliverable), research (reads and reports, changes nothing), design (produces a plan or design as its answer, changes nothing), review (examines other units' work and reports on it), test (only verifies other units' work by running checks), verify (confirms other work is correct) | `medium` confidence | role is review, test or verify: problem `verification-unit` (Jev verifies inside every unit; the planner folds the check into the criteria of the unit it would verify, for example "the tests for X pass"). A role that disagrees with the planner's `role` field is problem `role-mismatch` |
| Scope narrowing | same `contract.unit-shape` battery, second question | same state | `narrows`: Does `unit` leave out or narrow anything that `goal` and the criteria it serves require? | yes side `medium`, no side `high` | yes at any outcome, or no below act |

`contract.unit-shape` asks `role` and `narrows` in one request per unit.

**Topology-only criteria.** When `topology_only` reads yes at act for a contract criterion: if the plan honours a parallel request (code check 6 held), the criterion's disposition becomes `met-by-structure` with the reason naming the group that satisfies it; otherwise it becomes `excluded` with the reason "requires an agent arrangement this plan does not use". Neither is ever judged or failed; both are listed in the plan event, the contract tree and the final status line ("1 criterion excluded: requires an agent arrangement"). This is the Jev form of `isFanoutShapeConstraintText` and `systemUnsatisfiableConstraintIds`.

**Tool contract.** Implementation and integration units keep the write and exec tools unless `shape.forbids_writing` is yes at act. Research and design units are read-only (`restrictTools` with the planner tool set). This replaces `resolveImplementationToolContract` (`tools/agent/wrfc-batch-policy.ts:279`).

### 3.5 Repair and acceptance

`planContract` loops: plan, code checks, Jev checks. Any problem sends the planner a repair request listing every problem, up to `contract.planRepairLimit` repairs. When problems remain after the last repair, the contract goes to `awaiting-owner` with an escalation of reason `plan-unresolved` whose question lists the problems and the current plan. The owner's reply is read with `contract.owner-reply` (section 6.3): approve accepts the plan as it stands (the owner has authority over their own requirements), amend sends the reply text to the planner as an instruction and re-runs the checks, reject cancels the contract.

When the planner agent fails (spawn error, cancel, bound exceeded, unparseable after the repair budget), the contract fails with `failureKind: 'planning'`. There is no single-item fallback.

The accepted plan becomes the contract tree: criteria get their dispositions, units get `status: 'pending'`, groups get `pending` or `blocked`, and the `plan-accepted` decision records every decision id behind it.

## 4. The nudge loop

### 4.1 Agent-loop seams (changes to existing files)

The sub-agent loop is `runAgentTask` in `agents/orchestrator-runner.ts`. Two seams are added to `AgentOrchestratorRunContext` (line 75), both optional so contexts without a runner are unchanged:

```ts
readonly contractHooks?: ContractAgentHooks | undefined;

export interface ContractAgentHooks {
  /** After executeToolCalls returns for a turn of a contract-bound agent. Never awaited by the loop. */
  onTurnEnd(record: AgentRecord, turn: {
    readonly turn: number;
    readonly toolCalls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];
    readonly results: readonly ToolResult[];
    readonly assistantText: string;
  }): void;
  /** When the agent would complete. The loop awaits it. */
  holdCompletion(record: AgentRecord): Promise<{ readonly kind: 'release' } | { readonly kind: 'continue'; readonly message: string; readonly nudgeId: string }>;
}
```

- **Turn end.** Immediately after `conversation.addToolResults(results)` (orchestrator-runner.ts, after the `executeToolCalls` call), when `record.contractUnitId` is set, call `context.contractHooks?.onTurnEnd(...)` inside a try/catch that logs, like the `onToolExecuted` call in `executeToolCalls`.
- **Completion hold.** Where the loop computes `continueLoop = completeOrRegenerate(record, conversation, response)` and the result is `false`, when `record.contractUnitId` is set and `record.status` is not `cancelled`, await `context.contractHooks.holdCompletion(record)`. On `continue`, add `message` with `conversation.addUserMessage` (verbatim, like a drained steer), emit `COMMUNICATION` consumed for `nudgeId` through `emitCommunicationConsumed` as the steer drain does, set `continueLoop = true`, and set progress `Turn N · Correcting…` for the operator audience. On `release`, the loop ends and `finalizeAgentRun` completes the agent as today.
- **Cancellation during a hold.** The runner resolves every pending hold with `release` when it cancels a unit, before calling `AgentManager.cancel`, so the loop's existing post-loop cancelled detection runs.
- **Turn budget.** A hold that returns `continue` on the budget's last turn lets the loop hit `++turn > turnBudget.limit` and fail with `failureReason = TURN_BUDGET_EXHAUSTED`. The runner treats that as trigger `agent-failed` (4.3), not as a contract failure.

`AgentOrchestrator.createRunContext` (`agents/orchestrator.ts`, the object built around line 692) passes `contractHooks: this.toolDeps?.contractHooks`. `toolDeps` gains `contractHooks?: ContractAgentHooks` (orchestrator.ts:106 area). The composition root sets it to `runner.hooks()`.

**Records.** `AgentRecord` and `AgentInput` (`tools/agent/manager.ts`) change: `wrfcId` becomes `contractId`, `wrfcRole` becomes `contractRole: 'owner' | 'unit' | 'planner'`, `wrfcSubtaskId` becomes `contractUnitId`, `wrfcPhaseOrder` is removed, `wrfcRouteReason` becomes `routeReason`, `wrfcSubtasks` becomes `proposedUnits`, `dangerously_disable_wrfc` becomes `outsideContract`, and `reviewMode: 'none' | 'wrfc'` becomes `'none' | 'contract'`. The phase runner passes `contractId` and `contractUnitId` into `AgentManager.spawn` from new optional `WorkItemSpec` fields (`contractId`, `contractUnitId`, `route`, `tools`, `restrictTools`, `template`), copied onto `WorkItem`, and uses `WorkItem.task` as the brief unchanged.

**Wake.** `AgentManager.wakeWithSteer(agentId, steer)` (`tools/agent/manager.ts:696`) gains an options argument `{ allowCompleted?: boolean }`. With `allowCompleted` and a record whose `contractUnitId` is set and whose status is `completed`, it wakes the loop exactly as it does for `failed` (transcript-tail `priorSummary` plus the steer as a fresh user turn). The fleet `steer()` path (`runtime/fleet/registry.ts:794`) keeps calling it without options, so operator behaviour does not change.

### 4.2 When checks run (the observable events)

| Trigger | Observed through | What runs | Nudges on |
|---|---|---|---|
| `turn-end` | `ContractAgentHooks.onTurnEnd` for a turn whose tool calls include `write`, `edit` or `exec` (the tool names registered in `tools/write/index.ts:356`, `tools/edit/core.ts:546`, `tools/exec/runtime.ts:939`), when `contract.midRunChecks` is on | evidence without gates and without claims (the agent has not reported yet); judge and quality | regressions, and the quality items marked mid-run (4.5) at act; everything else is recorded only |
| `completion` | `ContractAgentHooks.holdCompletion` | full evidence: diff, claims, gates, output; judge and quality | every outcome except pass |
| `agent-failed` | `AGENT_FAILED` on the runtime bus for the unit's active agent with `failureReason === TURN_BUDGET_EXHAUSTED` or a circuit-breaker error, or after the watchdog kills a silent agent | full evidence; judge and quality | every outcome except pass; delivered by wake |
| `fix-passed` | the unit's planned-fix group passed its group check | full evidence against the unit's own criteria | every outcome except pass; delivered by wake with `allowCompleted` |
| `resume` | `resumeAll` found the unit mid-hold or mid-check | full evidence | as `fix-passed` |
| `owner-amend` | an owner reply with reading amend on a unit escalation | full evidence after the amendment is applied | as `fix-passed` |

At most one check per unit is in flight. A turn end that arrives while a check is in flight sets a `recheckPending` flag; when the check finishes, one more `turn-end` check runs if the flag is set. A `completion` trigger supersedes a pending `turn-end` check (its result is discarded if still running). Checks run under the runner's AbortController for the unit, aborted on cancel.

While a unit's agent is held, the watchdog does not count the time (4.10).

### 4.3 Evidence (`contract/evidence.ts`)

`collectUnitEvidence(contract, unit, trigger)` returns:

```ts
interface UnitEvidence {
  readonly output: string;                // record.fullOutput at completion; the last assistant text mid-run
  readonly changedPaths: readonly string[];
  readonly diff: string;                  // trimmed, see budget
  readonly omitted: readonly string[];    // paths whose diff did not fit
  readonly claims?: ClaimVerificationResult;
  readonly gates?: readonly QualityGateResult[];
  readonly commands: readonly { readonly command: string; readonly success: boolean; readonly head: string }[];
}
```

- **Diff of touched paths.** Worktree mode: `IsolatedWorktree.diff()` (`agents/worktree.ts:486`) for the unit's worktree, which gives `files`, `unifiedDiff` and `stat`. Shared mode: the unit's `baseline` is taken when its agent is spawned (`snapshotDirtyTree(cwd)` from `orchestration/dirty-guard.ts:104` and `AgentWorktree.currentHead()`); changed paths are those whose `hashWorkingTreeFile` differs from the baseline or that are new; the diff is `GitService.diffFile(path, false)` (`git/service.ts:200`) for tracked files and the file's text for new ones. Outside a git repository, changed paths are the `path` arguments of the unit's `write` and `edit` calls seen by `onTurnEnd`, with their current text. `ContractUnit.touchedPaths` is the union of every check's `changedPaths`.
- **Claim verification.** At `completion`, `parseUnitCompletionReport(record.fullOutput)` (moved `parseEngineerCompletionReport`) and `verifyUnitClaims(report, cwd)` (moved `verifyEngineerClaims`, unchanged logic, `cwd` = the unit's worktree or the project root). Its result is evidence for Jev and a deterministic input to the outcome (4.6).
- **Gates.** At `completion`, `agent-failed`, `fix-passed`, `resume` and `owner-amend`, `runContractGates({ configManager, cwd, runtimeBus, contractId, unitId })` runs the enabled `contract.gates` with the moved skip detection and the `contract.gateTimeoutMs` timeout. Gate output is evidence and a deterministic input to the outcome.
- **Agent output and commands.** The final output, and the `exec` commands the agent ran this unit with success and the first 20 lines of output, from the `onTurnEnd` records.
- **Budget.** The Jev request limits are 64k tokens per request and 32k for the state plus the longest question (`LIMITS`, `packages/judgment/src/port/limits.ts`). `trimEvidence` keeps the whole state under 24k estimated tokens by `estimateTokens`: output capped at 12,000 characters (head and tail), gate output at 4,000 characters per gate (tail, where failures print), and the diff filled file by file in order of the unit's `files` list then size, each file capped at 8,000 characters, until the budget is used; the rest are listed in `omitted`. The caps are constants in `evidence.ts`.

### 4.4 The questions

**Per-criterion readings: the judge pattern.** `contract.unit-judge` is `defineJudge` (`packages/judgment/src/patterns/judge.ts`). One request per check with `goal` = the unit's goal, `criteria` = the texts of the unit's judged criteria, `output` = the agent output, `evidence` = `{ changedPaths, diff, omitted, claims, gates, commands }`. The pattern asks, per criterion, "Does `output` fail to meet `criterion`, or does `evidence` fail to show that it meets it?" and once "Does `output` fail to achieve `goal`?", all in the one request.

Band: `{ yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence }` when `contract.acceptanceStakes` is `high` (the default), and `{ yes: medium, no: STAKES_BANDS.critical.confidence }` when it is `critical`. A false pass accepts failing work, so the pass side carries the higher stakes; a false fail costs one nudge. Both bands are declared in `contract/batteries/unit-judge.ts`; the setting only chooses between them (the Jev form of `wrfc.scoreThreshold`).

**Quality: `contract.unit-quality`**, `defineBattery`, asked in parallel with the judge (a second request; the two cannot share one because the judge's questions depend on the criteria). State: `{ goal, brief, changedPaths, diff, commands, output }`.

| Item | Question | Mid-run |
|---|---|---|
| `placeholder` | Does the change leave placeholder, stub, mock or TODO code where the unit requires working behaviour? | no |
| `tests_weakened` | Does the change delete, skip or loosen existing tests or checks rather than make the code pass them? | yes |
| `breaks_existing` | Does the change remove or break existing behaviour that the unit was not asked to change? | yes |
| `out_of_scope` | Does the change edit files or behaviour unrelated to the unit's goal? | yes |
| `hidden_failure` | Does the change swallow errors or hide failures instead of reporting them? | no |
| `unsupported_claims` | Does `output` claim results (tests run, commands passing, files created) that `commands`, `diff` or `changedPaths` do not show? | no |

Band: yes side `STAKES_BANDS.medium.yesNo.yes`, no side `STAKES_BANDS.high.yesNo.no`, one band for all items, declared once in the battery file.

**Severity of unmet criteria: `contract.unmet-severity`**, `defineBattery` with one choice item `severity` (critical: the deliverable cannot be used for its goal while this is unmet; major: the deliverable works but misses a requirement the user stated; minor: a detail that does not change whether the deliverable does what was asked), `STAKES_BANDS.low.confidence`. It runs per unmet criterion, concurrently, after the nudge is sent, so it never delays a nudge. The reading is stored on the `CriterionReading` and shown in events, escalations and nudges from the second one onward (a criterion's latest severity is reused).

### 4.5 Readings to verdicts (code, `contract/check.ts`)

For each criterion, from the judge's `criteria[i]` reading (a yes/no where yes means the criterion fails):

| Judge reading | Criterion verdict |
|---|---|
| verdict yes (leans fails), any outcome | `unmet` |
| verdict no at act | `met` |
| verdict no at confirm or escalate, or verdict none | `unshown` |

The goal reading is folded in the same way into a goal verdict. Quality items: verdict yes at any outcome is a problem; verdict no at act is clean; verdict no below act is `unshown` for that item.

### 4.6 Check outcomes (code)

| Condition, checked in this order | Result | What happens |
|---|---|---|
| Unit cancelled while the check ran | discarded | nothing |
| Trigger `turn-end` | `recorded` or `nudge` | history updated; a nudge only for regressions (4.8) and mid-run quality items at act |
| Any gate failed (not skipped) | `nudge` | kinds include `gate`; the unit cannot pass with a failing gate whatever the readings say |
| Claims kind `unverified`, or `unverifiable_no_claims` with no changed paths for a unit that must write | `nudge` | kinds include `claims`; this is the immediate nudge for a failed claim check |
| Any criterion `unmet`, goal `unmet`, or any quality problem | `nudge` | kinds `unmet`, `quality`, `regression` as applicable |
| Any criterion or goal `unshown`, or any quality item `unshown`, and the unit's consecutive unsettled checks are below `contract.evidenceNudgeLimit` | `nudge` | kind `unshown`: the agent is asked to show evidence (run the command, cite the file and line) |
| The same, at the limit | `await-owner` | escalation `unsettled` (6.3); the owner may approve, since a confirm-level reading means "proceed only after the owner confirms" |
| Every judged criterion `met`, goal `met`, every quality item clean, gates passed, claims verified | `pass` | the hold releases; the unit passes (subject to best-of-N and merge, 6.2 and 7.4) |

Before any `nudge` result is delivered, `contract/progress.ts` decides whether the unit has stalled (4.8); a stalled unit gets result `stall` instead and its hold is released only when correction takes over (5.1).

A `pass` is the only way a unit reaches `passed`. Nothing else, including the owner, can mark a unit passed while a criterion reads `unmet`: the owner can approve `unshown` readings, amend criteria, or cancel.

### 4.7 The nudge message (`contract/nudge.ts`)

`buildNudge(unit, check, history)` builds plain text in code. Order and wording are fixed in the file so they are reviewable in one place:

```
Contract check {n} on "{unit title}": the work does not pass yet. Fix what is listed, then finish your turn; it will be checked again.

Not met:
- [{id}] {criterion text}{ " (" + severity + ")" when known }
Regressed (these were met at check {k} and are not met now; restore them without undoing other fixes):
- [{id}] {criterion text}
Not shown (show evidence that these are met: run the command that proves it, or cite the file and line):
- [{id}] {criterion text}
Goal: {only when the goal reads unmet} The work as a whole does not yet do what the unit is for: {unit goal}
Quality problems:
- {fixed sentence per quality item, e.g. "Placeholder or stub code remains where working behaviour is required."}
Gate failures:
- {gate}: {last 40 lines of its output}
Claims not found on disk:
- {path} (claimed as created or modified; not present)

Already met (binding: do not break these):
- [{id}] {criterion text}
```

Empty sections are left out. The met list restates every criterion whose latest verdict is `met`, which is the Jev form of the fixer constraint addendum: corrections never silently break what works, and a correction that does break one is caught by the regression rule. Criteria belong to the contract, not to the sub-agent's report, so nothing the agent writes can alter them.

**Delivery.**

| Situation | Path |
|---|---|
| The agent is held at its completion point | the hold returns `{ kind: 'continue', message, nudgeId }`; the text is added as a user turn before the next model call |
| The agent is running (a `turn-end` nudge) | `messageBus.send('contract-runner', agentId, text, { kind: 'steer', ttlMs: contract.nudgeTtlMs, id: nudgeId })` (`agents/message-bus-core.ts`); the per-turn drain in `orchestrator-runner.ts` injects it verbatim as a user turn and emits the consumed signal after that turn's model call succeeds |
| The agent has stopped: `failed` (turn budget, circuit breaker) | `agentManager.wakeWithSteer(agentId, text)` |
| The agent has `completed` (after a fix group, on resume, after an owner amendment) | `agentManager.wakeWithSteer(agentId, text, { allowCompleted: true })` |
| The agent record is gone (process restart) | a new agent is spawned for the unit with the brief plus a "Previous checks" section listing the latest verdicts; the nudge text is its first user turn after the brief |

The runner registers itself on the message bus at construction as `{ agentId: 'contract-runner', role: 'orchestrator' }` through `registerAgent`, so `evaluateCommunicationRoute` (`agents/communication-policy.ts`) allows it to steer any agent. The doc comment on `CommunicationKind` `'steer'` (`events/communication.ts`) is extended to say the contract runner also uses it for nudges. `COMMUNICATION` consumed events for a nudge id set `Nudge.consumedAt` and emit `CONTRACT_NUDGE_CONSUMED`.

### 4.8 Regression and stall detection (`contract/progress.ts`, code only)

- **Regression.** A criterion whose previous verdict was `met` at act and whose new verdict is `unmet` has regressed. A regression is always a nudge, including mid-run, and emits `CONTRACT_CRITERION_REGRESSED`. This replaces `emitWrfcScoreRegression`.
- **Progress.** A check made progress when the set of criteria reading `met` is a strict superset of the previous check's, or the number of failing gates fell, or the number of quality problems fell, or a claims failure cleared. A check with none of these is a non-progress check.
- **Stall.** A unit has stalled when it has `contract.stallLimit` consecutive non-progress checks at triggers other than `turn-end`, or when the same criterion has regressed twice, or when its nudge count reaches `contract.maxNudgesPerUnit`.

### 4.9 Transport failures (`contract/runner.ts`)

The phase runner keeps its bounded respawn for spawn-time failures (`orchestration/phase-runner.ts:463-470`), with its test changed from `isTransportFailureMessage` to `readFailure({ message }, 'orchestration.phase-runner.transport-retry')` from `packages/engine/errors/src/failure-reading.ts`, retrying when `transientNetwork || beforeResponse`.

For a unit agent that fails mid-run (`AGENT_FAILED` without a turn-budget or circuit-breaker reason), the runner reads the error with `readFailure({ message: error }, 'contract.transport-retry')`. When `transientNetwork` or `beforeResponse` holds and `unit.transportRetries < contract.transportRetryLimit`, the runner waits `contract.transportRetryDelayMs`, then requeues the work item (`engine.requeueItem(unitId, reason)`) so the phase runner spawns a fresh agent with the same brief plus the "Previous checks" section; the retry is a `transport-retry` decision and does not count toward stalls or fix rounds. Otherwise the unit fails, and the contract fails with `failureKind: 'transport'` (network) or `'other'`. A provider that cannot serve is the failover chain's job before the error ever reaches the runner.

### 4.10 Watchdog (`contract/watchdog.ts`)

The runner subscribes to `AGENT_RUNNING`, `AGENT_PROGRESS`, `AGENT_STREAM_DELTA`, `AGENT_COMPLETED`, `AGENT_FAILED` and `AGENT_CANCELLED` and keeps a last-seen time per unit agent, as `setupListeners` and `tickWatchdog` (`agents/wrfc-controller.ts:629-733`) did. When `contract.heartbeatTimeoutMs` is above zero, a timer at a quarter of the timeout (between 50 ms and 5 s) finds unit agents that are running, not held, and silent past the timeout. The first time, the runner emits `CONTRACT_UNIT_SILENT`, cancels the agent with `AgentManager.cancel(id, 'kill')`, and requeues the item (a `silence-retry` decision). The second time for the same unit, the unit fails and the contract fails with `failureKind: 'other'` and the reason "unit {id} went silent twice".

## 5. Correction when nudging stalls (`contract/correction.ts`)

### 5.1 Routing a stall

On `stall`, the runner reads `contract.stall-route` (`defineBattery`, one choice item `route`, `STAKES_BANDS.medium.confidence`) about the state `{ unit: {goal, criteria}, unmet: [...], lastNudges: [last 3 texts], checks: [verdict summaries] }`:

| Option | Description given to Jev | Action |
|---|---|---|
| `split` | The remaining problems are large or span several parts, and would be handled better as smaller separate pieces of work | a planned-fix group (5.2) |
| `fresh` | The agent is stuck in one approach and a new attempt with a clean start could succeed | cancel the agent, spawn a new one for the unit with `routeSelector({ purpose: 'fresh-unit' })`, brief plus "Previous checks"; `unit.freshAgents += 1` |
| `owner` | The remaining problems need a decision, access or information only the owner can give, or the unit's criteria conflict | escalation `stalled` |

Code rules around the reading: when `unit.fixRounds + unit.freshAgents >= contract.maxFixRounds`, the route is `owner` without asking (escalation reason `fix-rounds-exhausted`). A route read below act goes to `owner`. A merge conflict on the unit's branch (7.4) is routed to `split` without asking, with the conflicting files named.

### 5.2 Planned-fix groups

A planned-fix group is ordinary contract structure: the planner receives the target (a unit, a group or the deliverable), the unmet and unshown criteria with their latest readings and severities, the last evidence (trimmed) and the last nudges, and returns a fix plan in the same schema with one group of kind `fix`. Its units' criteria have origin `fix` and a `serves` list naming the target's criteria. Code checks: every unmet target criterion is served by at least one fix-unit criterion; ids are fresh (`<target>.f<round>.u<n>`). The Jev plan checks for units (role, scope) run on the fix units; trace and coverage are not re-asked (fix criteria trace to plan criteria, which already trace to the user).

The group runs as its own workstream through the same engine, with the elastic pool (`releasePolicy: 'reviewed-and-merged'`), so edges release only on merge. Its units run the same nudge loop. When the group passes its group check, the target is checked again (trigger `fix-passed`) against its own criteria. If that check passes, the target passes; if not, the stall rules apply again with `fixRounds` incremented. This replaces `startPlannedFix`, `startCompoundSubtaskFix`, `planFixWorkstream`, `parseReviewIntoTasks` and `createFixWorkstreamRunner`. `planTaskGraph`, `clusterOf` and `ELASTIC_PHASE_CAPACITY` stay in the orchestration module (moved from `review-task-source.ts` to `orchestration/task-graph.ts`) and are used to add shared-file serialization edges between fix units.

Points resolved when this was built (R.6):

- **The stall-route state** also carries `lastOutput`, the head and tail of the agent's last report, since that is where an agent says what blocks it (a missing credential, criteria that conflict). The battery's fixtures cover each route.
- **A unit's fix in worktree mode.** The fix units work on the contract branch, so before its fix group starts, the unit's own item settles as completed: its work is committed on its branch and merged into the contract branch. The fix group then builds on it, and the unit's re-check reads the contract branch, limited to the files the unit and its fixes touched (`UnitRuntime.evidencePaths`), with the unit's report followed by the fix units' answers as its output. Once a unit's item has closed this way no agent of its own can take a nudge, so a re-check that does not pass goes to correction again; a `fresh` route for such a unit is a one-unit fix group built in code from the unit's own brief and criteria (`buildFreshGroup`). In shared mode the unit's item stays in its phase and its agent is woken as 4.2 says.
- **A fix group for a unit** runs inside the unit's group, which in shared mode already holds the shared-tree lock, so it does not take the lock again. Fix units that change the same file are serialized most severe first (`orchestration/task-graph.ts`).
- **Groups and the deliverable** have no agent of their own: their first failed check becomes a planned fix; when their checks stop making progress (the same rules as 4.8, over their checks) `contract.stall-route` is read, and a `fresh` reading is a new planned fix. A merge conflict routes to a planned fix without a reading, and the conflicting branch and files go to the fix planner.
- **Session mode** cannot delegate, so a planned fix or a fresh agent is not possible: stalls and failed group or deliverable checks go to the owner, with a line saying why.

## 6. Groups, the deliverable, and finishing

### 6.1 Running units

- One orchestration engine per contract (7.4). Each group is one workstream created with `groupWorkstreamInput(contract, group)`: `phases: unitPhases()` (one phase, `{ role: 'engineer', kind: 'engineer', capacity, gate: { scope, gates: [] } }`, where `scope` is `'all'` in worktree mode, so a passing unit's item worktree is committed onto its item branch for the integration lane to merge, and `'off'` in shared mode, where the contract commits its touched paths when the deliverable passes), one item per unit with `dependsOn` from the plan, `task` = `buildUnitBrief(...)`, the unit's template (`engineer` for implement, `integrator` for integration, `researcher` for research, `general` read-only for design), tools, route and contract binding, `attempts`, `files`, `budget`. Workstream `isolation` is the contract's; `releasePolicy` is `'reviewed-and-merged'` so every group is elastic and bounded by `fleetCapacity`.
- A group starts (`engine.start(groupId)`) when every group it depends on has passed its group check. Units inside it are scheduled by the engine's dependency gate, budget check and capacity (`computeClaims`, `applyDependencyGates`, `checkBudget`, `gateClaimAgainstFleet`).
- Before each unit agent is spawned, the runner awaits `routeSelector({ purpose: 'unit', ... })` and stores the route; it is passed through the work item (phase runner reads `WorkItem.route`).
- **Shared mode** sets phase capacity to 1 and takes a per-project-root lock in the runner (one running unit per shared working tree across all contracts in the process), so the shared-tree diff baseline is attributable to one unit and gates never see another unit's half-finished edits. This replaces the cross-chain gate batching of `checkAndRunGatesForAll` (`agents/wrfc-controller.ts:1405`).
- The phase runner's own `evaluateGate` (`orchestration/phase-runner.ts:228`) no longer runs gates or claim verification for contract work items (the hold already did both and a unit cannot complete without them), and its reviewer-verdict branch is deleted.

**Unit brief (`buildUnitBrief`).** Sections, in order: the contract goal; this unit's goal and brief; "Acceptance criteria for this unit" (id and text of every judged criterion, with the contract criteria each serves); the group's goal and the titles and goals of sibling units and of units this one depends on (so parts stay compatible with the whole); for an integration unit, every other unit's answer; the tool contract (read-only or not); and one fixed paragraph: "Your work is checked against these criteria while you work and when you finish. If a check finds a problem you will receive a correction; fix it and finish again." The brief contains no instruction to enumerate constraints or self-review; Jev reads the criteria continuously.

### 6.2 Best-of-N (`contract/best-of-n.ts`)

A unit with `attempts > 1` is expanded by the engine's attempts coordinator (`orchestration/attempts.ts`) into siblings with `autoAcceptWinner: false`. Each sibling runs the full nudge loop and parks in `held-merge` only after passing. When the engine emits `attempts-ready`, the runner reads `contract.best-of-n`, a `defineSelector` (`packages/judgment/src/patterns/select.ts`): context = the unit's goal and criteria; candidates = each held sibling, id = its item id, content = `{ stat, diff (trimmed so that all candidates share the evidence budget), answer }`; `instructions` = "Which candidate best achieves the unit's goal and criteria?"; `fitInstructions` = "Does this candidate meet every criterion of the unit, with no defect that another candidate avoids?"; `band` = `STAKES_BANDS.high.confidence`, `fitBand` = `STAKES_BANDS.high.yesNo`.

| Selection | Action |
|---|---|
| a chosen candidate at act | `engine.pickAttemptWinner(groupId, chosen)`; the unit passes with that sibling's work; `CONTRACT_ATTEMPTS_SELECTED` |
| a chosen candidate at confirm | escalation `attempts-undecided` naming the proposed winner; approve picks it, amend lets the owner name one |
| none, or escalate | escalation `attempts-undecided` with every candidate |
| failed siblings | never candidates |

The engine's `judgeAttempts` dependency is `createSelectAttemptJudge(selector)`, which wraps the same selector into an `AttemptJudge` for the operator verb `fleet.attempts.judge`, returning the chosen id (or null) and reasons built in code from the readings ("chosen u1#a1 with confidence 0.91 (act); fits: u1#a0 no 0.20, u1#a1 yes 0.93").

Points resolved when this was built (R.7):

- **Attempt units.** When a group starts in worktree mode, a unit with `attempts > 1` gets `attemptUnits`: one `ContractUnit` per sibling, with the engine's sibling ids (`<unitId>#a<n>`, `attemptItemId` in `orchestration/attempts.ts`), `attemptOf` and `attemptIndex`, the unit's goal, brief and files, and its criteria unread under ids `<unitId>#a<n>.c<k>`. Each attempt's route is the route selector's own pick for that attempt (a request with `purpose: 'unit'` and the attempt unit), handed to its sibling item through the work item spec's `attemptRoutes`. The attempts coordinator gives a contract sibling's work item its own `contractUnitId`, so each attempt's agent is held, checked, nudged, retried and watched as its own unit. Attempt units live under their plan unit, not in `contract.units`, so group, deliverable, answer and plan-sync code reads plan units only; `ContractRun.allUnits()` and `ContractRun.unit(id)` include them. The plan unit runs no agent; its `agentIds` hold its attempts' agents, so group and contract usage count each once.
- **Failures.** A failed attempt fails alone (`failUnit` does not fail the contract for an attempt unit) and is never a candidate. When every attempt failed, the plan unit fails, and the contract with it, naming each attempt's reason.
- **Selection.** On `attempts-ready`, the plan unit moves to `checking` and the selection is read over the attempts both held by the engine and `held-merge` in the tree. Each candidate gets an equal share of `EVIDENCE_TOKEN_BUDGET`: answers head and tail at 4 000 characters (halved further when needed), then the diff filled file by file (the unit's files first), the rest listed in `omitted`. The reading is recorded on the plan unit as `attemptSelection` (candidates, proposed attempt, outcome, reasons, decision id) with `CONTRACT_ATTEMPTS_SELECTED`.
- **Taking an attempt.** `acceptAttempt(run, unitId, attemptId, reason)` (used at act, and by the owner-reply step for approve or a named attempt) checks the attempt is a candidate, copies its criteria readings, answer and changed paths onto the plan unit, moves the plan unit to `held-merge` (a new move from `awaiting-owner` allows the owner path), marks the other passing attempts `passed` as not selected, records `attempts-selected`, and calls `engine.pickAttemptWinner`. The plan unit passes when the taken attempt merged into the contract branch; a merge conflict on it is reported for the plan unit.
- **Undecided.** Confirm, none and escalate call the R.6 step `attemptsUndecided(run, unitId, selection)`, which opens the `attempts-undecided` escalation (6.3).
- **The operator's judge.** A contract's engine gets `createContractAttemptJudge(run)` (context = the attempts' plan unit, answers from the attempt units, usage into the contract's judgment usage); other engines get `createSelectAttemptJudge()` with the item's task as the goal. The judge proposes a winner only at act, so an engine item that opted into `autoAcceptWinner` never takes a winner Jev did not act on.
- **Shared mode.** The engine runs siblings only in worktrees, so in a shared working tree the unit runs once and the runner records the decision `attempts-reduced` saying so.

### 6.3 Owner escalation (`contract/escalation.ts`)

An escalation sets the target (unit, group or contract) and the contract to `awaiting-owner`, releases any hold, and emits `CONTRACT_ESCALATED`. Its question is built in code:

```
Contract {id} needs your decision on {unit/group/deliverable/plan} "{title}".
{Reason sentence, fixed per reason code.}
Still not met:
- [{id}] {text} ({severity})
Not shown:
- [{id}] {text}
Reply to approve {what approval does for this reason}, to change what is required (say how), or to stop the contract.
```

The owner's reply arrives through `ContractRunner.reply` (from the CLI, the `contracts.reply` operator method, or the conversation: intake routes a message sent in a session with an open escalation to `reply`). It is read with `contract.owner-reply`, a `defineReplyReader` (`packages/judgment/src/patterns/reply.ts`) with the default readings and a `perOption.approve` band at `STAKES_BANDS.high.confidence`, the rest at `medium`. The proposal the reply is read against is the escalation's question and reason.

| Reading at act | Action |
|---|---|
| approve | `unsettled`: the unshown readings are accepted as met by owner confirmation, recorded as such (`Criterion.status = 'met'`, decision `owner-replied`), and the unit passes. `plan-unresolved`: the plan is accepted. `attempts-undecided`: the proposed winner is picked. `stalled` and `fix-rounds-exhausted`: approval of work with unmet criteria is not possible; the runner replies with the escalation question again, stating that unmet criteria need either a change to what is required or a stop |
| amend | the reply text goes to the planner as an owner instruction for the target: it may reword or drop criteria (origin `owner`, trace not re-asked since the owner said it) and rewrite the brief. The target is checked again (trigger `owner-amend`) and the loop continues |
| reject | the contract is cancelled with reason "stopped by the owner" and `failureKind: 'owner-rejected'` recorded on the cancelled contract |
| unclear, or any reading below act | the question is asked again with one fixed line: "I could not tell whether that approves, changes or stops the work." |

### 6.4 Group and deliverable judging, integration units (`contract/completion.ts`)

- **Group check.** When every unit of a group has passed (and, in worktree mode, merged into the contract branch), the group is checked with `contract.group-judge` (`defineJudge`, same bands as the unit judge): goal = group goal, criteria = group criteria (when a group has none, the check is skipped and the group passes), output = the units' answers, evidence = the group's diff against the contract branch point where the group started, gate results run in the contract worktree, and the unit verdict summaries. Pass at act passes the group. Anything else becomes a planned-fix group for the group (5.2), then a re-check; the stall and fix-round rules apply to the group.
- **Integration units** are ordinary units in the final `integration` group, with the integration role, template `integrator`, and criteria about the parts fitting together plus serving the contract criteria. Their answer is the deliverable's answer.
- **Deliverable check.** When every group has passed, the contract goes to `judging` and is checked with `contract.deliverable-judge` (`defineJudge`, same bands): goal = contract goal, criteria = the judged contract criteria (excluded and met-by-structure ones are left out and reported), output = the answer, evidence = the contract diff (trimmed), gates in the contract worktree, per-criterion summaries of the unit readings that serve each contract criterion. Pass at act moves the contract to `committing`. Anything else becomes a deliverable-level planned-fix group (contract status `fixing`), then a re-check.

### 6.5 Scoped commit, answer versus status, cancel

**Owner record.** Every contract has an owner `AgentRecord` spawned by the runner through `AgentManager.spawn` with `contractRole: 'owner'`, `template: 'orchestrator'`, `outsideContract: true`, and no executor run (the path `tools/agent/manager.ts:633-663` takes for a WRFC owner today, rewritten for contracts). Parents and surfaces wait on it exactly as they waited on a WRFC owner: its `status`, `fullOutput`, `AGENT_COMPLETED` and `AGENT_FAILED` are the contract's. The runner keeps it `running` until the contract is terminal and ignores premature completion or failure events for it, as `keepOwnerAgentActive` did.

**Scoped commit.** In worktree mode the contract's work already sits on the contract branch, holding only the units' changes. When the deliverable passes:

| Settings | Action |
|---|---|
| `contract.autoCommit` on, `commitScope` `scoped` or `all` | `GitService.merge` (`git/service.ts:353`) of the contract branch into the project root's current branch with a no-fast-forward merge and the message from `buildContractCommitMessage` (goal, criteria met with ids, gates passed, units and their titles, excluded criteria) |
| `autoCommit` off, or `commitScope` `off` | the contract branch's changes are applied to the project root without committing (a squash merge followed by unstaging exactly the changed paths), which leaves the work as uncommitted changes, as WRFC did |

In shared mode, `autoCommit` with `scoped` commits exactly `touchedPaths` minus untouched launch residue (`excludeUntouchedLaunchResidue`, `orchestration/dirty-guard.ts:136`) with `AgentWorktree.commitWorkingTree(message, paths)`; `all` calls it without paths; `off` leaves the tree as is. Outside git, the commit is skipped with the note "commit skipped: not a git repository".

A commit or apply failure is a warning on a passing contract, never a failure: the contract still passes, `Contract.commit` records the failure, the contract branch and worktree are kept, and the status line says so. `describeCommitOutcome` (moved unchanged) words it.

**Answer and status.** `renderContractAnswer(contract, getStatus)` returns the integration unit's answer for a multi-unit contract, otherwise the single unit's; a structured completion report is reduced to its `summary` with `parseCompletionReport`, as `renderWrfcChainAnswer` did. The owner record's `fullOutput` is the answer (or `CONTRACT_PASSED_WITHOUT_OUTPUT`, "The work is finished. Every acceptance criterion was checked and met." when there is none). The status line goes to `record.progress` with audience `operator` only (`setAgentProgress(owner, statusLine, 'operator')`) and to `Contract.statusLine`: `Contract {id} passed ({met} of {judged} criteria met, {nudges} corrections{, n excluded}); {commit note}` from `describeContractOutcome`. Channel delivery forwards only the answer, as today.

**Cancel.** `cancel(contractId, reason)` releases holds, cancels every running unit agent and the planner (`engine.kill` for work items, `AgentManager.cancel` for the planner), marks running units and groups `cancelled`, and ends the contract `cancelled` everywhere: owner record status `cancelled` (not failed), `CONTRACT_CANCELLED` with `filesModified` = the count of distinct `touchedPaths` across units, and the status line `Contract {id} cancelled; {n} files already modified {on disk | on branch contract/<short>}`. A `AGENT_CANCELLED` for any unit agent that the runner did not cause cancels the whole contract the same way (an operator kill of a member is an intended stop), as `onAgentCancelled` did.

**Work-plan and execution-plan sync (`contract/plan-sync.ts`).** Each contract gets a project work-plan task `contract-{contractId}` and each unit a child task `contract-{contractId}-{unitId}` through `workPlanService.createWorkPlanTask` or `updateWorkPlanTask` (`knowledge/project-planning/service.ts:361,393`), serialized per task id by a promise queue as `enqueueWrfcWorkPlanTaskOperation` did. Status mapping: pending and blocked to `pending`; running, checking, held, nudged and fixing to `in_progress`; awaiting-owner to `blocked`; passed to `done`; failed to `failed`; cancelled to `cancelled`. `source` is `'contract'` and the correlation field is `contractId` (renamed from `chainId` in `knowledge/project-planning/types.ts` and the `projectPlanning.workPlan.*` schemas). `completePlanItemsForUnit(agentIds, planManager)` marks active execution-plan items whose `agentId` is one of the unit's agents `complete` when the unit passes (not when its agent completes). The composition root wires `planManager` (the WRFC `setPlanManager` was never called).

### 6.6 Session mode (delegation forbidden)

When the request shape says the user forbids delegation, the contract has one group with one unit whose executor is the session's own conversation loop instead of a sub-agent. The core turn loop gets the same completion hold: at the two `emitTurnCompleted` sites in `core/orchestrator-turn-helpers.ts` (lines 239 and 284), when the turn belongs to a session-mode contract, the loop awaits `contractHooks.holdCompletion` for the session's pseudo-record (`contractUnitId` set, `id` = the turn id) and on `continue` appends the nudge as a user message and runs another model call in the same turn. Evidence, checks, nudges and all rules are identical. No sub-agent is spawned at any point.

Points resolved when this was built (R.6):

- **Steps.** The runner builds its correction and completion steps itself (`createContractSteps`), so every host gets working steps; `ContractRunnerDeps.steps` only lets a host take over individual steps.
- **Group and deliverable checks** are recorded as `UnitCheck`s with no quality items (`UnitCheck.quality` is partial) and result `stall` when the check is handed to correction. Their diff is measured from a baseline taken when the group started (`ContractGroup.baseline`) or when the contract's groups started (`Contract.baseline`), limited to the files their units and fixes touched, since groups that do not depend on each other run side by side.
- **The commit** in worktree mode removes the contract worktree after a commit or apply and keeps the `contract/<short>` branch as the record of the work; a failed merge is aborted and the branch and worktree stay. A shared-mode commit excludes files that were dirty at launch and were not touched (`Contract.baseline.dirty`).
- **The answer** is the deliverable unit's recorded answer (`ContractUnit.answer`, set when the unit passes), so it survives the agent record.
- **Owner replies.** The contract returns to the status it left for the owner once its last open escalation is answered. An amendment is planned by the planning model as a JSON answer (`contract/amendment.ts`); reworded or added criteria get ids `<target>.o<n>` (`o<n>` for the deliverable) and origin `owner`, and the target's fix rounds and fresh agents start again from zero, since what is required changed. A `writing-unclear` amend is read with the request-shape battery's `forbids_writing` question over the reply (R.4's `withOwnerWritingDecision` records it). An `attempts-undecided` amend takes the attempt the reply asks for, by id, by position or by what it did, read with `contract.owner-pick` (the selector pattern over the candidates, `STAKES_BANDS.high`, with fixtures, registered beside `contract.owner-reply`); a reading below act, or a reply that asks for none of them, asks which attempt to take. A reply to an escalation that is no longer open is refused.
- **Work-plan sync** writes the contract id in the work plan's existing correlation field (`chainId`), which the wire rename to `contractId` in 11.3 takes over with the regenerated schemas.
- **Session mode.** A session-mode contract settles to shared isolation with no contract branch once shaped. The runner binds a session's turn to the unit through `ContractSessionHooks.sessionTurn` (a stand-in record whose id is the turn id), the core turn loop reports each tool round, drains mid-run nudges before its next model call (`takeSessionNudge`), and holds at both completion points; `OrchestratorCoreServices.contractHooks` carries the hooks to the Orchestrator.

## 7. Persistence, resume and execution machinery

### 7.1 `ContractStore` (`contract/store.ts`)

Modeled on `orchestration/persistence.ts`: one file per contract at `<projectRoot>/.goodvibes/contracts/<contractId>.json` containing `{ schemaVersion, writtenAt, contract }`; atomic write through a temp file and rename; a corrupt or future-version file is quarantined to `<path>.unrecognized`; a 250 ms debounced writer triggered by every contract event; terminal contracts reaped after 14 days or beyond 50 files; quarantine files after 30 days or beyond 20. `CURRENT_CONTRACT_SCHEMA_VERSION = 1`; `deserializeContract` refuses a newer version.

`importContract(json, force = false)` refuses to overwrite a non-terminal contract unless forced, then inserts before any reaping so event consumers can resolve it, as `importChain` did.

**Sessions gain the contract tree.** `SessionManager.save` (`sessions/manager.ts:225`) writes one `{ type: 'contract', contract }` line per contract started in the session after the agent records, and `load` returns them as `contracts`; `CURRENT_SESSION_SCHEMA_VERSION` becomes 2 and version 1 files load with an empty list. `HostedSessionRecord` (`hosted-sessions/types.ts:64`) gains `contractIds: string[]`; `PersistedHostedSession` becomes version 2 with the same rule.

### 7.2 Resume and zombie reaping (`contract/resume.ts`)

`resumeAll()` at startup: lists `.goodvibes/contracts/*.json`, imports each non-terminal contract, and for each:

1. **Zombie test.** A contract is a zombie when a group it marks `running` or `fixing` has no loadable workstream snapshot (`loadWorkstreamSnapshot` returns nothing or quarantines it), or when in worktree mode its contract worktree path no longer exists. A zombie is marked `failed` with `failureKind: 'zombie'` and the reason naming what is missing, and emits `CONTRACT_STATUS_CHANGED` and `CONTRACT_FAILED` with `membersSettled: true`. This is `reapZombieChain` for contracts.
2. **Resume.** Otherwise the contract's engine is created and `engine.resumeAllFromDisk()` reloads its workstreams. Work items persisted `in-phase` are requeued by the engine (`item-requeued`), so their units get fresh agents with the brief plus "Previous checks". A unit that was `held`, `checking` or `nudged` resumes with trigger `resume`. A contract in `shaping`, `planning` or `checking-plan` restarts planning from the beginning. `awaiting-owner` stays waiting with its escalation. `judging` and `committing` re-run those steps. The active-contract cap applies; excess contracts are queued.

### 7.3 Concurrency cap and queue

`contract.maxActiveContracts` (default 6, the old `MAX_ACTIVE_CHAINS`) bounds contracts past `queued`. Further contracts wait in a FIFO queue (status `queued`, `CONTRACT_STATUS_CHANGED`), and the oldest is dequeued whenever a contract becomes terminal. A contract in `awaiting-owner` keeps its slot, since its work resumes at any reply. Units across all contracts are bounded by the fleet ceiling through the elastic pool (`gateClaimAgainstFleet` with `fleetCapacity`), and within a contract by phase capacity (`contract.maxParallelUnits`, default the `ELASTIC_PHASE_CAPACITY` of 64, or 1 in shared mode). Budget ceilings (`BudgetCeiling`) and `checkBudget` are the engine's, unchanged: money and token arithmetic stay code. A unit blocked on budget shows `blocked` with the engine's reason.

### 7.4 Worktree isolation and the contract branch

`contract.isolation` is `auto` (default), `worktree` or `shared`. `auto` picks `worktree` when the project root is a git repository with at least one commit, otherwise `shared`.

In worktree mode, the runner creates a contract worktree at `<projectRoot>/.goodvibes/.worktrees/contract/<short>` on branch `contract/<short>` from the current HEAD, recording `baseBranch`. The contract's orchestration engine is created with `projectRoot` = that worktree path, so every unit's item worktree (`ws/<wsShort>/<itemShort>`, `orchestration/worktree-isolation.ts`) branches from and integrates into the contract branch through the engine's sequential integration lane. The engine gains two dependencies, `stateRoot` (default `projectRoot`) and `stateNamespace`, used by `attachDebouncedWriter` and the snapshot functions, so workstream snapshots stay in the real project rather than inside the contract worktree, at `<projectRoot>/.goodvibes/orchestration/<contractId>/`: every contract names its groups `g1`, `g2`..., so without the namespace two contracts' `g1` snapshots would share one file and each engine's `resumeAllFromDisk` would load the other's.

A passing unit waits in `held-merge` until its branch merged into the contract branch, and only then moves to `passed`.

A merge conflict when a unit's branch integrates keeps the item's worktree and branch (engine behaviour), emits `CONTRACT_MERGE_CONFLICT`, and routes the unit to a planned-fix group (5.1). Dirty worktrees of failed or cancelled units are kept (engine behaviour). The contract worktree is removed after a successful commit or apply, and kept on any failure or cancel.

### 7.5 What of the orchestration module is reused

| Kept as is | Changed | Removed (WRFC-specific) |
|---|---|---|
| `engine.ts` scheduling, persistence, resume, kill, retry, dependency and budget gates, elastic pool, attempts, integration lane, orphan reconciliation; `scheduler.ts`, `budget.ts`, `elastic-pool.ts`, `dependency-gate.ts`, `graph-dynamics.ts`, `cancellation.ts`, `dirty-guard.ts`, `bookkeeping.ts`, `worktree-isolation.ts`, `attempts.ts`, `persistence.ts`, `workstream-attempts-validation.ts`, `workstream-draft-*.ts` | `engine.ts`: `stateRoot` and `stateNamespace` dependencies; `requeueItem(itemId, reason, task?)` hands the next agent a revised brief; an `item-agent-spawned` event dispatched synchronously after each spawn; the `contractUnitSettlement` dependency: a contract item's phase waits on the runner's settlement of its agent, not on the agent's terminal event, so a turn-budget stop can be woken, a transport failure requeued, and a failed agent whose work passes can still pass; the review-failure path that inserts a fix phase (`findOrInsertFixPhase`, the `phase.kind === 'review'` branch around line 517, `maxPhaseVisits`) is removed. `phase-runner.ts`: reviewer-verdict gate removed, gates and claims not re-run for contract items, spawn passes route, tools, template and contract binding from the work item, transport test through `readFailure`, imports moved to `contract/claims.ts`, `contract/gates.ts`, `contract/config.ts`. `types.ts`: `PhaseKind` loses `review` and `fix`; `PhaseRole` no longer references `WrfcAgentRole`; `PhaseGateSpec.scope` uses `ContractCommitScope`; `WorkItemSpec` and `WorkItem` gain the contract fields. `scheduler.ts`: `reviewPhaseBefore` removed. `proposal-workstream.ts` and `workstream-services.ts`: launch through the runner (section 10.4). `review-task-source.ts` becomes `task-graph.ts` with `planTaskGraph`, `clusterOf`, `ELASTIC_PHASE_CAPACITY` | `controller-compat.ts` (`engineerReviewPhases`, `fromChainSpec`), `fix-workstream-runner.ts`, `judge.ts` (`createProviderBackedAttemptJudge`, `parseAttemptVerdict`), and `parseReviewIntoTasks`, `planFixWorkstream` |

## 8. Events, fleet and the external seam

### 8.1 The contract event domain

The runtime domains `workflows` and `orchestration` are replaced by one domain, `contracts`. Changes: `RUNTIME_EVENT_DOMAINS` in `packages/engine/contracts/src/generated/runtime-event-domains.ts` (via its generator), `DomainEventMap` and `AnyRuntimeEvent` in `events/domain-map.ts`, the event stream `runtime.contracts` in `control-plane/method-catalog-events.ts` (replacing `runtime.orchestration` and `runtime.workflows`), `events/index.ts` re-exports, and validators for every `CONTRACT_*` type in `events/contracts.ts` `EVENT_VALIDATORS`. `events/workflows.ts` and `events/orchestration.ts` are deleted; `events/contract.ts` defines the union; `runtime/emitters/contract.ts` has one `emitContract*` helper per type, re-exported from `runtime/emitters/index.ts`, replacing `runtime/emitters/workflows.ts` and `runtime/emitters/orchestration.ts`. `contract/events.ts` wraps them with the context `{ sessionId, traceId: '<sessionId>:contract:<contractId>', source: 'contract-runner' }`.

| Event type | Payload |
|---|---|
| `CONTRACT_CREATED` | contractId, sessionId, origin, ask, ownerAgentId |
| `CONTRACT_STATUS_CHANGED` | contractId, from, to |
| `CONTRACT_SHAPED` | contractId, forbidsDelegation, requestsParallelAgents, forbidsWriting, asksForAttempts, decisionIds |
| `CONTRACT_PLANNED` | contractId, goal, criteria: CriterionView[], groups: { id, title, kind, dependsOn, unitIds }[], units: { id, groupId, title, role, dependsOn, attempts }[], repair: number |
| `CONTRACT_PLAN_CHECKED` | contractId, check ('structure', 'criterion-trace', 'plan-coverage', 'criterion-shape', 'unit-shape'), targetId?, passed, problems: { code, targetId?, message }[], decisionIds |
| `CONTRACT_GROUP_STATUS_CHANGED` | contractId, groupId, from, to |
| `CONTRACT_UNIT_STATUS_CHANGED` | contractId, groupId, unitId, from, to, agentId? |
| `CONTRACT_UNIT_SPAWNED` | contractId, unitId, agentId, route: { model, provider, reasoningEffort?, reason }, purpose ('unit', 'fresh-unit', 'transport-retry', 'silence-retry', 'resume') |
| `CONTRACT_CHECKED` | contractId, scope ('unit', 'group', 'deliverable'), targetId, checkId, trigger, result, criteria: { criterionId, verdict, probabilityUnmet, outcome }[], goal: { verdict, outcome }, quality: { item, verdict, outcome }[], gates: { gate, passed, skipped }[], claims?: kind, decisionIds |
| `CONTRACT_NUDGED` | contractId, unitId, nudgeId, checkId, kinds, criterionIds, delivery, agentId |
| `CONTRACT_NUDGE_CONSUMED` | contractId, unitId, nudgeId, agentId, turn? |
| `CONTRACT_CRITERION_REGRESSED` | contractId, unitId, criterionId, metAtCheckId, checkId |
| `CONTRACT_STALLED` | contractId, scope, targetId, route ('split', 'fresh', 'owner'), unmetCriterionIds, reason, decisionId? |
| `CONTRACT_FIX_PLANNED` | contractId, scope, targetId, groupId, unitIds, round |
| `CONTRACT_ESCALATED` | contractId, escalationId, scope, targetId, reason, question, unmetCriterionIds |
| `CONTRACT_OWNER_REPLIED` | contractId, escalationId, reading, outcome, action |
| `CONTRACT_GATE_RESULT` | contractId, targetId, gate, passed, skipped, durationMs |
| `CONTRACT_UNIT_SILENT` | contractId, unitId, agentId, silentMs, action ('retried', 'failed') |
| `CONTRACT_MERGE_CONFLICT` | contractId, unitId, branch, path, files |
| `CONTRACT_ATTEMPTS_SELECTED` | contractId, unitId, candidateIds, chosen (string or null), outcome, decisionId |
| `CONTRACT_COMMITTED` | contractId, status ('committed', 'applied', 'skipped', 'failed'), hash?, note |
| `CONTRACT_PASSED` | contractId, criteriaMet, criteriaJudged, excluded, nudges |
| `CONTRACT_FAILED` | contractId, reason, failureKind, membersSettled, turnLimit?, turnLimitSource? |
| `CONTRACT_CANCELLED` | contractId, reason, filesModified |
| `CONTRACT_SPAWN_GUARD_TRIGGERED` | contractId?, agentId, depth, activeAgents, reason (the old `ORCHESTRATION_RECURSION_GUARD_TRIGGERED`, emitted by `core/orchestrator-tool-runtime.ts` and when a unit agent tries to spawn, 10.3) |

The engine's own local event union (`orchestration/types.ts:681`, kebab-case) is unchanged and stays internal; the runner subscribes to it per engine and translates what surfaces need (merge conflicts, attempts, requeues) into contract events.

The `ORCHESTRATION_GRAPH_*` and `ORCHESTRATION_NODE_*` events emitted today for every agent spawn (`tools/agent/manager.ts:583-617`, `core/orchestrator-tool-runtime.ts:487-560`, and the private `emitOrchestration*` helpers of `agents/orchestrator.ts:268-336` passed into the run context) are removed: work spawns are units and are covered by contract events; agents outside contracts are covered by the `agents` domain. `AgentOrchestratorRunContext` loses its four `emitOrchestration*` members. `OrchestrationTaskContract` moves to `events/agents.ts` as `AgentTaskContract` on `AGENT_SPAWNING`, with `reviewMode: 'none' | 'contract'`. The `agents` domain payload fields `wrfcId`, `wrfcRole`, `wrfcPhaseOrder` become `contractId`, `contractRole`, `contractUnitId`; `communication` domain `wrfcId` becomes `contractId`; the planner domain's work-plan `chainId` becomes `contractId`.

**What happens to `agents/wrfc-runtime-events.ts`:** deleted; `contract/events.ts` replaces it. **The fleet adapter** is section 8.3.

### 8.2 Consumers of the old domains, and what they read instead

| File | Today | Instead |
|---|---|---|
| `channels/reply-pipeline.ts:119,541` | subscribes to `workflows`, handles `WORKFLOW_CHAIN_CREATED` | subscribes to `contracts`, handles `CONTRACT_CREATED` |
| `channels/reply-render.ts:474-540` | renders 11 `WORKFLOW_*` types to channel prose | renders `CONTRACT_CREATED`, `CONTRACT_STATUS_CHANGED`, `CONTRACT_CHECKED` (group and deliverable scope only), `CONTRACT_ESCALATED` (the question), `CONTRACT_PASSED`, `CONTRACT_FAILED`, `CONTRACT_CANCELLED`, `CONTRACT_COMMITTED`, with the same sentence style |
| `channels/workstream-labels.ts:59,236-261` | `describeWorkstreamState(WrfcState)` | `describeContractStatus(ContractStatus)` and `describeUnitStatus(UnitStatus)` |
| `integrations/notifier.ts:161-208`, `integrations/webhooks.ts:170-178` | notify on `WORKFLOW_CHAIN_PASSED` and `_FAILED` | `CONTRACT_PASSED`, `CONTRACT_FAILED`, `CONTRACT_CANCELLED` |
| `runtime/bootstrap-runtime-events.ts:14,67-77,115-116,128-219` | `router.wrfc()` sink, `[WRFC]` system messages, `wrfc.scoreThreshold`, `getChain`, `listChains`, orchestration store dispatch | `router.contract()`, `[Contract]` messages for status, checks, nudges, escalations, pass, fail, cancel; `getContract`; `list`; contract store dispatch |
| `runtime/bootstrap-hook-bridge.ts:66-126` | `WORKFLOW_*` and `ORCHESTRATION_*` to `Lifecycle:workflow:*` and `Lifecycle:orchestration:*` hooks | `CONTRACT_*` to `Lifecycle:contract:created`, `:planned`, `:checked`, `:nudged`, `:escalated`, `:passed`, `:failed`, `:cancelled` |
| `core/event-replay.ts:8-28,215-281` | WRFC chain reminders | contract reminders from `CONTRACT_STATUS_CHANGED`, `_PASSED`, `_FAILED` |
| `core/deterministic-replay.ts:47,745` | maps `WORKFLOW_*` to `workflows` | maps `CONTRACT_*` to `contracts` |
| `runtime/store/helpers/reducers/lifecycle.ts:273-382,430-537`, `runtime/store/domains/orchestration.ts`, `runtime/store/index.ts`, `runtime/store/helpers/events.ts`, `runtime/store/domains/agents.ts:33-69`, `communication.ts:19`, `reducers/sync.ts:43` | orchestration reducer and domain state; owner revival by `wrfcRole`; `wrfcRef` | `runtime/store/domains/contracts.ts` (`ContractDomainState`: contract views by id, per-unit latest verdicts) and a contract reducer; owner revival keyed on `contractRole === 'owner'`; `contractRef` |
| `runtime/ui-events.ts`, `runtime/transports/ui-runtime-events.ts` | `workflows` UI feed | `contracts` UI feed |
| `runtime/system-message-policy.ts:10-26`, `core/transcript-events/classify.ts:12` | `'wrfc'` kind and `[WRFC]` prefix | `'contract'` kind and `[Contract]` prefix |

### 8.3 Fleet: the contract tree view

`runtime/fleet/adapters/wrfc.ts` is replaced by `runtime/fleet/adapters/contract.ts`, and the work-item parts of `runtime/fleet/adapters/orchestration.ts` fold into it:

- `adaptContract(contract, memberNodes, now)`: kind `contract`, id `contract:<id>`, label `contract <id>`, root, never steerable; cost from members with provenance as `aggregateCost` did; model descriptor from the unit routes.
- `adaptContractGroup(group, contract)`: kind `contract-group`, id `group:<contractId>:<groupId>`, parent the contract.
- `adaptContractUnit(unit, contract, { item, steerable })`: kind `contract-unit`, id `unit:<contractId>:<unitId>`, parent its group; reuses `displayWorkItemUsage`, `collectLiveItemUsage`, `activeWorkItemAgentId`, worktree and merge fields from the work item; steerable when its active agent is running.
- `deriveCheckSummary(unit or contract)`: replaces `deriveReviewSummary`, returning `ProcessCheckSummary { criteria: { id, text, verdict, outcome }[], met, judged, nudges, lastCheckAt }` in place of `ProcessReviewSummary { score, passed, cycles, checklist }` (`runtime/fleet/types.ts:354`), so each criterion's reading shows in the fleet panel.
- `repriceContractOwnerNode(ownerNode, contractNode)`: replaces `repriceWrfcOwnerNode`.

`ProcessKind` (`runtime/fleet/types.ts:16`) and `FleetNodeKind` (`events/fleet.ts:22-36`) replace `wrfc-chain`, `wrfc-subtask`, `workstream`, `phase` and `work-item` with `contract`, `contract-group` and `contract-unit` (every workstream is now a contract group). `createProcessRegistry` (`runtime/fleet/registry.ts:230`): the `wrfcController` dependency becomes `contractRunner: Pick<ContractRunner, 'list'>` and `orchestrationEngine` is dropped (engines are per contract and reached through the runner); `assemble()` builds contract, group, unit and agent nodes; `killNode` on a contract cancels it, on a group cancels its running units' agents, on a unit kills its agent (the runner treats it as an operator cancel of the contract, 6.5); `steer` on a contract refuses ("steer a unit, not the contract"), on a unit sends a `steer` to the unit's active agent. `runtime/fleet/adapters/agent.ts:52-54,99-106,211` parents agent nodes by `contractUnitId` and labels them by `contractRole`. The schemas in `control-plane/operator-contract-schemas-fleet.ts` (`PROCESS_KIND_SCHEMA`, the review summary schema) and `control-plane/routes/fleet.ts` follow; `fleet.graph.get`, `fleet.attempts.*` and `fleet.conflicts.*` keep their inputs, reading `workstreamId` as a group id through the runner. The TUI and web UI render these nodes in the same rows, glyphs and columns they used for chains, subtasks and work items (task T and W).

Points resolved when this was built (R.8):

- **The review loop until R.10.** The WRFC controller stays live until R.10, so it reports on the `contracts` domain through `agents/wrfc-contract-events.ts` (deleted with it): a chain is a contract whose id is the chain id, its constraints are the criteria (`CONTRACT_PLANNED`), a review is a `CONTRACT_CHECKED` with one reading per constraint, a fix round is `CONTRACT_FIX_PLANNED`, a state change is `CONTRACT_STATUS_CHANGED` only when the mapped status changes, and an operator cancel is `CONTRACT_CANCELLED`. The score-regression warning becomes a log line; the cascade abort is carried by the failure that follows it.
- **Agent records keep their grouping ids.** `orchestrationGraphId`, `orchestrationNodeId` and `parentNodeId` stay on the agent record and `AGENT_SPAWNING` (the agent tool's graph grouping and `cancelGraph` use them); only the orchestration events go. `AGENT_SPAWNING` carries the task contract as `taskContract: AgentTaskContract`. A spawn refused by the spawn policy emits `CONTRACT_SPAWN_GUARD_TRIGGERED` with the refused spawn's parent as `agentId` (`root` for a top-level spawn, `conversation` for plan auto-spawn).
- **Hooks.** The hook category `contract` replaces `workflow` and `orchestration`; the spawn guard fires `Change:contract:spawn-guard`.
- **Channel prose.** An escalation's question opens with `Contract <id>`; the renderer puts the contract's plain-words label in its place, since channel text never carries a register id. Unit checks and nudges are the operator's and render nothing on channels.
- **The store domain** keeps a record per contract (status, plan, each unit's and group's latest verdict per criterion, open escalations, commit, outcome). Events for a contract not seen yet create it, since the review loop reports a status change before its creation. Ended contracts beyond 200 are dropped oldest first; the totals count every contract seen.
- **Fleet usage** of a contract, group or unit node is summed from the agent nodes that did the work, so the adapter needs only the runner's views and no work items; the registry dependency is `contractRunner: Pick<ContractRunner, 'list' | 'cancel'>` (`cancel` for a contract kill), optional until R.10 composes the runner in `services.ts`. A best-of-N unit's attempts are children of the unit node; a pick escalation flags the plan unit only.
- **Wire renames.** The surface reply field `workflowChainId` became `contractId`; the work plan's correlation field `chainId` became `contractId`, and a stored work plan written before the rename has its tasks' `chainId` read as `contractId`.
- **The fleet operator verbs** (`fleet.graph.get`, `fleet.attempts.*`, `fleet.conflicts.*`) still take their controller from the services orchestration engine, because the runner is composed in `services.ts` in R.10. Reading a `workstreamId` through the runner needs contract-qualified ids (every contract names its groups `g1`, `g2`...), and a pick of a contract attempt must go through `acceptAttempt` and close the `attempts-undecided` escalation; that is part of composing the runner.

### 8.4 The external work seam (`contract/external.ts`)

`WrfcExternalWorkBridge`, `WrfcExternalWorkAdapter` and the request, handle, snapshot and result types (`agents/wrfc-external-adapter.ts`) become `ContractExternalWorkBridge` and `ContractExternalWorkAdapter` with the same four methods (`dispatch`, `status`, `cancel`, `result`) and the same statuses. `ContractExternalWorkRequest` replaces `wrfcId` and `chainState` with `contractId` and `status: ContractStatus`. Two implementations:

- `createHostedContractWorkAdapter({ runner, hostedSessions })` in `hosted-sessions/contract-work-adapter.ts`, in process: `dispatch` starts a contract in a hosted session (created if none is given), `status` maps `ContractView` to a snapshot with the status line as `progress`, `cancel` calls `runner.cancel`, `result` returns the answer as `output` and the status line as `summary`.
- `createOperatorContractWorkAdapter(client)` in `packages/engine/operator-sdk/src/contract-work-adapter.ts`, for partner surfaces over the `contracts.*` operator methods (10.2).

## 9. Settings

### 9.1 `contract.*` (replaces `wrfc.*`, `config/schema-domain-core.ts`)

| Key | Type, default | Meaning |
|---|---|---|
| `contract.autoCommit` | boolean, true (the WRFC default) | commit the deliverable when it passes (6.5) |
| `contract.commitScope` | `off` \| `scoped` \| `all`, `scoped` | as 6.5 |
| `contract.gates` | `{ name, command, enabled }[]`, the WRFC defaults (typecheck and lint on, build off) | quality gates |
| `contract.gateTimeoutMs` | number, 120000 | per gate (the old `WRFC_GATE_TIMEOUT_MS`) |
| `contract.acceptanceStakes` | `high` \| `critical`, `high` | which declared pass band the judges use (4.4) |
| `contract.midRunChecks` | boolean, true | turn-end checks |
| `contract.evidenceNudgeLimit` | number, 2 | unsettled checks before the owner confirms |
| `contract.stallLimit` | number, 3 | consecutive non-progress checks that make a stall |
| `contract.maxNudgesPerUnit` | number, 12 | absolute nudge ceiling per unit |
| `contract.maxFixRounds` | number, 5 | planned-fix rounds plus fresh agents before the owner decides |
| `contract.planRepairLimit` | number, 2 | planner repairs before the owner decides |
| `contract.maxUnits` | number, 64 | units per plan |
| `contract.defaultAttempts` | number, 1 | attempts per unit without an explicit ask |
| `contract.maxActiveContracts` | number, 6 | active-contract cap |
| `contract.maxParallelUnits` | number, 64 | phase capacity per group in worktree mode |
| `contract.isolation` | `auto` \| `worktree` \| `shared`, `auto` | 7.4 |
| `contract.heartbeatTimeoutMs` | number, 0 (off) | watchdog |
| `contract.transportRetryLimit` | number, 1 | 4.9 |
| `contract.transportRetryDelayMs` | number, 5000 | 4.9 |
| `contract.nudgeTtlMs` | number, 300000 | message-bus ttl for mid-run nudges |
| `ui.contractMessages` | `panel` \| `conversation` \| `both`, `both` | replaces `ui.wrfcMessages` |

Numbers are read with the `Number.isFinite` guard `readWrfcConfig` used. The keys, value types and category in `config/schema-types.ts`, `config/schema-types-values.ts` and `config/schema.ts` follow.

### 9.2 Migration

`migrateWrfcSettings(parsed)` in `config/migrations.ts` and `applyContractSettingsMigrationPass` in `config/manager-migration-passes.ts`, added to `runLoadMigrationPasses`, rewrite an existing settings file once: `wrfc.autoCommit`, `commitScope`, `gates`, `transportRetryLimit`, `transportRetryDelayMs` move to the same names under `contract`; `wrfc.agentHeartbeatTimeoutMs` to `contract.heartbeatTimeoutMs`; `wrfc.maxFixAttempts` to `contract.maxFixRounds`; `ui.wrfcMessages` to `ui.contractMessages`; `wrfc.scoreThreshold` is removed, with a migration receipt stating that acceptance is now a per-criterion reading and strictness is `contract.acceptanceStakes`. The receipt goes through the existing `MigrationReceiptSink`.

## 10. Entry points and hosts

### 10.1 CLI (`contract/cli.ts`, `packages/engine/sdk/src/bin/goodvibes-contract.ts`)

`runContractCli(argv, io, deps)` is the whole CLI, so the products' `goodvibes run` (terminal-shell catalog `run`, `GoodVibesCliCommand`) can call the same function later. The bin boots in-process runtime services with `createRuntimeServices` (`runtime/services.ts`), installs the judgment port (`createSystemOnePort(judgmentConfigFromEnv())` wrapped with `withDecisionLog` over the state layer's decision-log store) with `installJudgmentPort`, and wires the route selector.

| Command | Behaviour | Exit |
|---|---|---|
| `goodvibes-contract run "<ask>" [--cwd <dir>] [--isolation auto\|worktree\|shared] [--json]` | starts a contract with origin `cli`; prints one line per contract event (or JSON lines); on `awaiting-owner` prints the question and, on a TTY, reads a reply from stdin and calls `reply`; prints the answer on pass, the status line on stderr | 0 passed, 1 failed, 2 awaiting the owner without a TTY, 130 cancelled by SIGINT (which calls `cancel`) |
| `goodvibes-contract status [<id>] [--json]` | one contract's tree with each criterion's latest verdict, or a table of contracts | 0 |
| `goodvibes-contract list [--all]` | contracts in the project | 0 |
| `goodvibes-contract cancel <id>` | cancels | 0, or 1 if not found |
| `goodvibes-contract reply <id> "<text>"` | replies to the open escalation | 0 |
| `goodvibes-contract resume` | `resumeAll()` then follows the resumed contracts like `run` | as `run` |

### 10.2 Daemon hosted-session host

- `HostedWorkspaceFloor` (`hosted-sessions/workspace-floor.ts:63`) replaces its optional `wrfcController` with a required `contractRunner`, one per workspace floor, built in `daemon/hosted-sessions-composition.ts` (`composeHostedSessions`, `composeHostedSessionsForFacade`) from the floor's services. `createHostedSessionRuntime` (`hosted-sessions/session-runtime.ts:169`) passes `services.contractRunner` to the conversation `Orchestrator` and to `registerAllTools` (which today receive a `{ listChains: () => [] }` stub and no controller), so the `agent` tool and intake dispatch reach the runner in hosted sessions.
- Contracts started in a hosted session carry its `sessionId`; the record's `contractIds` list is updated on `CONTRACT_CREATED` and persisted by the manager's `persist()`. Owner escalations raised in a hosted session are delivered as the session's reply, and a following `deliver(id, text)` while the escalation is open goes to `runner.reply` (the intake route in 10.3).
- Operator methods, new catalog `control-plane/method-catalog-contracts.ts`, handlers `control-plane/routes/contracts.ts`, schemas `control-plane/operator-contract-schemas-contracts.ts`, REST bindings in `packages/engine/daemon-sdk/src/gateway-rest-routes.ts`:

| Method | REST | Input | Output |
|---|---|---|---|
| `contracts.list` | `GET /api/contracts` | `{ sessionId?, includeTerminal? }` | `{ contracts: ContractView[] }` |
| `contracts.get` | `GET /api/contracts/{contractId}` | `{ contractId }` | `ContractView` |
| `contracts.start` | `POST /api/contracts` | `{ ask, sessionId?, workspaceRoot?, isolation? }` | `{ contract, ownerAgentId }` |
| `contracts.cancel` | `POST /api/contracts/{contractId}/cancel` | `{ contractId, reason? }` | `{ cancelled }` |
| `contracts.reply` | `POST /api/contracts/{contractId}/reply` | `{ contractId, escalationId, text }` | `OwnerReplyOutcome` |

Scopes follow the fleet methods (`read:fleet` for list and get, `write:fleet` for the rest). The operator and peer contract artifacts, the typed method maps and the web UI facade are regenerated. The daemon verbs task E.11 adds (plan, dispatch, status, override, receipt) call these methods.

- **Embed** (`embed/session.ts`) stays a port over the daemon it boots; when `SharedSessionBroker.submitMessage` returns mode `spawn` (`control-plane/session-broker-intent.ts:449`), `createEmbeddedSession.submit` calls `contracts.start` through the daemon server with the submitted text as the ask and binds the owner agent to the session, which closes the gap where an embed submit in spawn mode started nothing.

### 10.3 The conversation loop, intake dispatch and the agent tool

- **Request route.** `contract.request-route` (`contract/batteries/request-route.ts`), a `defineDispatch` over `{ converse: 'Conversation, a question about the conversation, or a request needing no work on files or systems', answer: 'A question answered from knowledge or by reading, with no change to anything', contract: 'Work that produces or changes something: code, files, documents, configuration, or a multi-step task' }` with band `STAKES_BANDS.medium.confidence` and `perOption.contract` at `high`. It runs once per user turn in `core/orchestrator-turn-loop.ts` at the site where `buildWrfcWorkflowRoutingPrompt` is appended today (line 367). Route `contract` at act starts a contract with origin `turn` and the turn's text as the ask, and ends the turn as the loop does after an authoritative chain start (`orchestrator-turn-helpers.ts:186-227`): the owner record is bound to the turn and its answer arrives through the normal agent-completion delivery. `converse` and `answer`, and any reading below act, let the loop continue normally, where the model may still call the `agent` tool (which also reaches the runner). No text is injected into the model's prompt. When a session has an open escalation, the turn's text goes to `runner.reply` before the route is read. The intake subsystem (task E.7) imports this same dispatch rather than defining another.
- **`toolResultStartedContract(result)`** replaces `toolResultIndicatesAuthoritativeWrfcChain`: it reads the agent tool's fixed JSON field `contractStarted: true` (code, a fixed format).
- **The `agent` tool** (`tools/agent/index.ts`): `spawn` and `batch-spawn` without `outsideContract` call `runner.start` with origin `agent-tool`, the ask from `authoritativeTask` when present, otherwise the parent turn's user text, and the tasks as `proposedUnits`; the result JSON carries `contractStarted: true`, `contractId`, the owner agent id and, when `requests_parallel_agents` shaped the plan, a plain announcement. The modes `wrfc-chains` and `wrfc-history` become `contracts` and `contract-history` (reading `runner.list` and `ContractStore`); the list mode's WRFC column shows the contract id and unit. `summarizeWrfcEvent` becomes `summarizeContractEvent`. `evaluateWrfcBatchPolicy` is deleted: the planner and the plan checks do what it did. `tools/agent/schema.ts` follows (modes, `reviewMode`, `outsideContract`, `contractId`, `proposedUnits`). `tools/agent/child-failure-envelope.ts:71-74` labels phases `contract:${contractRole}`.
- **`AgentManager.spawn`** (`tools/agent/manager.ts`): the root review-role normalization (312-375) and its imports from `wrfc-batch-policy.ts` and `root-spawn-chain-decision.ts` are removed; `setWrfcController` becomes `setContractRunner(runner: Pick<ContractRunner, 'startForOwner'>)`; the `createChain` call (633-663) becomes `startForOwner(record)`, which marks the record the contract owner and returns without running an executor. A spawn requested by an agent whose `contractRole` is `unit` is refused with "units are leaves; the contract plans sub-work" and emits `CONTRACT_SPAWN_GUARD_TRIGGERED` (this replaces the nested-spawn guard at 431-442 and `isWrfcOwnerChild`).
- **Conversation-level spawns outside contracts** keep `outsideContract: true`: `agents/conversation-continuation.ts:119,127`, `agents/planner-decomposition-runner.ts:90`, `daemon/surface-conversation-gate.ts:112-122`, and the runner's own planner.

### 10.4 Plan proposals and workstream drafts

`fromPlanProposal` and `approveAndLaunchProposal` (`orchestration/proposal-workstream.ts`) build a draft contract plan from the proposal (proposal items become units, their briefs the unit briefs) and launch it with `runner.startFromPlan`; the planner is asked only to write criteria for the given units and the contract criteria from the proposal's goal, and every plan check runs. `workstream-services.ts` launches drafts the same way, and its single-item path (`fromChainSpec`, line 238) becomes `runner.start({ ask: task, origin: 'proposal' })`. Workstream drafts, their store and edits are unchanged; they are drafts of contract plans.

## 11. Every WRFC function and file, placed

### 11.1 The inventory rows (`docs/inventory/wrfc-to-jev.md`)

| Inventory row | Placed in |
|---|---|
| Routing nudge | `contract.request-route` dispatch in `core/orchestrator-turn-loop.ts` (10.3) |
| No-delegation guard | `contract.request-shape` `forbids_delegation`, session mode (3.1, 6.6) |
| Engineer constraint enumeration addendum | the planner sets goal and criteria; `contract.criterion-trace`, `contract.plan-coverage`, `contract.criterion-shape` (3.2 to 3.4) |
| Scope preservation | `contract.unit-shape` `narrows`; tool contract from `forbids_writing` (3.4) |
| Role-fanout collapse | `contract.unit-shape` `role`; verification units refused (3.4) |
| Explicit parallel fan-out and topology constraints | `requests_parallel_agents`, code check 6, `topology_only`, dispositions `excluded` and `met-by-structure` (3.1, 3.3, 3.4) |
| Compound chains | groups, units, integration group, group and deliverable checks (6.1, 6.4) |
| Spawning phase agents with a route and reason | `ContractRouteSelector`, `UnitRoute.reason`, `AgentRecord.routeReason` (2.2, 6.1) |
| Active-chain cap and queue | `contract.maxActiveContracts`, queue, elastic pool (7.3) |
| Worktree isolation, dependency ordering, cancellation, budget | the ported engine per contract, contract branch (7.4, 7.5) |
| Agent-silence watchdog | `contract/watchdog.ts` (4.10) |
| One bounded transport retry | `readFailure` in the runner and phase runner (4.9) |
| Claim verification | `contract/claims.ts`, evidence and immediate nudge (4.3, 4.6) |
| Quality gates | `contract/gates.ts`, gate failures as nudges (4.3, 4.6) |
| Sub-deliverable engineer brief | `buildUnitBrief` (6.1) |
| Reviewer agent | `contract.unit-judge` with collected evidence (4.3, 4.4) |
| Review score from prose | per-criterion readings with bands, severity reading (4.4, 4.5) |
| Acceptance-checklist gate | every criterion must read met; unread is not met (4.6) |
| Constraint findings | one reading per criterion in one request; a missing answer is a port error (4.4) |
| Constraint continuity | criteria owned by the contract; nudges restate met ones (4.7) |
| Score regression warning | regression rule (4.8) |
| Controller verdict recorded separately | the check result is the only verdict, in the tree and the decision log (2.3) |
| Review/fix loop | the nudge loop until pass; stall to planned-fix, fresh agent or owner (4, 5) |
| Fixer and reviewer constraint addenda | nudge text with binding met criteria; regression nudges (4.7, 4.8) |
| Planned-fix decomposition | planned-fix groups (5.2) |
| Engineer self-check | not needed; Jev reads continuously (6.1) |
| Scoped auto-commit | contract branch merge or apply, shared-mode scoped commit (6.5) |
| Answer separate from status | owner `fullOutput` is the answer; status on the operator audience (6.5) |
| Honest outcome wording | `describeContractOutcome`, `describeCommitOutcome` (6.5) |
| Cancel is not failure | `cancel` (6.5) |
| Usage and tool-call totals | usage roll-up and owner repricing (2.3, 8.3) |
| Execution-plan and work-plan sync | `contract/plan-sync.ts` (6.5) |
| Chain persistence, import, resume | `ContractStore`, `importContract`, `resumeAll` (7.1, 7.2) |
| Zombie reaping | zombie test (7.2) |
| Owner decision audit | `ContractDecision` list with decision-log ids (2.3) |
| Workmap | folded into the contract tree and the decision log (7.1) |
| Workflow and orchestration events | the `contracts` domain (8.1) |
| Fleet view | contract, group and unit nodes with per-criterion readings (8.3) |
| External work adapter | `ContractExternalWorkBridge`, hosted and operator adapters (8.4) |
| Settings | `contract.*` and the migration (9) |
| Standard phase template and single-task spec | the single-unit plan shape and `unitPhases()` (3.3, 6.1) |
| Best-of-N | `contract.best-of-n` selector (6.2) |

### 11.2 Every WRFC file and its fate

| File | Fate |
|---|---|
| `agents/wrfc-controller.ts` | deleted; lifecycle in `contract/runner.ts`, checks in `check.ts`, nudges in `nudge.ts`, correction in `correction.ts`, finishing in `completion.ts`, persistence in `store.ts` and `resume.ts`, watchdog in `watchdog.ts`, usage in `usage.ts`, sync in `plan-sync.ts`. `extractScoreFromText`, `extractPassedFromText`, `extractIssuesFromText` re-exports go |
| `agents/wrfc-types.ts` | deleted; `contract/types.ts`. `QualityGate` and `QualityGateResult` move to `contract/gates.ts` |
| `agents/wrfc-config.ts` | deleted; `contract/config.ts`; `AgentManagerLike` moves to `contract/types.ts` |
| `agents/wrfc-reporting.ts` | deleted; `parseEngineerCompletionReport`, `verifyEngineerClaims`, `ClaimVerificationKind`, `ClaimVerificationResult` move to `contract/claims.ts` (renamed as in 2.1); `extract*FromText`, `parseReviewerCompletionReport`, `buildReviewTask`, `buildGateFailureTask` are removed (no reviewer, no prose score, gate output goes into nudges) |
| `agents/wrfc-gates.ts`, `agents/wrfc-gate-runtime.ts` | deleted; `contract/gates.ts` |
| `agents/wrfc-chain-answer.ts` | deleted; `contract/answer.ts` |
| `agents/wrfc-external-adapter.ts` | deleted; `contract/external.ts` |
| `agents/wrfc-plan-sync.ts` | deleted; `contract/plan-sync.ts` |
| `agents/wrfc-planned-fix.ts` | deleted; silence-as-unmet is structural (every criterion has its own reading), merged fix reports are replaced by the re-check of the target (5.2) |
| `agents/wrfc-prompt-addenda.ts` | deleted; `buildUnitBrief` and `buildNudge` |
| `agents/wrfc-runtime-events.ts` | deleted; `contract/events.ts` |
| `agents/wrfc-workmap.ts` | deleted; `runtime/retention/legacy-agent-journal-patterns.ts:117-120`, `retention/append-only-registry.ts:181-182` and `runtime/session-migration.ts:34` keep recognising old `_workmap.jsonl` files so the retention sweep still reaps them from existing state roots |
| `agents/wrfc-controller-test-support.ts` | deleted; `contract/testing.ts` |
| `agents/completion-report.ts` | kept; `ReviewerReport`, `ConstraintFinding`, `AcceptanceChecklistItem`, `AcceptanceChecklistGate`, `evaluateAcceptanceChecklistGate` and the `wrfcId` field are removed; the header comment names the contract runner |
| `core/wrfc-routing.ts` | deleted; `contract/intake-route.ts` and `contract.request-shape` |
| `tools/agent/wrfc-batch-policy.ts`, `tools/agent/root-spawn-chain-decision.ts` | deleted; batteries in 3.1 and 3.4 |
| `runtime/fleet/adapters/wrfc.ts` | deleted; `runtime/fleet/adapters/contract.ts` |
| `runtime/fleet/adapters/orchestration.ts` | deleted; its work-item helpers move into `adapters/contract.ts` |
| `orchestration/controller-compat.ts`, `orchestration/fix-workstream-runner.ts`, `orchestration/judge.ts` | deleted (7.5) |
| `orchestration/review-task-source.ts` | becomes `orchestration/task-graph.ts` (7.5) |
| `runtime/emitters/workflows.ts`, `runtime/emitters/orchestration.ts`, `events/workflows.ts`, `events/orchestration.ts` | deleted; `runtime/emitters/contract.ts`, `events/contract.ts` |
| `runtime/store/domains/orchestration.ts` | deleted; `runtime/store/domains/contracts.ts` |
| `tools/workflow` template `'wrfc'` ("WRFC Loop", `tools/workflow/index.ts:18-19`, `schema.ts:31`) | becomes template `'contract'` that starts a contract through the runner |

### 11.3 Every call site outside the WRFC files, and what it calls instead

| Call site | Today | Instead |
|---|---|---|
| `runtime/services.ts:40,140,310,430,436,686,905,970,1055,1153,1188` | constructs `WrfcController`, wires it into AgentManager, work plan, fix runner, fleet registry, poller teardown, `RuntimeServices` and scoped roots | constructs `createContractRunner` with the dependencies in 2.2 (including `planManager` and `workPlanService`), `agentManager.setContractRunner(runner)`, `toolDeps.contractHooks = runner.hooks()`, fleet registry `contractRunner`, `RuntimeServices.contractRunner`, `runner.resumeAll()` after services start |
| `runtime/agent-graph-composition.ts:19,31,64,69,76` (exported via `runtime/operations.ts:244`) | constructs and wires `WrfcController` | the same runner construction as services |
| `runtime/disposal.ts:112,153` | `wrfcController.dispose()` | `contractRunner.dispose()` |
| `runtime/ui-services.ts:30,123` | `agents.wrfcController` | `agents.contractRunner` |
| `runtime/bootstrap-runtime-events.ts`, `runtime/bootstrap-hook-bridge.ts`, `runtime/store/*`, `runtime/ui-events.ts`, `runtime/transports/ui-runtime-events.ts`, `runtime/system-message-policy.ts`, `runtime/events/index.ts:25-26` | WRFC and orchestration domains | section 8.2 |
| `runtime/emitters/agents.ts:19-58`, `runtime/emitters/communication.ts:25,62` | `wrfcId`, `wrfcRole`, `wrfcPhaseOrder` | `contractId`, `contractRole`, `contractUnitId` |
| `runtime/fleet/registry.ts`, `runtime/fleet/types.ts`, `runtime/fleet/adapters/agent.ts` | chain and subtask nodes | section 8.3 |
| `runtime/remote/capabilities.ts:43-45`, `remote/negotiation.ts:7`, `remote/types.ts:251` | `reviewMode: 'none' \| 'wrfc'` | `'none' \| 'contract'` |
| `core/orchestrator.ts:34,149,218,298,821,976`, `core/orchestrator-context-runtime.ts:10,115,145,168,389` | `Pick<WrfcController,'listChains'>` for compaction context | `Pick<ContractRunner,'list'>` |
| `core/compaction-types.ts:10,105-106`, `core/compaction-sections.ts`, `core/context-compaction.ts:425,478-487`, `core/conversation-compaction.ts:130` | `wrfcChains: WrfcChain[]` sections | `contracts: ContractView[]`; running contracts and units, completed work from contract answers, older contracts summarized by status line |
| `core/orchestrator-turn-helpers.ts:16,93-95,186-227`, `core/orchestrator-turn-loop.ts:49,367-369` | routing system message, stop after authoritative chain | 10.3, and the session-mode hold (6.6) |
| `core/orchestrator-tool-runtime.ts:487-560` | orchestration graph and node events | removed; recursion guard emits `CONTRACT_SPAWN_GUARD_TRIGGERED` |
| `core/event-replay.ts`, `core/deterministic-replay.ts`, `core/transcript-events/classify.ts` | workflow events and `[WRFC]` | section 8.2 |
| `agents/index.ts:24-33` | `export *` of the wrfc files | removed; contract exports come from the `contract` subpath |
| `agents/orchestrator.ts:31-34,268-340,692-700` | orchestration node emitters | removed; `contractHooks` passed into the run context (4.1) |
| `agents/orchestrator-runner.ts:84-97` and call sites | `emitOrchestration*` callbacks | removed; the two hook call sites added (4.1) |
| `agents/orchestrator-prompts.ts:119-194,284,351` | completion report with `wrfcId`, WRFC orchestrator role prompt, WRFC constraint layer | report field `contractUnitId`; the owner never runs a model so its role prompt goes; the constraint layer goes (criteria are in the brief) |
| `agents/communication-policy.ts:19,54-55,87` | `sharesWrfc()` | `sharesContract()` on `contractId` |
| `agents/message-bus-core.ts:24,42,66-86,162,224,293-299` | `wrfcId` metadata | `contractId` |
| `agents/completion-answer.ts:19,41-42` | "Review, fix, and gate updates will follow" when `wrfcId` is set | "The contract's checks will follow." when `contractRole === 'owner'` and not terminal |
| `agents/conversation-continuation.ts`, `agents/planner-decomposition-runner.ts`, `daemon/surface-conversation-gate.ts` | `dangerously_disable_wrfc: true` | `outsideContract: true` |
| `agents/archetypes.ts:55` | "WRFC coordination and decomposition agent" | "Contract owner: represents a contract and carries its answer" |
| `tools/index.ts:59,281,422,556` | optional `wrfcController` (never passed in-engine) | required `contractRunner`, passed by `agents/orchestrator.ts` tool deps and `hosted-sessions/session-runtime.ts` |
| `tools/agent/index.ts`, `tools/agent/manager.ts`, `tools/agent/schema.ts`, `tools/agent/child-failure-envelope.ts` | WRFC modes, fields, batch collapse, createChain | section 10.3 |
| `tools/goodvibes-runtime/index.ts:36` | "Do not spawn agents or WRFC chains" | "Do not spawn agents or start contracts" |
| `config/schema-domain-core.ts`, `config/schema.ts`, `config/schema-types.ts`, `config/schema-types-values.ts` | `wrfc` category, `ui.wrfcMessages` | section 9 |
| `hosted-sessions/workspace-floor.ts:56,72`, `hosted-sessions/session-runtime.ts:267` | optional `listChains` | section 10.2 |
| `daemon/types.ts:270-272`, `daemon/http/runtime-route-types.ts:249-251`, `daemon/http/runtime-routes.ts:71,272`, `packages/engine/daemon-sdk/src/runtime-route-types.ts:257,259` | `reviewMode`, `dangerously_disable_wrfc` | `reviewMode: 'none' \| 'contract'`, `outsideContract`, with validation |
| `daemon/surface-conversation-gate.ts:261`, `daemon/facade-composition.ts:795`, `adapters/ntfy/index.ts:295` | `wrfcId` mapped to `workflowChainId` | `contractId` mapped to `contractId` (the wire field is renamed) |
| `daemon/homeassistant-chat.ts:216` | "no WRFC summaries" | "no contract status summaries" |
| `channels/*`, `integrations/*` | workflow events | section 8.2 |
| `control-plane/operator-contract-schemas-fleet.ts`, `control-plane/routes/fleet.ts`, `control-plane/method-catalog-control-core.ts:512`, `method-catalog-fleet.ts:65`, `method-catalog-knowledge.ts:814-857`, `operator-contract-schemas-project-planning.ts:125,282` | WRFC kinds and wording, `chainId` | contract kinds and wording, `contractId` |
| `knowledge/project-planning/types.ts:14`, `workflow/work-plan-store.ts:85,209-214` | source `'wrfc'`, `linked.wrfcId` | source `'contract'`, `linked.contractId` |
| `orchestration/*` | see 7.5 | see 7.5 |
| `events/agents.ts`, `events/communication.ts`, `events/fleet.ts`, `events/planner.ts:44`, `events/turn.ts:144`, `events/index.ts`, `events/domain-map.ts`, `events/contracts.ts` | WRFC fields and domains | section 8.1 |
| `packages/engine/terminal-shell/src/gateway-verbs.ts:30,55,65-70`, `terminal-shell/src/index.ts:49` | `ProcessRegistryDeps` requires `wrfcController` | requires `contractRunner` |
| `packages/engine/contracts` generated files and artifacts | WRFC enums, `runtime.workflows`, `runtime.orchestration` | regenerated from the changed schemas |
| `packages/engine/scripts/line-cap-grandfather.ts:39-40` | grandfathers `wrfc-controller.ts` | entry removed |
| Engine tests listed in the call-site inventory (the WRFC controller, constraint, phantom, owner-agent, fan-out, operator-cancel, batch-policy, chain-authority, commit-scope, addenda, reviewer-contract, transport, continuation, fix-graph, compat, fleet cost, workflow-event, and orchestration-event tests, plus the helper `_helpers/orchestration-harness.ts`) | exercise WRFC | each test's purpose is re-expressed against the runner in the child task that replaces the code it tests (section 12); tests of removed behaviour (prose scores, reviewer reports, fix phases) are deleted with the code; tests that only carried a `wrfc*` field or stub are updated to the renamed field |

## 12. Child tasks, in dependency order

Every task: typecheck is `timeout 300 bun run typecheck` at the repository root, exit 0. Tests are `timeout 300 bun test <files>` in `packages/engine`, using `fakePort`, `noulAnswer` and `choiceAnswer` from `@goodvibes-jev/judgment/testing` installed with `installJudgmentPort`, and fake agent managers. Live calibration is `timeout 300 bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/contract/judgment-registry.ts --only <names>` with `TYPESAFE_API_KEY`, and passes when every named decision meets its accuracy floor (0.9 unless stated). Every battery has at least one fixture per question per answer it can give. Each task ends with the post-part audit: the task's files are re-read for further places the judgment foundation applies, and those are implemented in the same task. Each task commits as Mike Davis with no trailers. No task leaves a WRFC reference behind in the files it touches.

**R.1 Data model, settings, store.** Goal: `contract/types.ts`, `config.ts`, `store.ts` and the settings migration exist and are tested; nothing runs yet.
- Types and transition tables as 2.3; illegal transitions throw.
- `contract.*` and `ui.contractMessages` settings in the schema files; `migrateWrfcSettings` and its pass in `runLoadMigrationPasses`, with a test that migrates every `wrfc.*` key and records the `scoreThreshold` receipt.
- `ContractStore`: round trip, atomic write, quarantine of corrupt and future-version files, reaping, `importContract` refusing a live contract without `force`; tests for each.
- The `contracts` event domain is defined and registered (8.1): `events/contract.ts`, `runtime/emitters/contract.ts`, the domain list, `DomainEventMap`, validators, the `runtime.contracts` stream, and `contract/events.ts`; tests validate every event type. The old domains and their consumers are removed in R.8.
- Depends on: J.

**R.2 Agent-loop seams and record fields.** Goal: a contract-bound sub-agent can be held at completion, observed at turn end, nudged through the bus, and woken from `failed` or `completed`.
- `contractHooks` in `AgentOrchestratorRunContext` and `toolDeps`; the turn-end call and the completion hold in `orchestrator-runner.ts` (4.1); `wakeWithSteer` `allowCompleted`.
- `AgentRecord` and `AgentInput` renames (4.1) across `tools/agent/*`, `daemon/*`, `daemon-sdk`, emitters and events; `outsideContract` at the four outside-contract call sites; `WorkItemSpec` and `WorkItem` contract fields and the phase runner passing them to `spawn`.
- Tests with a fake executor and fake provider: a held agent receives a `continue` message as a user turn and completes on `release`; a steer from `contract-runner` is drained verbatim and a consumed event fires; a turn-budget failure is woken; a completed contract-bound agent is woken only with `allowCompleted`; the fleet steer path is unchanged (the existing `agent-steer-wake` and `orchestrator-runner-steer-drain` tests pass with renamed fields).
- Depends on: R.1.

**R.3 Evidence, checks and nudges.** Goal: given a unit and a trigger, the runner collects evidence, reads Jev, maps readings to an outcome and builds the nudge, exactly as sections 4.3 to 4.8.
- `evidence.ts`, `claims.ts`, `gates.ts` (moved code with its tests re-pointed), `check.ts`, `progress.ts`, `nudge.ts`.
- Batteries `contract.unit-judge`, `contract.unit-quality`, `contract.unmet-severity` with fixtures (judge fixtures cover all-met, one unmet, unmet goal, evidence missing for a claim, and a regression pair).
- Tests with the fake port: every row of the 4.6 table; the 4.5 verdict mapping at band edges; regression and stall rules including the double-regression case; nudge text golden files (every section, empty sections omitted, met criteria restated); evidence trimming keeps the state under the budget with `validateContextBudget`.
- Live calibration of the three decisions at their floors.
- Depends on: R.1.

**R.4 Planning.** Goal: from an ask, the runner produces an accepted plan or an escalation, with every check in section 3.
- `plan-schema.ts`, `planner.ts`, `plan-checks.ts`; batteries `contract.request-shape`, `contract.criterion-trace` (fidelity), `contract.plan-coverage`, `contract.criterion-shape`, `contract.unit-shape`, with fixtures.
- Tests with the fake port and a fake `DecompositionRunner`: every code check in 3.3 produces its problem; each Jev check produces its problem; the repair loop sends every problem and stops at the limit; `excluded` and `met-by-structure` dispositions; the tool contract under `forbids_writing`; planner failure fails the contract with `planning` and no single-item fallback exists.
- Live calibration of the five decisions.
- Depends on: R.1.

**R.5 Runner execution.** Goal: `createContractRunner` runs an accepted plan to passing units through the orchestration engine with the full nudge loop.
- `runner.ts`, `workstreams.ts`, `brief.ts`, `agent-hooks.ts`, `usage.ts`, `watchdog.ts`, emitting on the runtime bus through `contract/events.ts`; the owner record; the active-contract cap and queue; shared-mode lock; transport retry through `readFailure`; watchdog; cancel.
- Engine changes: `stateRoot`; fix-phase and review logic removed; phase runner changes (7.5).
- Tests with the fake port, fake executor and a temporary git repository: a two-unit plan where one unit is nudged at completion, fixes, and passes on re-check; a mid-run regression nudge through the bus; a turn-budget failure woken and passing; a transport failure retried once, a second failing the contract; silence retried then failed; cancel marks everything cancelled with the file count; the cap queues the seventh contract; usage rolls up to the owner; a unit never reaches `passed` while any criterion reads unmet (a property test over random reading sequences).
- Depends on: R.2, R.3, R.4.

**R.6 Correction and finishing.** Goal: stalls, planned-fix groups, fresh agents, owner escalation, group and deliverable checks, integration, commit, answer and plan sync all work as sections 5 and 6.
- `correction.ts`, `completion.ts`, `escalation.ts`, `answer.ts`, `plan-sync.ts`, `orchestration/task-graph.ts`; batteries `contract.stall-route`, `contract.group-judge`, `contract.deliverable-judge`, `contract.owner-reply`; session mode (6.6) at the core turn-loop hold sites.
- Tests with the fake port: each stall route; fix-round exhaustion goes to the owner; a planned-fix group passing then the target re-check passing; a group check failure repaired; a deliverable failure repaired; each owner reply reading for each escalation reason, including that approval cannot pass unmet criteria; commit and apply in worktree mode, scoped commit in shared mode, commit failure as a warning, non-git skip note; answer from the integration unit and status on the operator audience only; work-plan and execution-plan updates per status; session mode holds the turn loop and nudges without spawning.
- Live calibration of the four decisions.
- Depends on: R.5.

**R.7 Best-of-N.** Goal: attempts use candidate selection.
- `best-of-n.ts`, `contract.best-of-n` selector with fixtures, `createSelectAttemptJudge` wired as the engine's `judgeAttempts`; `orchestration/judge.ts` deleted.
- Tests: act picks and passes the unit; confirm and none escalate; failed siblings are never candidates; the operator `fleet.attempts.judge` verb returns the selection; the existing best-of-N engine tests pass with the new judge.
- Live calibration of `contract.best-of-n`.
- Depends on: R.5.

**R.8 Contract event domain and fleet.** Goal: the `contracts` domain replaces `workflows` and `orchestration` everywhere, and the fleet shows the contract tree.
- The rest of 8.1 (old domains, emitters and the orchestration node events removed; agent and communication fields renamed), and everything in 8.2 and 8.3.
- Contract artifacts, OpenAPI and typed method maps regenerated with the generators E.14 carries, and the artifact check passes.
- Tests: every event type validates; each consumer in 8.2 renders or reacts to the contract events (channel prose, notifier, webhooks, hook bridge names, replay, store reducer, owner revival); fleet nodes for a running contract with per-criterion readings, kill and steer on each node kind, owner repricing.
- Depends on: R.6, R.7.

**R.9 Persistence, resume and sessions.** Goal: contracts survive restarts and sessions carry the tree.
- `resume.ts`; `SessionManager` version 2 contract lines; hosted record `contractIds` and store version 2.
- Tests: a contract interrupted in each status resumes to the right step (planning restarts, held units re-check, in-phase items requeue with "Previous checks"); zombie contracts are reaped with `zombie`; version 1 session and hosted files load.
- Depends on: R.8.

**R.10 Entry points and call-site migration.** Goal: every call site in 11.3 uses the runner and every WRFC file in 11.2 is gone.
- The request-route dispatch (`contract.request-route`, fixtures, live calibration) in the core turn loop; `toolResultStartedContract`; the `agent` tool modes and batch path; `AgentManager.startForOwner` and the unit spawn guard; composition in `services.ts` and `agent-graph-composition.ts`; compaction; config consumers; proposals and workstream drafts through `startFromPlan`; the remaining rows of 11.3; the `tools/workflow` contract template.
- A repository search for `wrfc`, `Wrfc` and `WRFC` in `packages/engine` (excluding the legacy workmap retention patterns, which the task lists by path) returns nothing.
- The tests listed in 11.3 are re-expressed or removed as stated there, and pass.
- Depends on: R.9.

**R.11 Route selection.** Goal: the runner's `ContractRouteSelector` is the routing subsystem's route planner, picking from the whole catalog with no vendor or model names in its rules.
- `createRoutePlannerContractSelector(routing)` in `contract/route.ts` over the route planner task E.4 hoists; the reason string records the planner's tier and choice; wired in `services.ts`, `agent-graph-composition.ts` and the hosted floor.
- Tests with a fake route planner; the E.4 routing batteries it calls are already calibrated by E.4.
- Depends on: R.10 and ledger task E.4 (which does not depend on R, so there is no cycle; the ledger plan records this edge).

**R.12 CLI, daemon host, operator methods, external seam, embed.** Goal: the runner works as a CLI and as the daemon's hosted-session host, as section 10.
- `contract/cli.ts` and the bin; hosted floor, runtime and store changes; `contracts.*` methods with REST bindings; `createHostedContractWorkAdapter` and `createOperatorContractWorkAdapter`; embed spawn-mode start; artifacts regenerated.
- Tests: CLI commands and exit codes against a fake runner; hosted session turns start contracts, list them on the record, and route replies to open escalations; each operator method and REST route; both external adapters dispatch, poll, cancel and fetch results.
- Depends on: R.11.

**R.13 Proof and post-part audit.** Goal: a runnable proof shows the runner completing real multi-unit work end to end, and the part is audited.
- `packages/engine/scripts/contract-proof.ts`, run with `timeout 300 bun run --cwd packages/engine contract-proof` (script entry added to the engine `package.json`), live Jev and a configured model provider: it creates a temporary git repository with a small TypeScript project and a `test` gate, runs `goodvibes-contract run` with an ask that needs at least two implementation units and an integration unit (for example, add a parser module and a formatter module with tests, then wire them into a CLI command), and asserts from the contract store and the decision log that: the plan has at least three units with traced criteria; at least one unit received a nudge at completion and a later check of the same unit read every criterion met (the proof's ask includes a criterion the first attempt commonly misses, and if no natural nudge occurs the proof fails rather than passing silently); the group and deliverable checks passed; the deliverable was committed on the base branch with the gate passing; every Jev reading has a decision-log entry; the answer reached the owner record and the status line only the operator audience.
- The post-part audit note is written in `docs/audit/contract-runner.md` with every further place the judgment foundation applies in the runner and the files it touched, and each is implemented before the task closes.
- Depends on: R.12.

## Decisions taken in this design

- The runner builds on the ported orchestration engine (one engine per contract, one workstream per group, one work item per unit) instead of a new scheduler, because the engine already has the dependency gates, budget, elastic pool, attempts, worktree integration lane, persistence and requeue that WRFC's replacement needs. Alternative considered: a runner-owned scheduler over `AgentManager` directly; rejected as a second scheduler.
- Nudges at completion are delivered by holding the agent's loop open (a new hook) rather than letting it complete and waking it. Holding means failing work never emits `AGENT_COMPLETED` for a unit, and the correction is immediate. Waking is kept for agents that have already stopped. Alternative considered: wake-only; rejected because every nudge would flip the agent through completed and back.
- Mid-run nudges use the existing `steer` message kind, because it is injected verbatim as a user turn and has a consumed signal. Alternative considered: `directive`, which is framed as an inter-agent message and has no consumed signal.
- Worktree mode integrates units into a contract branch, and only the passing deliverable reaches the base branch. Alternative considered: integrating each unit into the base branch as the engine does for workstreams; rejected because work would land before it passed.
- Shared mode runs one unit at a time per working tree. Alternative considered: WRFC's cross-chain gate batching with attribution by Jev; rejected because a deterministic lock makes diff attribution exact and gates unambiguous.
- Criteria trace uses the fidelity pattern per criterion, with the quote check in code first, instead of a new per-item pattern in the judgment package.
- Owner approval can settle unshown readings, plans and attempt picks, never unmet criteria; the owner changes requirements through amend.
- Route selection is a required dependency wired to the routing subsystem (R.11 after E.4) rather than defaulting to the parent's model, which would be a fallback.

## Risks

- R.11 waits on ledger task E.4. Until it lands, R.12 and R.13 cannot close; R.1 to R.10 proceed with a fake selector in tests.
- The completion hold keeps a sub-agent's promise open during gates (up to `contract.gateTimeoutMs` per gate). A slow gate slows the unit but cannot hang it, because gates time out.
- Evidence trimming can hide the part of a large diff that proves a criterion. The judge's question counts missing evidence as not shown, so the result is an evidence nudge, not a false pass; the agent can cite the file and line.
- The proof depends on a first attempt missing a criterion. The proof's ask is chosen for that, and the proof fails loudly when no nudge happens so it never passes without exercising the loop.
- Renaming wire fields (`workflowChainId`, `chainId`, fleet kinds, event domains) changes contract schemas; R.8, R.10 and R.12 regenerate the artifacts and the web UI facade in the same task.
