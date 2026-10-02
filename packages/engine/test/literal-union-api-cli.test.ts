import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

test('the real API command accepts a literal permutation without rewriting its baseline and rejects contract edits', async () => {
  const engine = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = makeProjectTempDir('literal-api-command');
  for (const directory of ['scripts', 'etc', 'sdk/dist', 'terminal-shell/dist', 'node_modules']) mkdirSync(join(fixture, directory), { recursive: true });
  for (const file of ['check-subpath-api-surface.ts', 'subpath-api-surface-rule.ts', 'literal-union-order.ts', 'export-conditions.ts']) {
    copyFileSync(join(engine, 'scripts', file), join(fixture, 'scripts', file));
  }
  symlinkSync(resolve(engine, '../../node_modules/typescript'), join(fixture, 'node_modules/typescript'));
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'synthetic-api', type: 'module', exports: {
    './sdk': { types: './sdk/dist/index.d.ts' }, './terminal-shell': { types: './terminal-shell/dist/index.d.ts' },
  } }));
  const source = join(fixture, 'sdk/dist/index.d.ts');
  const baseline = 'export type Choice = "a" | "b"; export interface Options { required: boolean; }';
  writeFileSync(source, baseline);
  writeFileSync(join(fixture, 'terminal-shell/dist/index.d.ts'), 'export interface Terminal { write(text: string): void; }');
  const run = async (check: boolean) => {
    const child = Bun.spawn([process.execPath, join(fixture, 'scripts/check-subpath-api-surface.ts'), ...(check ? ['--check'] : [])], { cwd: fixture, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exit, output: stdout + stderr };
    } finally { clearTimeout(timer); }
  };
  expect((await run(false)).exit).toBe(0);
  const report = join(fixture, 'etc/subpath-api-surface.json');
  const recorded = readFileSync(report, 'utf8');
  writeFileSync(source, baseline.replace('"a" | "b"', '"b" | "a"'));
  expect(await run(true)).toMatchObject({ exit: 0 });
  expect(readFileSync(report, 'utf8')).toBe(recorded);
  for (const changed of [
    baseline.replace('"a" | "b"', '"a" | "b" | "c"'),
    baseline.replace('required: boolean;', 'required: boolean; added: string;'),
    'export interface Options { required: boolean; }',
  ]) {
    writeFileSync(source, changed);
    const result = await run(true);
    expect(result.exit).toBe(1);
    expect(result.output).toContain('the published subpath surface changed');
    expect(readFileSync(report, 'utf8')).toBe(recorded);
  }
}, 60_000);
