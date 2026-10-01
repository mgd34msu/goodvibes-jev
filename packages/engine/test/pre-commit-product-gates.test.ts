import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const roots: string[] = [];
const hook = resolve(import.meta.dir, '../../../.githooks/pre-commit');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function stagedChecks(files: readonly string[], failingGate = ''): { checks: string[]; exitCode: number } {
  const root = makeProjectTempDir('product-commit-hook'); roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'checks');
  writeFileSync(join(bin, 'bun'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CHECK_LOG"\nif [ "$*" = "$FAILING_GATE" ]; then exit 1; fi\n');
  chmodSync(join(bin, 'bun'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CHECK_LOG: log, FAILING_GATE: failingGate };
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
  const result = Bun.spawnSync(['bash', hook], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  return {
    checks: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    exitCode: result.exitCode,
  };
}

const gates = ['run credential-scope:check', 'run build', 'run typecheck', 'run api:check'];
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
    expect(stagedChecks([file])).toEqual({ checks: gates, exitCode: 0 });
  });
}
test('engine source and exports invoke the same gate chain', () => {
  expect(stagedChecks(['packages/engine/sdk/src/index.ts'])).toEqual({ checks: gates, exitCode: 0 });
  expect(stagedChecks(['packages/engine/package.json'])).toEqual({ checks: gates, exitCode: 0 });
});
test('documentation-only changes do not invoke build gates', () => {
  expect(stagedChecks(['products/daemon/README.md'])).toEqual({ checks: [], exitCode: 0 });
});
for (const [index, gate] of gates.entries()) {
  test(`product changes are rejected without running later gates when ${gate} fails`, () => {
    const result = stagedChecks(['products/daemon/src/cli/parser.ts'], gate);
    expect(result.exitCode).not.toBe(0);
    expect(result.checks).toEqual(gates.slice(0, index + 1));
  });
}
