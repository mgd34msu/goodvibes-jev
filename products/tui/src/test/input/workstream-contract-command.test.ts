import { describe, expect, test } from 'bun:test';
import { createContractOperatorService, type OperatorContractRunner, type ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerWorkstreamRuntimeCommands } from '../../input/commands/workstream-runtime.ts';
import { contractFixture } from '../helpers/contract-work-tree-fixtures.ts';

function fixture(records: ContractView[]) {
  const actions: unknown[][] = [];
  const output: string[] = [];
  const runner: OperatorContractRunner = {
    list: filter => records.filter(record => !filter?.sessionId || record.sessionId === filter.sessionId),
    get: id => records.find(record => record.id === id) ?? null,
    start: input => {
      actions.push(['start', input]);
      const contract = contractFixture({ id: 'new-contract', ask: input.ask, sessionId: input.sessionId, status: 'queued' });
      return { contract, owner: { id: contract.ownerAgentId, task: input.ask, template: 'engineer', status: 'running', startedAt: 1, tools: [], toolCallCount: 0, orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'contract', communicationLane: 'parent-only' } };
    },
    cancel: (id, reason) => { actions.push(['cancel', id, reason]); return true; },
    reply: async (id, escalationId, text) => { actions.push(['reply', id, escalationId, text]); return { escalationId, reading: 'approve', outcome: 'act', action: 'approve' }; },
  };
  const service = createContractOperatorService({ runner, workingDirectory: '/synthetic/project' });
  const registry = new CommandRegistry();
  registerWorkstreamRuntimeCommands(registry);
  const context = { session: { runtime: { sessionId: 'test-session' }, contractOperator: service }, print: (text: string) => output.push(text), renderRequest: () => {} } as unknown as CommandContext;
  return { actions, output, run: (args: string[]) => registry.execute('workstream', args, context) };
}

describe('workstream commands use the public contract operator', () => {
  test('explicit start preserves the whole request and current session', async () => {
    const f = fixture([]);
    await f.run(['start', 'Repair', 'the', 'retry', 'cap']);
    expect(f.actions).toHaveLength(1);
    expect(f.actions[0]?.[0]).toBe('start');
    expect(f.actions[0]?.[1]).toMatchObject({ ask: 'Repair the retry cap', sessionId: 'test-session', projectRoot: '/synthetic/project' });
    expect(f.output.join('\n')).toContain('new-contract: queued');
  });
  test('ambiguous or other-session references never cancel', async () => {
    const f = fixture([contractFixture({ id: 'contract-a' }), contractFixture({ id: 'contract-b' }), contractFixture({ id: 'outside', sessionId: 'other' })]);
    await f.run(['cancel', 'contract']);
    await f.run(['cancel', 'outside']);
    expect(f.actions).toEqual([]);
  });
  test('real cancellation routes only the selected ID and reports the result', async () => {
    const f = fixture([contractFixture({ id: 'contract-a', status: 'running' })]);
    await f.run(['cancel', 'contract-a']);
    expect(f.actions[0]?.slice(0, 2)).toEqual(['cancel', 'contract-a']);
    expect(f.output.join('\n')).toContain('Stopped workstream contract-a');
  });
  test('owner reply requires the selected open question; stale question has no action', async () => {
    const f = fixture([contractFixture({ status: 'awaiting-owner', escalations: [{ id: 'question-1', at: 1, scope: 'deliverable', targetId: 'contract-1', reason: 'unsettled', question: 'Apply?', unmetCriterionIds: [] }] })]);
    await f.run(['reply', 'contract-1', 'old-question', 'yes']);
    expect(f.actions).toEqual([]);
    await f.run(['reply', 'contract-1', 'question-1', 'Keep', 'the', 'repair']);
    expect(f.actions).toEqual([['reply', 'contract-1', 'question-1', 'Keep the repair']]);
  });
  test('legacy draft approval cannot silently start a contract', async () => {
    const f = fixture([]);
    await f.run(['create', 'change', 'files']);
    await f.run(['approve', 'draft']);
    expect(f.actions).toEqual([]);
    expect(f.output.join('\n')).toContain('Usage: /workstream start');
  });
});
