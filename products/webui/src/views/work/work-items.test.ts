/**
 * The Work list model: grouping (Needs you, Running, Finished), kinds, the
 * known-cost rule (no "price unknown"), best-of-N collapse, the approval
 * de-duplication, and the one-line summary.
 */
import { describe, expect, test } from 'bun:test';
import type { ContractRecord, ApprovalRecord, FleetAttemptGroup, FleetProcessNode, HostedSessionRecord, RuntimeTaskSummary } from '../../lib/goodvibes';
import type { UnionSessionRecord } from '../../lib/sessions-union';
import { buildWorkItems, groupWorkItems, knownCost, whenLabel, workSummary, type CiWatch, type WorkSources } from './work-items';

function node(partial: Partial<FleetProcessNode> & { id: string }): FleetProcessNode {
  return {
    kind: 'agent', label: partial.id, state: 'thinking', elapsedMs: 1000, startedAt: 1_700_000_000_000,
    costUsd: null, costState: 'unpriced',
    capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
    ...partial,
  } as FleetProcessNode;
}

function approval(partial: Partial<ApprovalRecord> & { id: string }): ApprovalRecord {
  return {
    callId: 'c', status: 'pending', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, metadata: {},
    request: { callId: 'c', tool: 'bash', args: { command: 'bun test' }, category: 'shell', analysis: { riskLevel: 'medium', summary: 'run the tests', reasons: [] } },
    ...partial,
  } as ApprovalRecord;
}

function session(partial: Partial<UnionSessionRecord> & { id: string }): UnionSessionRecord {
  return {
    kind: 'tui', project: 'p', title: partial.id, status: 'active', createdAt: 0, updatedAt: 1_700_000_000_000,
    messageCount: 2, retainedMessageCount: null, pendingInputCount: 0, surfaceKinds: [], activeAgentId: '',
    lastError: '', closeReason: '', attributedPrincipalName: '', attributedPrincipalKnown: null, raw: {},
    ...partial,
  };
}

const EMPTY: WorkSources = { approvals: [], nodes: [], attemptGroups: [], sessions: [], hosted: [], tasks: [], ciWatches: [] };

describe('grouping', () => {
  test('a pending approval and an attention node need you; live work runs; terminal work is finished', () => {
    const items = buildWorkItems({
      ...EMPTY,
      approvals: [approval({ id: 'a1' })],
      nodes: [
        node({ id: 'blocked', needsAttention: { reason: 'input', detail: 'which migration?' } } as Partial<FleetProcessNode> & { id: string }),
        node({ id: 'live' }),
        node({ id: 'done', state: 'done' }),
      ],
    });
    const groups = groupWorkItems(items, 'all');
    expect(groups.needs.map((i) => i.key)).toEqual(['approval:a1', 'fleet:blocked']);
    expect(groups.running.map((i) => i.key)).toEqual(['fleet:live']);
    expect(groups.finished.map((i) => i.key)).toEqual(['fleet:done']);
    expect(groups.needs[1].attentionReason).toBe('input');
  });

  test('an approval-blocked node whose ask is already listed stays under Running, so the ask shows once', () => {
    const items = buildWorkItems({
      ...EMPTY,
      approvals: [approval({ id: 'a1', sessionId: 's1' })],
      nodes: [node({ id: 'n1', state: 'awaiting-approval', sessionRef: { sessionId: 's1', agentId: 'n1' }, needsAttention: { reason: 'approval' } } as Partial<FleetProcessNode> & { id: string })],
    });
    const groups = groupWorkItems(items, 'all');
    expect(groups.needs.map((i) => i.key)).toEqual(['approval:a1']);
    expect(groups.running.map((i) => i.key)).toEqual(['fleet:n1']);
  });

  test('kinds: sessions, agents and processes filter separately', () => {
    const task: RuntimeTaskSummary = { id: 't1', kind: 'exec', title: 'Build', status: 'running', owner: 'me', queuedAt: 1 };
    const hosted = { id: 'h1', title: 'Hosted one', status: 'idle', workspaceRoot: '/w', turnCount: 1, messageCount: 1, updatedAt: 1, effectiveDetachPolicy: 'kill', attachedClients: [] } as unknown as HostedSessionRecord;
    const watch = { id: 'w1', repo: 'o/r', prNumber: 7, deliveryChannel: 'slack', triggerFixSession: false, createdAt: 1, lastOverall: 'failed' } as unknown as CiWatch;
    const items = buildWorkItems({
      ...EMPTY,
      nodes: [node({ id: 'agent' }), node({ id: 'watcher', kind: 'watcher' })],
      sessions: [session({ id: 's1' })],
      hosted: [hosted],
      tasks: [task],
      ciWatches: [watch],
    });
    expect(groupWorkItems(items, 'sessions').running.map((i) => i.key)).toEqual(['hosted:h1', 'session:s1']);
    expect(groupWorkItems(items, 'agents').running.map((i) => i.key)).toEqual(['fleet:agent']);
    expect(groupWorkItems(items, 'processes').running.map((i) => i.key)).toEqual(['fleet:watcher', 'task:t1', 'ci-watch:w1']);
    const ci = items.find((i) => i.key === 'ci-watch:w1');
    expect(ci?.title).toBe('o/r #7');
    expect(ci?.tone).toBe('bad');
  });

  test('search matches title or meta', () => {
    const items = buildWorkItems({ ...EMPTY, sessions: [session({ id: 's1', title: 'Refactor the parser' }), session({ id: 's2', title: 'Other' })] });
    expect(groupWorkItems(items, 'all', 'parser').running.map((i) => i.key)).toEqual(['session:s1']);
  });

  test('a ready best-of-N group needs your pick and its sibling attempts collapse into it', () => {
    const group = { groupId: 'g1', sourceTitle: 'Build the widget', ready: true, candidates: [{ state: 'held-merge' }, { state: 'held-merge' }], judgment: null } as unknown as FleetAttemptGroup;
    const items = buildWorkItems({
      ...EMPTY,
      attemptGroups: [group],
      nodes: [node({ id: 'att-1', attemptGroup: { groupId: 'g1' } } as Partial<FleetProcessNode> & { id: string }), node({ id: 'other' })],
    });
    const groups = groupWorkItems(items, 'all');
    expect(groups.needs.map((i) => i.title)).toEqual(['Pick a winner: 2 attempts for Build the widget']);
    expect(items.some((i) => i.key === 'fleet:att-1')).toBe(false);
  });

  test('the archive lists every node as finished', () => {
    const items = buildWorkItems({ ...EMPTY, archived: true, nodes: [node({ id: 'a' })] });
    expect(items.map((i) => i.group)).toEqual(['finished']);
  });
});

describe('honest values', () => {
  test('cost shows only when the daemon priced it', () => {
    expect(knownCost(node({ id: 'x', costUsd: 0.3, costState: 'priced' }))).toBe('$0.30');
    expect(knownCost(node({ id: 'x', costUsd: 0.3, costState: 'estimated' }))).toBe('~$0.30');
    expect(knownCost(node({ id: 'x', costUsd: null, costState: 'unpriced' }))).toBeUndefined();
    expect(knownCost(node({ id: 'x', kind: 'observed-external', costUsd: 1, costState: 'priced' }))).toBeUndefined();
  });

  test('no epoch dates: a missing or zero time is empty', () => {
    expect(whenLabel(0)).toBe('');
    expect(whenLabel(undefined)).toBe('');
    expect(whenLabel(1_700_000_000_000)).not.toBe('');
  });

  test('the summary counts running work and what needs you', () => {
    const items = buildWorkItems({ ...EMPTY, approvals: [approval({ id: 'a1' })], nodes: [node({ id: 'live' })] });
    const withAsk = workSummary(items);
    const runningOnly = workSummary(buildWorkItems({ ...EMPTY, nodes: [node({ id: 'live' })] }));
    expect(withAsk).not.toBe(runningOnly);
    // Observed external agents are counted on their own, never as GoodVibes' running work.
    const withExternal = workSummary(buildWorkItems({ ...EMPTY, nodes: [node({ id: 'live' }), node({ id: 'ext', kind: 'observed-external' })] }));
    expect(withExternal).not.toBe(runningOnly);
    expect(withExternal.startsWith(runningOnly)).toBe(true);
  });
});


describe('contract rows', () => {
  function contract(id: string, status: ContractRecord['status']): ContractRecord {
    return {
      id, status, schemaVersion: 1, sessionId: 's', origin: 'external', ask: 'Original ask', goal: `Goal ${id}`,
      ownerAgentId: 'owner', projectRoot: '/project', isolation: 'shared', criteria: [], groups: [], units: [],
      checks: [], escalations: [], decisions: [], fixRounds: 0, plannerAgentIds: [], createdAt: 1000,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' },
      judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    };
  }
  test('recorded lifecycle determines active and terminal groups without creating an approval action', () => {
    const items = buildWorkItems({ ...EMPTY, contracts: [contract('live', 'awaiting-owner'), contract('done', 'passed'), contract('failed', 'failed'), contract('stopped', 'cancelled')] });
    expect(items.find((item) => item.id === 'live')).toMatchObject({ type: 'contract', kind: 'processes', group: 'running', status: 'Awaiting-owner' });
    expect(items.filter((item) => item.group === 'finished')).toHaveLength(3);
    expect(groupWorkItems(items, 'processes').running).toHaveLength(1);
    expect(groupWorkItems(items, 'sessions').running).toHaveLength(0);
  });
  test('the real fleet contract root is replaced once while child controls remain available', () => {
    const items = buildWorkItems({ ...EMPTY, contracts: [contract('c1', 'running')], nodes: [
      node({ id: 'contract:c1', kind: 'contract' }), node({ id: 'group:c1:g1', kind: 'contract-group', parentId: 'contract:c1' }),
    ] });
    expect(items.filter((item) => item.type === 'contract')).toHaveLength(1);
    expect(items.map((item) => item.key)).toEqual(['contract:c1', 'fleet:group:c1:g1']);
    expect(items[1].depth).toBe(1);
  });
  test('a deduplicated active root preserves the fleet’s authoritative attention signal', () => {
    const items = buildWorkItems({ ...EMPTY, contracts: [contract('c1', 'awaiting-owner')], nodes: [
      node({ id: 'contract:c1', kind: 'contract', needsAttention: { reason: 'input', detail: 'Recorded open question' } }),
    ] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'contract:c1', group: 'needs', tone: 'warn', attentionReason: 'input' });
  });
  test('archive never invents archived contract records', () => {
    expect(buildWorkItems({ ...EMPTY, contracts: [contract('done', 'passed')], archived: true })).toEqual([]);
  });
});
