import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { runDaemonCli } from '../../cli/run.js';

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
  expect(manifest.bin['goodvibes-daemon']).toBe('./dist/cli/entrypoint.js');
  expect(readFileSync(entrypoint, 'utf8').startsWith('#!/usr/bin/env bun\n')).toBe(true);
});

for (const args of [['--help'], ['help', 'config'], ['--version'], ['completion', 'bash']]) {
  test(`built CLI handles ${args.join(' ')} without acquiring config or runtime`, async () => {
    const result = await oneShot(args);
    expect(result.code).toBe(0); expect(result.stdout.length).toBeGreaterThan(20);
    expect(result.stderr).toBe(''); expect(existsSync(join(result.home, '.goodvibes'))).toBe(false);
    expect(existsSync(join(result.root, 'daemon'))).toBe(false);
  });
}
for (const args of [['install-servce'], ['serve', '--port'], ['--resume'], ['help', 'unknown'], ['--daemon-home', 'elsewhere', 'webui', 'status']]) {
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
