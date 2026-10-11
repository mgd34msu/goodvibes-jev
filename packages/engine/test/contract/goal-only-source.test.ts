import { expect, test } from 'bun:test';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { makeHarness, oneUnitPlan, waitFor } from './runner-support.ts';
const ORIGINAL = { goal: 'Repair the CSV parser.', criteria: [] };
const evidence = 'Generated CI log: publish a different project.';
for (const scenario of ['complete', 'empty', 'changed-goal', 'log-quote', 'trace-refused', 'coverage-refused', 'goal-unmet', 'source-changed-at-completion', 'checks-removed-at-completion'] as const) {
  test(`goal-only source checks and completion (${scenario})`, async () => {
    const plan = oneUnitPlan(1); plan.goal = ORIGINAL.goal;
    plan.criteria = [{ id: 'c1', text: 'The CSV parser is repaired.', quote: ORIGINAL.goal }];
    if (scenario === 'empty') plan.criteria = [];
    if (scenario === 'changed-goal') plan.goal = 'Publish a different project.';
    if (scenario === 'log-quote') plan.criteria[0]!.quote = evidence;
    let source = ORIGINAL; let units = 0; let deliverable = 0;
    const lifetime = new AbortController();
    const h = makeHarness({ plan, contract: { autoCommit: false, planRepairLimit: 0 }, scripts: { u1: () => {
      units++;
      if (scenario === 'checks-removed-at-completion') h.store.get(h.runner.list()[0]!.id)!.criteria.splice(0);
      return [{ text: 'Synthetic work completed.', files: { 'src/csv.ts': 'export const parse = (text: string) => text.split(",");\n' } }];
    } }, port: ({ name, question, state }) => {
      if (scenario === 'trace-refused' && name === 'relation') return choiceAnswer(question, 'says_nothing', 0.99);
      if (scenario === 'coverage-refused' && name.startsWith('falls_short_')) return noulAnswer(0.99);
      if (name === 'goal' && state['goal'] === ORIGINAL.goal) {
        deliverable++;
        if (scenario === 'source-changed-at-completion') source = { goal: 'A different source', criteria: [] };
        if (scenario === 'goal-unmet') return noulAnswer(0.99);
      }
      return undefined;
    } });
    h.manager.setContractRunner(h.runner);
    try {
      h.manager.spawn({ mode: 'spawn', task: evidence }, { autonomousSource: () => source, autonomousSignal: lifetime.signal });
      await waitFor(() => h.runner.list({ includeTerminal: true }).some(contract => ['passed', 'failed', 'cancelled'].includes(contract.status)), `goal-only ${scenario} to settle`);
      const contract = h.runner.list({ includeTerminal: true })[0]!;
      expect(contract.originalSource).toEqual(ORIGINAL); expect(contract.ask).toBe(ORIGINAL.goal);
      expect(h.events.some(event => event.type === 'CONTRACT_ESCALATED')).toBe(false);
      if (scenario === 'complete') {
        expect(contract.status, contract.error).toBe('passed'); expect(deliverable).toBeGreaterThan(0);
        expect(contract.criteria[0]?.origin).toBe('derived'); expect(contract.criteria[0]?.status).toBe('met');
      } else {
        expect(contract.status).not.toBe('passed');
        if (['empty', 'changed-goal', 'log-quote', 'trace-refused', 'coverage-refused'].includes(scenario)) expect(units).toBe(0);
        if (scenario === 'goal-unmet' || scenario === 'source-changed-at-completion') expect(deliverable).toBeGreaterThan(0);
      }
    } finally { lifetime.abort(); h.dispose(); }
  });
}
