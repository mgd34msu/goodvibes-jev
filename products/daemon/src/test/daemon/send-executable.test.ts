import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedTestEnvironment } from '@goodvibes-jev/engine/toolchain/test-runner';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const launcher = fileURLToPath(new URL('../../../bin/goodvibes-daemon', import.meta.url));
const preload = fileURLToPath(new URL('../../../../../packages/engine/toolchain/src/test-runner/test-network-preload.ts', import.meta.url));
const PRIVATE_TOKEN = 'synthetic-relocated-daemon-token';
const SECRET_KEY = 'GOODVIBES_SURFACES_NTFY_TOKEN';
function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data));
}
function launch(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) {
  // Invoke the package's actual installed launcher and emitted daemon code.
  // The same owned loopback-only guard as the test runner protects its child.
  const child = spawn(process.execPath, ['--no-env-file', '--preload', preload, launcher, ...args], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = ''; let finished = false;
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { finished = true; resolve(code); });
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  return { child, output: () => ({ stdout, stderr }),
    async result() { const code = await done; clearTimeout(timeout); return { code, stdout, stderr }; },
    async close() { clearTimeout(timeout); if (!finished) child.kill('SIGKILL'); await done; },
  };
}

test('emitted package sends arguments and stdin using only relocated daemon settings and secrets, with no daemon listener', async () => {
  const root = makeOwnedTempDir('daemon-send-executable');
  const work = join(root, 'work'); const tree = join(root, 'tree'); const daemon = join(root, 'relocated-daemon');
  for (const directory of [work, daemon, join(tree, '.goodvibes', 'daemon')]) mkdirSync(directory, { recursive: true });
  const env = isolatedTestEnvironment(process.env, root, {
    GOODVIBES_HOME: tree, GOODVIBES_DAEMON_HOME: daemon, GOODVIBES_WORKING_DIR: work, NO_COLOR: '1',
  });
  const calls: Array<{ path: string; method: string; body: string; authorization: string | null; title: string | null; click: string | null }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    calls.push({ path: new URL(request.url).pathname, method: request.method, body: await request.text(),
      authorization: request.headers.get('Authorization'), title: request.headers.get('Title'), click: request.headers.get('Click') });
    return Response.json({ id: 'synthetic-private-provider-response-id', body: 'synthetic-private-response-body' });
  } });
  const settings = {
    controlPlane: { gateway: true, enabled: true, host: '127.0.0.1', port: server.port },
    integrations: { routeBinding: true, deliveryTracking: true }, service: { enabled: true },
    storage: { secretPolicy: 'plaintext_allowed' },
    surfaces: { ntfy: { enabled: true, topic: 'synthetic-owned-topic', baseUrl: `http://127.0.0.1:${server.port}`,
      token: `goodvibes://secrets/goodvibes/${SECRET_KEY}` } },
  };
  writeJson(join(daemon, 'settings.json'), settings);
  writeJson(join(daemon, 'secrets.json'), { [SECRET_KEY]: PRIVATE_TOKEN });
  // A competing normal home proves the process did not derive a second secret
  // root or silently fall back to the usual daemon settings directory.
  writeJson(join(tree, '.goodvibes', 'daemon', 'settings.json'), { surfaces: { ntfy: { enabled: false, topic: 'wrong-default-topic' } } });
  writeJson(join(tree, '.goodvibes', 'daemon', 'secrets.json'), { [SECRET_KEY]: 'synthetic-wrong-default-token' });
  const originalSettings = readFileSync(join(daemon, 'settings.json'), 'utf8');
  const originalSecrets = readFileSync(join(daemon, 'secrets.json'), 'utf8');
  const children: ReturnType<typeof launch>[] = [];
  async function run(args: string[], input = '') {
    const child = launch(args, env, work); children.push(child); child.child.stdin.end(input);
    const result = await child.result();
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('send request accepted');
    for (const privateValue of [PRIVATE_TOKEN, 'synthetic-wrong-default-token', 'synthetic-private-provider-response-id',
      'synthetic-private-response-body', 'synthetic-owned-topic', 'synthetic-override-topic']) {
      expect(result.stdout).not.toContain(privateValue); expect(result.stderr).not.toContain(privateValue);
    }
    expect(result.stdout).not.toContain('host started');
  }
  try {
    // The configured daemon port is already occupied by the ntfy fixture.
    // Success while it remains bound proves send does not start a listener.
    await run(['send', 'synthetic argument', 'message', '--title', 'Argument title']);
    await run(['send', '--channel', 'ntfy', '--to', 'synthetic-override-topic', '--title=Stdin title'], 'synthetic first line\nsecond line\n');
    expect(calls).toEqual([
      { path: '/synthetic-owned-topic', method: 'POST', body: 'synthetic argument message', authorization: `Bearer ${PRIVATE_TOKEN}`, title: 'Argument title', click: null },
      { path: '/synthetic-override-topic', method: 'POST', body: 'synthetic first line\nsecond line', authorization: `Bearer ${PRIVATE_TOKEN}`, title: 'Stdin title', click: null },
    ]);
    expect(readFileSync(join(daemon, 'settings.json'), 'utf8')).toBe(originalSettings);
    expect(readFileSync(join(daemon, 'secrets.json'), 'utf8')).toBe(originalSecrets);
    const names = readdirSync(root, { recursive: true }).map(String).join('\n');
    expect(names).not.toMatch(/daemon-lifecycle|daemon-receipts|operator-tokens|detached-daemon|bootstrap/);
    expect(existsSync(join(env.HOME!, '.goodvibes'))).toBe(false);
  } finally {
    await Promise.all(children.map((child) => child.close()));
    await server.stop(true); rmSync(root, { recursive: true, force: true });
  }
}, 40_000);

test('emitted --list never needs to load an unreadable secret store or acquire delivery owners', async () => {
  const root = makeOwnedTempDir('daemon-send-list-executable'); const work = join(root, 'work'); const daemon = join(root, 'daemon');
  mkdirSync(work, { recursive: true }); mkdirSync(daemon, { recursive: true });
  const env = isolatedTestEnvironment(process.env, root, { GOODVIBES_HOME: join(root, 'tree'), GOODVIBES_DAEMON_HOME: daemon });
  writeJson(join(daemon, 'settings.json'), { surfaces: {
    googleChat: { enabled: true, webhookUrl: 'https://example.invalid/synthetic-private-hook?key=private' },
    webhook: { enabled: true, defaultTarget: 'goodvibes://secrets/goodvibes/SYNTHETIC_PRIVATE_WEBHOOK' },
  } });
  writeFileSync(join(daemon, 'secrets.json'), '{deliberately unreadable synthetic fixture');
  const child = launch(['send', '--list'], env, work); child.child.stdin.end();
  try {
    const result = await child.result();
    expect(result.code, result.stderr).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout).toContain('googleChat: on; webhook URL: [configured; withheld]');
    expect(result.stdout).toContain('webhook: on; URL: [configured; withheld]');
    expect(result.stdout).not.toContain('synthetic-private'); expect(result.stdout).not.toContain('SYNTHETIC_PRIVATE');
    expect(readdirSync(root, { recursive: true }).map(String).join('\n')).not.toContain('artifacts');
  } finally { await child.close(); rmSync(root, { recursive: true, force: true }); }
});
