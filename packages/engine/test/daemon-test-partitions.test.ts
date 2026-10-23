import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { daemonTestManifest, daemonTestPlans } from '../scripts/daemon-test-partitions.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const parity = 'src/test/daemon/server-parity.test.ts';
function write(root: string, file: string, text = ''): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

test('complete daemon ownership matches an independent recursive census and discovers new files', () => {
  const daemon = resolve(import.meta.dir, '../../../products/daemon');
  const manifest = daemonTestManifest(daemon);
  const census = readdirSync(join(daemon, 'src/test'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name).slice(daemon.length + 1).replaceAll('\\', '/'))
    .filter(file => !file.split('/').some(part => ['node_modules', '.git', 'dist'].includes(part))).sort();
  expect(manifest.files).toEqual(census);
  expect(manifest.groups.flatMap(group => group.files).sort()).toEqual(census);
  expect(new Set(manifest.groups.flatMap(group => group.files)).size).toBe(census.length);
  expect(manifest.groups.find(group => group.id === 'server-parity')?.files).toEqual([parity]);
  expect(daemonTestPlans(daemon, []).flatMap(args => args.slice(2).map(file => file.slice(2))).sort()).toEqual(census);
  for (const args of [['src/test'], ['--timeout=1'], ['--test-name-pattern=only']]) {
    expect(() => daemonTestPlans(daemon, args)).toThrow('does not accept');
  }
  const root = mkdtempSync(join(tmpdir(), 'daemon-discovery-')); roots.push(root);
  write(root, 'src/test/one.test.ts');
  const before = daemonTestManifest(root);
  write(root, 'src/test/future/deeper/new.spec.cts');
  write(root, 'src/test/node_modules/ignored.test.ts');
  write(root, 'src/test/dist/ignored.test.ts');
  const after = daemonTestManifest(root);
  expect(after.files).toEqual(['src/test/future/deeper/new.spec.cts', 'src/test/one.test.ts']);
  expect(after.sha256).not.toBe(before.sha256);
});

test('real daemon entrypoint runs all children, preserves isolation and propagates a failed owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-runner-')); roots.push(root);
  const scripts = join(root, 'packages/engine/scripts'); mkdirSync(scripts, { recursive: true });
  for (const file of ['daemon-test-partitions.ts', 'test.ts', 'test-discovery.ts', 'test-partitions.ts', 'owned-test-child.ts', 'stale-tmp-sweep.ts',
    'test-run-tmp.ts', 'workspace-lock.ts', 'test-child-watchdog-env.ts', 'test-child-watchdog.ts',
    'test-isolation.ts', 'test-network-guard.ts', 'test-network-preload.ts']) {
    copyFileSync(resolve(import.meta.dir, '../scripts', file), join(scripts, file));
  }
  cpSync(resolve(import.meta.dir, '../toolchain/src/test-runner'), join(root, 'packages/engine/toolchain/src/test-runner'), { recursive: true });
  const daemon = join(root, 'products/daemon');
  const files = [parity, 'src/test/a.test.ts', 'src/test/future/deep/b.spec.ts'];
  const receipts = join(root, 'executed.jsonl');
  write(daemon, 'bunfig.toml', '[test]\npreload = ["./preload.ts"]\n');
  write(daemon, 'preload.ts', "process.env.DAEMON_FIXTURE_PRELOADED = 'yes';");
  for (const file of files) write(daemon, file, `
    import { test, expect } from 'bun:test';
    import { appendFileSync, mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    test(${JSON.stringify(file)}, () => {
      expect(process.env.DAEMON_FIXTURE_PRELOADED).toBe('yes');
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({ file: ${JSON.stringify(file)}, tmp: mkdtempSync(join(tmpdir(), 'owned-daemon-')) }) + '\\n');
    });
  `);
  const run = () => {
    const child = Bun.spawnSync({ cmd: [process.execPath, join(scripts, 'daemon-test-partitions.ts'), 'run'], cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: root, OPENAI_API_KEY: 'synthetic-must-not-inherit' },
      stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
  };
  const passed = run();
  expect(passed.code, passed.output).toBe(0);
  const entries = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { file: string; tmp: string });
  expect(entries.map(entry => entry.file).sort()).toEqual(files.sort());
  for (const entry of entries) expect(existsSync(entry.tmp)).toBe(false);
  write(daemon, parity, "import { test, expect } from 'bun:test'; test('owner failure', () => expect(false).toBe(true));");
  const failed = run();
  expect(failed.code, failed.output).not.toBe(0);
  expect(failed.output).toContain('owner failure');
  expect(failed.output).toContain('bun test exited with code 1');
}, 60_000);
