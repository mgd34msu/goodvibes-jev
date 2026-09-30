import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sourceMarkerFindings } from '../scripts/no-todo-marker-rules.ts';

const imported = "import { defineBattery } from '@goodvibes-jev/judgment';\n";

test('recorded literal code and text in actual inline decision fixtures remain intact', () => {
  const source = imported + "const battery = defineBattery({ fixtures: [{ state: { diff: ['+ // TODO implement'].join('\\n'), output: `STUB` }, expect: 'yes' }] });";
  expect(sourceMarkerFindings('battery.ts', source)).toEqual([]);
});

test('comments and executable fixture callbacks retain the marker gate', () => {
  const source = imported + "const battery = defineBattery({ fixtures: [ // TODO add cases\n { state: () => { throw new Error('STUB implementation'); } } ] });";
  expect(sourceMarkerFindings('battery.ts', source).map((finding) => finding.marker)).toEqual(['TODO', 'STUB']);
});

test('runtime expressions inside fixture arrays remain subject to the marker gate', () => {
  const source = imported + "defineBattery({ fixtures: [{ state: createState('TODO'), error: new Error('STUB'), output: ready ? 'FIXME' : '' }] });";
  expect(sourceMarkerFindings('battery.ts', source).map((finding) => finding.marker)).toEqual(['TODO', 'STUB', 'FIXME']);
});

test('markers in runtime strings, comments and arbitrary fixtures objects are still findings', () => {
  const source = "// TODO finish\nthrow new Error('STUB implementation');\nconst settings = { fixtures: ['FIXME'] };";
  expect(sourceMarkerFindings('runtime.ts', source).map((finding) => finding.marker)).toEqual(['TODO', 'STUB', 'FIXME']);
});

test('an unrelated import or shadowed factory name cannot exempt data', () => {
  const foreign = "import { defineBattery } from 'unrelated'; const x = defineBattery({ fixtures: ['TODO'] });";
  const shadowed = imported + "function f(defineBattery) { return defineBattery({ fixtures: ['TODO'] }); }";
  expect(sourceMarkerFindings('foreign.ts', foreign)).toHaveLength(1);
  expect(sourceMarkerFindings('shadow.ts', shadowed)).toHaveLength(1);
});

test('named import aliases and namespace calls identify the actual fixture consumer', () => {
  const source = "import { defineBattery as battery } from '@goodvibes-jev/judgment'; import * as judgment from '@goodvibes-jev/judgment'; battery({ fixtures: ['TODO'] }); judgment.defineJudge({ fixtures: ['STUB'] });";
  expect(sourceMarkerFindings('battery.ts', source)).toEqual([]);
});

test('an exempt literal cannot hide a later marker on the same line', () => {
  const source = imported + "const x = defineBattery({ fixtures: ['TODO'] }); // FIXME real work";
  const [finding] = sourceMarkerFindings('battery.ts', source);
  expect(finding?.marker).toBe('FIXME'); expect(finding?.line).toBe(2);
  expect(finding?.col).toBe(source.split('\n')[1]!.indexOf('FIXME') + 1);
});

test('indirect fixture arrays stay subject to the existing gate', () => {
  const source = imported + "const data = ['TODO']; const x = defineBattery({ fixtures: data });";
  expect(sourceMarkerFindings('battery.ts', source)).toHaveLength(1);
});

test('the original unfinished-code calibration example retains its marker without a source finding', () => {
  const source = readFileSync(new URL('../sdk/src/platform/contract/batteries/unit-quality.ts', import.meta.url), 'utf8');
  expect(source).toContain('+  // TODO: read from the store again once it is wired up');
  expect(sourceMarkerFindings('unit-quality.ts', source)).toEqual([]);
});
