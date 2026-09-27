/**
 * The correction and completion steps (docs/design/contract-runner.md
 * sections 5 and 6), put together: what the runner hands a unit, a group or
 * the contract to when a nudge is not the answer, and what it does when work
 * passes.
 *
 * - correction.ts: stall routing, planned-fix groups, fresh agents.
 * - completion.ts: group and deliverable checks, the commit, the answer.
 * - escalation.ts: owner escalations and reading the owner's replies.
 *
 * Each module acts on a contract through `ContractRun`, its `RunControl`, and
 * the runner parts in `StepContext`.
 */
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentManager, AgentRecord } from '../tools/agent/index.js';
import type { DecompositionRunner } from '../core/plan-decomposition.js';
import type { UnitCheckEscalations, UnitCheckLoop } from './agent-hooks.js';
import type { ContractConfigReader } from './config.js';
import { createCompletion } from './completion.js';
import { createCorrection } from './correction.js';
import { createEscalations, type OwnerReplyOutcome } from './escalation.js';
import type { GroupRunner, GroupSteps } from './group-runner.js';
import type { ContractPlannerDeps, PlanningOutcome, ShapeOutcome } from './planner.js';
import type { ContractRun } from './run-context.js';
import type { CheckTrigger, ContractRouteSelector } from './types.js';

/** The correction and completion steps: what the runner hands a unit, group or contract to when a nudge is not the answer. */
export interface ContractSteps extends UnitCheckEscalations, GroupSteps {}

/** The runner parts the steps act through. */
export interface StepContext {
  readonly agentManager: Pick<AgentManager, 'getStatus' | 'cancel'>;
  readonly configManager: ContractConfigReader;
  readonly runtimeBus: RuntimeEventBus;
  readonly routeSelector: ContractRouteSelector;
  readonly decompositionRunner: DecompositionRunner;
  readonly plannerDeps: (run: ContractRun) => ContractPlannerDeps;
  readonly getStatus: (agentId: string) => AgentRecord | null;
  /** The group runner (created after the steps; read when a step runs). */
  readonly groups: () => GroupRunner;
  /** The unit check loop (created after the steps; read when a step runs). */
  readonly checks: () => UnitCheckLoop;
  /** An owner reply settled the request shape or the plan: plan on, or start the accepted plan. */
  readonly continuePlanning: (run: ContractRun, outcome: ShapeOutcome | PlanningOutcome) => Promise<void>;
  /** The owner record's operator progress follows the contract's status. */
  readonly ownerProgress: (run: ContractRun) => void;
}

export interface ContractStepsWithReplies extends ContractSteps {
  /** An owner's free-text reply to an open escalation, read with the reply pattern (design 6.3). */
  reply(run: ContractRun, escalationId: string, text: string): Promise<OwnerReplyOutcome>;
  /** Judges a group now; a restart stopped it while it was being judged (design 7.2). */
  judgeGroup(run: ContractRun, groupId: string, trigger: CheckTrigger): Promise<void>;
  /** Judges the deliverable now; a restart stopped it while it was being judged. */
  judgeDeliverable(run: ContractRun, trigger: CheckTrigger): Promise<void>;
  /** Commits the passed deliverable; a restart stopped it while it was committing. */
  commitDeliverable(run: ContractRun): Promise<void>;
}

export function createContractSteps(context: StepContext): ContractStepsWithReplies {
  const escalations = createEscalations(context, {
    rejudgeGroup: (run, groupId) => completion.judgeGroup(run, groupId, 'owner-amend'),
    rejudgeDeliverable: (run) => completion.judgeDeliverable(run, 'owner-amend'),
  });
  const correction = createCorrection(context, {
    raise: escalations.raise,
    rejudgeGroup: (run, groupId) => completion.judgeGroup(run, groupId, 'fix-passed'),
    rejudgeDeliverable: (run) => completion.judgeDeliverable(run, 'fix-passed'),
  });
  const completion = createCompletion(context, correction);
  return {
    unitStalled: correction.unitStalled,
    unitAwaitsOwner: escalations.unitAwaitsOwner,
    unitMergeConflict: correction.unitMergeConflict,
    attemptsUndecided: escalations.attemptsUndecided,
    groupUnitsPassed: completion.groupUnitsPassed,
    groupsPassed: completion.groupsPassed,
    fixGroupPassed: correction.fixGroupPassed,
    reply: escalations.reply,
    judgeGroup: completion.judgeGroup,
    judgeDeliverable: completion.judgeDeliverable,
    commitDeliverable: completion.commitDeliverable,
  };
}
