/**
 * `engine.tools.test-of-source`: analyze mode `test_find` looks for the test
 * of a source file among the project files that import it (code resolves
 * the import specifiers; analyze/shared.ts importersOf). Which importer, if
 * any, is a test of that source? Read by Jev over each importer's path, the
 * lines that import the source, and the file's opening lines, in place of
 * probing fixed names (`.test` and `.spec` suffixes beside the file, in
 * `__tests__`, `test/` or `src/test/`), which missed every test named or
 * placed any other way and reported `exists: false` for it.
 *
 * The candidate-selection pattern: one choice picks an importer or none, and
 * one yes/no per importer confirms the pick is a test of the source. Code
 * offers at most TEST_CANDIDATES_PER_READING importers per request; with more
 * importers each group's pick goes on to a final selection among the picks.
 *
 * Band: medium stakes. A wrong pick sends an agent to extend a test that does
 * not cover the source; a missed test leads it to write a second one. A pick
 * that acts or confirms is reported as the test, with the outcome beside it.
 */
import { defineSelector, NONE, STAKES_BANDS, type Candidate, type JsonValue } from '@goodvibes-jev/judgment';

/** Importers offered to one selection. */
export const TEST_CANDIDATES_PER_READING = 16;
/** Opening lines of an importer the reading carries. */
export const TEST_CANDIDATE_HEAD_LINES = 12;
/** Most characters of one carried line. */
export const MAX_JUDGED_TEST_LINE_CHARS = 200;

const clip = (line: string): string => (line.length <= MAX_JUDGED_TEST_LINE_CHARS ? line : `${line.slice(0, MAX_JUDGED_TEST_LINE_CHARS)}...`);

/** What the selection sees about the source: its path relative to the project. */
export function testOfSourceContext(source: string): JsonValue {
  return { source };
}

/** One importer as a candidate: its path, the lines importing the source, and its opening lines. */
export function testOfSourceCandidate(file: string, importLines: readonly string[], lines: readonly string[]): Candidate {
  return {
    id: file,
    content: { file, importsSource: importLines.map(clip), opening: lines.slice(0, TEST_CANDIDATE_HEAD_LINES).map(clip) },
  };
}

const importer = (file: string, importLine: string, ...opening: string[]) => testOfSourceCandidate(file, [importLine], [importLine, ...opening]);

export const testOfSource = defineSelector({
  name: 'engine.tools.test-of-source',
  version: 1,
  description: 'Which file that imports a source file, if any, is a test of that source.',
  accuracyFloor: 0.85,
  instructions:
    'Each candidate is a project file that imports the source file `context.source`, shown with its path, the lines that import the source, and its opening lines. Which candidate is an automated test of `context.source`: a file whose job is to run and check the behavior of that source? Choose none when every candidate is ordinary code, a story, a benchmark, a fixture or a script that only uses the source.',
  fitInstructions:
    'Is this file an automated test of `context.source`, one that runs the source and checks what it does (test or it or describe blocks with expectations or assertions)?',
  band: STAKES_BANDS.medium.confidence,
  fitBand: STAKES_BANDS.medium.yesNo,
  fixtures: [
    {
      name: 'test beside other importers',
      context: testOfSourceContext('src/cart.ts'),
      candidates: [
        importer('src/checkout.ts', "import { subtotal } from './cart';", '', 'export function checkout(cart: Cart) {', '  const total = subtotal(cart.lines);'),
        importer('test/cart-totals.test.ts', "import { subtotal } from '../src/cart';", "import { describe, expect, test } from 'bun:test';", '', "describe('subtotal', () => {", "  test('adds line totals', () => {"),
      ],
      expect: 'test/cart-totals.test.ts',
    },
    {
      name: 'test in an unconventional place',
      context: testOfSourceContext('lib/parser.js'),
      candidates: [
        importer('checks/parser-behaviour.js', "const { parse } = require('../lib/parser');", "const assert = require('node:assert');", '', "assert.deepStrictEqual(parse('a=1'), { a: 1 });"),
        importer('lib/index.js', "module.exports = require('./parser');"),
      ],
      expect: 'checks/parser-behaviour.js',
    },
    {
      name: 'story and page only',
      context: testOfSourceContext('src/components/Button.tsx'),
      candidates: [
        importer('src/components/Button.stories.tsx', "import { Button } from './Button';", '', 'export default { title: "Button", component: Button };', 'export const Primary = () => <Button variant="primary">Save</Button>;'),
        importer('src/pages/Settings.tsx', "import { Button } from '../components/Button';", '', 'export function Settings() {'),
      ],
      expect: NONE,
    },
    {
      name: 'benchmark only',
      context: testOfSourceContext('src/hash.ts'),
      candidates: [importer('bench/hash.bench.ts', "import { hash } from '../src/hash';", "import { bench, run } from 'mitata';", '', "bench('hash 1kb', () => hash(buffer));", 'await run();')],
      expect: NONE,
    },
    {
      name: 'spec file among modules',
      context: testOfSourceContext('src/auth/session.ts'),
      candidates: [
        importer('src/auth/middleware.ts', "import { readSession } from './session';"),
        importer('src/routes/login.ts', "import { createSession } from '../auth/session';"),
        importer('src/auth/session.spec.ts', "import { createSession, readSession } from './session';", '', "it('reads back a created session', async () => {", '  const id = await createSession(user);', '  expect(await readSession(id)).toEqual(user);'),
      ],
      expect: 'src/auth/session.spec.ts',
    },
  ],
});
