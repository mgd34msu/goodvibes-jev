import { describe, expect, test } from 'bun:test';
import { createContractOperatorService, type OperatorContractRunner, type ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerWorkstreamRuntimeCommands } from '../../input/commands/workstream-runtime.ts';
import { contractFixture } from '../helpers/contract-work-tree-fixtures.ts';

function fixture(records: ContractView[], overrides: Partial<OperatorContractRunner> = {}) {
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
    reply: async (id, escalationId, text) => { actions.push(['reply', id, escalationId, text]); return { escalationId, reading: 'approve', outcome: 'act', action: 'approved' }; },
    ...overrides,
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
  test('every current action reports unavailable when no contract operator is present', async () => {
    const registry = new CommandRegistry();
    registerWorkstreamRuntimeCommands(registry);
    const output: string[] = [];
    const context = { session: { runtime: { sessionId: 'test-session' } }, print: (text: string) => output.push(text) } as unknown as CommandContext;
    for (const action of ['start', 'list', 'status', 'cancel', 'reply']) await registry.execute('workstream', [action], context);
    expect(output).toEqual(Array(5).fill('Workstreams are not available in this session.'));
  });

  test('empty start refuses without calling the runner', async () => {
    const f = fixture([]);
    await f.run(['start']);
    expect(f.actions).toEqual([]);
    expect(f.output).toEqual(['Usage: /workstream start <request>']);
  });

  test('list is honest when empty and isolates the current session', async () => {
    const empty = fixture([]);
    await empty.run(['list']);
    expect(empty.output).toEqual(['No workstreams in this session.']);
    const f = fixture([contractFixture({ id: 'mine', status: 'running' }), contractFixture({ id: 'outside', sessionId: 'other' })]);
    await f.run(['list']);
    expect(f.output.join('\n')).toContain('mine: running');
    expect(f.output.join('\n')).not.toContain('outside');
  });

  test('status renders recorded contract facts and unresolved owner questions', async () => {
    const record = contractFixture({ id: 'contract-view', status: 'awaiting-owner', statusLine: 'Waiting for your decision',
      commit: { status: 'failed', note: 'Working tree changed' },
      escalations: [{ id: 'q-open', at: 1, scope: 'deliverable', targetId: 'contract-view', reason: 'unsettled', question: 'Keep the repair?', unmetCriterionIds: [] },
        { id: 'q-old', at: 1, scope: 'deliverable', targetId: 'contract-view', reason: 'unsettled', question: 'Old question', unmetCriterionIds: [], resolvedAt: 2 }],
    });
    const f = fixture([record]);
    await f.run(['status', 'contract-v']);
    const output = f.output.join('\n');
    expect(output).toContain('contract-view: awaiting-owner');
    expect(output).toContain(record.ask);
    expect(output).toContain('Working tree changed');
    expect(output).toContain('Owner question q-open: Keep the repair?');
    expect(output).not.toContain('Old question');
    for (const group of record.groups) expect(output).toContain(`Group ${group.id}: ${group.status}`);
    for (const unit of record.units) expect(output).toContain(`Unit ${unit.id}: ${unit.status}`);
  });

  test('unknown references cannot status, cancel or reply', async () => {
    const f = fixture([contractFixture()]);
    for (const action of ['status', 'cancel', 'reply']) await f.run([action, 'missing', 'q', 'yes']);
    expect(f.actions).toEqual([]);
    expect(f.output).toEqual(Array(3).fill('Choose one exact or unambiguous workstream ID from /workstream list.'));
  });

  test('cancellation reaches selected active contracts in waiting and repair phases', async () => {
    for (const status of ['queued', 'planning', 'running', 'fixing', 'awaiting-owner'] as const) {
      const f = fixture([contractFixture({ id: 'selected', status }), contractFixture({ id: 'other', status })]);
      await f.run(['cancel', 'selected']);
      expect(f.actions).toEqual([['cancel', 'selected', 'Stopped by the user from /workstream']]);
      expect(f.output).toEqual(['Stopped workstream selected.']);
    }
  });

  test('cancellation of an already-ended contract reports no stop', async () => {
    const f = fixture([contractFixture({ id: 'ended', status: 'passed' })], { cancel: () => false });
    await f.run(['cancel', 'ended']);
    expect(f.output).toEqual(['Workstream ended has already ended.']);
  });

  test('terminal, resolved and incomplete replies never reach the runner', async () => {
    const question = { id: 'q', at: 1, scope: 'deliverable' as const, targetId: 'contract-1', reason: 'unsettled' as const, question: 'Proceed?', unmetCriterionIds: [] };
    const ended = fixture([contractFixture({ status: 'passed', escalations: [question] })]);
    await ended.run(['reply', 'contract-1', 'q', 'yes']);
    expect(ended.actions).toEqual([]);
    expect(ended.output).toEqual(['That owner question is no longer open. Inspect /workstream status before answering.']);
    const resolved = fixture([contractFixture({ status: 'awaiting-owner', escalations: [{ ...question, resolvedAt: 2 }] })]);
    await resolved.run(['reply', 'contract-1', 'q', 'yes']);
    await resolved.run(['reply', 'contract-1', 'q']);
    expect(resolved.actions).toEqual([]);
    expect(resolved.output[0]).toContain('no longer open');
    expect(resolved.output[1]).toContain('Usage: /workstream reply');
  });

  test('runner failures are reported rather than claiming success', async () => {
    const f = fixture([], { start: () => { throw new Error('Synthetic runner failed'); } });
    await f.run(['start', 'Repair']);
    expect(f.actions).toEqual([]);
    expect(f.output.join('\n')).toContain('Workstream action failed: Synthetic runner failed');
  });

  test('retired draft editing and phase actions cannot mutate contracts', async () => {
    const f = fixture([contractFixture()]);
    for (const action of ['create', 'approve', 'launch', 'edit', 'edit-item', 'remove-item', 'move-item', 'insert-phase']) {
      await f.run([action, 'contract-1', '--isolation', 'worktree']);
    }
    expect(f.actions).toEqual([]);
    expect(f.output).toHaveLength(8);
    expect(f.output.every(line => line.startsWith('Usage: /workstream start'))).toBe(true);
  });

});
