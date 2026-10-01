import { describe, expect, test } from 'bun:test';
import type { ContractRunner, ContractView, OwnerReplyOutcome } from '@goodvibes-jev/engine/sdk/platform/contract';
import type { AgentManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { SessionViews } from '../../shell/session-views.ts';
import { contractFixture } from '../helpers/contract-work-tree-fixtures.ts';

const text = (lines: readonly import('@goodvibes-jev/engine/sdk/platform/types').Line[]): string => lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');
function setup(initial: ContractView, replyResult: Promise<OwnerReplyOutcome> = Promise.resolve({ escalationId: 'e1', reading: 'approve', outcome: 'act', action: 'approved' })) {
  let contract = initial;
  let genericKills = 0;
  let genericSteers = 0;
  const cancelled: string[] = [];
  const replies: string[][] = [];
  let renders = 0;
  const record: NonNullable<ReturnType<AgentManager['getStatus']>> = { id: 'owner', template: 'engineer', task: initial.ask, status: 'completed', startedAt: 1000, completedAt: 2000, tools: [], toolCallCount: 0,
    contractId: initial.id, contractRole: 'owner', orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'contract', communicationLane: 'parent-only' };
  const runner: Pick<ContractRunner, 'get' | 'cancel' | 'reply'> = {
    get: () => contract,
    cancel: (id, reason) => { cancelled.push(id, reason); contract = { ...contract, status: 'cancelled' }; return true; },
    reply: (id, escalationId, body) => { replies.push([id, escalationId, body]); return replyResult; },
  };
  const views = new SessionViews({
    conversation: { laneColorOf: () => 1, getWorkTreeSources: () => ({}), getTreeGlyphSet: () => 'rounded' },
    agentManager: { list: () => [record], getStatus: () => record, getConversationSnapshot: () => [] },
    processManager: { list: () => [], getStatus: () => null, stop: () => false }, fleetNodes: () => [], contractRunner: runner,
    steer: () => { genericSteers++; return { queued: true, messageId: 'steer1' }; }, killAgent: () => { genericKills++; return ['owner']; },
    mainBusy: () => false, mainModel: () => 'synthetic', promptText: () => '', requestRender: () => { renders++; }, now: () => 3000, pollMs: 0,
  });
  views.open({ kind: 'agent', id: 'owner' });
  return { views, cancelled, replies, calls: () => ({ genericKills, genericSteers, renders }), update: (next: ContractView) => { contract = next; } };
}
const question = { id: 'e1', at: 1500, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'Apply the repair?', unmetCriterionIds: ['c1'] } as const;

describe('contract owner session controls', () => {
  test('stop confirmation cancels the real contract even while its owner record is completed', () => {
    const s = setup(contractFixture({ status: 'running', completedAt: undefined }));
    expect(s.views.frame(120)?.footer.keys).toContainEqual(['ctrl+x', 'stop contract']);
    s.views.pressStop();
    expect(s.cancelled).toHaveLength(0);
    s.views.pressStop();
    expect(s.cancelled[0]).toBe('contract-1');
    expect(s.calls().genericKills).toBe(0);
    expect(s.views.frame(120)?.footer.notice?.text).toContain('Stopped the contract');
  });
  test('owner questions use the asynchronous runner reply and never a synthetic steer inbox', async () => {
    const s = setup(contractFixture({ status: 'awaiting-owner', completedAt: undefined, escalations: [question] }));
    expect(s.views.frame(120)?.footer.placeholder).toBe('Reply to the contract owner question.');
    expect(s.views.steer('Apply it')).toBe(true);
    expect(s.views.steer('Duplicate')).toBe(false);
    expect(s.replies).toEqual([['contract-1', 'e1', 'Apply it']]);
    expect(s.calls().genericSteers).toBe(0);
    await Promise.resolve(); await Promise.resolve();
    expect(s.views.frame(120)?.footer.notice?.text).toContain('Owner reply accepted');
  });
  test('an active contract without an owner question refuses generic steering', () => {
    const s = setup(contractFixture({ status: 'running', completedAt: undefined }));
    expect(s.views.steer('change it')).toBe(false);
    expect(s.calls().genericSteers).toBe(0);
    expect(s.replies).toHaveLength(0);
  });
  test('terminal contract views repaint a late commit note with an unchanged owner record', () => {
    const contract = contractFixture();
    const s = setup(contract);
    expect(text(s.views.frame(120)!.body(40))).not.toContain('commit failed');
    s.update({ ...contract, commit: { status: 'failed', note: 'not applied' } });
    const after = text(s.views.frame(120)!.body(40));
    expect(after).toContain('passed · commit failed: not applied');
    expect(s.views.frame(120)?.footer.keys.some((entry) => entry[0] === 'ctrl+x')).toBe(false);
  });
});
