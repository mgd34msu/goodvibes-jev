/**
 * PlanProposal to contract (proposal-workstream.ts, design 10.4).
 * draftFromProposal maps one drafted unit per proposal item (title, brief,
 * dependencies, likely files, attempts) with the proposal's task as the goal,
 * and refuses a dangling dependency or a cycle. fromPlanProposal and
 * approveAndLaunchProposal launch it through runner.startFromPlan.
 */
import { describe, expect, test } from 'bun:test';
import {
  approveAndLaunchProposal,
  draftFromProposal,
  fromPlanProposal,
} from '../sdk/src/platform/orchestration/proposal-workstream.js';
import type { PlanProposal, WorkItem as ProposalWorkItem } from '../sdk/src/platform/core/plan-proposal.js';
import type { ContractRunner, StartedContract } from '../sdk/src/platform/contract/runner.js';
import type { StartFromPlanInput } from '../sdk/src/platform/contract/types.js';

function proposalItem(overrides: Partial<ProposalWorkItem> & { id: string; title: string; brief: string }): ProposalWorkItem {
  return {
    phaseId: 'phase-exec',
    dependsOn: [],
    ...overrides,
  };
}

function makeProposal(items: ProposalWorkItem[], overrides: Partial<PlanProposal> = {}): PlanProposal {
  return {
    id: 'prop-1',
    task: 'Build the thing',
    strategy: 'cohort',
    rationale: 'because',
    phases: [{ id: 'phase-exec', title: 'Execute', order: 1 }],
    workItems: items,
    createdAt: 1,
    source: 'planner-agent',
    ...overrides,
  };
}

/** A runner that records every startFromPlan call and answers with a fixed contract and owner. */
function recordingRunner(): { runner: Pick<ContractRunner, 'startFromPlan'>; calls: StartFromPlanInput[] } {
  const calls: StartFromPlanInput[] = [];
  return {
    calls,
    runner: {
      startFromPlan(input) {
        calls.push(input);
        return { contract: { id: 'contract-1' }, owner: { id: 'agent-owner-1' } } as unknown as StartedContract;
      },
    },
  };
}

const launch = { sessionId: 'session-1', projectRoot: '/repo' } as const;

describe('draftFromProposal: unit mapping', () => {
  test('one unit per proposal item; title and brief carried verbatim; the task is the goal', () => {
    const plan = draftFromProposal(makeProposal([
      proposalItem({ id: 'a', title: 'Item A', brief: 'do A carefully' }),
      proposalItem({ id: 'b', title: 'Item B', brief: 'do B next', dependsOn: ['a'] }),
    ]));
    expect(plan.goal).toBe('Build the thing');
    expect(plan.units).toEqual([
      { id: 'a', title: 'Item A', brief: 'do A carefully', dependsOn: [] },
      { id: 'b', title: 'Item B', brief: 'do B next', dependsOn: ['a'] },
    ]);
  });

  test('likely files become the unit files and attempts carry through; empty files are omitted', () => {
    const plan = draftFromProposal(makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a', likelyFiles: ['src/a.ts'], attempts: 3 }),
      proposalItem({ id: 'b', title: 'B', brief: 'b', likelyFiles: [] }),
    ]));
    expect(plan.units[0]).toEqual({ id: 'a', title: 'A', brief: 'a', dependsOn: [], files: ['src/a.ts'], attempts: 3 });
    expect(plan.units[1]).toEqual({ id: 'b', title: 'B', brief: 'b', dependsOn: [] });
  });
});

describe('draftFromProposal: assemble-time assertions', () => {
  test('throws on a dangling dependency id', () => {
    const proposal = makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a' }),
      proposalItem({ id: 'b', title: 'B', brief: 'b', dependsOn: ['nonexistent'] }),
    ]);
    expect(() => draftFromProposal(proposal)).toThrow(/unknown item id "nonexistent"/);
  });

  test('throws on a dependency cycle', () => {
    const proposal = makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a', dependsOn: ['b'] }),
      proposalItem({ id: 'b', title: 'B', brief: 'b', dependsOn: ['a'] }),
    ]);
    expect(() => draftFromProposal(proposal)).toThrow(/cycle detected/);
  });

  test('throws on a self-dependency (degenerate cycle)', () => {
    const proposal = makeProposal([proposalItem({ id: 'a', title: 'A', brief: 'a', dependsOn: ['a'] })]);
    expect(() => draftFromProposal(proposal)).toThrow(/cycle detected/);
  });

  test('accepts a valid diamond (D deps B,C; B,C dep A)', () => {
    const plan = draftFromProposal(makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a' }),
      proposalItem({ id: 'b', title: 'B', brief: 'b', dependsOn: ['a'] }),
      proposalItem({ id: 'c', title: 'C', brief: 'c', dependsOn: ['a'] }),
      proposalItem({ id: 'd', title: 'D', brief: 'd', dependsOn: ['b', 'c'] }),
    ]));
    expect(plan.units.find((unit) => unit.id === 'd')!.dependsOn).toEqual(['b', 'c']);
  });
});

describe('fromPlanProposal: launch through the runner', () => {
  test('starts the drafted plan with origin proposal, the task as the ask, and the launch inputs', () => {
    const { runner, calls } = recordingRunner();
    const proposal = makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a' }),
      proposalItem({ id: 'b', title: 'B', brief: 'b', dependsOn: ['a'] }),
    ]);
    const started = fromPlanProposal(runner, proposal, { ...launch, isolation: 'worktree', parentAgentId: 'agent-parent' });
    expect(started.contract.id).toBe('contract-1');
    expect(calls).toEqual([{
      ask: 'Build the thing',
      sessionId: 'session-1',
      origin: 'proposal',
      projectRoot: '/repo',
      draft: draftFromProposal(proposal),
      isolation: 'worktree',
      parentAgentId: 'agent-parent',
    }]);
  });

  test('a cycle throws before anything starts', () => {
    const { runner, calls } = recordingRunner();
    const proposal = makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a', dependsOn: ['b'] }),
      proposalItem({ id: 'b', title: 'B', brief: 'b', dependsOn: ['a'] }),
    ]);
    expect(() => fromPlanProposal(runner, proposal, launch)).toThrow(/cycle detected/);
    expect(calls).toHaveLength(0);
  });
});

describe('approveAndLaunchProposal: one confirmed act', () => {
  const proposal = makeProposal([proposalItem({ id: 'wi-1', title: 'Ship it', brief: 'do the shipping' })], { task: 'ship the thing' });

  test('without confirm: structured refusal, nothing started', () => {
    const { runner, calls } = recordingRunner();
    expect(approveAndLaunchProposal(runner, proposal, launch, {})).toEqual({ launched: false, requiresConfirm: true });
    expect(calls).toHaveLength(0);
  });

  test('with confirm: the contract starts in one call and its ids come back', () => {
    const { runner, calls } = recordingRunner();
    expect(approveAndLaunchProposal(runner, proposal, launch, { confirm: true })).toEqual({
      launched: true,
      contractId: 'contract-1',
      ownerAgentId: 'agent-owner-1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.draft).toEqual({ goal: 'ship the thing', units: [{ id: 'wi-1', title: 'Ship it', brief: 'do the shipping', dependsOn: [] }] });
  });
});
