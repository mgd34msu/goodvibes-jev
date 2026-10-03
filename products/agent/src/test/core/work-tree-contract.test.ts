import { collectToolCallOutcomes, collectCompletedToolCallIds } from '../../core/conversation-render-context.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { AgentManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';
import { ConversationManager } from '../../core/conversation.ts';
import { wireWorkTree } from '../../core/work-tree-wiring.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { renderAgentView } from '../../core/agent-view-render.ts';
import { buildContractOwnerModel, buildTurnModel, orphanResultBead, transcriptUnits, turnSignature } from '../../core/work-tree-model.ts';
import { renderTurn } from '../../core/work-tree-render.ts';
import { contractStatusSummary, projectContractTree } from '../../core/work-tree-contract.ts';
import type { AgentLaneInfo, WorkTreeSources } from '../../core/work-tree-sources.ts';
import { contractFixture, contractUnit, contractCriterion } from '../helpers/contract-work-tree-fixtures.ts';

type Message = ConversationMessageSnapshot;
const owner = (contract: ContractView): AgentLaneInfo => ({ id: contract.ownerAgentId, name: 'engineer', task: contract.ask, status: 'completed', toolCallCount: 0, messages: [], contract });
const messages: Message[] = [{ role: 'user', content: 'Fix it' }, { role: 'assistant', content: '', model: 'test-model', toolCalls: [{ id: 'spawn', name: 'agent', arguments: { mode: 'spawn', task: 'Fix it' } }] },
  { role: 'tool', callId: 'spawn', toolName: 'agent', content: JSON.stringify({ contractStarted: true, contractId: 'contract-1', ownerAgentId: 'owner' }), outcome: 'ok' }];
function model(contract: ContractView, collapse = new Map<string, boolean>()) {
  const unit = transcriptUnits(messages).find((entry) => entry.kind === 'turn');
  if (!unit || unit.kind !== 'turn') throw new Error('missing turn');
  return buildTurnModel({ messages, offset: 0, unit, sources: { agent: (id) => id === 'owner' ? owner(contract) : null, now: () => 3000 }, collapse, streamingIndex: -1 });
}
function draw(contract: ContractView, collapse = new Map<string, boolean>(), width = 120) {
  return renderTurn(model(contract, collapse), { width, glyphSet: 'rounded', focusId: null, lineNumberMode: 'off', collapseThreshold: 20, collapseState: collapse, isNavigableSystem: () => false, frame: 0 });
}
const text = (lines: ReturnType<typeof renderAgentView>): string => lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');

describe('public contract projection', () => {
  test('real contract-start results branch into their owner lane', () => {
    const turn = model(contractFixture());
    expect(turn.agentCount).toBe(1);
    expect(turn.rows.some((row) => row.kind === 'spawn' && row.lane.id === 'owner' && row.lane.name === 'Contract')).toBe(true);
    const rows = turn.rows.filter((row) => row.kind === 'bead');
    expect(rows.map((row) => row.bead.name)).toEqual(['contract', 'group', 'unit']);
    expect(rows.find((row) => row.bead.name === 'unit')?.bead.body).toMatchObject({ kind: 'text' });
  });

  test('attempts, criteria, checks, nudges, questions, replies and tree identity come from public fields', () => {
    const contract = contractFixture({ worktreePath: '/synthetic/worktree', isolation: 'worktree',
      units: [contractUnit({ attempts: 2, attemptUnits: [contractUnit({ id: 'u1.a1', attemptOf: 'u1', attemptIndex: 0 })],
        criteria: [contractCriterion({ disposition: 'excluded', dispositionReason: 'Owner excluded this criterion' })],
        nudges: [{ id: 'n1', checkId: 'u1.k1', at: 1200, kinds: ['unmet'], criterionIds: ['c1'], text: 'Clamp after jitter', delivery: 'bus', agentId: 'worker' }] })],
      escalations: [{ id: 'e1', at: 1600, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'Use the cap?', unmetCriterionIds: ['c1'] },
        { id: 'e2', at: 1700, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'Keep it?', unmetCriterionIds: [], resolvedAt: 1800, reply: { text: 'Keep it', reading: 'approve', outcome: 'act', decisionId: 'd2' } }],
    });
    const rows = projectContractTree(contract);
    expect(rows.map((row) => row.name)).toEqual(['contract', 'group', 'unit', 'attempt', 'owner question', 'owner reply']);
    const body = rows.flatMap((row) => row.lines).join('\n');
    expect(body).toContain('Tree: /synthetic/worktree');
    expect(body).toContain('[excluded]');
    expect(body).toContain('u1.k1 · completion · pass');
    expect(body).toContain('n1 · bus: Clamp after jitter');
    expect(body).toContain('Keep it');
    expect(rows.find((row) => row.name === 'owner question')?.status).toBe('wait');
  });

  test.each(['failed', 'skipped'] as const)('passed lifecycle with %s commit remains passed on collapsed rows and folded turn', (status) => {
    const contract = contractFixture({ commit: { status, note: 'not applied to the target tree' } });
    const turn = model(contract, new Map([['lane_owner', true]]));
    const folded = turn.rows.find((row) => row.kind === 'folded');
    expect(folded?.kind === 'folded' ? folded.lane.outcome : null).toBe(status === 'failed' ? 'warn' : 'ok');
    expect(folded?.kind === 'folded' ? folded.lane.foldSummary : '').toContain(`passed · commit ${status}: not applied`);
    expect(contractStatusSummary(contract)).toBe(`passed · commit ${status}: not applied to the target tree`);
    expect(text(draw(contract).lines)).toContain(`commit ${status}: not applied`);
    expect(text(draw(contract, new Map([['lane_owner', true]])).lines)).toContain(`commit ${status}: not applied`);
    expect(text(draw(contract, new Map([['turn_1', true]])).lines)).toContain(`commit ${status}: not applied`);
    for (const folded of [new Map<string, boolean>(), new Map([['lane_owner', true]]), new Map([['turn_1', true]])]) {
      expect(text(draw(contract, folded, 80).lines)).toContain(`commit ${status}: not applied`);
    }
    expect(turnSignature(model(contract))).not.toEqual(turnSignature(model({ ...contract, commit: { status, note: 'different note' } })));
  });

  test('an owner view shows real worker transcripts and pending owner questions without main turn activity', () => {
    const contract = contractFixture({ status: 'awaiting-owner', completedAt: undefined, escalations: [{ id: 'e1', at: 1600, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'Apply the repair?', unmetCriterionIds: ['c1'] }] });
    const worker: AgentLaneInfo = { id: 'worker', name: 'engineer', task: 'Clamp the retry', status: 'completed', toolCallCount: 1,
      messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read', arguments: { path: 'src/retry.ts' } }] }, { role: 'tool', callId: 'read', content: 'retry implementation', outcome: 'ok' }] };
    const sources: WorkTreeSources = { agent: (id) => id === 'worker' ? worker : null, now: () => 3000, turnActive: () => false };
    const m = buildContractOwnerModel({ info: owner(contract), sources, collapse: new Map() });
    expect(m.live).toBe(true);
    expect(m.rows.some((row) => row.kind === 'spawn' && row.lane.id === 'worker')).toBe(true);
    const rendered = text(renderAgentView({ width: 120, agent: owner(contract), messages: [], colorIndex: 1, parentName: 'main', sources, collapse: new Map(), glyphSet: 'rounded', frame: 0, now: 3000, queuedSteers: [] }));
    expect(rendered).toContain('Contract');
    expect(rendered).toContain('awaiting-owner');
    expect(rendered).toContain('owner question');
    expect(rendered).toContain('src/retry.ts');
    expect(rendered).not.toContain('No transcript yet');
  });
});

describe('live contract source wiring', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  test('late commit events invalidate an inactive folded conversation and preserve owner control identity', () => {
    const dir = makeProjectTempDir('gv-contract-tree');
    dirs.push(dir);
    const cm = new ConversationManager(() => 120);
    cm.setUnicodeCapable(true);
    cm.fromJSON({ messages });
    cm.workTree.restoreFoldState([['lane_owner', true]]);
    let contract = contractFixture();
    let notify: (() => void) | undefined;
    let renders = 0;
    let unsubscribed = false;
    const record: NonNullable<ReturnType<AgentManager['getStatus']>> = { id: 'owner', template: 'engineer', task: contract.ask, status: 'completed', startedAt: 1000, completedAt: 2000, tools: [], toolCallCount: 0,
      orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'contract', communicationLane: 'parent-only', contractId: contract.id, contractRole: 'owner' };
    const events = { on: () => () => {} };
    const wired = wireWorkTree({ conversation: cm, events: { tools: events, turns: events } as unknown as Parameters<typeof wireWorkTree>[0]['events'],
      agentManager: { getStatus: (id) => id === record.id ? record : null, getConversationSnapshot: () => [] },
      listContracts: () => [contract], onContractsChanged: (listener) => { notify = listener; return () => { unsubscribed = true; }; },
      fleetNodes: () => [], pendingCallId: () => undefined, turnActive: () => false, sessionsDir: dir, sessionId: () => 'test-session', requestRender: () => { renders++; } });
    const before = text(cm.getDisplayBlocks());
    expect(before).toContain('passed');
    expect(before).not.toContain('commit failed');
    const source = cm.getWorkTreeSources().agent?.('owner');
    expect(source?.contract?.id).toBe('contract-1');
    expect(source?.contract?.ownerAgentId).toBe('owner');
    contract = { ...contract, commit: { status: 'failed', note: 'not applied to the target tree' } };
    notify?.();
    expect(renders).toBe(1);
    expect(text(cm.getDisplayBlocks())).toContain('passed · commit failed: not applied');
    for (const unsub of wired.unsubs) unsub();
    expect(unsubscribed).toBe(true);
  });
});

describe('typed outcomes and legacy unknowns', () => {
  test.each(['ok', 'error', 'cancelled', undefined] as const)('orphan results respect %s regardless of text', (outcome) => {
    const result: Extract<Message, { role: 'tool' }> = { role: 'tool', callId: 'a', toolName: 'exec', content: 'Error: cancelled by user', ...(outcome === undefined ? {} : { outcome }) };
    const bead = orphanResultBead(result, 4, new Map());
    expect(bead.status).toBe(outcome === 'ok' ? 'ok' : outcome === 'error' ? 'err' : outcome === 'cancelled' ? 'cancel' : 'unknown');
    if (outcome === undefined) expect(bead.summary).toEqual({ text: 'outcome unknown', tone: 'faint' });
  });
});


test('a later legacy result clears an earlier known outcome while keeping completion presence', () => {
  const messages: Message[] = [
    { role: 'tool', callId: 'same', toolName: 'exec', content: 'first result', outcome: 'error' },
    { role: 'tool', callId: 'same', toolName: 'exec', content: 'Error: a quoted legacy result' },
  ];
  expect(collectToolCallOutcomes(messages).has('same')).toBe(false);
  expect(collectCompletedToolCallIds(messages).has('same')).toBe(true);
});

test('a restored contract owner remains visible without a live agent record', () => {
  const dir = makeProjectTempDir('gv-restored-contract-view');
  const conversation = new ConversationManager(() => 120);
  const contract = contractFixture();
  const events = { on: () => () => {} };
  const wired = wireWorkTree({ conversation, events: { tools: events, turns: events } as unknown as Parameters<typeof wireWorkTree>[0]['events'],
    agentManager: { getStatus: () => null, getConversationSnapshot: () => [] },
    listContracts: () => [contract], fleetNodes: () => [], pendingCallId: () => undefined,
    turnActive: () => false, sessionsDir: dir, sessionId: () => 'restored-session', requestRender() {},
  });
  try {
    const source = conversation.getWorkTreeSources().agent?.(contract.ownerAgentId);
    expect(source?.contract).toBe(contract);
    expect(source?.status).toBe('completed');
    expect(source?.task).toBe(contract.ask);
    expect(source?.messages).toEqual([]);
  } finally { for (const unsubscribe of wired.unsubs) unsubscribe(); }
});
