/**
 * Work-plan and execution-plan sync (docs/design/contract-runner.md section
 * 6.5): each contract and each unit is a project work-plan task following its
 * status, and the execution-plan items a unit's agents worked on complete when
 * the unit passes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  CONTRACT_TASK_STATUS,
  UNIT_TASK_STATUS,
  contractTaskId,
  unitTaskId,
  type ExecutionPlans,
  type WorkPlanService,
} from '../../sdk/src/platform/contract/index.js';
import { makeHarness, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { contractOf, finishes, keepsFailing, routeAnswer, terminal } from './steps-support.js';

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

interface Write {
  readonly kind: 'create' | 'update';
  readonly taskId: string;
  readonly status: string | undefined;
  readonly source: string | undefined;
  readonly contractId: string | undefined;
  readonly parentTaskId: string | undefined;
}

/** A work-plan service that records every write and refuses a second create of the same task, as the real one does. */
function recordingWorkPlan(): { readonly service: WorkPlanService; readonly writes: Write[] } {
  const writes: Write[] = [];
  const created = new Set<string>();
  const service = {
    createWorkPlanTask: async (input: Parameters<WorkPlanService['createWorkPlanTask']>[0]) => {
      const taskId = input.task.taskId!;
      if (created.has(taskId)) throw new Error(`Work plan task already exists: ${taskId}`);
      created.add(taskId);
      writes.push({ kind: 'create', taskId, status: input.task.status, source: input.task.source, contractId: input.task.contractId, parentTaskId: input.task.parentTaskId });
    },
    updateWorkPlanTask: async (input: Parameters<WorkPlanService['updateWorkPlanTask']>[0]) => {
      writes.push({ kind: 'update', taskId: input.taskId, status: input.patch.status, source: input.patch.source, contractId: input.patch.contractId, parentTaskId: input.patch.parentTaskId });
    },
  };
  // The fake returns nothing; the runner never reads the mutation result.
  return { service: service as unknown as WorkPlanService, writes };
}

const statusesOf = (writes: readonly Write[], taskId: string): (string | undefined)[] => writes.filter((write) => write.taskId === taskId).map((write) => write.status);

describe('plan sync (6.5)', () => {
  test('the contract and its unit follow their statuses in the work plan, and the unit passing completes its execution-plan items', async () => {
    const { service, writes } = recordingWorkPlan();
    const updates: [string, string, string, string | undefined][] = [];
    let unitAgent: string | undefined;
    const planManager = {
      getActive: () => ({
        id: 'plan-1',
        items: [
          { id: 'i1', agentId: unitAgent, status: 'in_progress' },
          { id: 'i2', agentId: 'someone-else', status: 'in_progress' },
          { id: 'i3', agentId: unitAgent, status: 'complete' },
        ],
      }),
      updateItem: (planId: string, itemId: string, status: string, agentId?: string) => {
        updates.push([planId, itemId, status, agentId]);
      },
    };
    const h = makeHarness({
      plan: oneUnitPlan(1),
      scripts: { u1: (record, run) => { unitAgent = record.id; return finishes('parser written')(record, run); } },
      workPlanService: service,
      // The fake plan carries only the fields the sync reads.
      planManager: planManager as unknown as ExecutionPlans,
    });
    harness = h;
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    await waitFor(() => statusesOf(writes, contractTaskId(contract.id)).at(-1) === 'done', 'the contract task to be done');
    await waitFor(() => statusesOf(writes, unitTaskId(contract.id, 'u1')).at(-1) === 'done', 'the unit task to be done');

    const contractWrites = writes.filter((write) => write.taskId === contractTaskId(contract.id));
    expect(contractWrites[0]).toMatchObject({ kind: 'create', status: 'pending', source: 'contract', contractId: contract.id, parentTaskId: undefined });
    expect(contractWrites.slice(1).every((write) => write.kind === 'update')).toBe(true);
    expect(new Set(statusesOf(writes, contractTaskId(contract.id)))).toEqual(new Set(['pending', 'in_progress', 'done']));

    const unitWrites = writes.filter((write) => write.taskId === unitTaskId(contract.id, 'u1'));
    expect(unitWrites[0]).toMatchObject({ kind: 'create', source: 'contract', contractId: contract.id, parentTaskId: contractTaskId(contract.id) });
    expect(statusesOf(writes, unitTaskId(contract.id, 'u1'))).toEqual(['in_progress', 'in_progress', 'done']);

    expect(updates).toEqual([['plan-1', 'i1', 'complete', unitAgent]]);
  }, 20_000);

  test('a unit and contract waiting on the owner show as blocked', async () => {
    const { service, writes } = recordingWorkPlan();
    const h = makeHarness({ plan: oneUnitPlan(1), contract: { stallLimit: 2 }, scripts: { u1: keepsFailing(3) }, port: routeAnswer('owner'), workPlanService: service });
    harness = h;
    const { contract } = startContract(h);
    await waitFor(() => contractOf(h, contract.id).status === 'awaiting-owner', 'the owner to be asked', 15_000);
    await waitFor(() => statusesOf(writes, unitTaskId(contract.id, 'u1')).at(-1) === 'blocked', 'the unit task to be blocked');
    await waitFor(() => statusesOf(writes, contractTaskId(contract.id)).at(-1) === 'blocked', 'the contract task to be blocked');
  }, 20_000);

  test('every unit and contract status maps to a work-plan status', () => {
    expect(Object.entries(UNIT_TASK_STATUS).filter(([, status]) => status === 'in_progress').map(([unit]) => unit).sort()).toEqual(['checking', 'fixing', 'held', 'held-merge', 'nudged', 'running']);
    expect([UNIT_TASK_STATUS.pending, UNIT_TASK_STATUS.blocked, UNIT_TASK_STATUS['awaiting-owner'], UNIT_TASK_STATUS.passed, UNIT_TASK_STATUS.failed, UNIT_TASK_STATUS.cancelled])
      .toEqual(['pending', 'pending', 'blocked', 'done', 'failed', 'cancelled']);
    expect([CONTRACT_TASK_STATUS.queued, CONTRACT_TASK_STATUS.running, CONTRACT_TASK_STATUS['awaiting-owner'], CONTRACT_TASK_STATUS.passed]).toEqual(['pending', 'in_progress', 'blocked', 'done']);
  });
});
