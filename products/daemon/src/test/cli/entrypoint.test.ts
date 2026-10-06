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

const entrypoint = fileURLToPath(new URL('../../../dist/cli/entrypoint.js', import.meta.url));
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
  return { child, done, waitFor, root, home, cwd, output: () => ({ stdout, stderr, exited }),
    async close() { if (!exited) child.kill('SIGKILL'); await done; } };
}
async function oneShot(args: string[], root?: string) {
  const fixture = launch(args, false, root);
  try { return { code: await fixture.done, ...fixture.output(), root: fixture.root, home: fixture.home }; }
  finally { await fixture.close(); }
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
      expect(invoked.status).toBe(0); expect(invoked.stdout).toContain('goodvibes-daemon 1.28.25');
      expect(existsSync(join(root, '.goodvibes'))).toBe(false);
    }
  }
});

for (const args of [['--help'], ['help', 'config'], ['--version'], ['completion', 'bash'], ['provision-wake-model', '--help']]) {
  test(`built CLI handles ${args.join(' ')} without acquiring config or runtime`, async () => {
    const result = await oneShot(args);
    expect(result.code).toBe(0); expect(result.stdout.length).toBeGreaterThan(20);
    expect(result.stderr).toBe(''); expect(existsSync(join(result.home, '.goodvibes'))).toBe(false);
    expect(existsSync(join(result.root, 'daemon'))).toBe(false);
  });
}
for (const args of [['install-servce'], ['serve', '--port'], ['--resume'], ['provision-wake-model', '--typo'], ['help', 'unknown'], ['--daemon-home', 'elsewhere', 'webui', 'status']]) {
  test(`built CLI refuses invalid arguments ${args.join(' ')}`, async () => {
    const result = await oneShot(args);
    expect(result.code).toBe(2); expect(result.stderr.length).toBeGreaterThan(5);
    expect(result.stdout).toBe(''); expect(existsSync(join(result.home, '.goodvibes'))).toBe(false);
  });
}
for (const args of [[], ['serve'], ['install-service'], ['start-service'], ['restart-service'], ['migrate-service', '-y'], ['send', 'fixture', 'text']]) {
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
      expect(await fx.done).toBe(0); expect(fx.output().stdout).toContain('POLL_DRAINED');
      await expect(fetch(`http://127.0.0.1:${port}/api/status`)).rejects.toThrow();
      expect(readFileSync(join(root, 'daemon', 'settings.json'), 'utf8')).not.toContain(String(port));
    } finally { await fx.close(); }
  }, 30_000);
}

test('emitted launcher reports failed bind, drains its graph and leaves the existing listener alone', async () => {
  const lease = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('existing-owner') });
  const root = makeOwnedTempDir('daemon-cli-bind-failure');
  mkdirSync(join(root, 'daemon'), { recursive: true });
  writeFileSync(join(root, 'daemon', 'settings.json'), JSON.stringify({ cluster: { enabled: false }, relay: { enabled: false } }));
  const fx = launch(['serve', '--hostname', '127.0.0.1', '--port', String(lease.port)], true, root);
  try {
    expect(await fx.done).toBe(1);
    expect(fx.output().stderr).toContain('Daemon startup failed');
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
