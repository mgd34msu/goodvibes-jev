import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import {
  withDecisionLog, type DecisionEntry, type DecisionId, type DecisionLog,
  type DecisionNote, type JudgmentPort, type NewDecisionEntry,
} from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.ts';
import {
  buildProjectPlanningAnswerActions as build,
  readProjectPlanningAnswerActions as read,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { ProjectPlanningQuestion } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { planningAnswerTopic, planningRecommendationSpecific } from '../sdk/src/platform/knowledge/project-planning/batteries/answer-actions.ts';
import { registry } from '../sdk/src/platform/knowledge/judgment-registry.ts';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

const question = (extra: Partial<ProjectPlanningQuestion> = {}): ProjectPlanningQuestion => ({ id: 'source-question', prompt: 'Which pieces belong in this change?', ...extra });
const SECRET = 'SYNTHETIC_PLANNING_CREDENTIAL_NOT_A_REAL_KEY';
const PAN = '4111111111111111';

function harness(values: Partial<Record<'scope' | 'tasks' | 'verification' | 'approval' | 'specific', number>> = {}, onAction?: () => void) {
  const fake = fakePort((name) => {
    if (!['scope', 'tasks', 'verification', 'approval', 'specific'].includes(name)) throw new Error(`Unexpected synthetic item: ${name}`);
    return noulAnswer(values[name as keyof typeof values] ?? 0.01);
  });
  const entries: NewDecisionEntry[] = [];
  const notes: { id: string; note: DecisionNote }[] = [];
  const log: DecisionLog = {
    record(entry) { entries.push(entry); return `decision-${entries.length}` as DecisionId; },
    attach(id, note) { notes.push({ id, note }); if (note.kind === 'action') onAction?.(); },
    get() { return undefined; }, query() { return [] as DecisionEntry[]; },
  };
  installJudgmentPort(withDecisionLog(fake.port, log));
  return { ...fake, entries, notes };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => { resolve = ok; });
  return { promise, resolve };
}

const ids = (actions: readonly { readonly id: string }[]) => actions.map((entry) => entry.id);

describe('planning answer readings and manual composition', () => {
  test('one fan-out selects supported bundles, independently of keyword overlap', async () => {
    const fake = harness({ scope: 0.99, verification: 0.99 });
    const input = question({ prompt: 'Describe the boundaries and the observations that would establish correctness.' });
    const result = await read(input);
    expect(fake.requests).toHaveLength(1);
    expect(Object.keys(fake.requests[0]!.questions)).toEqual(['scope', 'tasks', 'verification', 'approval']);
    expect(ids(result.actions)).toEqual(['scope-focused-first-pass', 'verification-default-gates', 'scope-end-to-end', 'scope-tui-first']);
    expect(result.recommendationSpecific).toBeNull();
    expect(ids(build(input, 'My explicit answer', result)).slice(-2)).toEqual(['ask-narrower', 'custom']);
    expect(build(input, 'My explicit answer', result).at(-1)).toMatchObject({ answer: 'My explicit answer', disabled: false });
    expect(result.decisionIds).toEqual(['decision-1']);
    expect(fake.notes.some(({ note }) => note.kind === 'action')).toBe(true);
  });

  test('a recommendation containing an old template phrase can remain specific', async () => {
    const fake = harness({ scope: 0.99, specific: 0.99 });
    const input = question({ recommendedAnswer: 'Define the first-pass scope as retry.ts plus its regression tests.' });
    const result = await read(input);
    expect(fake.requests).toHaveLength(2);
    expect(Object.keys(fake.requests[1]!.questions)).toEqual(['specific']);
    expect(result.recommendation).toBe(input.recommendedAnswer!);
    expect(result.actions.find((action) => action.id === 'recommended')?.answer).toBe(input.recommendedAnswer!);
    expect(result.decisionIds).toEqual(['decision-1', 'decision-2']);
  });

  test('held readings offer no semantic authority while manual answers remain usable', async () => {
    const fake = harness({ scope: 0.5, tasks: 0.5, verification: 0.5, approval: 0.5, specific: 0.5 });
    const input = question({ prompt: 'Is execution approved?', recommendedAnswer: 'Give a useful answer.' });
    const result = await read(input);
    expect(result.actions).toEqual([]);
    expect(result.recommendation).toBeNull();
    const actions = build(input, 'I explicitly choose this answer', result);
    expect(ids(actions)).toEqual(['ask-narrower', 'custom']);
    expect(actions[1]?.disabled).toBe(false);
    expect(fake.notes.filter(({ note }) => note.kind === 'action').map(({ note }) => note.kind === 'action' ? note.action : '')).toEqual(['suggestions:withheld', 'recommendation:withheld']);
  });

  test('negative readings never regain suggestions through keywords or generic prose', async () => {
    harness();
    const input = question({ prompt: 'What is the latest recorded approval?', recommendedAnswer: 'Think carefully and give an appropriate answer.' });
    const result = await read(input);
    expect(result.actions).toEqual([]);
    expect(result.recommendation).toBeNull();
    expect(ids(build(input, '', result))).toEqual(['ask-narrower', 'custom']);
    expect(build(input, '', result).at(-1)?.disabled).toBe(true);
  });

  test('deduplicates suggested answer text, preserves explicit approval kind and bounds detail only', async () => {
    harness({ scope: 0.99, approval: 0.99, specific: 0.99 });
    const input = question({ recommendedAnswer: '  USE A FOCUSED FIRST-PASS SCOPE FOR THIS GOAL.  ' });
    const result = await read(input);
    expect(ids(result.actions)).not.toContain('recommended');
    expect(result.recommendation).toBe(input.recommendedAnswer!);
    expect(result.actions[0]).toMatchObject({ id: 'approve-execution', kind: 'approve' });
    const draft = 'x'.repeat(200);
    const custom = build(input, draft, result).at(-1)!;
    expect(custom.answer).toBe(draft);
    expect(custom.detail).toHaveLength(86);
  });

  test('same-ID changed questions cannot consume an obsolete suggested answer', async () => {
    harness({ scope: 0.99 });
    const input = question();
    const result = await read(input);
    for (const changed of [
      { ...input, id: 'new-question' }, { ...input, prompt: 'What is the latest saved decision?' },
      { ...input, recommendedAnswer: 'New answer' }, { ...input, consequence: 'New consequence' },
      { ...input, status: 'answered' as const },
    ]) expect(ids(build(changed, 'current answer', result))).toEqual(['ask-narrower', 'custom']);
    expect(ids(build(input, 'current answer', result))).toContain('scope-focused-first-pass');
  });

  test('port absence does not prevent structurally valid manual composition', async () => {
    const input = question();
    await expect(read(input)).rejects.toBeInstanceOf(JudgmentPortMissingError);
    expect(ids(build(input, 'explicit answer'))).toEqual(['ask-narrower', 'custom']);
    expect(build(input, 'explicit answer').at(-1)?.disabled).toBe(false);
  });
});

describe('full-input privacy before the planning judgment boundary', () => {
  const rejected: readonly [string, Partial<ProjectPlanningQuestion>][] = [
    ['credential after display cap', { prompt: `${'ordinary '.repeat(700)} password=${SECRET}` }],
    ['card after display cap', { recommendedAnswer: `${'ordinary '.repeat(700)} ${PAN}` }],
    ['credential in nested excluded metadata', { metadata: { nested: { apiKey: SECRET } } }],
    ['card in excluded metadata', { metadata: { card: { number: PAN } } }],
    ['caller-controlled credential ID', { id: `password=${SECRET}` }],
    ['caller-controlled card ID', { id: PAN }],
  ];
  test.each(rejected)('%s is refused without provider requests or decision records', async (_name, extra) => {
    const fake = harness({ scope: 0.99 });
    let failure: unknown;
    try { await read(question(extra)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(JudgmentInputError);
    expect(String(failure)).not.toContain(SECRET);
    expect(String(failure)).not.toContain(PAN);
    expect(fake.requests).toEqual([]);
    expect(fake.entries).toEqual([]);
    expect(fake.notes).toEqual([]);
    // A semantic refusal is not a revocation of explicit operator input.
    expect(build(question(extra), 'my explicit answer').at(-1)?.disabled).toBe(false);
  });

  test('privacy refusal precedes even acquiring an unconfigured port', async () => {
    await expect(read(question({ id: PAN }))).rejects.toBeInstanceOf(JudgmentInputError);
  });

  test('accessors, cycles and serialization hooks are rejected without invoking caller code', async () => {
    const fake = harness();
    let invoked = 0;
    const accessor = { id: 'question', get prompt() { invoked++; return 'safe once'; } };
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const input of [accessor, question({ metadata: cyclic }), question({ metadata: { toJSON() { invoked++; return SECRET; } } })]) {
      await expect(read(input)).rejects.toBeInstanceOf(JudgmentInputError);
    }
    expect(invoked).toBe(0);
    expect(fake.requests).toEqual([]);
    expect(fake.entries).toEqual([]);
  });

  test('accepted source IDs and metadata remain local, with a single captured input snapshot', async () => {
    const fake = harness({ scope: 0.99, specific: 0.99 });
    const input = { ...question({ id: 'local-original-id', metadata: { displayHint: 'local-metadata-marker' }, recommendedAnswer: 'Change retry.ts only.' }) };
    const originalAsk = fake.port.ask;
    fake.port.ask = async (request) => {
      input.recommendedAnswer = 'Mutated after request';
      input.prompt = 'Mutated after request';
      return originalAsk(request);
    };
    const result = await read(input);
    expect(result.question.id).toBe('local-original-id');
    expect(result.recommendation).toBe('Change retry.ts only.');
    const evidence = JSON.stringify({ requests: fake.requests, entries: fake.entries, notes: fake.notes });
    expect(evidence).not.toContain('local-original-id');
    expect(evidence).not.toContain('local-metadata-marker');
    expect(evidence).not.toContain('Mutated after request');
    expect(JSON.stringify(fake.requests.map((request) => request.state))).toContain('question_0');
    expect(ids(build(input, 'current manual answer', result))).toEqual(['ask-narrower', 'custom']);
  });
});

describe('planning reading cancellation', () => {
  test('an already-aborted read asks and records nothing', async () => {
    const fake = harness({ scope: 0.99 });
    const controller = new AbortController(); controller.abort();
    await expect(read(question(), { signal: controller.signal })).rejects.toThrow();
    expect(fake.requests).toEqual([]);
    expect(fake.entries).toEqual([]);
  });

  test('the captured call signal stays authoritative when the caller changes its options object', async () => {
    const fake = harness({ scope: 0.99 });
    // Exercise the reader against a borrowed port that ignores cancellation.
    installJudgmentPort(fake.port);
    const entered = deferred(); const release = deferred();
    const originalAsk = fake.port.ask;
    fake.port.ask = async (request) => { entered.resolve(); await release.promise; return originalAsk(request); };
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const pending = read(question(), options).then(() => false, () => true);
    await entered.promise;
    options.signal = new AbortController().signal;
    controller.abort(); release.resolve();
    expect(await pending).toBe(true);
    expect(fake.requests[0]?.signal).toBe(controller.signal);
  });

  test('cancellation during a receipt prevents the next receipt and a ready result', async () => {
    const controller = new AbortController();
    const fake = harness({ scope: 0.99, specific: 0.99 }, () => { controller.abort(); });
    await expect(read(question({ recommendedAnswer: 'Only change retry.ts.' }), { signal: controller.signal })).rejects.toThrow();
    expect(fake.requests).toHaveLength(2);
    expect(fake.notes.filter(({ note }) => note.kind === 'action')).toHaveLength(1);
  });

  for (const blockedCall of [1, 2]) {
    test(`a late result after abort during call ${blockedCall} never becomes a suggestion action`, async () => {
      const fake = harness({ scope: 0.99, specific: 0.99 });
      const entered = deferred(); const release = deferred();
      const originalAsk = fake.port.ask;
      let calls = 0;
      fake.port.ask = async (request) => {
        if (++calls === blockedCall) { entered.resolve(); await release.promise; }
        return originalAsk(request);
      };
      const controller = new AbortController();
      const pending = read(question({ recommendedAnswer: 'Only change retry.ts.' }), { signal: controller.signal });
      const rejected = pending.then(() => false, () => true);
      await entered.promise;
      controller.abort(); release.resolve();
      expect(await rejected).toBe(true);
      expect(fake.requests.every((request) => request.signal === controller.signal)).toBe(true);
      expect(fake.notes.filter(({ note }) => note.kind === 'action')).toEqual([]);
    });
  }
});

test('both planning batteries are registered and their synthetic fixture replay is coherent', async () => {
  const names = registry.list().map((battery) => battery.name);
  expect(names).toContain(planningAnswerTopic.name);
  expect(names).toContain(planningRecommendationSpecific.name);
  for (const battery of [planningAnswerTopic, planningRecommendationSpecific]) {
    const cases = new Map(battery.fixtures.map((fixture) => [JSON.stringify(fixture.state), fixture.expect]));
    const { port } = fakePort((name, _question, state) => {
      const expected = cases.get(JSON.stringify(state)) as Record<string, string> | undefined;
      if (!expected || !Object.hasOwn(expected, name)) throw new Error('Fixture answer is missing');
      return noulAnswer(expected[name] === 'yes' ? 0.99 : 0.01);
    });
    const checks = await battery.checkFixtures(port);
    expect(checks.every((check) => check.correct)).toBe(true);
  }
});
