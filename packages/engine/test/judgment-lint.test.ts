/**
 * The semantic CI lints: fixture coverage of every answer a registered
 * decision can conclude, and Jev use only through registered decisions.
 */
import { describe, expect, test } from 'bun:test';
import { askAs, decisionHeader, defineBattery, defineDispatch, defineJudge, oneOf, rated, STAKES_BANDS, yesNo, type FixtureCheck } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { coverageFindings, questionCoverage, sourceFindings } from '../scripts/judgment-lint-rules.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registry as contractRegistry } from '../sdk/src/platform/contract/judgment-registry.ts';

const header = { version: 1, description: 'test', accuracyFloor: 0.8 };

describe('fixture coverage', () => {
  test('a battery missing an answer for a yes/no, a choice option and a rubric level is reported per question', async () => {
    const battery = defineBattery({
      ...header,
      name: 'test.lint.partial',
      items: {
        urgent: yesNo('Urgent?', STAKES_BANDS.low.yesNo),
        team: oneOf('Team?', { billing: null, technical: null, sales: null }, STAKES_BANDS.low.confidence),
        severity: rated('Severity?', ['low', 'medium', 'high'], STAKES_BANDS.low.confidence),
      },
      fixtures: [
        { name: 'a', state: 'a', expect: { urgent: 'yes', team: 'billing', severity: 0 } },
        { name: 'b', state: 'b', expect: { urgent: 'yes', team: 'technical', severity: 2 } },
      ],
    });
    const { findings, open } = await coverageFindings([battery]);
    expect(open).toEqual([]);
    expect(findings.map((finding) => finding.message)).toEqual([
      'question "severity" has no fixture expecting "1" (answers 0, 1, 2)',
      'question "team" has no fixture expecting "sales" (answers billing, sales, technical)',
      'question "urgent" has no fixture expecting "no" (answers no, yes)',
    ]);
  });

  test('a dispatch with every route covered and a judge with pass and fail covered are clean', async () => {
    const dispatch = defineDispatch({
      ...header,
      name: 'test.lint.dispatch',
      instructions: 'Team?',
      routes: { billing: null, technical: null },
      band: STAKES_BANDS.low.confidence,
      fixtures: [
        { name: 'charge', state: 'charged twice', expect: 'billing' },
        { name: 'crash', state: 'app crashes', expect: 'technical' },
      ],
    });
    const judge = defineJudge({
      ...header,
      name: 'test.lint.judge',
      band: STAKES_BANDS.low.yesNo,
      fixtures: [
        { name: 'ok', goal: 'greet', criteria: ['greets', 'is short'], output: 'hi', expect: { verdict: 'pass', unmet: [] } },
        { name: 'bad', goal: 'greet', criteria: ['greets'], output: 'bye', expect: { verdict: 'fail', unmet: [0] } },
      ],
    });
    expect(await coverageFindings([dispatch, judge])).toEqual({ findings: [], open: [] });
  });

  test('a question whose options come from each fixture has no fixed set, and is listed as open', () => {
    const check = (fixture: string, answers: string[]): FixtureCheck => ({ fixture, aspect: 'chosen', expected: answers[0]!, got: answers[0]!, correct: true, signal: 0.9, outcome: 'act', answers });
    const [coverage] = questionCoverage([check('one', ['a1', 'a2']), check('two', ['b1', 'b2'])]);
    expect(coverage).toEqual({ question: 'chosen', answers: undefined, expected: ['a1', 'b1'], missing: [] });
  });

  test('checks naming one shared question are covered together', () => {
    const check = (aspect: string, expected: string): FixtureCheck => ({ fixture: 'f', aspect, question: 'keep', expected, got: expected, correct: true, signal: 0.9, outcome: 'act', answers: ['no', 'yes'] });
    expect(questionCoverage([check('#1', 'yes'), check('#2', 'no')])).toEqual([{ question: 'keep', answers: ['no', 'yes'], expected: ['no', 'yes'], missing: [] }]);
  });

  test('a decision whose fixtures cannot be listed is a finding', async () => {
    const broken = { name: 'test.lint.broken', version: 1, description: '', accuracyFloor: 0.5, fixtureCount: 1, checkFixtures: async () => { throw new Error('no port'); } };
    expect((await coverageFindings([broken])).findings).toEqual([{ rule: 'fixture-coverage', where: 'test.lint.broken', message: 'its fixtures could not be listed: no port' }]);
  });
});

describe('registered use', () => {
  const registered = new Set(['engine.known']);

  test('a defined decision must be registered, by literal or same-file constant name', () => {
    const source = `
      const NAME = 'engine.unlisted';
      export const a = defineBattery({ name: 'engine.known', version: 1, items: {}, fixtures: [] });
      export const b = defineDispatch({ name: NAME, version: 1, fixtures: [] });
      export const c = defineRerank({ name: \`engine.\${x}\`, fixtures: [] });
      export const d = defineThing({ name: 'engine.not-a-decision' });
    `;
    expect(sourceFindings('x.ts', source, registered)).toEqual([
      { rule: 'registered-use', where: 'x.ts:4', message: 'defineDispatch defines "engine.unlisted", which no judgment registry registers' },
      { rule: 'registered-use', where: 'x.ts:5', message: 'defineRerank defines a decision whose name is not a string this lint can read, so its registration cannot be checked' },
    ]);
  });

  test('an inline request to a port and an askAs outside a definer are flagged; forwarding wrappers and definers are not', () => {
    const source = `
      async function classify(port) { return port.ask({ state: 'x', questions: { q: noul('?') } }); }
      function meteredPort(port) { return { ask: (request) => port.ask(request) }; }
      async function loose(port) { return askAs(port, header, 'battery', 'x', {}); }
      export function defineWidget(spec) { const run = (port) => askAs(port, spec, 'battery', 'x', {}); return run; }
      const answer = await knowledgeService.ask({ query: 'where' });
    `;
    expect(sourceFindings('y.ts', source, registered).map((finding) => [finding.where, finding.message])).toEqual([
      ['y.ts:2', 'asks Jev with a request built inline, outside a registered decision'],
      ['y.ts:4', 'calls askAs outside a decision definer (a `function define*`), so the call is attributed to no registered decision'],
    ]);
  });

  test('every fixed-name instance of a private factory is checked, including critical variants', () => {
    const source = `
      function judge(name, band) { return defineJudge({ name, band, fixtures: [] }); }
      const NAME = 'engine.known';
      export const judges = { high: judge(NAME, high), critical: judge('engine.critical', critical) };
    `;
    expect(sourceFindings('factory.ts', source, new Set(['engine.known', 'engine.critical']))).toEqual([]);
    expect(sourceFindings('factory.ts', source, registered).map((finding) => finding.message)).toEqual([
      'defineJudge defines "engine.critical", which no judgment registry registers',
    ]);
  });

  test.each([
    "const decision = judge(runtimeName);",
    "const decision = judge(...runtimeNames);",
    "const alias = judge; const decision = alias('engine.known');",
    "use(judge); const decision = judge('engine.known');",
    "export { judge }; const decision = judge('engine.known');",
    "const api = { judge }; const decision = judge('engine.known');",
    '',
  ])('a private factory is not trusted with unknown or escaping invocations: %s', (use) => {
    const source = `function judge(name) { return defineJudge({ name, fixtures: [] }); } ${use}`;
    expect(sourceFindings('factory.ts', source, registered)).toHaveLength(1);
  });

  test('an exported factory and a reassigned parameter cannot be proved from local calls', () => {
    for (const source of [
      "export function judge(name) { return defineJudge({ name, fixtures: [] }); } judge('engine.known');",
      "function judge(name) { name = runtimeName; return defineJudge({ name, fixtures: [] }); } judge('engine.known');",
      "function judge(name) { [name] = runtimeNames; return defineJudge({ name, fixtures: [] }); } judge('engine.known');",
    ]) expect(sourceFindings('factory.ts', source, registered)).toHaveLength(1);
  });

  test.each([
    "for (name of ['engine.unlisted']) {}",
    "for (name in { 'engine.unlisted': null }) {}",
    "for ([name] of [['engine.unlisted']]) {}",
    "for ({ value: name } of [{ value: 'engine.unlisted' }]) {}",
    "var name = 'engine.unlisted';",
    "var [name] = ['engine.unlisted'];",
    "for (var name = 'engine.unlisted'; false;) {}",
    "function name() {}",
    "eval(\"name = 'engine.unlisted'\");",
  ])('rebinding cannot preserve a factory parameter proof: %s', (write) => {
    const source = `function judge(name) { ${write} return defineJudge({ name, fixtures: [] }); } judge('engine.known');`;
    expect(sourceFindings('factory-write.ts', source, registered).length).toBeGreaterThan(0);
  });

  test('a separately bound loop variable does not mutate the factory parameter', () => {
    const source = `function judge(name) { for (const name of ['engine.unlisted']) {} return defineJudge({ name, fixtures: [] }); } judge('engine.known');`;
    expect(sourceFindings('loop-scope.ts', source, registered)).toEqual([]);
  });

  test('name resolution respects lexical scope instead of finding an unrelated same-named constant', () => {
    const source = `
      const NAME = 'engine.known';
      function other() { const NAME = 'engine.unlisted'; return defineJudge({ name: NAME, fixtures: [] }); }
      function judge(NAME) { return defineJudge({ name: NAME, fixtures: [] }); }
      judge(dynamicName);
    `;
    const messages = sourceFindings('scope.ts', source, registered).map((finding) => finding.message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('"engine.unlisted"');
    expect(messages[1]).toContain('registration cannot be checked');
  });

  const custom = (header = 'HEADER', tail = '') => `
    const HEADER = { name: 'engine.known', version: 1 } as const;
    const OTHER = { name: 'engine.known', version: 1 } as const;
    const FIXTURES = [];
    export const decision = {
      ...decisionHeader({ ...HEADER, fixtures: FIXTURES }),
      async read(port, input) { return askAs(port, ${header}, 'battery', input, {}); },
      checkFixtures: (port) => checkEachFixture(FIXTURES, {}, (fixture) => decision.read(port, fixture)),
    };
    ${tail}
  `;

  test('a composed custom decision carries its registered header and fixture checks', () => {
    expect(sourceFindings('custom.ts', custom(), registered)).toEqual([]);
    expect(sourceFindings('custom.ts', custom(), new Set()).map((finding) => finding.message)).toEqual([
      'decisionHeader defines "engine.known", which no judgment registry registers',
      'calls askAs outside a decision definer (a `function define*`), so the call is attributed to no registered decision',
    ]);
  });

  test('custom decision attribution requires the matching header, fixtures and fixture checker', () => {
    for (const source of [
      custom('OTHER'),
      custom().replace('fixtures: FIXTURES', 'description: "no fixtures"'),
      custom().replace('checkFixtures:', 'unrelated:'),
      custom('HEADER', "askAs(port, HEADER, 'battery', input, {});"),
    ]) expect(sourceFindings('custom.ts', source, registered).some((finding) => finding.message.includes('calls askAs outside'))).toBe(true);
  });

  test.each([
    "HEADER.name = 'engine.unlisted';",
    "HEADER['name'] = 'engine.unlisted';",
    "const alias = HEADER; alias.name = 'engine.unlisted';",
    "const wrapper = { header: HEADER }; wrapper.header.name = 'engine.unlisted';",
    "mutate(HEADER);",
    "Object.assign(HEADER, { name: 'engine.unlisted' });",
    "Object.defineProperty(HEADER, 'name', { value: 'engine.unlisted' });",
    "delete HEADER.name;",
    "for (HEADER.name of ['engine.unlisted']) {}",
    "export { HEADER };",
    "function getHeader() { return HEADER; }",
    "eval(\"HEADER.name = 'engine.unlisted'\");",
  ])('mutable or escaping const headers cannot authorize custom reads: %s', (write) => {
    const source = custom('HEADER', write);
    expect(sourceFindings('header-write.ts', source, registered).some((finding) => finding.message.includes('calls askAs outside'))).toBe(true);
  });

  test('an exported header binding is not a private immutable runtime identity', () => {
    expect(sourceFindings('header-export.ts', custom().replace('const HEADER', 'export const HEADER'), registered).some((finding) => finding.message.includes('calls askAs outside'))).toBe(true);
  });

  test('a write inside the custom reader invalidates its captured header proof', () => {
    const source = custom().replace('return askAs', "HEADER.name = 'engine.unlisted'; return askAs");
    expect(sourceFindings('reader-write.ts', source, registered).some((finding) => finding.message.includes('calls askAs outside'))).toBe(true);
  });

  test('a spread getter can mutate the later read header after its registered name was copied', async () => {
    const header = { name: 'engine.known', get version() { this.name = 'engine.unlisted'; return 1; }, description: 'test', accuracyFloor: 0.8 };
    const snapshot = decisionHeader({ ...header, fixtures: [{ name: 'registered sample' }] });
    const fake = fakePort(() => { throw new Error('no questions expected'); });
    await askAs(fake.port, header, 'battery', 'test', {});
    expect(snapshot.name).toBe('engine.known');
    expect(fake.requests[0]?.context?.battery).toBe('engine.unlisted');
    const source = custom().replace("version: 1 } as const;", "get version() { this.name = 'engine.unlisted'; return 1; } };");
    expect(sourceFindings('getter-header.ts', source, registered).some((finding) => finding.message.includes('calls askAs outside'))).toBe(true);
  });

  test.each([
    "set version(value) { this.name = value; }",
    "toJSON() { this.name = 'engine.unlisted'; return {}; }",
    "__proto__: { get version() { this.name = 'engine.unlisted'; return 1; } }",
    "get version() { exposed = this; return 1; }",
  ])('headers with accessors, methods or prototype overrides are not plain data: %s', (member) => {
    const source = custom().replace('version: 1 } as const;', `${member} };`);
    expect(sourceFindings('active-header.ts', source, registered).some((finding) => finding.message.includes('calls askAs outside'))).toBe(true);
  });

  test('accessors in a recursively spread source also invalidate header attribution', () => {
    const source = custom().replace("const HEADER = { name: 'engine.known', version: 1 } as const;", `
      const BASE = { name: 'engine.known', get version() { this.name = 'engine.unlisted'; return 1; } };
      const HEADER = { ...BASE };
    `);
    expect(sourceFindings('getter-copy.ts', source, registered).some((finding) => finding.message.includes('calls askAs outside'))).toBe(true);
  });

  test('a private header copied through another spread still proves the same registered identity', () => {
    const source = custom().replace("const HEADER = { name: 'engine.known', version: 1 } as const;", "const BASE = { name: 'engine.known', version: 1 } as const; const HEADER = { ...BASE };");
    expect(sourceFindings('header-copy.ts', source, registered)).toEqual([]);
  });

  test.each([
    "const SPEC = { ...HEADER, fixtures: [], ...unknown }; defineJudge(SPEC);",
    "defineJudge({ ...HEADER, fixtures: [], ...unknown });",
    "const SPEC = { name: 'engine.known', fixtures: [] }; mutate(SPEC); defineJudge(SPEC);",
  ])('unresolved composed decision specs do not silently disappear: %s', (use) => {
    const source = `const HEADER = { name: 'engine.known' }; ${use}`;
    expect(sourceFindings('unresolved.ts', source, registered).length).toBeGreaterThan(0);
  });

  test('spreads cannot hide an unregistered name or make an unknown override silently pass', () => {
    const source = `
      const HEADER = { name: 'engine.unlisted' };
      const a = defineJudge({ ...HEADER, fixtures: [] });
      const b = defineJudge({ name: 'engine.known', fixtures: [], ...unknown });
    `;
    expect(sourceFindings('spread.ts', source, registered)).toHaveLength(2);
  });

  test('the actual composed contract decisions are clean only with every real registration', () => {
    const names = new Set(contractRegistry.list().map((decision) => decision.name));
    for (const filename of ['unit-judge', 'group-judge', 'deliverable-judge', 'plan-coverage', 'unit-shape']) {
      const path = resolve(import.meta.dir, `../sdk/src/platform/contract/batteries/${filename}.ts`);
      const source = readFileSync(path, 'utf8');
      expect(sourceFindings(path, source, names)).toEqual([]);
      expect(sourceFindings(path, source, new Set())).not.toEqual([]);
    }
  });
});
