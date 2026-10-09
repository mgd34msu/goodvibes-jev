import { expect, spyOn, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { runDaemonCli } from '../../cli/run.js';
import { createDaemonCliConfiguration } from '../../cli/configuration.js';
import { parseDaemonCli } from '../../cli/parser.js';
import { prepareDaemonCliServe } from '../../cli/serve.js';
import * as shell from '@goodvibes-jev/engine/terminal-shell';
import * as serviceCommands from '../../daemon/service-commands.js';
import * as wakeCommand from '../../daemon/provision-wake-model.js';

const entrypoint = fileURLToPath(new URL('../../../dist/cli/entrypoint.js', import.meta.url));
const packageVersion = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
function launch(args: string[], composed = false, root = makeOwnedTempDir('daemon-built-cli')) {
  const home = join(root, 'home'); const cwd = join(root, 'work');
  mkdirSync(home, { recursive: true }); mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, [composed
    ? fileURLToPath(new URL('../helpers/daemon-cli-child.ts', import.meta.url)) : entrypoint, ...args], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: join(root, 'daemon'),
      GOODVIBES_WORKING_DIR: cwd, XDG_CONFIG_HOME: join(root, 'xdg'),
      GOODVIBES_DAEMON_TOKEN: 'synthetic-cli-token', NO_COLOR: '1' },
  });
  let stdout = ''; let stderr = ''; let exited = false;
  const changes = new EventEmitter();
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); changes.emit('change'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { exited = true; changes.emit('change'); resolve(code); });
  });
  async function boundedExit(ceilingMs: number) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([done, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`CLI did not exit within ${ceilingMs}ms: ${stdout}\n${stderr}`)), ceilingMs);
      })]);
    } finally { clearTimeout(timeout); }
  }
  let cleanupFinished = false;
  async function close() {
    // An outer fixture finally must not replace an already reported exit and
    // cleanup failure with a second teardown failure.
    if (cleanupFinished) return;
    try {
      if (!exited) child.kill('SIGKILL');
      await boundedExit(5_000);
    } finally {
      cleanupFinished = true;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  }
  async function waitForExit(ceilingMs = 20_000) {
    let failure: unknown;
    try { return await boundedExit(ceilingMs); }
    catch (error) { failure = error; throw error; }
    finally {
      try { await close(); }
      catch (cleanupError) {
        if (failure !== undefined) throw new AggregateError([failure, cleanupError], 'CLI exit and cleanup failed', { cause: failure });
        throw cleanupError;
      }
    }
  }
  async function waitFor(text: string) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`Missing ${text}: ${stdout}\n${stderr}`)); }, 15_000);
      const cleanup = () => { clearTimeout(timeout); changes.off('change', check); };
      const check = () => {
        if (stdout.includes(text)) { cleanup(); resolve(); }
        else if (exited) { cleanup(); reject(new Error(`CLI exited: ${stdout}\n${stderr}`)); }
      };
      changes.on('change', check); check();
    });
  }
  return { child, waitForExit, waitFor, close, root, home, cwd, output: () => ({ stdout, stderr, exited }) };
}
async function oneShot(args: string[], root?: string) {
  const fixture = launch(args, false, root);
  return { code: await fixture.waitForExit(), ...fixture.output(), root: fixture.root, home: fixture.home };
}

test('emitted package entry retains the Bun shebang and canonical bin path', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { bin: Record<string, string> };
  expect(manifest.bin['goodvibes-daemon']).toBe('./bin/goodvibes-daemon');
  const launcher = fileURLToPath(new URL('../../../bin/goodvibes-daemon', import.meta.url));
  if (process.platform !== 'win32') expect(statSync(launcher).mode & 0o111).toBe(0o111);
  expect(readFileSync(entrypoint, 'utf8').startsWith('#!/usr/bin/env bun\n')).toBe(true);
  const lock = Bun.JSONC.parse(readFileSync(new URL('../../../../../bun.lock', import.meta.url), 'utf8')) as { workspaces: Record<string, { bin?: Record<string, string> }> };
  expect(lock.workspaces['products/daemon']?.bin).toEqual(manifest.bin);
  for (const consumer of ['agent', 'tui']) {
    const bin = fileURLToPath(new URL(`../../../../${consumer}/node_modules/.bin/goodvibes-daemon`, import.meta.url));
    expect(realpathSync(bin)).toBe(realpathSync(launcher));
    if (process.platform !== 'win32') {
      const root = makeOwnedTempDir('daemon-cli-bin-link');
      const invoked = spawnSync(bin, ['--version'], { timeout: 10_000, encoding: 'utf8',
        env: { ...process.env, HOME: root, GOODVIBES_HOME: root, GOODVIBES_DAEMON_HOME: join(root, 'daemon') } });
      expect(invoked.error).toBeUndefined(); expect(invoked.signal).toBeNull();
      expect(invoked.status).toBe(0); expect(invoked.stdout).toBe(`goodvibes-daemon ${packageVersion}\n`);
      expect(existsSync(join(root, '.goodvibes'))).toBe(false);
    }
  }
});

for (const [args, expected] of [
  [['--help'], 'Usage: goodvibes-daemon [COMMAND] [OPTIONS]'],
  [['help', 'config'], 'Usage: goodvibes-daemon config list|get <key>|set <key> <value>|unset <key>'],
  [['help', 'sessions'], 'Usage: goodvibes-daemon sessions list|kill <id>'],
  [['--version'], `goodvibes-daemon ${packageVersion}\n`],
  [['completion', 'bash'], 'complete -F _goodvibes_daemon_complete goodvibes-daemon'],
  [['provision-wake-model', '--help'], 'Usage: goodvibes-daemon provision-wake-model'],
] as const) {
  test(`built CLI handles ${args.join(' ')} without acquiring config or runtime`, async () => {
    const result = await oneShot([...args]);
    expect(result.code).toBe(0); expect(result.stdout).toContain(expected);
    if (args[0] === '--version') expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe(''); expect(existsSync(join(result.home, '.goodvibes'))).toBe(false);
    expect(existsSync(join(result.root, 'daemon'))).toBe(false);
  });
}
for (const [args, expected] of [
  [['install-servce'], ['Unknown command: install-servce', 'Usage: goodvibes-daemon [COMMAND] [OPTIONS]']],
  [['serve', '--port'], ['--port', 'Usage: goodvibes-daemon [COMMAND] [OPTIONS]']],
  [['--resume'], ['--resume', 'Usage: goodvibes-daemon [COMMAND] [OPTIONS]']],
  [['provision-wake-model', '--typo'], ['Usage: goodvibes-daemon provision-wake-model [--strict] [--help]']],
  [['help', 'doctor'], ['Unknown command: doctor\n']],
  [['--daemon-home', 'elsewhere', 'webui', 'status'], ['`webui` has to be the first argument: goodvibes-daemon webui']],
  [['--daemon-home', 'elsewhere', 'send', 'hello'], ['`send` has to be the first argument: goodvibes-daemon send']],
] as const) {
  test(`built CLI refuses invalid arguments ${args.join(' ')}`, async () => {
    const result = await oneShot([...args]);
    expect(result.code).toBe(2);
    for (const text of expected) expect(result.stderr).toContain(text);
    if (args[0] === 'help') expect(result.stderr).toBe(expected[0]);
    expect(result.stdout).toBe(''); expect(existsSync(join(result.home, '.goodvibes'))).toBe(false);
    expect(existsSync(join(result.root, 'daemon'))).toBe(false);
    expect(existsSync(join(result.root, 'work', 'elsewhere'))).toBe(false);
  });
}
for (const args of [['install-service'], ['start-service'], ['restart-service'], ['migrate-service', '-y']]) {
  test(`uncomposed built CLI refuses ${args.join(' ') || 'bare serve'} before files or service work`, async () => {
    const result = await oneShot(args);
    expect(result.code).toBe(2); expect(result.stderr).toMatch(/composition|not been migrated/);
    expect(existsSync(join(result.home, '.goodvibes'))).toBe(false);
    expect(existsSync(join(result.root, 'daemon'))).toBe(false);
  });
}

test('built config dispatcher awaits receipts and persists the selected daemon tier across processes', async () => {
  const root = makeOwnedTempDir('daemon-cli-config');
  const written = await oneShot(['--daemon-home', 'custom-daemon', 'config', 'set', 'controlPlane.port', '43129'], root);
  expect(written.code).toBe(0); expect(written.stdout).toContain('43129');
  const path = join(root, 'work', 'custom-daemon', 'settings.json');
  expect(readFileSync(path, 'utf8')).toContain('43129');
  expect(existsSync(join(root, 'daemon', 'settings.json'))).toBe(false);
  const read = await oneShot(['--daemon-home', 'custom-daemon', 'config', 'get', 'controlPlane.port', '--json'], root);
  expect(read.code).toBe(0); expect(read.stdout).toContain('43129'); expect(read.stdout).not.toContain('[object Promise]');
});

test('CLI errors from caller-owned output/config ports never render exception values', async () => {
  const lines: string[] = [];
  expect(await runDaemonCli(['--version'], { stdout() { throw new Error('PRIVATE_OUTPUT_VALUE'); }, stderr: (line) => { lines.push(line); } })).toBe(1);
  expect(lines).toEqual(['Daemon command failed']);
});

test('shipped emitted entrypoint serves complete fresh-install inbox membership without injected adapters', async () => {
  const lease = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('lease') });
  const port = lease.port!; await lease.stop(true);
  const root = makeOwnedTempDir('daemon-production-serving');
  mkdirSync(join(root, 'daemon'), { recursive: true });
  writeFileSync(join(root, 'daemon', 'settings.json'), JSON.stringify({ cluster: { enabled: false }, relay: { enabled: false } }));
  const fx = launch(['serve', '--hostname', '127.0.0.1', '--port', String(port)], false, root);
  try {
    await fx.waitFor('host started');
    const response = await fetch(`http://127.0.0.1:${port}/api/channels/inbox`, { headers: { Authorization: 'Bearer synthetic-cli-token' } });
    expect(response.status).toBe(200);
    const receipt = await response.json() as { providers?: unknown; data?: { providers?: unknown } };
    const providers = receipt.providers ?? receipt.data?.providers;
    expect(providers).toEqual(['slack', 'discord', 'email'].map(provider => ({ provider,
      state: 'unconfigured', configured: false, syncing: false, itemCount: 0, storedCount: 0 })));
    expect(fx.child.kill('SIGTERM')).toBe(true);
    expect(await fx.waitForExit()).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/api/channels/inbox`)).rejects.toThrow();
  } finally { await fx.close(); }
}, 30_000);

test('shipped entrypoint refuses configured provider intake without trusted account admission', async () => {
  const root = makeOwnedTempDir('daemon-production-refusal');
  mkdirSync(join(root, 'daemon'), { recursive: true });
  writeFileSync(join(root, 'daemon', 'settings.json'), JSON.stringify({ cluster: { enabled: false }, relay: { enabled: false },
    surfaces: { slack: { enabled: true } } }));
  const result = await oneShot(['serve', '--hostname', '127.0.0.1', '--port', '41379'], root);
  expect(result.code).toBe(1); expect(result.stdout).not.toContain('host started');
}, 30_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`emitted explicit launcher serves real loopback contracts and awaits inbox drainage on ${signal}`, async () => {
    const lease = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('lease') });
    const port = lease.port!; await lease.stop(true);
    const root = makeOwnedTempDir('daemon-cli-serving');
    mkdirSync(join(root, 'daemon'), { recursive: true });
    writeFileSync(join(root, 'daemon', 'settings.json'), JSON.stringify({ cluster: { enabled: false }, relay: { enabled: false } }));
    const fx = launch(['serve', '--hostname', '127.0.0.1', '--port', String(port)], true, root);
    try {
      await fx.waitFor('host started');
      const response = await fetch(`http://127.0.0.1:${port}/api/channels/inbox`, { headers: { Authorization: 'Bearer synthetic-cli-token' } });
      expect(response.status).toBe(200); const body = await response.text();
      expect(body).toContain('fixture'); expect(body).toContain('Synthetic subject');
      const status = await oneShot(['status', '--host', '127.0.0.1', '--port', String(port), '--token', 'synthetic-cli-token', '--json'], root);
      expect(status.code).toBe(0); expect(status.stdout).not.toContain('Daemon command failed');
      fx.child.stdin.write('hold\n'); await fx.waitFor('POLL_HELD');
      expect(fx.child.kill(signal)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(fx.output().exited).toBe(false);
      fx.child.stdin.write('release\n');
      expect(await fx.waitForExit()).toBe(0); expect(fx.output().stdout).toContain('POLL_DRAINED');
      await expect(fetch(`http://127.0.0.1:${port}/api/status`)).rejects.toThrow();
      expect(readFileSync(join(root, 'daemon', 'settings.json'), 'utf8')).not.toContain(String(port));
    } finally { await fx.close(); }
  }, 30_000);
}

test('CLI test deadline kills and reaps an interrupted child held in shutdown', async () => {
  const lease = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('lease') });
  const port = lease.port!; await lease.stop(true);
  const root = makeOwnedTempDir('daemon-cli-deadline');
  mkdirSync(join(root, 'daemon'), { recursive: true });
  writeFileSync(join(root, 'daemon', 'settings.json'), JSON.stringify({ cluster: { enabled: false }, relay: { enabled: false } }));
  const fx = launch(['serve', '--hostname', '127.0.0.1', '--port', String(port)], true, root);
  try {
    await fx.waitFor('host started');
    fx.child.stdin.write('hold\n'); await fx.waitFor('POLL_HELD');
    expect(fx.child.kill('SIGTERM')).toBe(true);
    // The poll deliberately never releases. This ceiling belongs to the test
    // owner, independently of the production graceful-shutdown deadline.
    await expect(fx.waitForExit(100)).rejects.toThrow('CLI did not exit within 100ms');
    expect(fx.output().exited).toBe(true);
    expect(fx.child.signalCode).toBe('SIGKILL');
    expect(fx.output().stdout).not.toContain('POLL_DRAINED');
    expect(() => process.kill(fx.child.pid!, 0)).toThrow();
    await expect(fetch(`http://127.0.0.1:${port}/api/status`)).rejects.toThrow();
  } finally { await fx.close(); }
}, 30_000);

test('emitted launcher reports failed bind, drains its graph and leaves the existing listener alone', async () => {
  const lease = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('existing-owner') });
  const root = makeOwnedTempDir('daemon-cli-bind-failure');
  mkdirSync(join(root, 'daemon'), { recursive: true });
  writeFileSync(join(root, 'daemon', 'settings.json'), JSON.stringify({ cluster: { enabled: false }, relay: { enabled: false } }));
  const fx = launch(['serve', '--hostname', '127.0.0.1', '--port', String(lease.port)], true, root);
  try {
    expect(await fx.waitForExit()).toBe(1);
    expect(fx.output().stderr).toContain('Daemon startup failed');
    expect(fx.output().stdout).toContain(`intended-port=${lease.port}`);
    expect(fx.output().stdout).not.toContain(' bound:');
    expect(fx.output().stdout).not.toContain('host started');
    expect(await (await fetch(`http://127.0.0.1:${lease.port}`)).text()).toBe('existing-owner');
  } finally { await fx.close(); await lease.stop(true); }
});

for (const flag of ['--enable', '--disable']) {
  test(`explicit launcher refuses invalid ${flag} before acquiring its runtime`, async () => {
    const root = makeOwnedTempDir('daemon-cli-feature-refusal');
    const stderr: string[] = [];
    let inboxAcquisitions = 0;
    const code = await runDaemonCli(['serve', flag, 'unknown-fixture-feature'], {
      env: { HOME: root, GOODVIBES_HOME: root }, cwd: root,
      runtime: { inboxFactory() { inboxAcquisitions++; throw new Error('Must not acquire'); } },
      process: { process: { on() {}, off() {}, exit() {} } },
      stdout() { throw new Error('Must not report startup'); }, stderr: (line) => { stderr.push(line); },
    });
    expect(code).toBe(2); expect(stderr.join('\n')).toContain('unknown feature id');
    expect(inboxAcquisitions).toBe(0);
  });
}

test('custom daemon identity receives the legacy migration and does not seed the default tier', async () => {
  const root = makeOwnedTempDir('daemon-cli-selected-migration');
  const legacy = join(root, 'home', '.goodvibes', 'tui');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'settings.json'), JSON.stringify({ controlPlane: { port: 43129 } }));
  const read = await oneShot(['--daemon-home', 'selected', 'config', 'get', 'controlPlane.port', '--json'], root);
  expect(read.code).toBe(0); expect(read.stdout).toContain('43129');
  expect(readFileSync(join(root, 'work', 'selected', 'settings.json'), 'utf8')).toContain('43129');
  expect(existsSync(join(root, 'home', '.goodvibes', 'daemon', 'settings.json'))).toBe(false);
});

for (const [flags, expected] of [
  [['--provider', 'openai', '--model', 'anthropic:fixture-model'], 'openai:fixture-model'],
  [['--model', 'anthropic:fixture-model', '--provider', 'openai'], 'openai:fixture-model'],
  [['--model', 'openai/fixture-model'], 'openai:fixture-model'],
  [['--provider', 'openai', '--model', 'anthropic/fixture-model'], 'openai:fixture-model'],
  [['--model', 'openrouter:namespace/model:revision'], 'openrouter:namespace/model:revision'],
] as const) {
  test(`model identity reaches runtime config for ${flags.join(' ')}`, () => {
    const root = makeOwnedTempDir('daemon-cli-provider');
    const parsed = parseDaemonCli(['serve', ...flags]);
    const { config } = createDaemonCliConfiguration(parsed.flags, { HOME: root }, root);
    expect(prepareDaemonCliServe(config, parsed.flags)).toEqual([]);
    expect(config.get('provider.model')).toBe(expected);
  });
}

test('known capabilities without a switch refuse before serving', () => {
  const root = makeOwnedTempDir('daemon-cli-unswitchable');
  const parsed = parseDaemonCli(['serve', '--disable', 'fetch-sanitization']);
  const { config } = createDaemonCliConfiguration(parsed.flags, { HOME: root }, root);
  expect(prepareDaemonCliServe(config, parsed.flags).join('\n')).toContain('no off switch');
});

for (const command of ['install-service', 'start-service', 'restart-service', 'migrate-service']) {
  test(`composed ${command} refuses home overrides before service mutations`, async () => {
    const root = makeOwnedTempDir('daemon-cli-service-homes');
    const stderr: string[] = [];
    const code = await runDaemonCli([command], {
      env: { HOME: root, GOODVIBES_DAEMON_HOME: join(root, 'selected') }, cwd: root,
      runtime: { inboxFactory() { throw new Error('Must not acquire'); } },
      serviceBinaryPath: '/synthetic-installed-daemon', stdout() {}, stderr: (line) => { stderr.push(line); },
    });
    expect(code).toBe(2); expect(stderr.join('\n')).toContain('overridden tree or daemon homes');
    expect(existsSync(join(root, '.goodvibes'))).toBe(false);
  });
}

test('cluster clipboard output is emitted byte-for-byte without a second escape', async () => {
  const root = makeOwnedTempDir('daemon-cli-cluster-output');
  const rawOutput = '\u001b]52;c;U1lOVEhFVElD\u0007';
  const command = spyOn(shell, 'runClusterCommand').mockResolvedValue({ exitCode: 0, lines: [], rawOutput });
  const lines: string[] = [];
  try {
    expect(await runDaemonCli(['cluster', 'key', '--copy'], { env: { HOME: root }, cwd: root,
      stdout: (line) => { lines.push(line); }, stderr() { throw new Error('No refusal expected'); } })).toBe(0);
    expect(lines).toEqual([rawOutput]);
  } finally { command.mockRestore(); }
});

test('fresh frozen workspace install links the launcher before compiled output exists', () => {
  const root = makeOwnedTempDir('daemon-cli-frozen-order');
  const daemon = join(root, 'packages', 'daemon');
  const consumer = join(root, 'packages', 'consumer');
  mkdirSync(join(daemon, 'bin'), { recursive: true }); mkdirSync(consumer, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cli-link-fixture', private: true, workspaces: ['packages/*'] }));
  writeFileSync(join(daemon, 'package.json'), JSON.stringify({ name: '@fixture/daemon', version: '1.0.0', bin: { 'fixture-daemon': 'bin/goodvibes-daemon' } }));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: '@fixture/consumer', version: '1.0.0', dependencies: { '@fixture/daemon': 'workspace:*' } }));
  const launcher = join(daemon, 'bin', 'goodvibes-daemon');
  writeFileSync(launcher, readFileSync(new URL('../../../bin/goodvibes-daemon', import.meta.url)), { mode: 0o755 });
  const env = { ...process.env, HOME: root, BUN_INSTALL_CACHE_DIR: join(root, 'cache') };
  for (const flag of ['--lockfile-only', '--frozen-lockfile']) {
    const install = spawnSync(process.execPath, ['install', flag, '--ignore-scripts'], { cwd: root, env, timeout: 15_000, encoding: 'utf8' });
    expect({ code: install.status, error: install.error?.message }).toEqual({ code: 0, error: undefined });
  }
  const link = join(consumer, 'node_modules', '.bin', 'fixture-daemon');
  expect(realpathSync(link)).toBe(launcher);
  expect(existsSync(join(daemon, 'dist'))).toBe(false);
  // Only link/emission order is under test here; actual runtime proof is above.
  mkdirSync(join(daemon, 'dist', 'cli'), { recursive: true });
  writeFileSync(join(daemon, 'dist', 'cli', 'entrypoint.js'), 'console.log("compiled-fixture-reached");\n', { mode: 0o644 });
  const invoked = spawnSync(process.execPath, [link], { cwd: root, env, timeout: 10_000, encoding: 'utf8' });
  expect(invoked.status).toBe(0); expect(invoked.stdout.trim()).toBe('compiled-fixture-reached');
});

for (const exitCode of [3, 4]) {
  test(`service-status exit ${exitCode} preserves its JSON receipt on stdout`, async () => {
    const root = makeOwnedTempDir('daemon-cli-service-receipt');
    const receipt = JSON.stringify({ installed: exitCode === 3, running: false });
    const run = spyOn(serviceCommands, 'runDaemonServiceCli').mockResolvedValue({
      ok: true, exitCode, lines: [receipt], status: { platform: 'manual', installed: exitCode === 3, running: false, path: '',
        serviceName: 'fixture', autostart: false, commandPreview: 'fixture', suggestedCommands: [] },
    });
    const stdout: string[] = []; const stderr: string[] = [];
    try {
      expect(await runDaemonCli(['service-status', '--json'], { env: { HOME: root }, cwd: root,
        stdout: (line) => { stdout.push(line); }, stderr: (line) => { stderr.push(line); } })).toBe(exitCode);
      expect(stdout).toEqual([receipt]); expect(stderr).toEqual([]);
    } finally { run.mockRestore(); }
  });
}

test('strict wake-provisioning degradation keeps its receipt on stdout without downloading', async () => {
  const root = makeOwnedTempDir('daemon-cli-wake-receipt');
  const run = spyOn(wakeCommand, 'runProvisionWakeModelCommand').mockResolvedValue({ exitCode: 1, lines: ['wake-word model: synthetic degraded receipt'] });
  const stdout: string[] = []; const stderr: string[] = [];
  try {
    expect(await runDaemonCli(['provision-wake-model', '--strict'], { env: { HOME: root }, cwd: root,
      stdout: (line) => { stdout.push(line); }, stderr: (line) => { stderr.push(line); } })).toBe(1);
    expect(stdout).toEqual(['wake-word model: synthetic degraded receipt']); expect(stderr).toEqual([]);
  } finally { run.mockRestore(); }
});
