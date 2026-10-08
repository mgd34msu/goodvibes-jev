/** Owned HTTPS proof for the emitted CLI. WSS remains a separate transport. */
import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalNetworkTransportInstaller } from '@goodvibes-jev/engine/sdk/platform/runtime/transport';
import { createDaemonCliConfiguration } from '../../cli/configuration.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const entrypoint = fileURLToPath(new URL('../../../dist/cli/entrypoint.js', import.meta.url));
const emittedRun = new URL('../../../dist/cli/run.js', import.meta.url).href;
const guard = fileURLToPath(new URL('../../../../../packages/engine/scripts/test-network-preload.ts', import.meta.url));
const TOKEN = 'owned-https-synthetic-operator-token';
const RELATIVE_CA = 'certs/owned-ca.pem';
type TrustMode = 'custom' | 'bundled+custom' | 'bundled';
type Result = { code: number | null; stdout: string; stderr: string };

function certificate(root: string, name: string) {
  const cert = join(root, `${name}-cert.pem`); const key = join(root, `${name}-key.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
  { stdio: 'ignore', timeout: 10_000 });
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
}

function httpsFixture() {
  const root = makeOwnedTempDir('daemon-remote-http-trust');
  const credentials = certificate(root, 'server');
  const requests: Array<{ path: string; method: string; authorization: string | null }> = [];
  let beforeReply: (() => Promise<void>) | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, tls: credentials,
    async fetch(request): Promise<Response> {
      const path = new URL(request.url).pathname;
      requests.push({ path, method: request.method, authorization: request.headers.get('authorization') });
      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) return new Response('Unauthorized', { status: 401 });
      if (path === '/status') {
        await beforeReply?.();
        return Response.json({ status: 'running', version: 'owned-https-version', cluster: { enabled: false } });
      }
      if (path === '/api/health') return Response.json({ overall: 'healthy', network: {
        controlPlane: { host: '127.0.0.1', port: server.port, scheme: 'https', ready: true },
      } });
      if (path === '/api/channels/status') return Response.json({ channels: [{ id: 'owned-channel', state: 'ready', enabled: true }] });
      if (path === '/api/cluster/status') return Response.json({ ok: true, data: { membership: 'no-group', nodeName: 'owned-node' } });
      return new Response('No fixture route', { status: 404 });
    },
  });
  return { root, credentials, requests, port: server.port!,
    holdReplies(callback: () => Promise<void>) { beforeReply = callback; },
    async close() { await server.stop(true); },
  };
}

function configuration(f: ReturnType<typeof httpsFixture>, name: string, mode: TrustMode = 'custom', ca: string | null = f.credentials.cert) {
  const root = join(f.root, name); const home = join(root, 'os-home'); const tree = join(root, 'selected-tree');
  const cwd = join(root, 'work'); const daemon = join(cwd, 'selected-daemon');
  const configDir = join(tree, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT);
  const envDaemon = join(root, 'env-daemon');
  for (const directory of [home, cwd, daemon, configDir, envDaemon]) mkdirSync(directory, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GOODVIBES_HOME: tree, GOODVIBES_DAEMON_HOME: envDaemon,
    GOODVIBES_WORKING_DIR: cwd, XDG_CONFIG_HOME: join(root, 'xdg'), NO_COLOR: '1' };
  delete env.GOODVIBES_DAEMON_TOKEN; delete env.GOODVIBES_HTTP_TOKEN;
  // Ambient machine trust must never make this synthetic certificate valid.
  for (const key of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) delete env[key];
  const settings = join(configDir, 'settings.json'); const daemonSettings = join(daemon, 'settings.json');
  writeFileSync(settings, JSON.stringify({ network: { outboundTls: {
    mode, customCaFile: RELATIVE_CA, customCaDir: '', allowInsecureLocalhost: false,
  } } }, null, 2));
  writeFileSync(daemonSettings, JSON.stringify({ controlPlane: {
    hostMode: 'local', host: '127.0.0.1', port: f.port, tls: { mode: 'direct' },
  } }, null, 2));
  const token = join(daemon, 'operator-tokens.json');
  writeFileSync(token, JSON.stringify({ token: TOKEN, peerId: 'owned-peer', createdAt: 1 }, null, 2));
  if (ca !== null) {
    mkdirSync(join(configDir, 'certs'), { recursive: true });
    writeFileSync(join(configDir, RELATIVE_CA), ca);
  }
  // Config migration is a separate existing behavior. Establish its settled
  // state before checking that these read commands preserve settings bytes.
  const config = createDaemonCliConfiguration({ daemonHome: 'selected-daemon', workingDir: undefined }, env, cwd);
  expect(config.config.getControlPlaneConfigDir()).toBe(configDir);
  const receipts = join(configDir, 'control-plane', 'daemon-receipts.json');
  mkdirSync(join(configDir, 'control-plane'), { recursive: true });
  writeFileSync(receipts, JSON.stringify([{ id: 'owned-receipt', text: 'Owned update receipt', at: 1_700_000_000_000 }]));
  const unchanged = new Map([settings, daemonSettings, token, receipts].map((path) => [path, readFileSync(path)]));
  return { root, home, tree, cwd, daemon, envDaemon, configDir, env, config,
    args(command: 'status' | 'update') { return ['--daemon-home', 'selected-daemon', command, ...(command === 'update' ? ['--check'] : []), '--json']; },
    assertUnchanged() { for (const [path, bytes] of unchanged) expect(readFileSync(path)).toEqual(bytes); },
    track(path: string) { unchanged.set(path, readFileSync(path)); },
  };
}

async function cli(c: ReturnType<typeof configuration>, command: 'status' | 'update'): Promise<Result> {
  const child = spawn(process.execPath, ['--preload', guard, entrypoint, ...c.args(command)], {
    cwd: c.cwd, env: c.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = ''; let exited = false;
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { exited = true; resolve(code); });
  });
  void done.catch(() => {});
  async function boundedExit(timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([done, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`HTTPS CLI did not exit within ${timeoutMs}ms: ${stdout}\n${stderr}`)), timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  try { return { code: await boundedExit(20_000), stdout, stderr }; }
  finally {
    if (!exited) child.kill('SIGKILL');
    try { await boundedExit(5_000); }
    finally { child.stdout.destroy(); child.stderr.destroy(); }
  }
}

async function programmatic(c: ReturnType<typeof configuration>, command: 'status' | 'update'): Promise<Result> {
  const { runDaemonCli } = await import(emittedRun) as typeof import('../../cli/run.js');
  const stdout: string[] = []; const stderr: string[] = [];
  const code = await runDaemonCli(c.args(command), { env: c.env, cwd: c.cwd,
    stdout: (line) => { stdout.push(line); }, stderr: (line) => { stderr.push(line); },
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function successfulStatus(result: Result, port: number) {
  expect(result, result.stderr).toMatchObject({ code: 0, stderr: '' });
  const receipt = JSON.parse(result.stdout);
  expect(receipt).toMatchObject({ ok: true, data: {
    target: `https://127.0.0.1:${port}`, isLocal: true,
    identity: { status: 'running', version: 'owned-https-version' },
    health: { overall: 'healthy', network: { controlPlane: { scheme: 'https', port, ready: true } } },
    channels: { channels: [{ id: 'owned-channel', state: 'ready' }] },
    cluster: { membership: 'no-group', nodeName: 'owned-node' },
  } });
  // This slice changes HTTPS fetch only. It must not claim the WSS query worked.
  expect(receipt.data.hostedSessions.error).toBeString();
  expect(receipt.data.hostedSessions.count).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain(TOKEN);
}

function successfulUpdate(result: Result, port: number) {
  expect(result, result.stderr).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: {
    target: `https://127.0.0.1:${port}`, isLocal: true, version: 'owned-https-version',
    checkRequested: true, checkVerbAvailable: false,
    local: { receipts: [{ id: 'owned-receipt', text: 'Owned update receipt', at: 1_700_000_000_000 }], rolledBack: false },
  } });
  expect(result.stdout + result.stderr).not.toContain(TOKEN);
}

function rejected(result: Result) {
  expect(result).toMatchObject({ code: 1, stdout: '' });
  expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: 'could not reach the daemon on this machine' });
  expect(result.stdout + result.stderr).not.toContain(TOKEN);
}

test('emitted status trusts the selected custom CA for every HTTP document, with WSS reported separately', async () => {
  const f = httpsFixture();
  try {
    const c = configuration(f, 'valid-custom');
    successfulStatus(await cli(c, 'status'), f.port);
    expect(f.requests.map((request) => request.path).sort()).toEqual(['/api/channels/status', '/api/cluster/status', '/api/health', '/status']);
    expect(f.requests.every((request) => request.method === 'GET' && request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    c.assertUnchanged();
  } finally { await f.close(); }
}, 30_000);

for (const mode of ['custom', 'bundled+custom'] as const) {
  test(`emitted update --check reads receipts with ${mode} CA trust and leaves them unconsumed`, async () => {
    const f = httpsFixture();
    try {
      const c = configuration(f, `valid-${mode}`, mode);
      successfulUpdate(await cli(c, 'update'), f.port);
      expect(f.requests).toEqual([{ path: '/status', method: 'GET', authorization: `Bearer ${TOKEN}` }]);
      c.assertUnchanged();
    } finally { await f.close(); }
  }, 30_000);
}

for (const policy of ['missing', 'wrong', 'bundled-only'] as const) {
  test(`emitted status and update reject ${policy} CA without disabling verification`, async () => {
    const f = httpsFixture();
    try {
      const ca = policy === 'missing' ? null : policy === 'wrong' ? certificate(f.root, 'wrong').cert : f.credentials.cert;
      const c = configuration(f, policy, policy === 'bundled-only' ? 'bundled' : 'custom', ca);
      for (const command of ['status', 'update'] as const) rejected(await cli(c, command));
      expect(f.requests).toHaveLength(0);
      c.assertUnchanged();
    } finally { await f.close(); }
  }, 30_000);
}

test('relative CA belongs to the selected tree and operator token belongs to the selected daemon home', async () => {
  const f = httpsFixture();
  try {
    const c = configuration(f, 'selected-home');
    const wrongCa = certificate(f.root, 'decoy').cert;
    for (const root of [c.cwd, c.daemon, c.envDaemon, join(c.home, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT)]) {
      mkdirSync(join(root, 'certs'), { recursive: true });
      const ca = join(root, RELATIVE_CA); writeFileSync(ca, wrongCa); c.track(ca);
    }
    for (const root of [c.envDaemon, join(c.home, '.goodvibes', 'daemon')]) {
      mkdirSync(root, { recursive: true });
      const token = join(root, 'operator-tokens.json');
      writeFileSync(token, JSON.stringify({ token: 'owned-decoy-token' })); c.track(token);
      const settings = join(root, 'settings.json');
      writeFileSync(settings, JSON.stringify({ controlPlane: { port: 1 } })); c.track(settings);
    }
    successfulStatus(await cli(c, 'status'), f.port);
    successfulUpdate(await cli(c, 'update'), f.port);
    expect(f.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    c.assertUnchanged();
  } finally { await f.close(); }
}, 30_000);

test('a correct decoy CA cannot rescue an invalid CA in the selected tree', async () => {
  const f = httpsFixture();
  try {
    const c = configuration(f, 'invalid-selected-home', 'custom', certificate(f.root, 'wrong-selected').cert);
    for (const root of [c.cwd, c.daemon, c.envDaemon, join(c.home, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT)]) {
      mkdirSync(join(root, 'certs'), { recursive: true });
      const path = join(root, RELATIVE_CA); writeFileSync(path, f.credentials.cert); c.track(path);
    }
    for (const command of ['status', 'update'] as const) rejected(await cli(c, command));
    expect(f.requests).toHaveLength(0); c.assertUnchanged();
  } finally { await f.close(); }
}, 30_000);

test('sequential emitted programmatic CLI configurations preserve ambient fetch and do not retain trust', async () => {
  const f = httpsFixture(); const originalFetch = globalThis.fetch;
  try {
    const trusted = configuration(f, 'sequence-custom'); const strict = configuration(f, 'sequence-bundled', 'bundled');
    f.holdReplies(async () => { expect(globalThis.fetch).toBe(originalFetch); });
    successfulUpdate(await programmatic(trusted, 'update'), f.port);
    expect(globalThis.fetch).toBe(originalFetch);
    rejected(await programmatic(strict, 'update'));
    expect(globalThis.fetch).toBe(originalFetch);
    successfulStatus(await programmatic(trusted, 'status'), f.port);
    expect(globalThis.fetch).toBe(originalFetch);
    rejected(await programmatic(strict, 'status'));
    expect(globalThis.fetch).toBe(originalFetch);
    await expect(originalFetch(`https://127.0.0.1:${f.port}/status`)).rejects.toThrow();
    trusted.assertUnchanged(); strict.assertUnchanged();
  } finally { globalThis.fetch = originalFetch; await f.close(); }
}, 30_000);

test('concurrent emitted programmatic CLI configurations keep separate CA authorities and ambient fetch', async () => {
  const a = httpsFixture(); const b = httpsFixture(); const originalFetch = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const bothReached = new Promise<void>((resolve) => { reached = resolve; });
  let arrivals = 0;
  const pending: Array<Promise<Result>> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ca = configuration(a, 'concurrent-a'); const cb = configuration(b, 'concurrent-b');
    const wrongA = configuration(a, 'crossed-a', 'custom', b.credentials.cert);
    const wrongB = configuration(b, 'crossed-b', 'custom', a.credentials.cert);
    const bundled = configuration(a, 'concurrent-bundled', 'bundled');
    for (const f of [a, b]) f.holdReplies(async () => {
      expect(globalThis.fetch).toBe(originalFetch);
      if (++arrivals === 2) reached();
      await gate;
    });
    pending.push(programmatic(ca, 'status'), programmatic(cb, 'update'));
    await Promise.race([bothReached, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Both independently trusted HTTPS calls must be in flight')), 10_000);
    })]);
    clearTimeout(timer);
    expect(globalThis.fetch).toBe(originalFetch);
    // Probe strict configurations while both successful calls still own their
    // HTTP requests, so a temporary global install cannot pass unnoticed.
    const probes = [
      programmatic(wrongA, 'update'), programmatic(wrongB, 'update'), programmatic(bundled, 'update'),
    ];
    pending.push(...probes);
    const denied = await Promise.race([Promise.all(probes), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Untrusted configurations must reject while trusted calls are held')), 10_000);
    })]);
    clearTimeout(timer);
    for (const result of denied) rejected(result);
    expect(globalThis.fetch).toBe(originalFetch);
    release();
    const [status, update] = await Promise.all(pending.slice(0, 2));
    successfulStatus(status!, a.port); successfulUpdate(update!, b.port);
    expect(globalThis.fetch).toBe(originalFetch);
    for (const c of [ca, cb, wrongA, wrongB, bundled]) c.assertUnchanged();
  } finally {
    clearTimeout(timer); release();
    await Promise.allSettled(pending);
    globalThis.fetch = originalFetch;
    await Promise.all([a.close(), b.close()]);
  }
}, 30_000);

test('strict CLI trust cannot inherit another home custom CA from an installed global product wrapper', async () => {
  const f = httpsFixture(); const originalFetch = globalThis.fetch;
  try {
    const previous = configuration(f, 'previous-custom'); const strict = configuration(f, 'selected-bundled', 'bundled');
    // Preserve the guarded call chain, but own a fresh function without any
    // installer markers from other tests in this non-isolated runner.
    globalThis.fetch = originalFetch.bind(globalThis);
    new GlobalNetworkTransportInstaller().install(previous.config.config);
    const installedFetch = globalThis.fetch;
    for (const command of ['update', 'status'] as const) {
      rejected(await programmatic(strict, command));
      expect(globalThis.fetch).toBe(installedFetch);
    }
    expect(f.requests).toHaveLength(0);
    // The scoped call must not reconfigure the pre-existing installer's owner.
    const ambient = await installedFetch(`https://127.0.0.1:${f.port}/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(ambient.status).toBe(200);
    expect(await ambient.json()).toMatchObject({ version: 'owned-https-version' });
    expect(globalThis.fetch).toBe(installedFetch);
    previous.assertUnchanged(); strict.assertUnchanged();
  } finally { globalThis.fetch = originalFetch; await f.close(); }
}, 30_000);
