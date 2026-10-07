import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultTestArgs } from '../scripts/test-discovery.ts';
import { engineTestManifest, partitionTestArgs, partitionTestFiles, platformTestMatrix } from '../scripts/test-partitions.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(paths: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'engine-partitions-'));
  roots.push(root);
  mkdirSync(join(root, 'test'));
  for (const path of paths) {
    const file = join(root, 'test', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  return root;
}

test('partitions deterministically, balances file counts, and visits every input exactly once', () => {
  const files = ['g', 'a', 'f', 'b', 'e', 'c', 'd'];
  const partitions = partitionTestFiles(files, 3);
  expect(partitions).toEqual([['a', 'd', 'g'], ['b', 'e'], ['c', 'f']]);
  expect(partitions).toEqual(partitionTestFiles([...files].reverse(), 3));
  expect(partitions.flat().sort()).toEqual([...files].sort());
  expect(files).toEqual(['g', 'a', 'f', 'b', 'e', 'c', 'd']);
  expect(partitionTestFiles(files, 1)).toEqual([[...files].sort()]);
});

test('rejects duplicate input, invalid counts and empty partitions rather than passing no tests', () => {
  for (const count of [0, -1, 1.5, NaN, Infinity, 17, 5]) {
    expect(() => partitionTestFiles(['a', 'b', 'c', 'd'], count)).toThrow();
  }
  expect(() => partitionTestFiles([], 1)).toThrow();
  expect(() => partitionTestFiles(['a', 'a'], 2)).toThrow('duplicate');
});

test('default and focused local arguments are unchanged, and partitions cannot mix filters or cwd', () => {
  const root = fixture(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts']);
  expect(partitionTestArgs(root, [])).toBeNull();
  expect(partitionTestArgs(root, ['test/a.test.ts', '--timeout=123'])).toBeNull();
  expect(partitionTestArgs(root, ['--cwd', '../judgment', 'test'])).toBeNull();
  for (const args of [
    ['--partition'], ['--partition=0/4'], ['--partition=5/4'], ['--partition=1/0'],
    ['--partition=1/5'], ['--partition=1/4.0'], ['--partition=01/4'],
    ['--partition=1/4', '--partition=2/4'], ['--partition=1/4', 'test/a.test.ts'],
    ['--partition=1/4', '--cwd', '../judgment'], ['--partition=1/4', '--test-name-pattern=x'],
    ['--manifest-sha256=bad'], ['--partition=1/4', '--manifest-sha256=bad'],
    ['--partition=1/4', '--manifest-sha256=bad', '--manifest-sha256=bad'],
  ]) expect(() => partitionTestArgs(root, args), JSON.stringify(args)).toThrow();
});

test('the actual repo matrix is an exact disjoint cover of canonical and independently inventoried files', () => {
  const root = resolve(import.meta.dir, '..');
  const manifest = engineTestManifest(root);
  const independent = readdirSync(join(root, 'test'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll('\\', '/'))
    .filter((file) => !/^test\/(workers|workers-wrangler|hermes|fixtures|types)\//.test(file))
    .filter((file) => !file.split('/').some((part) => ['node_modules', '.git', 'dist'].includes(part)))
    .sort();
  expect(manifest.files).toEqual(independent);
  expect(manifest.files).toEqual(defaultTestArgs(root));
  const rows = platformTestMatrix(root).include.filter((row) => row.platform === 'bun');
  const selected = rows.map((row) => partitionTestArgs(root, row['test-cmd'].split(' ').slice(3))!.map((file) => {
    expect(file).toStartWith('./test/');
    return file.slice(2);
  }));
  expect(selected.flat().sort()).toEqual([...manifest.files]);
  expect(new Set(selected.flat()).size).toBe(manifest.files.length);
  expect(selected.map((files) => files.length).every((count) => count > 0)).toBe(true);
  expect(Math.max(...selected.map((files) => files.length)) - Math.min(...selected.map((files) => files.length))).toBeLessThanOrEqual(1);
});

test('new nested files enter the manifest once and stale CI discovery fails closed', () => {
  const root = fixture(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'workers/other.test.ts', 'fixtures/other.test.ts']);
  const previous = engineTestManifest(root);
  mkdirSync(join(root, 'test/future/deeper'), { recursive: true });
  writeFileSync(join(root, 'test/future/deeper/new.spec.mjs'), '');
  const current = engineTestManifest(root);
  expect(current.files).toHaveLength(5);
  expect(current.partitions.flatMap((partition) => partition.files).filter((file) => file === 'test/future/deeper/new.spec.mjs')).toHaveLength(1);
  expect(current.sha256).not.toBe(previous.sha256);
  expect(() => partitionTestArgs(root, ['--partition=1/4', `--manifest-sha256=${previous.sha256}`])).toThrow('differs');
});

test('real owned runner executes each partition once, preserves skips and propagates a failing partition', () => {
  // The first two files land in different partitions. Bare substring filters
  // would accidentally select the second file while running the first one.
  const paths = ['a.test.ts', 'nested/test/a.test.ts', 'y.test.ts', 'z.test.ts'];
  const root = fixture([...paths, 'workers/ignored.test.ts', 'fixtures/ignored.test.ts']);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts);
  for (const file of ['test.ts', 'test-discovery.ts', 'test-partitions.ts', 'owned-test-child.ts', 'stale-tmp-sweep.ts',
    'test-run-tmp.ts', 'workspace-lock.ts', 'test-child-watchdog-env.ts', 'test-child-watchdog.ts',
    'test-isolation.ts', 'test-network-guard.ts', 'test-network-preload.ts']) {
    copyFileSync(resolve(import.meta.dir, '../scripts', file), join(scripts, file));
  }
  cpSync(resolve(import.meta.dir, '../toolchain/src/test-runner'), join(root, 'toolchain/src/test-runner'), { recursive: true });
  const receipt = join(root, 'executed.jsonl');
  for (const path of paths) writeFileSync(join(root, 'test', path), `
    import { test, expect } from 'bun:test';
    import { appendFileSync } from 'node:fs';
    test(${JSON.stringify(path)}, () => {
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      appendFileSync(${JSON.stringify(receipt)}, ${JSON.stringify(path + '\n')});
      expect(true).toBe(true);
    });
    test.skip('declared optional fixture', () => { throw new Error('must remain skipped'); });
  `);
  for (const path of ['workers/ignored.test.ts', 'fixtures/ignored.test.ts']) {
    writeFileSync(join(root, 'test', path), "throw new Error('excluded area ran');");
  }
  const run = (args: string[]) => {
    const child = Bun.spawnSync({
      cmd: [process.execPath, join(scripts, 'test.ts'), ...args], cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: root, OPENAI_API_KEY: 'synthetic-must-not-inherit' },
      timeout: 15_000, stdout: 'pipe', stderr: 'pipe',
    });
    return { code: child.exitCode, output: `${child.stdout.toString()}${child.stderr.toString()}` };
  };
  for (const id of ['1/2', '2/2']) {
    const result = run([`--partition=${id}`]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('2 pass');
    expect(result.output).toContain('2 skip');
  }
  expect(readFileSync(receipt, 'utf8').trim().split('\n').sort()).toEqual(paths);
  writeFileSync(join(root, 'test/z.test.ts'), "import { test, expect } from 'bun:test'; test('failure must reach CI', () => expect(false).toBe(true));");
  const failed = run(['--partition=2/2']);
  expect(failed.code, failed.output).not.toBe(0);
  expect(failed.output).toContain('failure must reach CI');
  expect(failed.output).toContain('bun test exited with code 1');
  const invalid = run(['--partition=1/2', '--test-name-pattern=does-not-exist']);
  expect(invalid.code).not.toBe(0);
  expect(invalid.output).toContain('no other test arguments');
}, 60_000);
