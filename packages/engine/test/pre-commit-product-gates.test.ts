import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const roots: string[] = [];
const hook = resolve(import.meta.dir, '../../../.githooks/pre-commit');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function stagedChecks(files: readonly string[]): string[] {
  const root = makeProjectTempDir('product-commit-hook'); roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'checks');
  writeFileSync(join(bin, 'bun'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CHECK_LOG"\n');
  chmodSync(join(bin, 'bun'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CHECK_LOG: log };
  function command(args: string[]): void {
    const result = Bun.spawnSync(args, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(`Fixture command failed: ${args.join(' ')}\n${result.stderr.toString()}`);
  }
  command(['git', 'init', '--quiet']);
  for (const file of files) {
    const target = join(root, file); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'fixture\n');
  }
  command(['git', 'add', '--', ...files]);
  command(['bash', hook]);
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

const gates = ['run line:check', 'run credential-scope:check', 'run build', 'run typecheck', 'run api:check'];
for (const file of [
  'products/daemon/src/cli/parser.ts',
  'products/tui/src/components/fixture.tsx',
  'products/daemon/src/test/cli/parser.test.ts',
  'products/daemon/scripts/build.ts',
  'products/daemon/package.json',
  'products/daemon/tsconfig.build.json',
  'products/daemon/migration.json',
]) {
  test(`product change invokes the full real gate chain: ${file}`, () => {
    expect(stagedChecks([file])).toEqual(gates);
  });
}
test('engine source and exports retain the original gate chain', () => {
  expect(stagedChecks(['packages/engine/sdk/src/index.ts'])).toEqual(gates);
  expect(stagedChecks(['packages/engine/package.json'])).toEqual(gates);
});
test('documentation-only changes do not invoke build gates', () => {
  expect(stagedChecks(['products/daemon/README.md'])).toEqual([]);
});
