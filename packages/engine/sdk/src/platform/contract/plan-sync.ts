/**
 * Work-plan and execution-plan sync (docs/design/contract-runner.md section
 * 6.5): the project work plan shows each contract as a task and each of its
 * units as a child task, following their statuses; and when a unit passes,
 * the active execution-plan items its agents were working on are marked
 * complete (when the unit passes, not when its agent completes, since a
 * completed agent's work may still be corrected).
 *
 * Work-plan writes are serialized per task id, so a quick run of status
 * changes lands in order; a failed write is logged, never thrown into the
 * runner.
 */
import type { ContractEvent } from '../../events/contract.js';
import type { ExecutionPlanManager } from '../core/execution-plan.js';
import type { ProjectPlanningService } from '../knowledge/project-planning/service.js';
import type { ProjectWorkPlanTaskStatus } from '../knowledge/project-planning/types.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type { ContractStatus, ContractView, UnitStatus } from './types.js';

export type WorkPlanService = Pick<ProjectPlanningService, 'createWorkPlanTask' | 'updateWorkPlanTask'>;
export type ExecutionPlans = Pick<ExecutionPlanManager, 'getActive' | 'updateItem'>;

/** The work-plan source every contract task carries. */
export const CONTRACT_WORK_PLAN_SOURCE = 'contract';

/** The status a unit's work-plan task shows (design 6.5). */
export const UNIT_TASK_STATUS: Readonly<Record<UnitStatus, ProjectWorkPlanTaskStatus>> = {
  pending: 'pending',
  blocked: 'pending',
  running: 'in_progress',
  checking: 'in_progress',
  held: 'in_progress',
  nudged: 'in_progress',
  fixing: 'in_progress',
  'held-merge': 'in_progress',
  'awaiting-owner': 'blocked',
  passed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** The status a contract's work-plan task shows. */
export const CONTRACT_TASK_STATUS: Readonly<Record<ContractStatus, ProjectWorkPlanTaskStatus>> = {
  queued: 'pending',
  shaping: 'in_progress',
  planning: 'in_progress',
  'checking-plan': 'in_progress',
  running: 'in_progress',
  judging: 'in_progress',
  fixing: 'in_progress',
  committing: 'in_progress',
  'awaiting-owner': 'blocked',
  passed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function contractTaskId(contractId: string): string {
  return `contract-${contractId}`;
}

export function unitTaskId(contractId: string, unitId: string): string {
  return `contract-${contractId}-${unitId}`;
}

function titleOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

/**
 * Marks complete every active execution-plan item whose agent is one of the
 * unit's agents and that is not already complete or failed.
 */
export function completePlanItemsForUnit(agentIds: readonly string[], planManager: ExecutionPlans): void {
  const plan = planManager.getActive();
  if (!plan) return;
  const agents = new Set(agentIds);
  for (const item of plan.items) {
    if (item.agentId === undefined || !agents.has(item.agentId) || item.status === 'complete' || item.status === 'failed') continue;
    try {
      planManager.updateItem(plan.id, item.id, 'complete', item.agentId);
    } catch (error) {
      logger.warn('contract runner: an execution-plan item was not updated', { planId: plan.id, itemId: item.id, error: summarizeError(error) });
    }
  }
}

export interface ContractPlanSyncDeps {
  readonly workPlanService?: WorkPlanService | undefined;
  readonly planManager?: ExecutionPlans | undefined;
  /** The contract as it stands, for titles and agent ids. */
  readonly getContract: (contractId: string) => ContractView | null;
}

export interface ContractPlanSync {
  /** The runner listener: every contract event goes through it. */
  readonly onEvent: (event: ContractEvent) => void;
  /** Resolves once every queued work-plan write finished. */
  flush(): Promise<void>;
}

export function createContractPlanSync(deps: ContractPlanSyncDeps): ContractPlanSync {
  const queues = new Map<string, Promise<void>>();
  /** Task ids created in this process; the first write for any other id creates it, falling back to an update when it exists. */
  const known = new Set<string>();

  function enqueue(taskId: string, operation: (service: WorkPlanService) => Promise<void>): void {
    const service = deps.workPlanService;
    if (service === undefined) return;
    const previous = queues.get(taskId) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(() => operation(service))
      .catch((error: unknown) => logger.warn('contract runner: a work-plan task was not synced', { taskId, error: summarizeError(error) }))
      .finally(() => {
        if (queues.get(taskId) === next) queues.delete(taskId);
      });
    queues.set(taskId, next);
  }

  function upsert(taskId: string, task: {
    readonly title: string;
    readonly notes: string;
    readonly status: ProjectWorkPlanTaskStatus;
    readonly contractId: string;
    readonly parentTaskId?: string | undefined;
    readonly agentId?: string | undefined;
    readonly metadata: Record<string, unknown>;
  }): void {
    enqueue(taskId, async (service) => {
      const fields = {
        title: task.title,
        notes: task.notes,
        owner: task.parentTaskId === undefined ? 'contract' : 'unit',
        status: task.status,
        source: CONTRACT_WORK_PLAN_SOURCE,
        // The work plan's correlation field; renamed to contractId with the wire schemas (design 11.3).
        contractId: task.contractId,
        originSurface: 'daemon',
        tags: ['contract', ...(task.parentTaskId === undefined ? [] : ['unit'])],
        ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
        ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
        metadata: task.metadata,
      };
      if (!known.has(taskId)) {
        try {
          await service.createWorkPlanTask({ task: { taskId, ...fields } });
          known.add(taskId);
          return;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('already exists')) throw error;
          known.add(taskId);
        }
      }
      await service.updateWorkPlanTask({ taskId, patch: fields });
    });
  }

  function onEvent(event: ContractEvent): void {
    switch (event.type) {
      case 'CONTRACT_CREATED':
        upsert(contractTaskId(event.contractId), {
          title: titleOf(event.ask),
          notes: `Contract ${event.contractId}: the work is checked against its acceptance criteria while it runs.`,
          status: 'pending',
          contractId: event.contractId,
          agentId: event.ownerAgentId,
          metadata: { contractStatus: 'queued', origin: event.origin },
        });
        return;
      case 'CONTRACT_STATUS_CHANGED': {
        const contract = deps.getContract(event.contractId);
        upsert(contractTaskId(event.contractId), {
          title: titleOf(contract?.ask ?? event.contractId),
          notes: contract?.goal ? `Goal: ${contract.goal}` : `Contract ${event.contractId}`,
          status: CONTRACT_TASK_STATUS[event.to],
          contractId: event.contractId,
          metadata: { contractStatus: event.to, ...(contract?.statusLine === undefined ? {} : { statusLine: contract.statusLine }) },
        });
        return;
      }
      case 'CONTRACT_UNIT_STATUS_CHANGED': {
        const contract = deps.getContract(event.contractId);
        const unit = contract?.units.flatMap((candidate) => [candidate, ...(candidate.attemptUnits ?? [])]).find((candidate) => candidate.id === event.unitId);
        upsert(unitTaskId(event.contractId, event.unitId), {
          title: titleOf(unit?.title ?? event.unitId),
          notes: unit === undefined ? `Unit ${event.unitId}` : `Goal: ${unit.goal}`,
          status: UNIT_TASK_STATUS[event.to],
          contractId: event.contractId,
          parentTaskId: contractTaskId(event.contractId),
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          metadata: { unitStatus: event.to, contractUnitId: event.unitId, groupId: event.groupId },
        });
        if (event.to === 'passed' && deps.planManager !== undefined && unit !== undefined) completePlanItemsForUnit(unit.agentIds, deps.planManager);
        return;
      }
      default:
        return;
    }
  }

  return {
    onEvent,
    flush: async () => {
      while (queues.size > 0) await Promise.all([...queues.values()]);
    },
  };
}
