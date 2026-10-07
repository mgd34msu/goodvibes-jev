import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyRuntimeConfigValue } from '@goodvibes-jev/engine/terminal-shell';
import { describeDerivedBindMismatch, readControlPlaneBinding } from '@goodvibes-jev/engine/sdk/platform/config';
import { DaemonServer } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { isKnownConfigKey } from '../../config/config-key-guard.js';
import { createDaemonCliConfiguration } from '../../cli/configuration.js';
import { getPackageVersion } from '../../cli/help.js';
import { runConfiguredDaemonCli, type DaemonCliRuntime } from '../../cli/serve.js';
import type { DaemonProcessExitCode, DaemonProcessHandle } from '../../daemon/process-lifecycle.js';
import * as hosts from '../../runtime/daemon-host.js';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.js';
import { availableLoopbackPorts } from '../helpers/companion-cli-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

class ProcessFixture extends EventEmitter {
  readonly exits: DaemonProcessExitCode[] = [];
  exit(code: DaemonProcessExitCode) { this.exits.push(code); }
}
let restores: Array<() => void>;
let handles: DaemonProcessHandle[];
let releases: Array<() => void>;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function keep<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  releases.push(resolve);
  return { promise, resolve };
}
beforeEach(() => {
  restores = []; handles = []; releases = [];
  keep(spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]));
  keep(spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue());
});
afterEach(async () => {
  for (const release of releases) release();
  for (const handle of handles) await handle.shutdown();
  for (const restore of restores.reverse()) restore();
});

async function fixture(configure?: (services: RuntimeServices) => void, factories: hosts.DaemonHostFactories = {}) {
  const root = makeOwnedTempDir('startup-diagnostics');
  const env = { HOME: root, GOODVIBES_HOME: join(root, 'tree'), GOODVIBES_DAEMON_HOME: join(root, 'selected') };
  const configuration = createDaemonCliConfiguration({ daemonHome: undefined, workingDir: undefined }, env, root);
  const [port] = await availableLoopbackPorts(1);
  applyRuntimeConfigValue(configuration.config, 'cluster.enabled', false);
  applyRuntimeConfigValue(configuration.config, 'relay.enabled', false);
  applyRuntimeConfigValue(configuration.config, 'controlPlane.port', port!);
  const stdout: string[] = []; const stderr: string[] = []; const fatal: string[] = [];
  const target = new ProcessFixture();
  let acquired = 0; let host: hosts.DaemonHost | undefined;
  const createHost = hosts.createDaemonHost;
  keep(spyOn(hosts, 'createDaemonHost').mockImplementation((options) => {
    host = createHost(options, { async createRuntime(runtime) {
      acquired++;
      const services = await createRuntimeServices(runtime);
      configure?.(services); return services;
    }, ...factories });
    return host;
  }));
  const write = fs.writeSync;
  function captureWrite(fd: number, data: NodeJS.ArrayBufferView, offset?: number | null, length?: number | null, position?: number | null): number;
  function captureWrite(fd: number, data: string, position?: number | null, encoding?: BufferEncoding | null): number;
  function captureWrite(fd: number, data: NodeJS.ArrayBufferView | string, offset?: number | null,
    length?: number | BufferEncoding | null, position?: number | null): number {
    if (typeof data === 'string') return write(fd, data, offset, typeof length === 'string' ? length : undefined);
    if (fd === 2 && Buffer.isBuffer(data)) {
      const start = offset ?? 0; const size = typeof length === 'number' ? length : data.byteLength - start;
      fatal.push(data.subarray(start, start + size).toString('utf8')); return size;
    }
    return write(fd, data, offset, typeof length === 'number' ? length : undefined, position);
  }
  keep(spyOn(fs, 'writeSync').mockImplementation(captureWrite));
  const runtime: DaemonCliRuntime = {
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    localUserAuthManager: new UserAuthManager({ bootstrapFilePath: join(root, 'users.json'), bootstrapCredentialPath: join(root, 'bootstrap.txt'),
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('fixture'), roles: ['admin'] }] }),
  };
  const start = (out: (line: string) => void = (line) => { stdout.push(line); },
    err: (line: string) => void = (line) => { stderr.push(line); }) => {
    const handle = runConfiguredDaemonCli(configuration, runtime, env, { process: target }, err, out);
    handles.push(handle); return handle;
  };
  return { root, env, configuration, stdout, stderr, fatal, target, start, port,
    get host() { return host; }, acquired: () => acquired, tokenPath: join(env.GOODVIBES_DAEMON_HOME, 'operator-tokens.json') };
}

test('starting output can shut down before any token or graph acquisition and escapes selected home controls', async () => {
  const f = await fixture();
  const configuration = { ...f.configuration, homeDirectory: `${f.root}/tree\n\x1b\x85\u202e`, daemonHomeDirectory: `${f.root}/daemon\r\u2066` };
  let handle!: DaemonProcessHandle;
  handle = runConfiguredDaemonCli(configuration, { inboxFactory() { throw new Error('No graph allowed'); } }, f.env,
    { process: f.target }, (line) => { f.stderr.push(line); }, (line) => { f.stdout.push(line); void handle.shutdown(); });
  handles.push(handle);
  expect(await handle.ready).toBeUndefined();
  expect(await handle.finished).toBe(0);
  expect(f.acquired()).toBe(0); expect(existsSync(f.tokenPath)).toBe(false);
  expect(f.stdout).toHaveLength(1);
  expect(f.stdout[0]).toContain(`goodvibes-daemon ${getPackageVersion()} starting:`);
  expect(f.stdout[0]).toContain('tree\\n\\u001b\\u0085\\u202e');
  expect(f.stdout[0]).toContain('daemon\\r\\u2066');
  expect(f.stderr).toEqual([]);
});

test('a starting writer failure fails startup before token or graph acquisition without private exception output', async () => {
  const f = await fixture();
  const handle = f.start(() => { throw new Error('private-starting-writer'); });
  await expect(handle.ready).rejects.toThrow('Daemon startup failed');
  expect(await handle.finished).toBe(1);
  expect(f.target.exits).toEqual([1]); expect(f.acquired()).toBe(0); expect(existsSync(f.tokenPath)).toBe(false);
  expect(f.fatal.join('')).toContain('Daemon startup failed');
  expect(f.fatal.join('')).not.toContain('private-starting-writer');
});

test('held boot cannot publish bound or readiness until the owned start settles', async () => {
  const entered = gate(); const release = gate();
  const f = await fixture((services) => {
    const start = services.bootTasks!.start;
    keep(spyOn(services.bootTasks!, 'start').mockImplementation(async () => { entered.resolve(); await release.promise; return start(); }));
  });
  const handle = f.start();
  await entered.promise;
  expect(f.host!.daemon!.isRunning).toBe(true);
  expect(f.stdout).toHaveLength(1); expect(f.stdout[0]).toContain('starting:');
  release.resolve(); await handle.ready;
  expect(f.stdout).toHaveLength(3);
  expect(f.stdout[1]).toContain(`bound: host="127.0.0.1" port=${f.host!.daemon!.boundPort}`);
  expect(f.stdout[2]).toBe(`goodvibes-daemon ${getPackageVersion()} host started (ready)`);
  expect(f.stderr).toEqual([]);
});

test('a listener stopped during held boot cannot publish bound or readiness after settlement', async () => {
  const entered = gate(); const release = gate();
  const f = await fixture((services) => {
    const start = services.bootTasks!.start;
    keep(spyOn(services.bootTasks!, 'start').mockImplementation(async () => { entered.resolve(); await release.promise; return start(); }));
  });
  const handle = f.start(); await entered.promise;
  await f.host!.daemon!.stop();
  expect(f.host!.daemon!.isRunning).toBe(false);
  release.resolve();
  await expect(handle.ready).rejects.toThrow('Daemon startup failed');
  expect(await handle.finished).toBe(1);
  expect(f.stdout).toHaveLength(1); expect(f.stdout[0]).toContain('starting:');
  expect(f.stderr).toEqual([]);
});

for (const shutdown of [false, true]) {
  test(`a restart admitted during boot settles before diagnostics${shutdown ? ' and shutdown fences them' : ''}`, async () => {
    const bootEntered = gate(); const bootRelease = gate(); const restartEntered = gate(); const restartRelease = gate();
    const f = await fixture((services) => {
      const start = services.bootTasks!.start;
      keep(spyOn(services.bootTasks!, 'start').mockImplementation(async () => { bootEntered.resolve(); await bootRelease.promise; return start(); }));
    });
    const handle = f.start(); await bootEntered.promise;
    const daemon = f.host!.daemon!; const stop = daemon.stop.bind(daemon);
    keep(spyOn(daemon, 'stop').mockImplementationOnce(async () => { restartEntered.resolve(); await restartRelease.promise; await stop(); }));
    const [newPort] = await availableLoopbackPorts(1);
    f.configuration.config.set('controlPlane.port', newPort!);
    await restartEntered.promise;
    bootRelease.resolve(); await tick();
    expect(f.stdout).toHaveLength(1);
    if (shutdown) void handle.shutdown();
    restartRelease.resolve();
    if (shutdown) {
      expect(await handle.ready).toBeUndefined(); expect(await handle.finished).toBe(0);
      expect(f.stdout).toHaveLength(1); expect(daemon.isRunning).toBe(false);
    } else {
      await handle.ready;
      expect(daemon.isRunning).toBe(true); expect(daemon.boundPort).toBe(newPort!);
      expect(f.stdout[1]).toContain(`bound: host="127.0.0.1" port=${newPort}`);
      expect(f.stdout[2]).toContain('host started');
    }
    expect(f.stderr).toEqual([]);
  });
}

for (const phase of ['bound', 'mismatch', 'ready', 'binding getter'] as const) {
  test(`${phase} failure remains owned until the acquired graph drains`, async () => {
    const closing = gate(); const release = gate();
    const f = await fixture((services) => {
      const close = services.close;
      keep(spyOn(services, 'close').mockImplementation(async () => { closing.resolve(); await release.promise; await close(); }));
    }, { createServer(config) {
      const server = new DaemonServer({ ...config, ...(phase === 'mismatch' ? { port: 0 } : {}) });
      if (phase === 'binding getter') Object.defineProperty(server, 'boundHost', { configurable: true, get() { throw new Error('private-getter-failure'); } });
      return server;
    } });
    const handle = f.start((line) => {
      f.stdout.push(line);
      if (phase === 'bound' && line.includes(' bound:') || phase === 'ready' && line.includes('host started')) throw new Error('private-output-failure');
    }, (line) => { f.stderr.push(line); if (phase === 'mismatch') throw new Error('private-mismatch-writer'); });
    await expect(handle.ready).rejects.toThrow('Daemon startup failed');
    await closing.promise; await tick();
    expect(f.target.exits).toEqual([]); expect(f.host!.daemon!.isRunning).toBe(false);
    expect(f.fatal.join('')).toContain('Daemon startup failed'); expect(f.fatal.join('')).not.toContain('private-');
    release.resolve(); expect(await handle.finished).toBe(1); expect(f.target.exits).toEqual([1]);
  });
}

for (const phase of ['bound', 'mismatch', 'ready'] as const) {
  test(`shutdown from ${phase} output fences later diagnostics and drains`, async () => {
    const f = await fixture(undefined, phase === 'mismatch' ? { createServer(config) {
      // A supported explicit host override creates a real mismatch with configured port.
      return new DaemonServer({ ...config, port: 0 });
    } } : {});
    let handle!: DaemonProcessHandle;
    handle = f.start((line) => { f.stdout.push(line); if (phase === 'bound' && line.includes(' bound:') || phase === 'ready' && line.includes('host started')) void handle.shutdown(); },
      (line) => { f.stderr.push(line); if (phase === 'mismatch') void handle.shutdown(); });
    expect(await handle.ready).toBeUndefined(); expect(await handle.finished).toBe(0);
    expect(f.stdout).toHaveLength(phase === 'ready' ? 3 : 2);
    expect(f.stderr.length).toBe(phase === 'mismatch' ? 1 : 0);
    expect(f.host!.daemon!.isRunning).toBe(false);
  });
}

for (const phase of ['bound', 'mismatch'] as const) {
  test(`running-state loss from ${phase} output cannot publish readiness`, async () => {
    const f = await fixture(undefined, phase === 'mismatch' ? { createServer(config) {
      return new DaemonServer({ ...config, host: '127.0.0.1', port: 0 });
    } } : {});
    const unavailable = () => {
      // Change the borrowed server observation synchronously at the output seam;
      // the existing owner still performs and awaits the real socket stop.
      Object.defineProperty(f.host!.daemon!, 'isRunning', { configurable: true, get: () => false });
    };
    const handle = f.start((line) => { f.stdout.push(line); if (phase === 'bound' && line.includes(' bound:')) unavailable(); },
      (line) => { f.stderr.push(line); if (phase === 'mismatch') unavailable(); });
    await expect(handle.ready).rejects.toThrow('Daemon startup failed');
    expect(await handle.finished).toBe(1);
    expect(f.stdout).toHaveLength(2); expect(f.stdout.join('\n')).not.toContain('host started');
    expect(f.host!.snapshot().state).toBe('closed');
  });
}

for (const mode of ['agreement', 'wildcard', 'public URL', 'mismatch'] as const) {
  test(`canonical ${mode} diagnostics use the actual bound endpoint without raw URL disclosure`, async () => {
    const f = await fixture(undefined, mode === 'mismatch' || mode === 'wildcard' ? { createServer(config) {
      return new DaemonServer({ ...config, host: '127.0.0.1', ...(mode === 'mismatch' ? { port: 0 } : {}) });
    } } : {});
    if (mode === 'wildcard') {
      applyRuntimeConfigValue(f.configuration.config, 'controlPlane.hostMode', 'network');
      applyRuntimeConfigValue(f.configuration.config, 'controlPlane.host', '0.0.0.0');
      const config = f.configuration.config;
      const binding = readControlPlaneBinding((key) => isKnownConfigKey(key, config.getSchema()) ? config.get(key) : undefined);
      expect(describeDerivedBindMismatch({ host: '0.0.0.0', port: f.port! }, binding)).toBeNull();
    }
    if (mode === 'mismatch') {
      applyRuntimeConfigValue(f.configuration.config, 'controlPlane.hostMode', 'custom');
      applyRuntimeConfigValue(f.configuration.config, 'controlPlane.host', 'user:private-client-password@localhost/path?private-query#private-fragment');
    }
    if (mode === 'public URL') applyRuntimeConfigValue(f.configuration.config, 'controlPlane.publicBaseUrl', 'https://user:private-public-password@public.example/?private-query#private-fragment');
    const handle = f.start(); await handle.ready;
    expect(f.stdout[0]).toContain(`intended-port=${f.port}`);
    if (mode === 'mismatch') expect(f.stdout[0]).toContain('intended-host=[withheld]');
    expect(f.stdout[1]).toContain(`port=${f.host!.daemon!.boundPort}`);
    expect(f.stderr).toEqual(mode === 'mismatch' ? ['[goodvibes-daemon] warning: control-plane client binding disagrees with the bound listener (derived-bind-mismatch).'] : []);
    expect([...f.stdout, ...f.stderr, ...f.fatal].join('\n')).not.toContain('private-');
  });
}

for (const host of ['user:private-password@127.0.0.1', 'http://user:private-password@localhost/path?private-query#private-fragment', 'localhost?private-query', 'localhost#private-fragment', 'localhost\nprivate-host']) {
  test('malformed configured host is withheld before acquisition', async () => {
    const f = await fixture();
    applyRuntimeConfigValue(f.configuration.config, 'controlPlane.hostMode', 'custom');
    applyRuntimeConfigValue(f.configuration.config, 'controlPlane.host', host);
    let handle!: DaemonProcessHandle;
    handle = f.start((line) => { f.stdout.push(line); void handle.shutdown(); });
    expect(await handle.finished).toBe(0); expect(await handle.ready).toBeUndefined();
    expect(f.stdout[0]).toContain('intended-host=[withheld]');
    expect(f.stdout.join('\n')).not.toContain('private-');
    expect(f.acquired()).toBe(0); expect(existsSync(f.tokenPath)).toBe(false);
  });
}
