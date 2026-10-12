import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDaemonCliOwnership } from '../../cli/configuration.js';
import { applyVerifiedUpdate, realUpdateFileIo, rollbackKeptPrevious, sha256 } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { writeNativeInstallationFixture } from '../helpers/native-runtime-provenance.js';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveDaemonUpdateArtifact, resolveInstalledDaemonUpdateArtifact } from '../../daemon/lifecycle.js';
import { VERSION } from '../../version.js';

const FIXTURE_VERSION = '9.9.9-test';
const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath')!;
const originalOverride = process.env.GOODVIBES_DAEMON_BINARY;
afterEach(() => {
  Object.defineProperty(process, 'execPath', originalExecPath);
  if (originalOverride === undefined) delete process.env.GOODVIBES_DAEMON_BINARY;
  else process.env.GOODVIBES_DAEMON_BINARY = originalOverride;
});

describe('resolveDaemonUpdateArtifact', () => {
  test('a compiled binary path resolves to the host version and exact exec path', () => {
    const execPath = '/usr/local/bin/goodvibes';
    expect(resolveDaemonUpdateArtifact({ execPath, version: FIXTURE_VERSION }))
      .toEqual({ version: FIXTURE_VERSION, execPath });
  });

  test('a dev/source Bun interpreter resolves to undefined', () => {
    expect(resolveDaemonUpdateArtifact({ execPath: '/usr/bin/bun', version: FIXTURE_VERSION })).toBeUndefined();
  });

  test('a bun-global package install resolves to undefined', () => {
    expect(resolveDaemonUpdateArtifact({
      execPath: '/home/u/.bun/install/global/node_modules/.bin/goodvibes', version: FIXTURE_VERSION,
    })).toBeUndefined();
  });

  test.each([
    'C:\\tools\\bun.exe', 'C:/tools/BUN.EXE',
    'C:\\project\\node_modules\\pkg\\bin\\goodvibes.exe',
    'C:/project/node_modules/pkg/bin/goodvibes.exe',
    '/project/node_modules/pkg/node_modules/vendor/goodvibes',
  ])('rejects source/package ancestry: %s', (execPath) => {
    expect(resolveDaemonUpdateArtifact({ execPath, version: FIXTURE_VERSION })).toBeUndefined();
  });

  test.each(['C:\\Programs\\goodvibes.exe', '/opt/../opt//goodvibes', './goodvibes', '/opt/node_modules-backup/goodvibes'])
  ('preserves binary-classified path bytes without discovery or normalization: %s', (execPath) => {
    expect(resolveDaemonUpdateArtifact({ execPath, version: FIXTURE_VERSION }))
      .toEqual({ version: FIXTURE_VERSION, execPath });
  });

  test('defaults to process.execPath and the product VERSION', () => {
    const execPath = '/fixture/default/goodvibes';
    Object.defineProperty(process, 'execPath', { ...originalExecPath, value: execPath });
    expect(resolveDaemonUpdateArtifact()).toEqual({ version: VERSION, execPath });
    expect(resolveDaemonUpdateArtifact({ version: FIXTURE_VERSION })).toEqual({ version: FIXTURE_VERSION, execPath });
    expect(resolveDaemonUpdateArtifact({ execPath: '/fixture/explicit/goodvibes' }))
      .toEqual({ version: VERSION, execPath: '/fixture/explicit/goodvibes' });
  });

  test('the default process path still undergoes the install-kind guard', () => {
    Object.defineProperty(process, 'execPath', { ...originalExecPath, value: '/usr/bin/bun' });
    expect(resolveDaemonUpdateArtifact()).toBeUndefined();
  });

  test('GOODVIBES_DAEMON_BINARY cannot redirect or bypass artifact resolution', () => {
    process.env.GOODVIBES_DAEMON_BINARY = '/override/goodvibes';
    Object.defineProperty(process, 'execPath', { ...originalExecPath, value: '/usr/bin/bun' });
    expect(resolveDaemonUpdateArtifact()).toBeUndefined();
    const execPath = '/actual/goodvibes';
    expect(resolveDaemonUpdateArtifact({ execPath, version: FIXTURE_VERSION }))
      .toEqual({ version: FIXTURE_VERSION, execPath });
    Object.defineProperty(process, 'execPath', { ...originalExecPath, value: execPath });
    expect(resolveDaemonUpdateArtifact()).toEqual({ version: VERSION, execPath });
  });

  test('uses nullish defaults, preserving explicit empty version and path bytes', () => {
    expect(resolveDaemonUpdateArtifact({ execPath: '', version: '' })).toEqual({ execPath: '', version: '' });
  });
});

test('isolated import and resolution do not construct runtime owners or use the network', () => {
  const script = `
    import { mock } from 'bun:test';
    let activations = 0;
    function unexpected() { activations++; throw new Error('Unexpected runtime activation'); }
    const daemonEntry = import.meta.resolve('@goodvibes-jev/engine/sdk/platform/daemon');
    for (const [file, name] of [
      ['server.js', 'DaemonServer'],
      ['http-listener.js', 'HttpListener'],
      ['auto-updater.js', 'DaemonAutoUpdater'],
      ['service-manager.js', 'PlatformServiceManager'],
    ]) {
      mock.module(new URL(file, daemonEntry).href, () => ({ [name]: unexpected }));
    }
    globalThis.fetch = unexpected;
    Bun.serve = unexpected;
    Bun.connect = unexpected;
    const { resolveDaemonUpdateArtifact } = await import(${JSON.stringify(new URL('../../daemon/lifecycle.ts', import.meta.url).href)});
    const artifact = resolveDaemonUpdateArtifact({ execPath: '/fixture/goodvibes', version: 'fixture' });
    if (activations !== 0) throw new Error('Caught runtime activation');
    if (artifact?.execPath !== '/fixture/goodvibes' || artifact.version !== 'fixture') throw new Error('Incorrect artifact');
  `;
  const result = spawnSync(process.execPath, ['--no-env-file', '--preload',
    fileURLToPath(new URL('../../../../../packages/engine/toolchain/src/test-runner/test-network-preload.ts', import.meta.url)),
    '--eval', script], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: process.env,
    encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL',
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});

function installedFixture(version = '9.9.9-test', arch: 'x64' | 'arm64' = 'x64') {
  return writeNativeInstallationFixture(makeOwnedTempDir('daemon-lifecycle-install'), version, arch);
}
const defaultHome = { isOverridden: false };

describe('verified native lifecycle admission', () => {
  for (const arch of ['x64', 'arm64'] as const) test(`complete ${arch} metadata admits only its running native installation`, () => {
    const f = installedFixture('9.9.9-test', arch);
    const artifact = resolveInstalledDaemonUpdateArtifact(defaultHome, f.options);
    expect(artifact?.execPath).toBe(f.execPath); expect(artifact?.version).toBe(f.receipt.version);
    expect(Object.isFrozen(artifact)).toBe(true); expect(() => artifact?.assertCurrent?.()).not.toThrow();
  });

  test('a source invocation cannot arm an adjacent valid native cohort', () => {
    const f = installedFixture();
    expect(resolveInstalledDaemonUpdateArtifact(defaultHome, { ...f.options, bundled: false })).toBeUndefined();
  });

  for (const override of ['tree', 'identity', 'flag'] as const) test(`${override} home override refuses a complete native cohort`, () => {
    const f = installedFixture(); const root = makeOwnedTempDir('native-home-override');
    const ownership = resolveDaemonCliOwnership({ daemonHome: override === 'flag' ? join(root, 'flag') : undefined, workingDir: undefined },
      { HOME: root, ...(override === 'tree' ? { GOODVIBES_HOME: join(root, 'tree') } : {}),
        ...(override === 'identity' ? { GOODVIBES_DAEMON_HOME: join(root, 'identity') } : {}) }, root);
    expect(ownership.isOverridden).toBe(true);
    expect(resolveInstalledDaemonUpdateArtifact(ownership, f.options)).toBeUndefined();
  });

  test('package-managed native-looking files remain outside standalone lifecycle ownership', () => {
    const root = makeOwnedTempDir('package-native-refusal');
    const f = writeNativeInstallationFixture(join(root, 'node_modules', 'daemon'), '9.9.9-test');
    expect(resolveInstalledDaemonUpdateArtifact(defaultHome, f.options)).toBeUndefined();
    expect(resolveInstalledDaemonUpdateArtifact(defaultHome, { ...f.options, execPath: '/usr/bin/bun' })).toBeUndefined();
  });

  test('a foreign native target cannot be mixed into the installed cohort', () => {
    const f = installedFixture(); writeFileSync(join(f.execPath, '..', 'goodvibes-daemon-linux-arm64.bun'), 'foreign runtime');
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, f.options)).toThrow();
  });

  test('a binary-looking executable without a complete receipt cannot arm lifecycle', () => {
    const root = makeOwnedTempDir('unowned-native-binary'); const execPath = join(root, 'goodvibes-daemon');
    writeFileSync(execPath, 'synthetic bare binary'); chmodSync(execPath, 0o755);
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, { bundled: true, execPath, version: '9.9.9-test', platform: 'linux', arch: 'x64' })).toThrow();
  });

  for (const index of [0, 1, 2, 3, 4, 5]) test(`missing native cohort member ${index} refuses admission`, () => {
    const f = installedFixture(); rmSync(f.targets[index]!.path);
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, f.options)).toThrow();
  });

  test('wrong running version and unsupported installation target stay unarmed', () => {
    const f = installedFixture();
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, { ...f.options, version: '9.9.8-test' })).toThrow();
    expect(resolveInstalledDaemonUpdateArtifact(defaultHome, { ...f.options, platform: 'darwin' })).toBeUndefined();
    expect(resolveInstalledDaemonUpdateArtifact(defaultHome, { ...f.options, arch: 'riscv64' })).toBeUndefined();
  });

  test('wrong runtime mode and bytes cannot be treated as a verified installation', () => {
    const f = installedFixture(); const runtime = f.targets[1]!.path;
    chmodSync(runtime, 0o644);
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, f.options)).toThrow();
    chmodSync(runtime, 0o755); writeFileSync(runtime, 'unowned replacement runtime');
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, f.options)).toThrow();
  });

  test('matching payload checksums cannot authorize an unsupported toolchain', () => {
    const f = installedFixture(); const metadata = Buffer.from(JSON.stringify({ ...JSON.parse(f.buffers[3]!.toString()), version: '0.0.0' }));
    writeFileSync(f.targets[3]!.path, metadata);
    const receipt = { ...f.receipt, artifact: { ...f.receipt.artifact, files: f.receipt.artifact.files.map((file, index) =>
      index === 3 ? { ...file, sha256: sha256(metadata), size: metadata.length } : file) } };
    writeFileSync(f.targets[5]!.path, JSON.stringify(receipt));
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, f.options)).toThrow();
  });

  test('a symlinked native member and an unfinished transaction refuse admission', () => {
    const f = installedFixture(); const runtime = f.targets[1]!.path; const peer = runtime + '.peer';
    renameSync(runtime, peer); symlinkSync(peer, runtime);
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, f.options)).toThrow();
    rmSync(runtime); renameSync(peer, runtime); writeFileSync(runtime + '.update-transaction', 'unsettled');
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, f.options)).toThrow();
  });

  test('same-byte replacement and caller cancellation retire the retained installation', () => {
    const f = installedFixture(); const abort = new AbortController();
    const artifact = resolveInstalledDaemonUpdateArtifact(defaultHome, { ...f.options, signal: abort.signal });
    expect(artifact).toBeDefined(); const runtime = f.targets[1]!.path;
    copyFileSync(runtime, runtime + '.peer'); renameSync(runtime + '.peer', runtime);
    expect(() => artifact!.assertCurrent!()).toThrow();
    const next = resolveInstalledDaemonUpdateArtifact(defaultHome, { ...f.options, signal: abort.signal });
    abort.abort(); expect(() => next!.assertCurrent!()).toThrow();
  });

  for (const damage of ['bytes', 'missing'] as const) test(`damaged current ${damage} with a verified prior admits recovery only`, () => {
    const f = installedFixture(); const previous = installedFixture('9.9.8-test');
    for (const [index, target] of f.targets.entries()) copyFileSync(previous.targets[index]!.path, target.path + '.previous');
    if (damage === 'missing') rmSync(f.targets[1]!.path);
    else writeFileSync(f.execPath, 'damaged current daemon');
    const artifact = resolveInstalledDaemonUpdateArtifact(defaultHome, f.options);
    expect(artifact).toBeDefined();
    expect(() => artifact!.assertStarting!()).not.toThrow();
    expect(() => artifact!.assertCurrent!()).toThrow();
    writeFileSync(f.targets[1]!.path + '.previous', 'changed prior runtime');
    expect(() => artifact!.assertStarting!()).toThrow();
  });

  test('damaged current receipt cannot borrow a valid prior installation version', () => {
    const f = installedFixture(); const previous = installedFixture('9.9.8-test');
    for (const [index, target] of f.targets.entries()) copyFileSync(previous.targets[index]!.path, target.path + '.previous');
    writeFileSync(f.execPath, 'damaged current daemon');
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, { ...f.options, version: previous.receipt.version })).toThrow();
    const receipt = { ...f.receipt, packageName: 'unowned-package' };
    writeFileSync(f.targets[5]!.path, JSON.stringify(receipt));
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, f.options)).toThrow();
  });

  test('damaged current without an intact prior cannot enter recovery admission', () => {
    const f = installedFixture(); const previous = installedFixture('9.9.8-test');
    for (const [index, target] of f.targets.entries()) copyFileSync(previous.targets[index]!.path, target.path + '.previous');
    writeFileSync(f.execPath, 'damaged current daemon');
    writeFileSync(f.targets[1]!.path + '.previous', 'damaged prior runtime');
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, f.options)).toThrow();
  });

  test('recovery admission retains cancellation and unfinished-transaction refusal', () => {
    const f = installedFixture(); const previous = installedFixture('9.9.8-test'); const abort = new AbortController();
    for (const [index, target] of f.targets.entries()) copyFileSync(previous.targets[index]!.path, target.path + '.previous');
    writeFileSync(f.execPath, 'damaged current daemon');
    const artifact = resolveInstalledDaemonUpdateArtifact(defaultHome, { ...f.options, signal: abort.signal });
    expect(() => artifact!.assertStarting!()).not.toThrow();
    abort.abort(); expect(() => artifact!.assertStarting!()).toThrow();
    writeFileSync(f.targets[1]!.path + '.update-transaction', 'unfinished');
    expect(() => resolveInstalledDaemonUpdateArtifact(defaultHome, f.options)).toThrow();
  });

  test('verified native update and rollback can be admitted by each freshly restarted artifact', async () => {
    const f = installedFixture('9.9.8-test'); const next = installedFixture('9.9.9-test');
    const old = resolveInstalledDaemonUpdateArtifact(defaultHome, f.options);
    const requests: string[] = []; const base = 'https://native-fixture.test/release';
    await applyVerifiedUpdate({ targets: f.targets, platform: 'linux', io: realUpdateFileIo,
      daemonNative: { execPath: f.execPath, platform: 'linux', arch: 'x64', version: next.receipt.version }, downloadBaseUrl: base,
      fetchImpl: async (url) => {
        requests.push(url); const name = url.slice(base.length + 1);
        const bytes = name === 'SHA256SUMS.txt' ? Buffer.from(next.checksumManifest) : next.assets[name];
        if (!bytes) throw new Error('Unexpected synthetic native asset');
        return { ok: true, status: 200, text: async () => bytes.toString(), arrayBuffer: async () => Uint8Array.from(bytes).buffer };
      },
    });
    expect(requests).toHaveLength(f.targets.length + 1);
    expect(() => old!.assertCurrent!()).toThrow();
    const restarted = resolveInstalledDaemonUpdateArtifact(defaultHome, { ...f.options, version: next.receipt.version });
    expect(() => restarted!.assertCurrent!()).not.toThrow();
    expect(readFileSync(f.execPath).toString()).toBe(next.buffers[0]!.toString());
    expect(rollbackKeptPrevious(f.targets, realUpdateFileIo, undefined, { native: true, requireComplete: true }).restored).toHaveLength(f.targets.length);
    expect(() => restarted!.assertCurrent!()).toThrow();
    const restored = resolveInstalledDaemonUpdateArtifact(defaultHome, f.options);
    expect(() => restored!.assertCurrent!()).not.toThrow();
    expect(readFileSync(f.execPath).toString()).toBe(f.buffers[0]!.toString());
  });
});
