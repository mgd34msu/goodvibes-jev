import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sourceMarkerAnchors, sourceMarkerFindings } from '../scripts/no-todo-marker-rules.ts';
import { captureStaticInputs, saveStaticSourceReadings } from '../scripts/static-source-readings.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const imported = "import { defineBattery } from '@goodvibes-jev/judgment';\n";
const texts = (source: string) => sourceMarkerAnchors('source.ts', source).map(anchor => anchor.text);

async function readingsFor(source: string, probability = 0.01, selected?: string) {
  const anchors = sourceMarkerAnchors('source.ts', source);
  const inputs = captureStaticInputs('deferred-work', 'source.ts', source, anchors);
  return preparedStaticReadings(inputs, probability, selected);
}

test('actual recorded literal fixture data remains intact and outside implementation candidates', () => {
  const source = imported + "const battery = defineBattery({ fixtures: [{ state: { diff: ['+ // TODO implement'].join('\\n'), output: `STUB` }, expect: 'yes' }] });";
  expect(texts(source)).not.toContain("'+ // TODO implement'");
  expect(texts(source)).not.toContain('`STUB`');
  expect(texts(source)).not.toContain("'yes'");
});

test('fixture comments and executable callback strings remain actual candidates', () => {
  const source = imported + "const battery = defineBattery({ fixtures: [ // Finish persistence before release\n { state: () => { throw new Error('Stub implementation'); } } ] });";
  expect(texts(source)).toContain('// Finish persistence before release');
  expect(texts(source)).toContain("'Stub implementation'");
});

test('runtime expressions inside fixture arrays remain subject to semantic reading', () => {
  const source = imported + "defineBattery({ fixtures: [{ state: createState('TODO'), error: new Error('STUB'), output: ready ? 'FIXME' : '' }] });";
  expect(texts(source)).toContain("'TODO'");
  expect(texts(source)).toContain("'STUB'");
  expect(texts(source)).toContain("'FIXME'");
});

test('foreign imports and shadowed factories cannot exempt source strings', () => {
  expect(texts("import { defineBattery } from 'unrelated'; const x = defineBattery({ fixtures: ['TODO'] });")).toContain("'TODO'");
  expect(texts(imported + "function f(defineBattery) { return defineBattery({ fixtures: ['TODO'] }); }")).toContain("'TODO'");
});

test('named import aliases and namespace calls retain the actual fixture exemption', () => {
  const source = "import { defineBattery as battery } from '@goodvibes-jev/judgment'; import * as judgment from '@goodvibes-jev/judgment'; battery({ fixtures: ['TODO'] }); judgment.defineJudge({ fixtures: ['STUB'] });";
  expect(texts(source)).not.toContain("'TODO'");
  expect(texts(source)).not.toContain("'STUB'");
});

test('source scanning distinguishes comments from quoted text and regex tokens', () => {
  const source = "const text = '// not an actual comment'; const regex = /\\/\\//;\nconst value = `/* also text */`; /* actual comment */\nfunction f() { /* empty body comment */ }";
  const anchors = sourceMarkerAnchors('source.ts', source);
  expect(anchors.filter(anchor => anchor.text.startsWith('/*')).map(anchor => anchor.text)).toEqual(['/* actual comment */', '/* empty body comment */']);
  expect(anchors.some(anchor => anchor.text === '// not an actual comment')).toBe(false);
});

test('contiguous line comments retain a complete lexical statement and exact starting position', () => {
  const source = '// This reader used to drop the result.\n  // It now persists the complete record.\n\n// Separate statement.\nconst value = 3; // Inline context.\n// Continuation of that inline comment.';
  expect(sourceMarkerAnchors('source.ts', source)).toMatchObject([
    { line: 1, col: 1, text: '// This reader used to drop the result.\n  // It now persists the complete record.' },
    { line: 4, col: 1, text: '// Separate statement.' },
    { line: 5, col: 18, text: '// Inline context.\n// Continuation of that inline comment.' },
  ]);
});

test('candidate grammar keeps unfinished-code anchors and excludes ordinary protocol identifiers', () => {
  const source = "const protocol = 'ready'; const filter = 'TODO';\nfunction f() { return 'Coming soon'; }\nthrow new Error('Real implementation is missing'); // Wire persistence later";
  expect(texts(source)).not.toContain("'ready'");
  expect(texts(source)).toContain("'TODO'");
  expect(texts(source)).toContain("'Coming soon'");
  expect(texts(source)).toContain("'Real implementation is missing'");
  expect(texts(source)).toContain('// Wire persistence later');
});

test('marker-free deferred comments use a canonical observation and exact source position', async () => {
  const source = "const value = 3;\n// Write support is unfinished and required before release.\n";
  const anchor = sourceMarkerAnchors('source.ts', source).find(candidate => candidate.line === 2);
  if (!anchor) throw new Error('Actual comment was not extracted');
  const readings = await readingsFor(source, 0.99, anchor.id);
  expect(sourceMarkerFindings('source.ts', source, readings)).toEqual([{ line: 2, col: 1, marker: 'deferred-work', text: anchor.text }]);
});

test('ordinary marker prose needs a settled no, and absent or stale observations stay held', async () => {
  const source = "// The RPC stub forwards the exact TODO task status from the protocol.\n";
  const readings = await readingsFor(source);
  expect(sourceMarkerFindings('source.ts', source, readings)).toEqual([]);
  expect(sourceMarkerFindings('source.ts', source)).toMatchObject([{ marker: 'evidence-held' }]);
  expect(sourceMarkerFindings('source.ts', `${source}// changed context\n`, readings)).toMatchObject([{ marker: 'evidence-held' }]);
  const weak = await readingsFor(source, 0.2);
  expect(sourceMarkerFindings('source.ts', source, weak)).toMatchObject([{ marker: 'evidence-held' }]);
});

test('the original unfinished-code fixture retains its source and exact literal exemption', () => {
  const source = readFileSync(new URL('../sdk/src/platform/contract/batteries/unit-quality.ts', import.meta.url), 'utf8');
  expect(source).toContain('+  // Reading from the store is not implemented.');
  expect(texts(source).some(text => text.includes('+  // Reading from the store is not implemented.'))).toBe(false);
});

test('offline todo entry point distinguishes clear, inconclusive and confirmed unfinished work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-comment-gate-'));
  try {
    mkdirSync(join(root, 'src'));
    const source = '// Intentional read-only adapter.\n';
    writeFileSync(join(root, 'src', 'source.ts'), source);
    const inputs = captureStaticInputs('deferred-work', 'src/source.ts', source, sourceMarkerAnchors('src/source.ts', source));
    const receiptPath = join(root, 'readings.json');
    saveStaticSourceReadings(await preparedStaticReadings(inputs), receiptPath);
    const env = { ...process.env, TODO_ROOT: root, TODO_DIRS_JSON: '["src"]', STATIC_SOURCE_READINGS_PATH: receiptPath };
    const command = ['bun', resolve(import.meta.dir, '../scripts/no-todo-markers.ts')];
    const accepted = Bun.spawnSync(command, { env });
    expect(accepted.exitCode).toBe(0);
    const unfinished = '// Persistence is unfinished.\n';
    writeFileSync(join(root, 'src', 'source.ts'), unfinished);
    const held = Bun.spawnSync(command, { env });
    expect(held.exitCode).toBe(0);
    expect(held.stderr.toString()).toContain('ADVISORY');
    expect(held.stderr.toString()).toContain('evidence-held');
    expect(held.stderr.toString()).toContain('src/source.ts:1');
    const changedInputs = captureStaticInputs('deferred-work', 'src/source.ts', unfinished, sourceMarkerAnchors('src/source.ts', unfinished));
    saveStaticSourceReadings(await preparedStaticReadings(changedInputs, 0.99, changedInputs[0]!.anchors[0]!.id), receiptPath);
    const rejected = Bun.spawnSync(command, { env });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain('[deferred-work]');
    expect(rejected.stderr.toString()).toContain('src/source.ts:1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
