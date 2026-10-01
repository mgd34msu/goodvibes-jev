import { describe, expect, test } from 'bun:test';
import { summarizeRunningAgents } from '../../renderer/process-summary.ts';
import { contractFixture, contractUnit } from '../helpers/contract-work-tree-fixtures.ts';

describe('summarizeRunningAgents', () => {
  test('counts active manager and runtime agents once', () => {
    const summary = summarizeRunningAgents([{ id: 'agent-1', progress: 'doing work' }], [{ id: 'agent-1', latestProgress: 'runtime work' }, { id: 'agent-2' }], []);
    expect(summary.count).toBe(2);
    expect(summary.progress).toBe('doing work');
  });
  test('does not add a contract owner to its active worker count', () => {
    const summary = summarizeRunningAgents([{ id: 'worker', progress: 'repairing' }, { id: 'owner', contractRole: 'owner' }], [{ id: 'owner' }], [contractFixture({ status: 'running' })]);
    expect(summary.count).toBe(1);
    expect(summary.progress).toBe('repairing');
  });
  test.each(['passed', 'failed', 'cancelled'] as const)('%s contract members cannot keep a stale runtime running badge alive', (status) => {
    const summary = summarizeRunningAgents([{ id: 'worker' }, { id: 'owner' }, { id: 'independent' }], [{ id: 'worker' }], [contractFixture({ status })]);
    expect(summary.count).toBe(1);
    expect(summary.progress).toBeUndefined();
  });
  test('uses typed contract status when active members have no progress text', () => {
    const summary = summarizeRunningAgents([{ id: 'worker' }], [], [contractFixture({ status: 'fixing' })]);
    expect(summary.progress).toBe('Contract fixing');
    expect(summary.count).toBe(1);
  });
  test('planner and nested attempt identities participate without counting the wrapper', () => {
    const contract = contractFixture({ status: 'running', plannerAgentIds: ['planner'], units: [contractUnit({ agentIds: [], attemptUnits: [contractUnit({ id: 'u1.a1', agentIds: ['attempt'] })] })] });
    expect(summarizeRunningAgents([{ id: 'planner' }, { id: 'attempt' }], [{ id: 'attempt' }], [contract]).count).toBe(2);
  });
  test('terminal agent statuses and typed owner roles are respected even without retained contracts', () => {
    expect(summarizeRunningAgents([{ id: 'old', status: 'cancelled' }, { id: 'owner', contractRole: 'owner' }], [{ id: 'owner2', contractRef: { contractId: 'c2', contractRole: 'owner' } }], []).count).toBe(0);
  });
});
