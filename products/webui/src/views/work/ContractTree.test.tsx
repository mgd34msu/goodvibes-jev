import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ContractTree } from './ContractTree';
import type { ContractRecord } from './ContractTree';

type Unit = ContractRecord['units'][number];
type Check = ContractRecord['checks'][number];
type Criterion = ContractRecord['criteria'][number];
const usage: ContractRecord['usage'] = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced',
};
function contract(overrides: Partial<ContractRecord> = {}): ContractRecord {
  return {
    id: 'contract-1', schemaVersion: 1, sessionId: 'session-1', origin: 'turn', ask: 'Original owner request',
    ownerAgentId: 'owner-1', projectRoot: '/project', isolation: 'shared', goal: '', criteria: [], groups: [],
    units: [], status: 'queued', checks: [], fixRounds: 0, escalations: [], decisions: [], usage,
    judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 }, plannerAgentIds: [], createdAt: 0, ...overrides,
  };
}
function check(overrides: Partial<Check> = {}): Check {
  return {
    id: 'check-1', at: 0, trigger: 'completion', goal: { probabilityUnmet: 0.48, verdict: 'unshown', outcome: 'confirm' },
    quality: {}, result: 'recorded', decisionIds: ['decision-check'], evidenceDigest: 'sha256:recorded-digest', ...overrides,
  };
}
function criterion(overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: 'criterion-1', text: 'Keep the original constraint', origin: 'stated', quote: 'exact words from the ask',
    serves: ['owner-goal'], disposition: 'judged', status: 'unshown', readings: [], ...overrides,
  };
}
function unit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: 'unit-1', groupId: 'group-1', title: 'Implement the constraint', goal: 'Unit goal as recorded', brief: 'Unit brief as recorded',
    role: 'implement', dependsOn: [], files: [], attempts: 1, criteria: [], status: 'checking', agentIds: [], checks: [], nudges: [],
    fixRounds: 0, freshAgents: 0, transportRetries: 0, touchedPaths: [], usage, ...overrides,
  };
}
const cleanups: (() => void)[] = [];
function render(record: ContractRecord) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  flushSync(() => root.render(<ContractTree contract={record} />));
  cleanups.push(() => { flushSync(() => root.unmount()); el.remove(); });
  return el;
}
function section(el: HTMLElement, title: string) {
  return [...el.querySelectorAll('section')].find((item) => item.querySelector('h4')?.textContent === title);
}
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

describe('ContractTree read-only evidence', () => {
  test('preserves the original ask without manufacturing a goal, result, or evidence', () => {
    const el = render(contract());
    expect(section(el, 'Goal')?.textContent).toContain('No goal recorded.');
    expect(el.textContent).toContain('Original owner request');
    for (const empty of ['No criteria recorded.', 'No checks recorded.', 'No groups recorded.', 'No units recorded.', 'No escalations recorded.', 'No decisions recorded.', 'No answer recorded.', 'No commit result recorded.']) {
      expect(el.textContent).toContain(empty);
    }
    expect(section(el, 'Recorded result')?.textContent).toContain('queued');
    expect(el.querySelectorAll('button, input, textarea, select, form')).toHaveLength(0);
    expect(el.textContent).not.toContain('Approved');
    expect(el.textContent).not.toContain('0%');
  });

  test('shows every criterion reading with exact probability, outcome, severity, and references', () => {
    const el = render(contract({
      goal: 'The recorded goal', criteria: [criterion({
        readings: [
          { checkId: 'check-1', at: 0, probabilityUnmet: 0.87, verdict: 'unmet', outcome: 'act', severity: 'major', decisionId: 'reading-decision', severityDecisionId: 'severity-decision' },
          { checkId: 'missing-check', at: 1000, probabilityUnmet: 0.48, verdict: 'unshown', outcome: 'confirm' },
        ],
      }), criterion({ id: 'excluded', origin: 'derived', quote: undefined, disposition: 'excluded', dispositionReason: 'Outside the recorded scope', status: 'unread' })],
      checks: [check()],
    }));
    const readings = el.querySelector('[aria-label="Readings for criterion-1"]');
    expect(readings?.children).toHaveLength(2);
    for (const recorded of ['0.87', 'unmet', 'act', 'major', 'reading-decision', 'severity-decision', '0.48', 'unshown', 'confirm']) {
      expect(readings?.textContent).toContain(recorded);
    }
    expect(readings?.textContent).toContain('missing-check · Check not present in this record');
    expect(el.querySelector('blockquote')?.textContent).toBe('exact words from the ask');
    for (const recorded of ['stated', 'derived', 'excluded', 'Outside the recorded scope', 'unread', 'No source quote recorded.', 'No readings recorded.']) {
      expect(el.textContent).toContain(recorded);
    }
    expect(el.textContent).not.toContain('87%');
  });

  test('renders check digest, goal, sparse quality, claims, gate skips and full output without inferring a pass', () => {
    const el = render(contract({ checks: [check({
      result: 'native-decision', quality: { hidden_failure: { verdict: 'uncertain', outcome: 'escalate' } },
      claims: { kind: 'unverified', summary: 'Recorded claim summary' },
      gates: [
        { gate: 'run tests', passed: false, skipped: true, output: 'Skipped because no command was configured', durationMs: 0 },
        { gate: 'typecheck', passed: false, skipped: false, output: 'Exact error\nsecond line', durationMs: 42 },
        { gate: 'legacy gate', passed: true, output: '', durationMs: 1 },
      ], problems: ['gate', 'claims'], qualityProblems: ['hidden_failure'],
    })] }));
    for (const recorded of ['sha256:recorded-digest', 'native-decision', 'decision-check', 'hidden_failure', 'uncertain', 'escalate', 'unverified', 'Recorded claim summary', 'skipped', 'false', '42', 'Not recorded']) {
      expect(el.textContent).toContain(recorded);
    }
    const outputs = [...el.querySelectorAll('pre')].map((node) => node.textContent);
    expect(outputs).toEqual(['Skipped because no command was configured', 'Exact error\nsecond line']);
    expect(el.textContent).toContain('No gate output recorded.');
    expect(el.textContent).not.toContain('tests_weakened');
    expect(el.textContent).not.toContain('All checks passed');
  });

  test('keeps group nesting, attempt units, ungrouped units, missing references, and expandable evidence links', () => {
    const attempt = unit({ id: 'attempt-1', title: 'Candidate A', attemptOf: 'unit-1', attemptIndex: 0, status: 'held-merge', checks: [check({ id: 'attempt-check' })] });
    const el = render(contract({
      criteria: [criterion({ readings: [{ checkId: 'attempt-check', at: 0, probabilityUnmet: 0.1, verdict: 'met', outcome: 'act' }] })],
      groups: [{ id: 'group-1', title: 'Recorded group', goal: 'Group goal', kind: 'work', dependsOn: [], criteria: [], unitIds: ['unit-1', 'missing-unit'], status: 'judging', checks: [], fixRounds: 0, usage }],
      units: [unit({ attemptUnits: [attempt], attemptSelection: { engineGroupId: 'engine-group', candidateIds: ['attempt-1'], proposedId: 'attempt-1', outcome: 'confirm', reasons: 'Recorded selection reason', decisionId: 'selection-decision' } }), unit({ id: 'orphan', title: 'Unreferenced work', groupId: 'missing-group' })],
    }));
    const group = el.querySelector('[aria-label="Groups"]');
    expect(group?.textContent).toContain('Candidate A');
    expect(group?.textContent).toContain('Unit missing-unit is referenced by this group but is not present in this record.');
    expect(el.querySelector('[aria-label="Units outside recorded groups"]')?.textContent).toContain('Unreferenced work');
    expect(el.textContent).toContain('No selection recorded');
    expect(el.textContent).toContain('held-merge');
    expect(el.textContent).toContain('Recorded selection reason');
    for (const detail of el.querySelectorAll('details')) detail.open = false;
    const link = el.querySelector<HTMLAnchorElement>('[aria-label="Readings for criterion-1"] a');
    expect(link).not.toBeNull();
    const target = document.getElementById(link?.hash.slice(1) ?? '');
    expect(target?.querySelector('details')?.open).toBe(false);
    flushSync(() => link?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(target?.querySelector('details')?.open).toBe(true);
    for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) expect(parent.open).toBe(true);
    }
    expect(document.activeElement).toBe(target?.querySelector('summary') ?? null);
    expect(el.querySelectorAll('button')).toHaveLength(0);
  });

  test('uses unique evidence anchors when several groups reference the same unit', () => {
    const group: ContractRecord['groups'][number] = { id: 'g1', title: 'One', goal: '', kind: 'work', dependsOn: [], criteria: [], unitIds: ['unit-1'], status: 'pending', checks: [], fixRounds: 0, usage };
    const el = render(contract({ groups: [group, { ...group, id: 'g2', title: 'Two' }], units: [unit({ checks: [check()] })] }));
    const ids = [...el.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(el.querySelectorAll('[aria-label="Checks"]')).toHaveLength(2);
  });

  test('keeps unresolved escalation questions and recorded replies as history, with no reply controls', () => {
    const el = render(contract({ status: 'awaiting-owner', escalations: [
      { id: 'escalation-open', at: 0, scope: 'unit', targetId: 'unit-1', reason: 'attempts-undecided', question: 'Which recorded candidate?', unmetCriterionIds: ['criterion-1'], decisionIds: ['escalation-decision'] },
      { id: 'escalation-resolved', at: 1, scope: 'plan', targetId: 'contract-1', reason: 'plan-unresolved', question: 'Recorded plan question', unmetCriterionIds: [], resolvedAt: 0, reply: { text: 'Recorded amendment', reading: 'amend', outcome: 'act', decisionId: 'reply-decision' } },
    ] }));
    for (const recorded of ['Which recorded candidate?', 'attempts-undecided', 'No resolution recorded', 'No owner reply recorded.', 'Resolution recorded', 'Recorded amendment', 'amend', 'reply-decision', 'escalation-decision']) {
      expect(el.textContent).toContain(recorded);
    }
    expect(el.querySelector('[aria-label="Escalation history"]')?.children).toHaveLength(2);
    expect(el.querySelectorAll('button, textarea, form')).toHaveLength(0);
  });

  test.each(['passed', 'failed', 'cancelled'] as const)('renders terminal %s and every provided result verbatim', (status) => {
    const el = render(contract({ status, statusLine: 'Exact runner status line', answer: 'Recorded final answer\nWith a second line', error: 'Exact recorded error', failureKind: 'judgment-unavailable', completedAt: 0, commit: { status: 'skipped', note: 'Exact commit note', hash: 'abcd1234' } }));
    const result = section(el, 'Recorded result');
    for (const recorded of [status, 'Exact runner status line', 'Recorded final answer\nWith a second line', 'Exact recorded error', 'judgment-unavailable', 'skipped', 'Exact commit note', 'abcd1234', '1970-01-01T00:00:00.000Z']) {
      expect(result?.textContent).toContain(recorded);
    }
  });
});
