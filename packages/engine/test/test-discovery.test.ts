import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultTestArgs } from '../scripts/test-discovery.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(paths: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'test-discovery-'));
  roots.push(root);
  mkdirSync(join(root, 'test'));
  for (const path of paths) {
    const file = join(root, 'test', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  return root;
}

test('discovers contract, routing, and arbitrary new nested suites in stable order', () => {
  const root = fixture([
    'root.test.ts', 'contract/runner.test.ts', 'routing/routes.test.ts',
    'future/deep/suite.test.tsx', 'future/module.spec.mjs', 'future/plain.ts',
    'integration/wire.test.ts', 'toolchain/gate.test.ts',
  ]);
  expect(defaultTestArgs(root)).toEqual([
    'test/contract/runner.test.ts', 'test/future/deep/suite.test.tsx',
    'test/future/module.spec.mjs', 'test/integration/wire.test.ts',
    'test/root.test.ts', 'test/routing/routes.test.ts', 'test/toolchain/gate.test.ts',
  ]);
});

test('leaves separate runtime lanes and non-test inputs out of the default suite', () => {
  const root = fixture([
    'root.test.ts', 'workers/workers.test.ts', 'workers-wrangler/wrangler.test.ts',
    'hermes/runtime.test.ts', 'fixtures/project/example.test.ts', 'types/consumer.test.ts',
    'future/node_modules/dependency.test.ts', 'future/dist/generated.test.ts',
  ]);
  expect(defaultTestArgs(root)).toEqual(['test/root.test.ts']);
});

test('optional nested directories are unnecessary in a package-only checkout', () => {
  expect(defaultTestArgs(fixture(['root.test.ts']))).toEqual(['test/root.test.ts']);
});

test('real contract and routing suites are selected by the same helper the runner calls', () => {
  const engineRoot = resolve(import.meta.dir, '..');
  const discovered = defaultTestArgs(engineRoot);
  expect(discovered).toContain('test/contract/runner.test.ts');
  expect(discovered).toContain('test/contract/route.test.ts');
  expect(discovered).toContain('test/routing/route-planner.test.ts');
  expect(discovered).toContain('test/routing/benchmark-routing.test.ts');
  expect(discovered.some((path) => path.startsWith('test/workers/'))).toBe(false);
});

test('the actual runner executes nested fixture suites by default and preserves explicit selections', () => {
  const root = fixture(['root.test.ts', 'contract/runner.test.ts', 'routing/route.test.ts', 'new/deeper/extra.test.ts', 'workers/ignored.test.ts']);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts);
  for (const file of ['test.ts', 'test-discovery.ts', 'owned-test-child.ts', 'stale-tmp-sweep.ts',
    'test-run-tmp.ts', 'workspace-lock.ts', 'test-child-watchdog-env.ts', 'test-child-watchdog.ts',
    'test-isolation.ts', 'test-network-guard.ts', 'test-network-preload.ts']) {
    copyFileSync(resolve(import.meta.dir, '../scripts', file), join(scripts, file));
  }
  for (const path of ['root.test.ts', 'contract/runner.test.ts', 'routing/route.test.ts', 'new/deeper/extra.test.ts']) {
    writeFileSync(join(root, 'test', path), `import { test, expect } from 'bun:test'; test(${JSON.stringify(path)}, () => expect(true).toBe(true));`);
  }
  writeFileSync(join(root, 'test/workers/ignored.test.ts'), "throw new Error('separate worker lane must not run');");
  const run = (args: string[]) => {
    const child = Bun.spawnSync({
      cmd: [process.execPath, join(scripts, 'test.ts'), ...args], cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: root }, timeout: 10_000,
      stdout: 'pipe', stderr: 'pipe',
    });
    const output = `${child.stdout.toString()}${child.stderr.toString()}`;
    expect(child.exitCode, output).toBe(0);
    return output;
  };
  const all = run([]);
  expect(all).toContain('4 pass');
  expect(all).toContain('contract/runner.test.ts');
  expect(all).toContain('routing/route.test.ts');
  expect(all).toContain('new/deeper/extra.test.ts');
  expect(run(['test/root.test.ts'])).toContain('1 pass');
});
