import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildPreparationLockPath, withBuildPreparationLock } from '../../../scripts/build-preparation-lock.ts';
import { prepareRelease } from '../../../scripts/release-prepare.ts';
import { runWorkspaceToolchain } from '../../../scripts/run-toolchain.ts';
import { checkBinaryVersion } from '../../../scripts/check-version.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const prepareModule = resolve(import.meta.dir, '../../../scripts/release-prepare.ts');
const lockModule = resolve(import.meta.dir, '../../../scripts/build-preparation-lock.ts');
function fixture(): string {
  const root = makeOwnedTempDir('daemon-build-preparation');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', private: true, version: '1.2.3' }));
  writeFileSync(join(root, 'src/version.ts'), "let _version = '1.2.3';\n");
  writeFileSync(join(root, 'README.md'), 'version-1.2.3-blue.svg\n');
  return root;
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture did not reach its explicit readiness marker');
    await Bun.sleep(10);
  }
}
function processFor(script: string, root: string) {
  return Bun.spawn([process.execPath, '--no-env-file', '-e', script, root], { stdout: 'pipe', stderr: 'pipe' });
}
async function successful(child: ReturnType<typeof processFor>): Promise<void> {
  const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, errors }).toEqual({ code: 0, errors: '' });
}
function fakeToolchain(root: string, script: string): void {
  const engine = join(root, 'node_modules/@goodvibes-jev/engine');
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', exports: { './package.json': './package.json' }, bin: { 'goodvibes-build-binaries': './fake.ts', 'goodvibes-post-build-smoke': './fake.ts' } }));
  writeFileSync(join(engine, 'fake.ts'), script);
}

test('concurrent real preparation processes serialize full read/write transactions without losing bumps', async () => {
  const root = fixture();
  const children = Array.from({ length: 4 }, () => processFor(`
    import { writeFileSync } from 'node:fs';
    import { prepareRelease } from ${JSON.stringify(prepareModule)};
    await prepareRelease(process.argv[1], ['--patch', '--no-changelog'], (path, text) => {
      writeFileSync(path, text);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    });
  `, root));
  await Promise.all(children.map(successful));
  expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('1.2.7');
  checkBinaryVersion(root);
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('version-1.2.7-blue.svg\n');
  expect(existsSync(buildPreparationLockPath(root))).toBe(false);
});

test('the real native wrapper keeps a version writer out until its exact child exits', async () => {
  const root = fixture();
  fakeToolchain(root, `
    import { existsSync, writeFileSync, readFileSync } from 'node:fs';
    writeFileSync('started', 'yes');
    while (!existsSync('finish')) await Bun.sleep(10);
    if (JSON.parse(readFileSync('package.json', 'utf8')).version !== '1.2.3') process.exit(9);
  `);
  const building = runWorkspaceToolchain(root, 'build', []);
  let pending: Promise<readonly string[]> | undefined;
  try {
    await until(() => existsSync(join(root, 'started')));
    pending = prepareRelease(root, ['--patch', '--no-changelog']);
    await Bun.sleep(30);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('1.2.3');
  } finally { writeFileSync(join(root, 'finish'), 'yes'); }
  expect(await building).toBe(0);
  await pending;
  checkBinaryVersion(root);
  expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('1.2.4');
});

test('a writer blocks native consumers before spawn, and failure releases ownership', async () => {
  const root = fixture();
  fakeToolchain(root, "import { writeFileSync } from 'node:fs'; writeFileSync('started', 'yes'); process.exit(7);");
  let unlock!: () => void;
  let entered = false;
  const holder = withBuildPreparationLock(root, async () => { entered = true; await new Promise<void>(resolve => { unlock = resolve; }); });
  await until(() => entered);
  const consuming = runWorkspaceToolchain(root, 'smoke', []);
  try { await Bun.sleep(30); expect(existsSync(join(root, 'started'))).toBe(false); }
  finally { unlock(); }
  await holder;
  expect(await consuming).toBe(7);
  await expect(withBuildPreparationLock(root, () => { throw new Error('operation failed'); })).rejects.toThrow('operation failed');
  expect(await withBuildPreparationLock(root, () => 'next')).toBe('next');
});

test('symlink aliases use the same product mutex and an old live holder is never stolen', async () => {
  const root = fixture();
  const alias = root + '-alias';
  symlinkSync(root, alias, 'dir');
  expect(buildPreparationLockPath(alias)).toBe(buildPreparationLockPath(root));
  const file = buildPreparationLockPath(root); mkdirSync(dirname(file), { recursive: true });
  const bytes = JSON.stringify({ pid: process.pid, token: 'fixture-live-owner', acquiredAt: 1 });
  writeFileSync(file, bytes); utimesSync(file, new Date(0), new Date(0));
  await expect(prepareRelease(alias, ['--patch', '--no-changelog'], undefined, 40)).rejects.toThrow('timed out');
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('1.2.3');
});

test('a genuinely exited owner is reclaimed, while malformed ownership fails closed', async () => {
  const root = fixture();
  const child = processFor(`
    import { withBuildPreparationLock } from ${JSON.stringify(lockModule)};
    await withBuildPreparationLock(process.argv[1], () => process.exit(0));
  `, root);
  await successful(child);
  const file = buildPreparationLockPath(root);
  expect(existsSync(file)).toBe(true);
  await prepareRelease(root, ['--patch', '--no-changelog']);
  expect(existsSync(file)).toBe(false);
  writeFileSync(file, 'incomplete');
  await expect(prepareRelease(root, ['--patch', '--no-changelog'], undefined, 40)).rejects.toThrow('timed out');
  expect(readFileSync(file, 'utf8')).toBe('incomplete');
});

test('invalid preparation or native arguments refuse before creating lock state', async () => {
  const root = fixture();
  await expect(prepareRelease(root, [])).rejects.toThrow('Usage:');
  await expect(runWorkspaceToolchain(root, 'publish', [])).rejects.toThrow('Usage:');
  expect(existsSync(join(root, '.tmp'))).toBe(false);
});
