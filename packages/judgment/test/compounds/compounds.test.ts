import { describe, expect, test } from 'bun:test';
import {
  defineBattery,
  defineCompositeScore,
  defineHierarchyWalker,
  defineJudge,
  defineRankRecheck,
  fanOut,
  oneOf,
  rated,
  STAKES_BANDS,
  verifyThenEscalate,
  yesNo,
} from '../../src/index.ts';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '../fake-port.ts';

const header = { version: 1, description: 'test', accuracyFloor: 0.8 };

describe('fanOut', () => {
  const urgency = defineBattery({
    ...header,
    name: 'test.urgency',
    items: { urgent: yesNo('Urgent?', STAKES_BANDS.medium.yesNo) },
    fixtures: [{ name: 'f', state: 's', expect: { urgent: 'yes' } }],
  });
  const routing = defineBattery({
    ...header,
    name: 'test.routing',
    items: {
      team: oneOf('Team?', { billing: null, technical: null }, STAKES_BANDS.medium.confidence),
      mood: rated('Mood?', ['calm', 'angry'], STAKES_BANDS.medium.confidence),
    },
    fixtures: [{ name: 'f', state: 's', expect: { team: 'billing', mood: 1 } }],
  });

  test('asks every battery in one request and hands each its own readings', async () => {
    const { port, requests } = fakePort((name, q) =>
      name.endsWith('urgent') ? noulAnswer(0.9) : name.endsWith('team') ? choiceAnswer(q, 'billing', 0.95) : scoreAnswer(q, 1, 0.9),
    );
    const got = await fanOut(port, 'charged twice!!', { urgency, routing }, { site: 'intake' });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions).sort()).toEqual(['routing__mood', 'routing__team', 'urgency__urgent']);
    expect(requests[0]!.context).toEqual({ battery: 'test.urgency+test.routing', pattern: 'fan-out', site: 'intake' });
    expect(got.readings.urgency.urgent.verdict).toBe('yes');
    expect(got.readings.routing.team.choice).toBe('billing');
    expect(got.readings.routing.mood.level).toBe(1);
  });

  test('refuses batteries tuned on different models', async () => {
    const pinned = defineBattery({
      ...header,
      name: 'test.pinned',
      model: 'jev-9.0.0',
      items: { a: yesNo('A?', STAKES_BANDS.low.yesNo) },
      fixtures: [{ name: 'f', state: 's', expect: { a: 'no' } }],
    });
    const { port } = fakePort(() => noulAnswer(0.5));
    expect(fanOut(port, 's', { urgency, pinned })).rejects.toThrow(RangeError);
  });
});

describe('rank-recheck', () => {
  const compound = defineRankRecheck({
    ...header,
    name: 'test.skills',
    instructions: 'Which skill fits the request?',
    gates: {
      acts: { instructions: 'Does the request ask to act on the user system?' },
      prose: { instructions: 'Could a generalist answer this in prose?', inverted: true },
    },
    gateThreshold: 0.3,
    shortlist: 2,
    recheckInstructions: 'Exactly one of these skills fits. Which?',
    fitInstructions: 'Does this skill do what the request asks?',
    recheckBand: { actAt: 0.7, confirmAt: 0.5 },
    fitBand: { act: { yes: 0.6, no: 0.2 }, confirm: { yes: 0.3, no: 0.29 } },
    fixtures: [{ name: 'f', state: 's', options: [], expect: 'none' }],
  });
  const options = [
    { id: 'powerpoint', summary: 'Edit .pptx decks', detail: 'Edits existing decks' },
    { id: 'pptx-author', summary: 'Build decks with python-pptx', detail: 'Authors new decks from scratch' },
    { id: 'apple-notes', summary: 'Manage Apple Notes', detail: 'Notes.app via memo' },
  ];

  test('a low gate stops after the wide pass', async () => {
    const { port, requests } = fakePort((name, q) => (name === 'which' ? choiceAnswer(q, 'apple-notes', 0.5) : noulAnswer(name === 'gate_prose' ? 0.95 : 0.1)));
    const got = await compound.suggest(port, { request: 'explain monads' }, options);
    expect(requests).toHaveLength(1);
    expect(got.chosen).toBeUndefined();
    expect(got.gate).toBeCloseTo(0.075);
  });

  test('a passing gate rechecks only the shortlist, with full detail', async () => {
    const { port, requests } = fakePort((name, q, state) => {
      if (name === 'which') return { ...choiceAnswer(q, 'powerpoint', 0.7), probabilities: { powerpoint: 0.7, 'pptx-author': 0.3, 'apple-notes': 0 } };
      if (name.startsWith('gate_')) return noulAnswer(name === 'gate_prose' ? 0.1 : 0.9);
      if (name === 'pick') return choiceAnswer(q, 'pptx-author', 0.8);
      const index = Number(name.split('_')[1]);
      const id = (state as { candidates: { id: string }[] }).candidates[index]!.id;
      return noulAnswer(id === 'pptx-author' ? 0.75 : 0.4);
    });
    const got = await compound.suggest(port, { request: 'build a pitch deck' }, options);
    expect(requests).toHaveLength(2);
    expect((requests[1]!.state as { candidates: { id: string; content: string }[] }).candidates).toEqual([
      { id: 'powerpoint', content: 'Edits existing decks' },
      { id: 'pptx-author', content: 'Authors new decks from scratch' },
    ]);
    expect(got.chosen).toBe('pptx-author');
    expect(requests[1]!.context?.pattern).toBe('rank-recheck.recheck');
  });
});

describe('rank-recheck definition', () => {
  test('refuses a malformed fit band when defined, not when first run', () => {
    expect(() =>
      defineRankRecheck({
        ...header,
        name: 'test.bad',
        instructions: 'q',
        gates: { g: { instructions: 'g?' } },
        gateThreshold: 0.3,
        shortlist: 2,
        recheckInstructions: 'r',
        fitInstructions: 'f',
        recheckBand: { actAt: 0.7, confirmAt: 0.5 },
        fitBand: { act: { yes: 0.6, no: 0.3 }, confirm: { yes: 0.3, no: 0.29 } },
        fixtures: [{ name: 'f', state: 's', options: [], expect: 'none' }],
      }),
    ).toThrow(RangeError);
  });
});

describe('verifyThenEscalate', () => {
  const judge = defineJudge({
    ...header,
    name: 'test.judge',
    band: STAKES_BANDS.high.yesNo,
    fixtures: [{ name: 'f', goal: 'g', criteria: ['c'], output: 'o', expect: { verdict: 'pass' } }],
  });
  const task = { goal: 'Return the registration open date', criteria: ['The date is stated in the source'] };

  test('escalates past a failing cheap tier and accepts the first pass', async () => {
    const { port, requests } = fakePort((_name, _q, state) => noulAnswer((state as { output: string }).output === 'invented' ? 0.95 : 0.05));
    const got = await verifyThenEscalate(port, judge, [
      { name: 'small', produce: async () => 'invented' },
      { name: 'strong', produce: async () => '' },
      { name: 'never-reached', produce: async () => { throw new Error('should not run'); } },
    ], task);
    expect(requests).toHaveLength(2);
    expect(got).toMatchObject({ output: '', tier: 'strong', accepted: true });
    expect(got.attempts.map((a) => a.judgment.verdict)).toEqual(['fail', 'pass']);
  });

  test('reports the last attempt unaccepted when every tier fails', async () => {
    const { port } = fakePort(() => noulAnswer(0.95));
    const got = await verifyThenEscalate(port, judge, [{ name: 'only', produce: async () => 'x' }], task);
    expect(got.accepted).toBe(false);
    expect(got.tier).toBe('only');
  });
});

describe('hierarchy walker', () => {
  const tree = {
    'A Human necessities': { 'A01 Agriculture': { 'A01K31/12 Perches for birds': {}, 'A01K1/00 Housing animals': {} } },
    'E Construction': { 'E99 Other': { 'E99Z99/00 Not otherwise provided': {} } },
  };
  const probs: Record<string, Record<string, number>> = {
    '': { 'A Human necessities': 0.45, 'E Construction': 0.55 },
    'A Human necessities': { 'A01 Agriculture': 1 },
    'A Human necessities > A01 Agriculture': { 'A01K31/12 Perches for birds': 0.95, 'A01K1/00 Housing animals': 0.05 },
  };
  const walker = (beamWidth: number) =>
    defineHierarchyWalker({
      ...header,
      name: 'test.cpc',
      tree,
      beamWidth,
      actAt: 0.7,
      confirmAt: 0.5,
      fixtures: [{ name: 'f', state: 's', expect: 'A Human necessities > A01 Agriculture > A01K31/12 Perches for birds' }],
    });
  const answerer = (_n: string, q: Parameters<typeof choiceAnswer>[0], _s: unknown) => {
    if (q.type !== 'choice') throw new Error('choice only');
    const labels = Object.keys(q.criteria).sort().join('|');
    const key = Object.keys(probs).find((k) => Object.keys(probs[k]!).sort().join('|') === labels)!;
    const p = probs[key]!;
    const best = Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0];
    return { type: 'choice', choice: best, confidence: 0.5, probabilities: p };
  };

  test('greedy follows the early misstep; the beam recovers the right leaf', async () => {
    const greedy = await walker(1).walk(fakePort(answerer).port, 'a wooden perch for birds');
    expect(greedy.best.path.at(-1)).toBe('E99Z99/00 Not otherwise provided');
    const { port, requests } = fakePort(answerer);
    const beam = await walker(3).walk(port, 'a wooden perch for birds');
    expect(beam.best.path.at(-1)).toBe('A01K31/12 Perches for birds');
    expect(beam.best.score).toBeCloseTo(Math.sqrt(0.45 * 0.95));
    // single-child nodes decide nothing and are not asked
    expect(requests.every((r) => Object.keys((r.questions['child'] as { criteria: object }).criteria).length > 1)).toBe(true);
  });

  test('refuses fixtures that do not name a leaf', () => {
    expect(() =>
      defineHierarchyWalker({
        ...header,
        name: 'test.bad',
        tree,
        beamWidth: 2,
        actAt: 0.7,
        confirmAt: 0.5,
        fixtures: [{ name: 'f', state: 's', expect: 'A Human necessities' }],
      }),
    ).toThrow(RangeError);
  });
});

describe('composite score', () => {
  test('normalizes each dimension and weights it per profile in one request', async () => {
    const composite = defineCompositeScore({
      ...header,
      name: 'test.resume',
      dimensions: {
        python: { instructions: 'Python depth?', levels: ['none', 'some', 'daily', 'deep', 'expert'], band: STAKES_BANDS.low.confidence },
        leadership: { instructions: 'Leadership?', levels: ['none', 'some', 'leads teams'], band: STAKES_BANDS.low.confidence },
      },
      profiles: { ic: { python: 0.8, leadership: 0.2 }, manager: { python: 0.25, leadership: 0.75 } },
      fixtures: [{ name: 'f', state: 's', expect: { python: 4, leadership: 0 } }],
    });
    const { port, requests } = fakePort((name, q) => (name === 'python' ? scoreAnswer(q, 3, 0.9) : scoreAnswer(q, 1, 0.9)));
    const got = await composite.score(port, 'resume text');
    expect(requests).toHaveLength(1);
    expect(got.composites.ic).toBeCloseTo(0.8 * 0.75 + 0.2 * 0.5);
    expect(got.composites.manager).toBeCloseTo(0.25 * 0.75 + 0.75 * 0.5);
  });

  test('refuses a profile with no positive weight', () => {
    expect(() =>
      defineCompositeScore({
        ...header,
        name: 'test.bad',
        dimensions: { a: { instructions: 'A?', levels: ['x', 'y'], band: STAKES_BANDS.low.confidence } },
        profiles: { p: { a: 0 } },
        fixtures: [{ name: 'f', state: 's', expect: { a: 1 } }],
      }),
    ).toThrow(RangeError);
  });
});
