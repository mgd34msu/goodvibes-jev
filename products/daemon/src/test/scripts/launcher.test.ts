import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const launcherBytes = readFileSync(new URL('../../../bin/goodvibes-daemon', import.meta.url));
function fixture(checkout = true) {
  const workspace = makeOwnedTempDir('daemon-local-launcher');
  const root = join(workspace, 'products/daemon');
  mkdirSync(join(root, 'bin'), { recursive: true });
  const launcher = join(root, 'bin/goodvibes-daemon'); writeFileSync(launcher, launcherBytes); chmodSync(launcher, 0o755);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', private: true, type: 'module' }));
  if (checkout) {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'goodvibes-jev', private: true, workspaces: ['products/*'] }));
    writeFileSync(join(workspace, 'bun.lock'), '{}');
    writeFileSync(join(root, 'tsconfig.json'), '{}');
  }
  const put = (kind: 'source' | 'emitted', text: string) => {
    const directory = join(root, kind === 'source' ? 'src/cli' : 'dist/cli'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, kind === 'source' ? 'entrypoint.ts' : 'entrypoint.js'), text);
  };
  const invoke = (args: string[] = [], command = process.execPath, path = launcher) => spawnSync(command, [path, ...args], {
    cwd: workspace, env: { ...process.env, HOME: workspace, GOODVIBES_HOME: join(workspace, 'uncreated-home') }, encoding: 'utf8', timeout: 5000,
  });
  return { workspace, root, launcher, put, invoke };
}

test('emitted output wins over source and unrelated native/vendor executables', () => {
  const f = fixture(); f.put('emitted', 'console.log("emitted");'); f.put('source', 'throw new Error("source must not run");');
  for (const folder of ['native', 'vendor']) {
    mkdirSync(join(f.root, folder)); writeFileSync(join(f.root, folder, 'goodvibes-daemon-linux-x64'), '#!/bin/sh\necho stale-native\n', { mode: 0o755 });
  }
  const result = f.invoke(); expect(result.status).toBe(0); expect(result.stdout).toBe('emitted\n'); expect(result.stderr).toBe('');
});

test('a verified checkout falls back to source in the same process and preserves argv and exit status', () => {
  const f = fixture();
  f.put('source', 'console.log(JSON.stringify({ pid: process.pid, args: process.argv.slice(2) })); process.exitCode = 7;');
  const args = ['--help', 'one value', '--literal=$HOME'];
  const result = f.invoke(args);
  expect(result.status).toBe(7); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({ pid: result.pid, args });
  expect(existsSync(join(f.workspace, 'uncreated-home'))).toBe(false);
});

test('source alone in an installed-like package refuses with actionable build diagnostics and no mutation', () => {
  const f = fixture(false); f.put('source', 'console.log("must-not-run");');
  const result = f.invoke();
  expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(result.stderr).toContain('bun run build'); expect(result.stderr).toContain('does not download or install artifacts');
  for (const folder of ['native', 'vendor', '.goodvibes']) expect(existsSync(join(f.root, folder))).toBe(false);
});

test('a built installed-like package needs no source-checkout markers', () => {
  const f = fixture(false); f.put('emitted', 'console.log("installed-emitted");');
  const result = f.invoke(); expect(result.status).toBe(0); expect(result.stdout).toBe('installed-emitted\n'); expect(result.stderr).toBe('');
});

test('an empty checkout reports its missing build instead of inventing an entrypoint', () => {
  const f = fixture(); const result = f.invoke();
  expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('bun run build');
});

test('each checkout marker is necessary and malformed metadata never enables fallback', () => {
  for (const [file, text] of [
    ['package.json', '{"name":"other","private":true,"workspaces":["products/*"]}'],
    ['package.json', '{"name":"goodvibes-jev","private":false,"workspaces":["products/*"]}'],
    ['package.json', '{"name":"goodvibes-jev","private":true,"workspaces":[]}'],
    ['products/daemon/package.json', '{"name":"other","private":true}'],
    ['products/daemon/package.json', '{"name":"@goodvibes-jev/daemon","private":false}'],
    ['package.json', '{bad json'],
    ['bun.lock', null], ['products/daemon/tsconfig.json', null],
  ] as const) {
    const f = fixture(); f.put('source', 'console.log("must-not-run");');
    if (text === null) rmSync(join(f.workspace, file)); else writeFileSync(join(f.workspace, file), text);
    const result = f.invoke(); expect(result.status, file).toBe(1); expect(result.stdout).toBe('');
  }
});

test('a worktree Git marker and exact workspace entry are supported without a lockfile', () => {
  const f = fixture(); rmSync(join(f.workspace, 'bun.lock')); writeFileSync(join(f.workspace, '.git'), 'gitdir: fixture-only\n');
  writeFileSync(join(f.workspace, 'package.json'), JSON.stringify({ name: 'goodvibes-jev', private: true, workspaces: ['products/daemon'] }));
  f.put('source', 'console.log("source");'); expect(f.invoke().stdout).toBe('source\n');
});

test('an emitted runtime failure never switches to source fallback', () => {
  const f = fixture(); f.put('emitted', 'throw new Error("emitted failure");'); f.put('source', 'console.log("must-not-run");');
  const result = f.invoke(); expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('emitted failure');
});

test('the source-only launcher resolves through a consumer bin symlink from a foreign cwd', () => {
  const f = fixture(); f.put('source', 'console.log("source");');
  const dir = join(f.workspace, 'foreign path/node_modules/.bin'); mkdirSync(dir, { recursive: true });
  const link = join(dir, 'goodvibes-daemon'); symlinkSync(f.launcher, link);
  const result = f.invoke([], process.execPath, link); expect(result.status).toBe(0); expect(result.stdout).toBe('source\n');
});

test('explicit Node invocation gives the working-Bun prerequisite instead of an opaque runtime import error', () => {
  const f = fixture(); f.put('emitted', 'throw new Error("must-not-import-under-node");');
  const result = f.invoke([], 'node'); expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stdout).toBe(''); expect(result.stderr).toContain('requires a working Bun executable');
  expect(result.stderr).not.toContain('must-not-import-under-node');
});
