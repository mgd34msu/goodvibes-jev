import { describe, expect, test } from 'bun:test';
import {
  BatteryRegistry,
  defineBattery,
  JudgmentError,
  oneOf,
  rated,
  STAKES_BANDS,
  validateContextBudget,
  yesNo,
  type JudgmentPort,
  type JudgmentRequest,
  type Questions,
} from '../src/index.ts';

const band = STAKES_BANDS.medium;

const triage = () =>
  defineBattery({
    name: 'test.ticket-triage',
    version: 1,
    description: 'Routes a support ticket and reads its urgency and mood.',
    accuracyFloor: 0.8,
    items: {
      urgent: yesNo('Does the ticket convey urgency?', band.yesNo),
      team: oneOf('Which team handles the ticket?', { billing: 'Charges', technical: 'Bugs' }, {
        ...band.confidence,
        perOption: { billing: STAKES_BANDS.high.confidence },
      }),
      mood: rated('How frustrated is the sender?', ['Calm', 'Frustrated', 'Very angry'], band.confidence),
    },
    fixtures: [
      { name: 'double charge', state: 'I was charged twice, fix it now!', expect: { urgent: 'yes', team: 'billing', mood: 2 } },
      { name: 'crash', state: 'The app crashes on login.', expect: { team: 'technical' } },
    ],
  });

function recordingPort(answers: Record<string, unknown>) {
  const requests: JudgmentRequest<Questions>[] = [];
  const port: JudgmentPort = {
    model: 'jev-1.13.0',
    async ask(request) {
      requests.push(request as JudgmentRequest<Questions>);
      const picked = Object.fromEntries(Object.keys(request.questions).map((name) => [name, answers[name]]));
      return {
        answers: picked as never,
        requestedModel: request.model ?? 'jev-1.13.0',
        model: 'jev-1.13.0',
        usage: { inputTokens: 10, outputTokens: 2 },
        latencyMs: 5,
        requestId: 'req-t',
      };
    },
  };
  return { port, requests };
}

const ANSWERS = {
  urgent: { type: 'noul', noul: 0.92 },
  team: { type: 'choice', choice: 'billing', confidence: 0.8, probabilities: { billing: 0.9, technical: 0.1 } },
  mood: { type: 'score', score: 1.9, confidence: 0.9, legend: {}, probabilities: { '0': 0, '1': 0.1, '2': 0.9 } },
};

describe('defineBattery', () => {
  test('runs every question about one state in a single request, attributed to the battery', async () => {
    const { port, requests } = recordingPort(ANSWERS);
    const run = await triage().run(port, 'I was charged twice', { site: 'intake.triage' });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions).sort()).toEqual(['mood', 'team', 'urgent']);
    expect(requests[0]!.context).toEqual({ battery: 'test.ticket-triage', batteryVersion: 1, pattern: 'battery', site: 'intake.triage' });
    expect(run.readings.urgent).toMatchObject({ verdict: 'yes', outcome: 'act' });
    // billing carries a high-stakes band: 0.8 confidence confirms instead of acting.
    expect(run.readings.team).toMatchObject({ choice: 'billing', outcome: 'confirm' });
    expect(run.readings.mood).toMatchObject({ level: 2, outcome: 'act' });
    expect(run.result.model).toBe('jev-1.13.0');
  });

  test('`only` asks the named subset and nothing else', async () => {
    const { port, requests } = recordingPort(ANSWERS);
    const run = await triage().run(port, 'x', { only: ['urgent'] });
    expect(Object.keys(requests[0]!.questions)).toEqual(['urgent']);
    expect(Object.keys(run.readings)).toEqual(['urgent']);
  });

  test('a pinned model on the battery is sent with the request', async () => {
    const { port, requests } = recordingPort(ANSWERS);
    const pinned = defineBattery({
      name: 'test.pinned',
      version: 2,
      description: 'd',
      accuracyFloor: 1,
      model: 'jev-1.13.0',
      items: { urgent: yesNo('Urgent?', band.yesNo) },
      fixtures: [{ name: 'a', state: 'now!', expect: { urgent: 'yes' } }],
    });
    await pinned.run(port, 'x');
    expect(requests[0]!.model).toBe('jev-1.13.0');
  });

  test.each([
    ['a bad name', { name: 'Bad Name' }],
    ['a zero version', { version: 0 }],
    ['an accuracy floor of 0', { accuracyFloor: 0 }],
    ['no questions', { items: {} }],
    [
      'a question no fixture covers',
      { fixtures: [{ name: 'only urgent', state: 's', expect: { urgent: 'yes' } }] },
    ],
    [
      'an impossible expected option',
      { fixtures: [{ name: 'f', state: 's', expect: { urgent: 'yes', team: 'sales', mood: 1 } }] },
    ],
    [
      'an expected level off the rubric',
      { fixtures: [{ name: 'f', state: 's', expect: { urgent: 'yes', team: 'billing', mood: 3 } }] },
    ],
    [
      'duplicate fixture names',
      {
        fixtures: [
          { name: 'f', state: 's', expect: { urgent: 'yes', team: 'billing', mood: 1 } },
          { name: 'f', state: 's', expect: { urgent: 'no' } },
        ],
      },
    ],
    [
      'a band for an unknown option',
      {
        items: {
          team: oneOf('Which team?', { billing: null, technical: null }, {
            actAt: 0.7,
            confirmAt: 0.5,
            perOption: { sales: { actAt: 0.9, confirmAt: 0.6 } } as never,
          }),
        },
        fixtures: [{ name: 'f', state: 's', expect: { team: 'billing' } }],
      },
    ],
  ])('rejects %s', (_label, change) => {
    const base = {
      name: 'test.bad',
      version: 1,
      description: 'd',
      accuracyFloor: 0.9,
      items: {
        urgent: yesNo('Urgent?', band.yesNo),
        team: oneOf('Which team?', { billing: null, technical: null }, band.confidence),
        mood: rated('Mood?', ['calm', 'upset'], band.confidence),
      },
      fixtures: [{ name: 'f', state: 's', expect: { urgent: 'yes', team: 'billing', mood: 1 } }],
    };
    expect(() => defineBattery({ ...base, ...change } as never)).toThrow(RangeError);
  });
});

describe('BatteryRegistry', () => {
  test('lists batteries by name and refuses duplicates', () => {
    const registry = new BatteryRegistry();
    registry.register(triage());
    expect(registry.get('test.ticket-triage')?.version).toBe(1);
    expect(() => registry.register(triage())).toThrow(RangeError);
    const other = new BatteryRegistry();
    other.register(
      defineBattery({
        name: 'test.another',
        version: 1,
        description: 'd',
        accuracyFloor: 1,
        items: { a: yesNo('A?', band.yesNo) },
        fixtures: [{ name: 'f', state: 's', expect: { a: 'no' } }],
      }),
    );
    expect(BatteryRegistry.merge(registry, other).list().map((b) => b.name)).toEqual(['test.another', 'test.ticket-triage']);
  });
});

describe('context budget', () => {
  test('a state beyond the 32k budget with its longest question is refused before sending', () => {
    const state = 'word '.repeat(20_000);
    const error = (() => {
      try {
        validateContextBudget(state, { q: { type: 'noul', instructions: 'Is this long?' } });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(JudgmentError);
    expect((error as JudgmentError).kind).toBe('invalid-request');
  });

  test('a normal request fits', () => {
    expect(() => validateContextBudget('short state', { q: { type: 'noul', instructions: 'Short?' } })).not.toThrow();
  });
});
