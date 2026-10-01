import { afterEach, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const SOURCE_SCRIPTS = resolve(import.meta.dir, '../scripts');
let root: string;
let engine: string;

function write(relative: string, text: string): void {
  const path = join(engine, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function run() {
  const result = Bun.spawnSync({
    cmd: [process.execPath, '--no-env-file', '--preload', join(root, 'offline.ts'), join(engine, 'scripts/bundle-budget.ts'), '--no-build'],
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    timeout: 10_000,
  });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'entry-file-size-'));
  engine = join(root, 'packages/engine');
  mkdirSync(join(engine, 'scripts'), { recursive: true });
  for (const name of ['bundle-budget.ts', 'export-conditions.ts']) {
    copyFileSync(join(SOURCE_SCRIPTS, name), join(engine, 'scripts', name));
  }
  write('package.json', JSON.stringify({ exports: { './sdk': './sdk/dist/index.js' } }));
  write('sdk/dist/index.js', 'export const fixture = 1;\n');
  write('bundle-budgets.json', '{}\n');
  writeFileSync(join(root, 'offline.ts'), "globalThis.fetch = async () => { throw new Error('Unexpected network in fixture'); };\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test('a built new export reports its entry-file bytes without requiring a baseline', () => {
  write('package.json', JSON.stringify({ exports: {
    './sdk': './sdk/dist/index.js', './sdk/new-entry': './sdk/dist/new-entry.js',
  } }));
  const source = 'export { fixture } from "./index.js";\n';
  write('sdk/dist/new-entry.js', source);
  const result = run();
  expect(result.code).toBe(0);
  expect(result.output).toContain('ADVISORY');
  expect(result.output).toContain('./new-entry');
  expect(result.output).toContain(`${gzipSync(source).length} B`);
  expect(readFileSync(join(engine, 'bundle-budgets.json'), 'utf8')).toBe('{}\n');
});

test('entry-file growth reports the prior baseline without enforcing an arbitrary ceiling', () => {
  const baseline = JSON.stringify({ '.': { gzip_bytes: 1 } });
  write('bundle-budgets.json', baseline);
  const result = run();
  expect(result.code).toBe(0);
  expect(result.output).toContain('ADVISORY');
  expect(result.output).toContain('above');
  expect(readFileSync(join(engine, 'bundle-budgets.json'), 'utf8')).toBe(baseline);
});

for (const kind of ['missing', 'malformed', 'stale'] as const) {
  test(`${kind} optional baseline data cannot fail a valid built export`, () => {
    if (kind === 'missing') rmSync(join(engine, 'bundle-budgets.json'));
    if (kind === 'malformed') write('bundle-budgets.json', '{broken');
    if (kind === 'stale') write('bundle-budgets.json', JSON.stringify({ './retired-entry': { gzip_bytes: 100 } }));
    const result = run();
    expect(result.code).toBe(0);
    expect(result.output).toContain('ADVISORY');
  });
}

for (const domains of [['retired-domain'], { invalid: 'list' }]) {
  test(`optional event-domain reference ${Array.isArray(domains) ? 'drift' : 'malformation'} remains advisory`, () => {
    write('sdk/dist/events/actual-domain.js', 'export const event = "fixture";\n');
    write('bundle-budgets.json', JSON.stringify({ './events': { gzip_bytes: 100, domains } }));
    const result = run();
    expect(result.code).toBe(0);
    expect(result.output).toContain('ADVISORY');
    expect(result.output).toContain('domain');
  });
}

test('a missing built export remains a fatal packaging error', () => {
  write('package.json', JSON.stringify({ exports: { './sdk/missing': './sdk/dist/missing.js' } }));
  const result = run();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('built file');
  expect(result.output).toContain('./missing');
});

test('missing build output with --no-build remains fatal and does not invoke a build', () => {
  rmSync(join(engine, 'sdk/dist'), { recursive: true });
  const result = run();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('dist/ is missing');
  expect(result.output).not.toContain('Running bun run build');
});

test('syntactically malformed actual package JSON remains fatal', () => {
  write('package.json', '{broken');
  expect(run().code).not.toBe(0);
});
