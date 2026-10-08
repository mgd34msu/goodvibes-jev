import { afterEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveDaemonUpdateArtifact } from '../../daemon/lifecycle.js';
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
