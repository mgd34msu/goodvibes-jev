import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ContractTree } from './ContractTree';
import type { ContractRecord } from './ContractTree';

type Source = NonNullable<ContractRecord['nativeSource']>;
type NativeState = NonNullable<ContractRecord['nativeDecisions']>;
type DecisionRecord = NativeState['history'][number];
type Decision = DecisionRecord['decision'];
const source: Source = {
  sourceId: 'source-original', sourceRevision: 'source-v3', inputRevision: 'input-v2',
  criteriaId: 'criteria-original', criteriaRevision: 'criteria-v7',
  goal: '  Original goal\nKeep every word.  ',
  criteria: ['  First original criterion\nsecond line  ', 'Second criterion', 'Second criterion'],
};
const binding: Decision['binding'] = {
  sourceId: source.sourceId, inputRevision: source.inputRevision,
  actionId: 'bound-action', actionRevision: 'action-v4', authorityId: 'host-authority', authorityRevision: 'authority-v2',
  scopeId: 'scope-original', scopeRevision: 'scope-v5',
};
const decisionBase = {
  schemaVersion: 1, decisionId: 'semantic-act', binding, judgmentDecisionIds: ['judgment-1', 'judgment-2'],
  evidence: [{ id: 'evidence-original', revision: 'evidence-v6' }], summary: 'Recorded summary, exactly as stored.',
} satisfies Omit<Decision, 'outcome'>;
const act: Decision = { ...decisionBase, outcome: 'act' };
const revise: Decision = { ...decisionBase, decisionId: 'semantic-revise', outcome: 'revise', next: { id: 'gather-existing-evidence', revision: 'continuation-v2', kind: 'gather-evidence' } };
const defer: Decision = { ...decisionBase, decisionId: 'semantic-defer', outcome: 'defer', until: { id: 'external-evidence-ready', revision: 'condition-v1' } };
const reject: Decision = { ...decisionBase, decisionId: 'semantic-reject', outcome: 'reject', summary: 'No permissible continuation was recorded.' };
function receipt(decision: Decision): DecisionRecord {
  return { schemaVersion: 1, stage: 'evidence', targetId: 'unit-native', operationRevision: 'operation-v9', decision };
}
function decisions(history: Decision[] = []): NativeState {
  return { schemaVersion: 1, history: history.map(receipt), pending: {}, spent: {}, plannerOutputs: {}, attemptChoices: {}, attemptedChoices: {} };
}
function contract(overrides: Partial<ContractRecord> = {}): ContractRecord {
  return {
    id: 'ctr-01234567', schemaVersion: 5, sessionId: 'session-original', origin: 'turn', ask: 'Display request',
    ownerAgentId: 'owner-original', projectRoot: '/project', isolation: 'shared', goal: 'Recorded tree goal',
    criteria: [], groups: [], units: [], status: 'checking-plan', checks: [], fixRounds: 0, escalations: [], decisions: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' },
    judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 }, plannerAgentIds: [], createdAt: 0, ...overrides,
  };
}
const cleanups: (() => void)[] = [];
function render(record: ContractRecord) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  const update = (next: ContractRecord) => flushSync(() => root.render(<ContractTree contract={next} />));
  update(record);
  cleanups.push(() => { flushSync(() => root.unmount()); el.remove(); });
  return { el, update };
}
function section(el: HTMLElement, title: string) {
  return [...el.querySelectorAll('section')].find((item) => item.querySelector('h4')?.textContent === title);
}
function disclosure(el: HTMLElement, title: string) {
  return [...el.querySelectorAll('details')].find((item) => item.querySelector('summary')?.textContent === title);
}
function fact(el: Element | undefined, label: string) {
  return [...(el?.querySelectorAll('dl > div') ?? [])].find((item) => item.querySelector('dt')?.textContent === label)?.querySelector('dd')?.textContent;
}
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

describe('Native contract records', () => {
  test('leaves contracts with no native or provenance fields unchanged', () => {
    const { el } = render(contract());
    expect(section(el, 'Goal')?.textContent).toContain('Recorded tree goal');
    for (const absent of ['Native source', 'Native progress', 'Transport waiting', 'Native semantic decisions', 'Durable launch record', 'Durable admission provenance', 'Captured input provenance']) {
      expect(el.textContent).not.toContain(absent);
    }
    expect(el.textContent).toContain('Display request');
    expect(el.textContent).toContain('No decisions recorded.');
    expect(el.querySelectorAll('button, input, textarea, select, form')).toHaveLength(0);
  });

  test('preserves original native goal and criteria, whitespace, order, duplicates and revision refs', () => {
    const { el } = render(contract({ nativeSource: source }));
    expect(section(el, 'Original native goal')?.querySelector('p')?.textContent).toBe(source.goal);
    expect([...el.querySelectorAll('[aria-label="Original native criteria"] > li')].map((item) => item.textContent)).toEqual([...source.criteria]);
    const native = section(el, 'Native source');
    for (const value of [source.sourceId, source.sourceRevision, source.inputRevision, source.criteriaId, source.criteriaRevision]) expect(native?.textContent).toContain(value);
    expect(section(el, 'Goal')?.querySelector('p')?.textContent).toBe('Recorded tree goal');
    expect(el.textContent).toContain('Display request');
  });

  test('renders waiting and backoff as operational progress without inventing a semantic decision', () => {
    const { el } = render(contract({ nativeProgress: { schemaVersion: 1, state: 'deciding', stage: 'plan', targetId: 'ctr-01234567' },
      nativeWaiting: { schemaVersion: 1, requests: [{ logicalRequestId: 'logical-retry-1', attempt: { attempt: 3, endpointIndex: 0, endpointKind: 'hosted', requestedModel: 'jev-recorded-model', latencyMs: 45, outcome: 'unavailable', requestId: 'wire-request-2', status: 503 }, elapsedMs: 2300, nextDelayMs: 1000 }] },
      nativeDecisions: decisions(),
    }));
    const waiting = section(el, 'Transport waiting');
    for (const value of ['logical-retry-1', 'hosted', 'jev-recorded-model', 'unavailable', 'wire-request-2', '503', '2300', '1000']) expect(waiting?.textContent).toContain(value);
    expect(fact(waiting, 'Endpoint index')).toBe('0');
    expect(fact(waiting, 'Attempt')).toBe('3');
    expect(fact(waiting, 'Latency (ms)')).toBe('45');
    expect(fact(section(el, 'Native progress'), 'State')).toBe('deciding');
    expect(el.textContent).toContain('No native semantic decisions recorded.');
    expect(el.querySelector('[aria-label="Native decision history"]')).toBeNull();
    for (const invented of ['Recorded outcome:', 'deferred', 'refused', 'Approved', 'Rejected', 'Resume work']) expect(el.textContent).not.toContain(invented);
    expect(el.querySelectorAll('button, input, textarea, select, form, a')).toHaveLength(0);
  });

  test('shows all four semantic outcomes verbatim with supporting calls, evidence, bindings and variant refs', () => {
    const { el } = render(contract({ nativeDecisions: decisions([act, revise, defer, reject]) }));
    const history = el.querySelector('[aria-label="Native decision history"]');
    expect(history?.children).toHaveLength(4);
    const records = [...(history?.children ?? [])];
    expect(records.map((item) => fact(item, 'Recorded outcome'))).toEqual(['act', 'revise', 'defer', 'reject']);
    for (const record of records) {
      for (const value of ['evidence', 'unit-native', 'operation-v9', 'judgment-1', 'judgment-2', 'evidence-original', 'evidence-v6', ...Object.values(binding)]) expect(record.textContent).toContain(value);
    }
    expect(section(el, 'Recorded continuation')?.textContent).toContain('gather-evidence');
    expect(section(el, 'Recorded continuation')?.textContent).toContain('continuation-v2');
    expect(section(el, 'Recorded resume condition')?.textContent).toContain('external-evidence-ready');
    expect(section(el, 'Recorded resume condition')?.textContent).toContain('condition-v1');
    expect(el.textContent).toContain(reject.summary);
    expect(el.querySelectorAll('button, input, textarea, select, form, a')).toHaveLength(0);
    for (const invented of ['Approved', 'Retry now', 'Resume work', 'Run continuation']) expect(el.textContent).not.toContain(invented);
  });

  test('keeps deferred state, pending receipt and exact external condition separate from transport waiting', () => {
    const state: NativeState = { ...decisions([defer]), pending: { 'evidence:unit-native': receipt(defer) } };
    const { el } = render(contract({ nativeProgress: { schemaVersion: 1, state: 'deferred', stage: 'evidence', targetId: 'unit-native', until: defer.until }, nativeDecisions: state }));
    expect(fact(section(el, 'Native progress'), 'State')).toBe('deferred');
    expect(section(el, 'Progress condition reference')?.textContent).toContain('external-evidence-ready');
    const pending = el.querySelector('[aria-label="Pending native records"]');
    expect(pending?.children).toHaveLength(1);
    expect(pending?.textContent).toContain('evidence:unit-native');
    expect(pending?.textContent).toContain('Recorded outcome: defer');
    expect(pending?.textContent).toContain('condition-v1');
    expect(section(el, 'Transport waiting')).toBeUndefined();
    expect(el.textContent).not.toContain('Awaiting approval');
  });

  test('renders refused state as recorded without manufacturing a rejection receipt', () => {
    const { el } = render(contract({ nativeProgress: { schemaVersion: 1, state: 'refused', stage: 'fix-plan', targetId: 'group-refused' } }));
    expect(fact(section(el, 'Native progress'), 'State')).toBe('refused');
    expect(fact(section(el, 'Native progress'), 'Stage')).toBe('fix-plan');
    expect(fact(section(el, 'Native progress'), 'Target id')).toBe('group-refused');
    expect(el.querySelector('[aria-label="Native decision history"]')).toBeNull();
    expect(el.textContent).not.toContain('Recorded outcome: reject');
  });

  test('distinguishes legacy criterion outcomes from native semantic outcomes', () => {
    const { el } = render(contract({ nativeDecisions: decisions([act]), criteria: [{ id: 'legacy-criterion', text: 'Recorded criterion', origin: 'stated', serves: [], disposition: 'judged', status: 'unshown', readings: [{ checkId: 'old-check', at: 0, probabilityUnmet: 0.5, verdict: 'unshown', outcome: 'confirm' }] }] }));
    expect(el.querySelector('[aria-label="Readings for legacy-criterion"]')?.textContent).toContain('confirm');
    const native = section(el, 'Native semantic decisions');
    expect(native?.textContent).toContain('Recorded outcome: act');
    expect(native?.textContent).not.toContain('confirm');
    expect(native?.textContent).toContain('separate from criterion readings');
  });

  test('renders capture provenance even on a non-native contract, including deleted paths and zero time', () => {
    const snapshot: NonNullable<ContractRecord['inputSnapshot']> = {
      version: 1, id: 'capture-original', sourceRoot: '/owner/project', sourceIdentity: 'source-inode-identity', gitIdentity: 'git-original',
      ownerHead: 'original-head', ownerRef: 'refs/heads/main', indexFingerprint: 'index-original', inputTree: 'tree-original', inputCommit: 'commit-original', capturedAt: 0, dirty: true,
      exclusions: ['.git', '.goodvibes', '.ssh'], files: [
        { path: 'src/original.ts', kind: 'file', mode: '100644', oid: 'original-oid', digest: 'original-digest', identity: 'file-inode-identity' },
        { path: 'removed.txt', kind: 'missing', mode: '0' },
        { path: 'linked-path', kind: 'symlink', mode: '120000', oid: 'link-oid' },
      ],
    };
    const { el } = render(contract({ inputSnapshot: snapshot }));
    const capture = disclosure(el, 'Captured input provenance');
    for (const value of ['capture-original', '/owner/project', 'source-inode-identity', 'git-original', 'original-head', 'refs/heads/main', 'index-original', 'tree-original', 'commit-original', '1970-01-01T00:00:00.000Z', 'true', '.goodvibes', 'original-oid', 'original-digest', 'file-inode-identity', 'removed.txt', 'missing', 'symlink', '120000']) expect(capture?.textContent).toContain(value);
    expect(el.querySelector('[aria-label="Captured files"]')?.children).toHaveLength(3);
    expect(el.querySelectorAll('a, button')).toHaveLength(0);
    expect(section(el, 'Native source')).toBeUndefined();
  });

  test('shows durable admission key, binding, input, placement and launch claim without claiming execution', () => {
    const admission: NonNullable<ContractRecord['durableAdmission']> = {
      schemaVersion: 2, contractId: 'ctr-01234567', ownerAgentId: 'owner-original', payloadRevision: 'payload-original',
      key: { workId: 'work-original', criteriaId: source.criteriaId, criteriaRevision: source.criteriaRevision, attemptId: 'attempt-original' }, binding,
      input: { ask: 'Admission display request', nativeSource: source, sessionId: 'admission-session', origin: 'turn', projectRoot: '/original-project', isolation: 'worktree', parentAgentId: 'parent-original', budget: { maxTokens: 0, maxCostUsd: 0 }, proposedUnits: [{ task: 'Original proposed task', template: 'original-template' }] },
      execution: { isolation: 'worktree', branch: 'contract/01234567', worktreePath: '/original-project/.goodvibes/.worktrees/contract/01234567', baseBranch: 'original-base' },
    };
    const { el, update } = render(contract({ durableAdmission: admission, durableLaunchState: 'launch-claimed' }));
    const provenance = disclosure(el, 'Durable admission provenance');
    for (const value of ['payload-original', 'work-original', 'attempt-original', ...Object.values(binding), 'Admission display request', 'admission-session', '/original-project', 'parent-original', 'contract/01234567', 'original-base', 'Original proposed task', 'original-template']) expect(provenance?.textContent).toContain(value);
    expect(fact(provenance, 'Token ceiling')).toBe('0');
    expect(fact(provenance, 'Cost ceiling (USD)')).toBe('0');
    expect(section(el, 'Durable launch record')?.textContent).toContain('does not establish whether execution began');
    expect(fact(section(el, 'Durable launch record'), 'Launch state')).toBe('launch-claimed');
    const { execution: _execution, ...legacyAdmission } = admission;
    update(contract({ durableLaunchState: 'prepared', durableAdmission: { ...legacyAdmission, schemaVersion: 1 } }));
    expect(fact(section(el, 'Durable launch record'), 'Launch state')).toBe('prepared');
    expect(el.textContent).toContain('No execution placement recorded.');
    expect(el.querySelectorAll('a, button, form')).toHaveLength(0);
  });

  test('keeps stored summaries, planner outputs and references inert, and removes stale native records on refresh', () => {
    const payload = '<button onclick="run()">Approve and execute</button> javascript:alert(1)';
    const state: NativeState = {
      ...decisions([{ ...act, summary: payload }]), spent: { 'plan-budget': 0 }, plannerOutputs: { 'planner-output': payload },
      attemptChoices: { 'selected-unit': 'candidate-original' }, attemptedChoices: { 'attempted-unit': ['candidate-original', 'candidate-next'] },
    };
    const { el, update } = render(contract({ nativeDecisions: state }));
    expect(section(el, 'Recorded decision summary')?.querySelector('p')?.textContent).toBe(payload);
    expect(disclosure(el, 'planner-output')?.querySelector('p')?.textContent).toBe(payload);
    expect(fact(section(el, 'Spent correction budgets'), 'plan-budget')).toBe('0');
    expect(el.textContent).toContain('candidate-next');
    expect(el.querySelectorAll('button, script, a, form')).toHaveLength(0);
    update(contract());
    expect(section(el, 'Native semantic decisions')).toBeUndefined();
    expect(el.textContent).not.toContain(payload);
  });
});
