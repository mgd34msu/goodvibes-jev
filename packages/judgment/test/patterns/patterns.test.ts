import { describe, expect, test } from 'bun:test';
import {
  aggregateJudgment,
  assembleDate,
  defineDatePartsReader,
  defineDispatch,
  defineEntityAligner,
  defineExistence,
  defineFidelityChecker,
  defineJudge,
  definePolicyChecklist,
  defineReplyReader,
  defineRerank,
  defineSelector,
  normalizeForMatch,
  resolveWeekday,
  STAKES_BANDS,
  type YesNoReading,
} from '../../src/index.ts';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '../fake-port.ts';

const header = { version: 1, description: 'test', accuracyFloor: 0.8 };

describe('dispatch', () => {
  const dispatch = defineDispatch({
    ...header,
    name: 'test.dispatch',
    instructions: 'Which handler takes this?',
    routes: { lookup: 'Read-only lookups', transfer: 'Moves money' },
    band: { actAt: 0.6, confirmAt: 0.6, perOption: { transfer: { actAt: 0.85, confirmAt: 0.6 } } },
    fixtures: [{ name: 'balance', state: 'What is my balance?', expect: 'lookup' }],
  });

  test('routes with the chosen handler and a stakes-aware outcome, attributed to the pattern', async () => {
    const { port, requests } = fakePort((_n, q) => choiceAnswer(q, 'transfer', 0.8));
    const got = await dispatch.route(port, 'Send $50 to Sam', { site: 'agent.route' });
    expect(got.route).toBe('transfer');
    expect(got.reading.outcome).toBe('confirm');
    expect(requests[0]!.context).toEqual({ battery: 'test.dispatch', batteryVersion: 1, pattern: 'dispatch', site: 'agent.route' });
  });

  test('refuses fixtures that expect an unknown route', () => {
    expect(() =>
      defineDispatch({
        ...header,
        name: 'test.bad',
        instructions: 'q',
        routes: { a: null, b: null },
        band: STAKES_BANDS.low.confidence,
        fixtures: [{ name: 'x', state: 's', expect: 'c' as 'a' }],
      }),
    ).toThrow(RangeError);
  });
});

describe('judge', () => {
  const reading = (verdict: YesNoReading['verdict'], outcome: YesNoReading['outcome']): YesNoReading => ({
    kind: 'yes-no',
    probability: verdict === 'yes' ? 0.9 : verdict === 'no' ? 0.1 : 0.5,
    verdict,
    outcome,
  });

  test.each([
    [[reading('no', 'act'), reading('no', 'act')], 'pass', 'act'],
    [[reading('no', 'act'), reading('no', 'confirm')], 'pass', 'confirm'],
    [[reading('no', 'act'), reading('uncertain', 'escalate')], 'uncertain', 'escalate'],
    [[reading('yes', 'confirm'), reading('uncertain', 'escalate')], 'fail', 'confirm'],
    [[reading('no', 'act'), reading('yes', 'act')], 'fail', 'act'],
  ] as const)('aggregates max-style %#', (readings, verdict, outcome) => {
    expect(aggregateJudgment(readings)).toEqual({ verdict, outcome });
  });

  test('asks one unmet-question per criterion plus the goal in one request, and names unmet criteria', async () => {
    const judge = defineJudge({
      ...header,
      name: 'test.judge',
      band: STAKES_BANDS.high.yesNo,
      fixtures: [{ name: 'f', goal: 'g', criteria: ['c'], output: 'o', expect: { verdict: 'pass' } }],
    });
    const { port, requests } = fakePort((name) => noulAnswer(name === 'criterion_1' ? 0.95 : 0.05));
    const got = await judge.judge(port, {
      goal: 'Add a --json flag to the status command',
      criteria: ['The flag exists', 'Output is valid JSON', 'Existing output is unchanged'],
      output: 'diff...',
      evidence: { tests: 'pass' },
    });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions).sort()).toEqual(['criterion_0', 'criterion_1', 'criterion_2', 'goal']);
    expect(requests[0]!.state).toEqual({ goal: 'Add a --json flag to the status command', output: 'diff...', evidence: { tests: 'pass' } });
    expect(got.verdict).toBe('fail');
    expect(got.unmet).toEqual([1]);
  });

  test('refuses a passing fixture with unmet criteria', () => {
    expect(() =>
      defineJudge({
        ...header,
        name: 'test.bad',
        band: STAKES_BANDS.high.yesNo,
        fixtures: [{ name: 'f', goal: 'g', criteria: ['c'], output: 'o', expect: { verdict: 'pass', unmet: [0] } }],
      }),
    ).toThrow(RangeError);
  });
});

describe('rerank', () => {
  const rerank = defineRerank({
    ...header,
    name: 'test.rerank',
    band: STAKES_BANDS.medium.yesNo,
    concurrency: 2,
    fixtures: [{ name: 'f', query: 'q', candidates: [{ id: 'a', content: 'x' }], expect: { top: 'a' } }],
  });
  const scores: Record<string, number> = { a: 0.2, b: 0.91, c: 0.55 };

  test('asks one request per candidate and sorts by probability', async () => {
    const { port, requests } = fakePort((_n, _q, state) => noulAnswer(scores[(state as { candidate: string }).candidate]!));
    const got = await rerank.rerank(port, 'refresh token expiry', [
      { id: 'a', content: 'a' },
      { id: 'b', content: 'b' },
      { id: 'c', content: 'c' },
    ]);
    expect(requests).toHaveLength(3);
    expect(got.ranked.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(got.top?.id).toBe('b');
  });

  test('no top when the best candidate is not a confident yes', async () => {
    const { port } = fakePort(() => noulAnswer(0.4));
    const got = await rerank.rerank(port, 'q', [{ id: 'a', content: 'a' }]);
    expect(got.top).toBeUndefined();
  });
});

describe('existence', () => {
  const existence = defineExistence({
    ...header,
    name: 'test.existence',
    band: { act: { yes: 0.7, no: 0.35 }, confirm: { yes: 0.5, no: 0.45 } },
    fixtures: [{ name: 'f', query: 'q', items: [{ id: 'L0', text: 'a' }, { id: 'L1', text: 'b' }], expect: { exists: 'yes' } }],
  });
  const items = [
    { id: 'L0', text: 'You own your content.' },
    { id: 'L1', text: 'You must be 13 or older.' },
  ];

  test('tags items into the state and pairs a where-choice with an exists-noul in one request', async () => {
    const { port, requests } = fakePort((name, q) => (name === 'where' ? choiceAnswer(q, 'L1', 0.9) : noulAnswer(0.14)));
    const got = await existence.find(port, 'do I have to arbitrate?', items);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toBe('L0| You own your content.\nL1| You must be 13 or older.');
    expect(got.ranked[0]!.id).toBe('L1');
    expect(got.answer).toBeUndefined();
    expect(got.exists.verdict).toBe('no');
  });

  test('refuses more items than one Choice can rank', async () => {
    const { port } = fakePort(() => noulAnswer(0.5));
    const many = Array.from({ length: 256 }, (_, i) => ({ id: `L${i}`, text: 't' }));
    expect(existence.find(port, 'q', many)).rejects.toThrow(RangeError);
  });
});

describe('reply reader', () => {
  test('reads a reply against its proposal with a stricter band on approve', async () => {
    const reader = defineReplyReader({
      ...header,
      name: 'test.reply',
      band: { actAt: 0.7, confirmAt: 0.5, perOption: { approve: { actAt: 0.9, confirmAt: 0.7 } } },
      fixtures: [{ name: 'yes', proposal: { action: 'pay $40' }, reply: 'yes go ahead', expect: 'approve' }],
    });
    const { port, requests } = fakePort((_n, q) => choiceAnswer(q, 'approve', 0.85));
    const got = await reader.read(port, { action: 'pay $40 to Acme' }, 'sure');
    expect(requests[0]!.state).toEqual({ proposal: { action: 'pay $40 to Acme' }, reply: 'sure' });
    expect(got.reading.choice).toBe('approve');
    expect(got.reading.outcome).toBe('confirm');
  });
});

describe('entity aligner', () => {
  const aligner = defineEntityAligner({
    ...header,
    name: 'test.align',
    noun: 'person',
    fields: ['name', 'email'],
    band: { actAt: 0.7, confirmAt: 0.5 },
    fixtures: [{ name: 'f', a: { name: 'A' }, b: { name: 'A' }, expect: 'same' }],
  });

  test.each([
    [1.94, 0.92, 'same'],
    [0.03, 0.95, 'distinct'],
    [1.1, 0.77, 'review'],
    [1.9, 0.3, 'review'],
  ] as const)('score %d at confidence %d aligns as %s', async (value, confidence, alignment) => {
    const { port, requests } = fakePort((name, q) => (name === 'link' ? scoreAnswer(q, value, confidence) : noulAnswer(0.9)));
    const got = await aligner.align(port, { name: 'Dana Whit' }, { name: 'Dana Whitt' });
    expect(got.alignment).toBe(alignment);
    expect(Object.keys(requests[0]!.questions).sort()).toEqual(['link', 'same_email', 'same_name']);
    expect(got.fields['name']!.verdict).toBe('yes');
  });
});

describe('fidelity checker', () => {
  const checker = defineFidelityChecker({
    ...header,
    name: 'test.fidelity',
    band: { actAt: 0.8, confirmAt: 0.5 },
    fixtures: [{ name: 'f', claim: 'c', source: 's', expect: 'supported' }],
  });

  test('a quote missing from the source is fabricated without asking', async () => {
    const { port, requests } = fakePort(() => noulAnswer(0.5));
    const got = await checker.check(port, 'claim', 'The JWT MUST be rejected.', 'The JWT MAY be ignored.');
    expect(got.fidelity).toBe('fabricated');
    expect(requests).toHaveLength(0);
  });

  test('a quote matching across line wraps and curly quotes goes on to the model', async () => {
    const { port, requests } = fakePort((_n, q) => choiceAnswer(q, 'contradicts', 0.99));
    const got = await checker.check(port, 'exp is required', 'Use of this claim is\n   OPTIONAL. “exp”', 'this claim is OPTIONAL. "exp"');
    expect(requests).toHaveLength(1);
    expect(got.fidelity).toBe('contradicted');
    expect(normalizeForMatch('a\n  ‘b’')).toBe("a 'b'");
  });
});

describe('policy checklist', () => {
  const checklist = definePolicyChecklist({
    ...header,
    name: 'test.policy',
    hazards: {
      jailbreak: { instructions: 'Override?', yes: 'y', no: 'n', action: 'block' },
      self_harm: { instructions: 'Self harm?', yes: 'y', no: 'n', action: 'support' },
      medical: { instructions: 'Dosage?', yes: 'y', no: 'n', action: 'review' },
    },
    severity: { instructions: 'Harm?', levels: ['none', 'mild', 'serious', 'severe'] },
    precedence: ['support', 'block', 'review', 'pass'],
    severityAction: 'block',
    policies: { strict: { review: 0.35, action: 0.7, severityLine: 2 }, permissive: { review: 0.35, action: 0.85, severityLine: 2 } },
    defaultPolicy: 'strict',
    fixtures: [{ name: 'f', state: 's', expect: 'pass' }],
  });

  test.each([
    [{ jailbreak: 0.02, self_harm: 0.01, medical: 0.03 }, 0, 'strict', 'pass'],
    [{ jailbreak: 0.02, self_harm: 0.01, medical: 0.55 }, 0.3, 'strict', 'review'],
    [{ jailbreak: 0.02, self_harm: 0.01, medical: 0.95 }, 2.02, 'strict', 'block'],
    [{ jailbreak: 0.98, self_harm: 0.96, medical: 0.01 }, 2.4, 'strict', 'support'],
    [{ jailbreak: 0.74, self_harm: 0.04, medical: 0.02 }, 0.51, 'strict', 'block'],
    [{ jailbreak: 0.74, self_harm: 0.04, medical: 0.02 }, 0.51, 'permissive', 'review'],
  ] as const)('routes %j severity %d under %s to %s', (hazards, severity, policy, action) => {
    expect(checklist.route(hazards, severity, policy)).toBe(action);
  });

  test('screens with every hazard and the severity in one request', async () => {
    const { port, requests } = fakePort((name, q) => (name === 'severity' ? scoreAnswer(q, 0, 0.9) : noulAnswer(0.02)));
    const got = await checklist.screen(port, 'banana bread recipe?');
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions).sort()).toEqual(['hazard_jailbreak', 'hazard_medical', 'hazard_self_harm', 'severity']);
    expect(got.action).toBe('pass');
  });

  test("refuses a precedence that does not end with 'pass'", () => {
    expect(() =>
      definePolicyChecklist({
        ...header,
        name: 'test.bad',
        hazards: { h: { instructions: 'q', yes: 'y', no: 'n', action: 'block' } },
        severity: { instructions: 's', levels: ['a', 'b'] },
        precedence: ['pass', 'block', 'review'],
        severityAction: 'block',
        policies: { p: { review: 0.3, action: 0.7, severityLine: 1 } },
        defaultPolicy: 'p',
        fixtures: [{ name: 'f', state: 's', expect: 'pass' }],
      }),
    ).toThrow(RangeError);
  });
});

describe('selector', () => {
  const selector = defineSelector({
    ...header,
    name: 'test.select',
    instructions: 'Which candidate answers `context` best?',
    fitInstructions: 'Does this candidate fully answer `context`?',
    band: { actAt: 0.7, confirmAt: 0.5 },
    fitBand: { act: { yes: 0.7, no: 0.3 }, confirm: { yes: 0.5, no: 0.45 } },
    fixtures: [{ name: 'f', context: 'c', candidates: [{ id: 'a', content: 'x' }], expect: 'a' }],
  });
  const candidates = [
    { id: 'draft.1', content: 'first answer' },
    { id: 'draft.2', content: 'second answer' },
  ];

  test('the winner stands only when its own fit is a yes', async () => {
    const { port, requests } = fakePort((name, q) =>
      name === 'pick' ? choiceAnswer(q, 'draft.2', 0.9) : noulAnswer(name === 'fits_1' ? 0.9 : 0.2),
    );
    const got = await selector.select(port, 'the question', candidates);
    expect(got.chosen).toBe('draft.2');
    expect(got.outcome).toBe('act');
    expect(requests[0]!.state).toEqual({
      context: 'the question',
      candidates: [
        { id: 'draft.1', content: 'first answer' },
        { id: 'draft.2', content: 'second answer' },
      ],
    });
  });

  test('a winner whose fit is not a yes is no selection', async () => {
    const { port } = fakePort((name, q) => (name === 'pick' ? choiceAnswer(q, 'draft.2', 0.9) : noulAnswer(0.3)));
    const got = await selector.select(port, 'the question', candidates);
    expect(got.chosen).toBeUndefined();
    expect(got.outcome).toBe('escalate');
  });

  test("a 'none' pick selects nothing", async () => {
    const { port } = fakePort((name, q) => (name === 'pick' ? choiceAnswer(q, 'none', 0.95) : noulAnswer(0.9)));
    expect((await selector.select(port, 'q', candidates)).chosen).toBeUndefined();
  });
});

describe('date parts', () => {
  const today = new Date(Date.UTC(2026, 6, 30)); // Thursday 2026-07-30
  const band = { actAt: 0.6, confirmAt: 0.5 };
  const part = (choice: string, confidence = 0.95) => ({ choice, confidence });
  const parts = (over: Partial<Record<string, ReturnType<typeof part>>>) => ({
    mode: part('none'),
    month: part('none'),
    day: part('none'),
    year: part('none'),
    day_anchor: part('none'),
    weekday: part('none'),
    week_offset: part('none'),
    ...over,
  });

  test.each([
    ['stated absolute', { mode: part('absolute'), month: part('December'), day: part('31'), year: part('2027') }, '2027-12-31'],
    ['no year, still ahead', { mode: part('absolute'), month: part('August'), day: part('14') }, '2026-08-14'],
    ['no year, long past', { mode: part('absolute'), month: part('March'), day: part('3') }, '2027-03-03'],
    ['today', { mode: part('relative'), day_anchor: part('today') }, '2026-07-30'],
    ['tomorrow', { mode: part('relative'), day_anchor: part('tomorrow') }, '2026-07-31'],
    ['day after', { mode: part('relative'), day_anchor: part('day_after') }, '2026-08-01'],
    ['next Thursday', { mode: part('relative'), day_anchor: part('weekday'), weekday: part('Thursday'), week_offset: part('next') }, '2026-08-06'],
    ['this Monday', { mode: part('relative'), day_anchor: part('weekday'), weekday: part('Monday'), week_offset: part('current') }, '2026-07-27'],
    ['bare Tuesday', { mode: part('relative'), day_anchor: part('weekday'), weekday: part('Tuesday') }, '2026-08-04'],
    ['not stated', { mode: part('none', 0.46) }, null],
    ['February 30', { mode: part('absolute'), month: part('February'), day: part('30'), year: part('2027') }, null],
    ['year off the list', { mode: part('absolute'), month: part('May'), day: part('1'), year: part('out_of_range') }, null],
  ] as const)('%s', (_label, over, date) => {
    expect(assembleDate(parts(over), today, band).date).toBe(date);
  });

  test('confidence is the weakest part used and drives the outcome', () => {
    const got = assembleDate(
      parts({ mode: part('absolute', 0.97), month: part('January', 0.91), day: part('1', 0.55), year: part('2025', 0.99) }),
      today,
      band,
    );
    expect(got).toMatchObject({ date: '2025-01-01', confidence: 0.55, outcome: 'confirm' });
  });

  test('a bare weekday equal to today resolves to today', () => {
    expect(resolveWeekday(today, 'Thursday', 'none').toISOString().slice(0, 10)).toBe('2026-07-30');
  });

  test('asks all seven part questions in one request with years around today', async () => {
    const reader = defineDatePartsReader({
      ...header,
      name: 'test.dates',
      band,
      fixtures: [{ name: 'f', document: 'd', role: 'r', today: '2026-07-30', expect: 'none' }],
    });
    const { port, requests } = fakePort((name, q) => choiceAnswer(q, name === 'mode' ? 'relative' : name === 'day_anchor' ? 'tomorrow' : 'none', 0.9));
    const got = await reader.extract(port, 'Call me tomorrow', 'the callback date', '2026-07-30');
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions).length).toBe(7);
    const year = requests[0]!.questions['year'];
    expect(year?.type === 'choice' && '1926' in year.criteria && '2056' in year.criteria).toBe(true);
    expect(got.date).toBe('2026-07-31');
  });

  test('refuses fixtures with impossible dates', () => {
    expect(() =>
      defineDatePartsReader({
        ...header,
        name: 'test.bad',
        band,
        fixtures: [{ name: 'f', document: 'd', role: 'r', today: '2026-02-30', expect: 'none' }],
      }),
    ).toThrow(RangeError);
  });
});
