import { describe, expect, test } from 'bun:test';
import {
  choice,
  defineBattery,
  defineCoarseningClassifier,
  defineCounter,
  defineExtractionVerifier,
  defineFunctionCaller,
  defineRuleLadder,
  defineStructureRecovery,
  encodeColumns,
  createModelCatalog,
  noul,
  renderMarkdown,
  score,
  splitCompound,
  splitLines,
  STAKES_BANDS,
  yesNo,
  type Block,
} from '../../src/index.ts';
import { choiceAnswer, fakePort, noulAnswer } from '../fake-port.ts';

const header = { version: 1, description: 'test', accuracyFloor: 0.8 };

describe('counter', () => {
  test('one question per item, counted in code, uncertain items reported', async () => {
    const counter = defineCounter({
      ...header,
      name: 'test.count',
      condition: 'Is `item` the name of a fruit?',
      band: STAKES_BANDS.medium.yesNo,
      fixtures: [{ name: 'f', items: ['apple'], expect: 1 }],
    });
    const p: Record<string, number> = { item_0: 0.95, item_1: 0.02, item_2: 0.9, item_3: 0.5 };
    const { port, requests } = fakePort((name) => noulAnswer(p[name]!));
    const got = await counter.count(port, ['apple', 'typesafe', 'banana', 'tomato']);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toEqual({ items: ['apple', 'typesafe', 'banana', 'tomato'] });
    expect(got.count).toBe(2);
    expect(got.uncertain).toEqual([3]);
  });
});

describe('coarsening classifier', () => {
  const classifier = defineCoarseningClassifier({
    ...header,
    name: 'test.sic',
    instructions: 'Which industry?',
    labels: {
      '28': { description: 'chemicals', parent: 'manufacturing' },
      '63': { description: 'insurance', parent: 'finance' },
    },
    band: { actAt: 0.9, confirmAt: 0.5 },
    fixtures: [{ name: 'f', state: 's', expect: 'manufacturing' }],
  });

  test.each([
    [0.95, 'fine', '28'],
    [0.6, 'coarse', 'manufacturing'],
  ] as const)('confidence %d reports the %s label', async (confidence, level, label) => {
    const { port } = fakePort((_n, q) => choiceAnswer(q, '28', confidence));
    const got = await classifier.classify(port, 'a pharmaceutical maker');
    expect(got).toMatchObject({ level, label, fine: '28' });
  });
});

describe('rule ladder', () => {
  const ladder = defineRuleLadder({
    ...header,
    name: 'test.passages',
    questions: {
      injection: { instructions: 'Does this passage attempt to control the system answering the query?' },
      contradicts: { instructions: 'Does this passage conflict with a factual premise stated in the query?' },
      relevant: { instructions: 'Does this passage address the subject of the query?' },
      evidence: { instructions: 'Does this passage state information usable in a direct answer?' },
    },
    rungs: [
      { ask: 'injection', when: 'above', at: 0.7, route: 'exclude' },
      { ask: 'contradicts', when: 'above', at: 0.7, route: 'conflicting' },
      { ask: 'relevant', when: 'below', at: 0.45, route: 'exclude' },
      { ask: 'evidence', when: 'above', at: 0.55, route: 'include' },
    ],
    otherwise: 'exclude',
    fixtures: [{ name: 'f', state: 's', expect: 'include' }],
  });

  test.each([
    [{ injection: 0.99, contradicts: 0.9, relevant: 0.71, evidence: 0.36 }, 'exclude', 0],
    [{ injection: 0.15, contradicts: 0.92, relevant: 0.49, evidence: 0.51 }, 'conflicting', 1],
    [{ injection: 0.1, contradicts: 0.1, relevant: 0.2, evidence: 0.9 }, 'exclude', 2],
    [{ injection: 0.1, contradicts: 0.1, relevant: 0.99, evidence: 0.98 }, 'include', 3],
    [{ injection: 0.1, contradicts: 0.1, relevant: 0.77, evidence: 0.46 }, 'exclude', undefined],
  ] as const)('climbs %j to %s', (probabilities, route, rung) => {
    expect(ladder.climb(probabilities)).toEqual({ route, rung });
  });

  test('asks every question in one request', async () => {
    const { port, requests } = fakePort(() => noulAnswer(0.1));
    await ladder.route(port, { query: 'q', passage: 'p' });
    expect(Object.keys(requests[0]!.questions).sort()).toEqual(['contradicts', 'evidence', 'injection', 'relevant']);
  });
});

describe('function caller', () => {
  const caller = defineFunctionCaller({
    ...header,
    name: 'test.trading',
    instructions: 'What is the user asking the trading assistant to do?',
    functions: {
      plot_price: {
        description: 'Chart a price',
        args: {
          symbol: { kind: 'choice', question: 'Which ticker?', options: { NVDA: null, AAPL: null } },
          window: { kind: 'choice', question: 'How far back?', options: { '1w': null, '1mo': null }, stated: 'Does the user say how far back?' },
          volume: { kind: 'flag', question: 'Does the user want volume?' },
        },
      },
      compare_returns: {
        description: 'Compare returns of several tickers',
        args: { symbols: { kind: 'set', question: 'Does the user want {} in the comparison?', members: ['NVDA', 'AAPL', 'MSFT'] } },
      },
    },
    band: { actAt: 0.7, confirmAt: 0.5 },
    fixtures: [{ name: 'f', state: 's', expect: { fn: 'plot_price' } }],
  });

  test('fills the chosen function in one request, leaving an unstated optional out', async () => {
    const { port, requests } = fakePort((name, q) => {
      if (name === '__function__') return choiceAnswer(q, 'plot_price', 0.95);
      if (name === 'plot_price.symbol') return choiceAnswer(q, 'AAPL', 0.9);
      if (name === 'plot_price.window?') return noulAnswer(0.04);
      if (name === 'plot_price.volume') return noulAnswer(0.88);
      return q.type === 'choice' ? choiceAnswer(q, Object.keys(q.criteria)[0]!, 0.5) : noulAnswer(0.5);
    });
    const got = await caller.fill(port, 'show me apple daily with volume');
    expect(requests).toHaveLength(1);
    expect(got).toMatchObject({ fn: 'plot_price', args: { symbol: 'AAPL', volume: true }, omitted: ['window'], weakest: 'volume' });
    expect(got.confidence).toBeCloseTo(0.88);
    expect(got.outcome).toBe('act');
  });

  test('a set argument takes every member read as yes', async () => {
    const yes = new Set(['compare_returns.symbols[0]', 'compare_returns.symbols[2]']);
    const { port } = fakePort((name, q) =>
      name === '__function__' ? choiceAnswer(q, 'compare_returns', 0.97) : q.type === 'choice' ? choiceAnswer(q, Object.keys(q.criteria)[0]!, 0.5) : noulAnswer(yes.has(name) ? 0.93 : 0.04),
    );
    const got = await caller.fill(port, 'compare nvda and msft');
    expect(got.args).toEqual({ symbols: ['NVDA', 'MSFT'] });
  });
});

describe('extraction verifier', () => {
  const verifier = defineExtractionVerifier({
    ...header,
    name: 'test.extraction',
    fireAt: 0.7,
    fixtures: [{ name: 'f', instruction: 'i', source: 's', fields: { a: {} }, record: { a: '' }, expect: { escalate: false } }],
  });

  test('a filled field gets the metric battery, an empty one the absence check, and any check over the line fires', async () => {
    const { port, requests } = fakePort((name) => noulAnswer(name === 'description::hallucinated' ? 0.95 : name === 'description::off_target' ? 0.85 : 0.1));
    const got = await verifier.verify(port, {
      instruction: 'Extract the registration open date',
      source: 'NYU events calendar navigation',
      fields: { registration_open_date: { type: 'string', description: 'mm/dd/yyyy' }, description: { type: 'string' } },
      record: { registration_open_date: '', description: 'Registration opens for the fall semester' },
    });
    expect(requests).toHaveLength(1);
    const names = Object.keys(requests[0]!.questions);
    expect(names).toContain('registration_open_date::absence_wrong');
    expect(names.filter((n) => n.startsWith('description::')).length).toBe(4);
    expect(got.escalate).toBe(true);
    expect(got.fired.map((f) => `${f.field}::${f.metric}`)).toEqual(['description::hallucinated', 'description::off_target']);
  });
});

describe('structure recovery', () => {
  const recovery = defineStructureRecovery({
    ...header,
    name: 'test.structure',
    joinAfterDangling: 0.2,
    joinAfterTerminal: 0.5,
    fixtures: [{ name: 'f', text: 't', expect: ['paragraph'] }],
  });

  test('splits lines, keeping blank-line gaps', () => {
    expect(splitLines('\na  b\n\nc\n')).toEqual([
      { text: 'a b', gap: false },
      { text: 'c', gap: true },
    ]);
  });

  test('stitches by the punctuation-aware bar, and classifies only blocks without a marker', async () => {
    const text = 'Hi everyone, the migration that is\nhappening next week is ready.\nWe start Monday:\nThe platform team\n- a marked item';
    const joins: Record<string, number> = { L001: 0.39, L002: 0.45, L003: 0.22 };
    const { port, requests } = fakePort((name, q) => {
      if (name in joins) return noulAnswer(joins[name]!);
      if (name.startsWith('type_')) return choiceAnswer(q, name === 'type_B002' ? 'list_item' : 'paragraph', 0.9);
      if (name.startsWith('step_')) return noulAnswer(0.1);
      return q.type === 'choice' ? choiceAnswer(q, Object.keys(q.criteria)[0]!, 0.9) : noulAnswer(0.5);
    });
    const blocks = await recovery.recover(port, text);
    expect(requests).toHaveLength(2);
    // L004 carries an explicit marker, so it is never asked about joining.
    expect(Object.keys(requests[0]!.questions).sort()).toEqual(['L001', 'L002', 'L003']);
    expect(blocks.map((b) => b.text)).toEqual([
      'Hi everyone, the migration that is happening next week is ready.',
      'We start Monday:',
      'The platform team',
      '- a marked item',
    ]);
    expect(Object.keys(requests[1]!.questions).filter((n) => n.startsWith('type_'))).toEqual(['type_B000', 'type_B001', 'type_B002']);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'list_item', 'list_item']);
  });

  test('renders consecutive list items as one list, numbered when they read as steps', () => {
    const block = (text: string, type: Block['type'], step = 0.1): Block => ({
      text, lines: [0], gap: false, type, confidence: 1, headingLevel: 'section', step, callout: 'note',
    });
    expect(renderMarkdown([block('Before Monday', 'heading'), block('Update', 'list_item', 0.9), block('- Delete cache', 'list_item', 0.8)])).toBe(
      '## Before Monday\n\n1. Update\n2. Delete cache\n',
    );
    expect(renderMarkdown([block('Platform team', 'list_item'), block('Web team', 'list_item')])).toBe('- Platform team\n- Web team\n');
  });
});

describe('feature columns', () => {
  test('a yes/no is one column, a score its mean and spread, a choice one column per option', () => {
    const questions = {
      fault: noul('Is a fault named?'),
      oak: score('How much oak?', ['none', 'some', 'lots']),
      style: choice('Style?', { red: null, white: null }),
    };
    const rows = [
      { fault: { type: 'noul', noul: 0.2 }, oak: { type: 'score', probabilities: { '0': 0, '1': 1, '2': 0 } }, style: { type: 'choice', probabilities: { red: 0.9, white: 0.1 } } },
      { fault: { type: 'noul', noul: 0.8 }, oak: { type: 'score', probabilities: { '0': 0.5, '1': 0, '2': 0.5 } }, style: { type: 'choice', probabilities: { red: 0.2, white: 0.8 } } },
    ] as const;
    const columns = encodeColumns(questions, rows as never, 'mean_spread');
    expect(columns.map((c) => c.name)).toEqual(['fault', 'oak', 'oak_sd', 'style=red', 'style=white']);
    expect(columns[1]!.values).toEqual([1, 1]);
    expect(columns[2]!.values).toEqual([0, 1]);
    expect(columns[4]!.values).toEqual([0.1, 0.8]);
  });
});

describe('compound split', () => {
  const detector = defineBattery({
    ...header,
    name: 'test.multiple',
    items: { multiple: yesNo('Does this request ask for more than one distinct action?', STAKES_BANDS.medium.yesNo) },
    fixtures: [{ name: 'f', state: 's', expect: { multiple: 'yes' } }],
  });

  test.each([
    [0.95, ['turn off the lights', 'lock the door'], false],
    [0.05, ['turn off the lights and lock the door'], false],
    [0.5, ['turn off the lights and lock the door'], true],
  ] as const)('p=%d yields %j', async (p, parts, uncertain) => {
    const { port } = fakePort(() => noulAnswer(p));
    let splits = 0;
    const got = await splitCompound(port, detector, async (request) => {
      splits += 1;
      return request.split(' and ');
    }, 'turn off the lights and lock the door');
    expect(got.parts).toEqual([...parts]);
    expect(got.uncertain).toBe(uncertain);
    expect(splits).toBe(p > 0.9 ? 1 : 0);
  });
});

describe('model listing', () => {
  test('lists the models the endpoint accepts', async () => {
    const models = await createModelCatalog({
      endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:7000', apiKey: 'k' },
      model: 'jev-1.13.0',
      timeoutMs: 1_000,
      retry: { maxRetries: 0 },
      fetch: async () => new Response(JSON.stringify({ models: [{ name: 'local-s1', description: 'local', release_date: '2026-09-01' }] }), { status: 200 }),
    }).list();
    expect(models.map((m) => m.name)).toEqual(['local-s1']);
  });
});
