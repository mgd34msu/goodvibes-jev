import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { availableLoopbackPorts, companionCliFixture } from '../helpers/companion-cli-fixture.js';

const selectedHomeFlags = ['--daemon-home', 'selected-daemon'];
const tokenPath = (home: string) => join(home, 'operator-tokens.json');

function configure(home: string, httpPort?: number) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'settings.json'), JSON.stringify({
    cluster: { enabled: false }, relay: { enabled: false },
    ...(httpPort === undefined ? {} : {
      danger: { httpListener: true }, httpListener: { hostMode: 'local', port: httpPort },
    }),
  }));
}

function readIdentity(home: string) {
  const bytes = readFileSync(tokenPath(home), 'utf8');
  const record = JSON.parse(bytes) as { token: string; peerId: string; createdAt: number };
  expect(record.token).toMatch(/^gv_[A-Za-z0-9_-]+$/);
  expect(record.peerId).toMatch(/^[a-f0-9]{24}$/);
  expect(Number.isFinite(record.createdAt)).toBe(true);
  expect(record.createdAt).toBeGreaterThan(0);
  if (process.platform !== 'win32') expect(statSync(tokenPath(home)).mode & 0o777).toBe(0o600);
  return { bytes, ...record };
}

async function httpStatus(port: number, path: string, token?: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  await response.arrayBuffer();
  return response.status;
}

/** The control-plane contract authenticates the upgrade's Authorization header. */
function upgradeStatus(port: number, token?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write([
        'GET /api/control-plane/ws?clientKind=web HTTP/1.1',
        `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        ...(token === undefined ? [] : [`Authorization: Bearer ${token}`]), '', '',
      ].join('\r\n'));
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      const end = received.indexOf('\r\n');
      if (end >= 0) { socket.destroy(); resolve(received.slice(0, end)); }
    });
    socket.on('error', reject);
    socket.on('close', () => {
      if (!received.includes('\r\n')) reject(new Error('WebSocket upgrade closed without a status line'));
    });
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error('WebSocket upgrade timed out')); });
  });
}

function readyFrame(port: number, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // This guarded suite runs in Bun. DOM ambient types hide Bun's supported
    // header-bearing constructor overload, so restore that overload explicitly.
    const BunWebSocket = WebSocket as typeof WebSocket & {
      new (url: string, options: Bun.WebSocketOptions): WebSocket;
    };
    const socket = new BunWebSocket(`ws://127.0.0.1:${port}/api/control-plane/ws?clientKind=web`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    let settled = false;
    const finish = (error?: Error, data?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('WebSocket ready frame timed out')), 10_000);
    socket.onmessage = (message) => {
      try { finish(undefined, JSON.parse(String(message.data))); }
      catch { finish(new Error('WebSocket did not send JSON')); }
    };
    socket.onerror = () => finish(new Error('Authenticated WebSocket failed'));
    socket.onclose = () => finish(new Error('WebSocket closed before ready'));
  });
}

function statusArgs(port: number, homeFlags = selectedHomeFlags) {
  return [...homeFlags, 'status', '--host', '127.0.0.1', '--port', String(port), '--json'];
}

test('emitted launcher bootstraps the selected identity for HTTP, WebSocket and a separate status process, then reuses it', async () => {
  const fx = companionCliFixture();
  const [port] = await availableLoopbackPorts(1);
  configure(fx.daemonHome);
  expect(existsSync(tokenPath(fx.daemonHome))).toBe(false);
  const args = [...selectedHomeFlags, 'serve', '--hostname', '127.0.0.1', '--port', String(port)];
  const first = fx.launch(args, { composed: true });
  let identity: ReturnType<typeof readIdentity>;
  try {
    await first.waitFor('host started');
    identity = readIdentity(fx.daemonHome);
    const response = await fetch(`http://127.0.0.1:${port}/api/channels/inbox`, {
      headers: { Authorization: `Bearer ${identity.token}` }, signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Synthetic subject');
    expect(await readyFrame(port, identity.token)).toMatchObject({ type: 'event', event: 'ready' });
    for (const wrongToken of [undefined, 'wrong-companion-token']) {
      expect(await httpStatus(port, '/api/channels/inbox', wrongToken)).toBe(401);
      expect(await upgradeStatus(port, wrongToken)).toMatch(/^HTTP\/1\.1 401\b/);
    }
    const status = await fx.oneShot(statusArgs(port));
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, data: {
      target: `http://127.0.0.1:${port}`, hostedSessions: { count: 0, sessions: [] },
    } });
    expect(existsSync(tokenPath(fx.envDaemonHome))).toBe(false);
    expect(existsSync(tokenPath(fx.defaultDaemonHome))).toBe(false);

    // Neither an unselected env home nor the tree default can adopt this token.
    for (const env of [{}, { GOODVIBES_DAEMON_HOME: undefined }]) {
      const wrongHome = await fx.oneShot(statusArgs(port, []), env);
      expect(wrongHome.code).toBe(1);
      expect(JSON.parse(wrongHome.stderr)).toMatchObject({ ok: false, error: 'no operator token was found for this machine' });
    }
    const otherHome = join(fx.cwd, 'other-daemon');
    mkdirSync(otherHome, { recursive: true });
    const otherIdentity = JSON.stringify({ token: 'other-home-token', peerId: 'other-peer', createdAt: 1 });
    writeFileSync(tokenPath(otherHome), otherIdentity);
    const other = await fx.oneShot(statusArgs(port, ['--daemon-home', 'other-daemon']));
    expect(other.code).toBe(1);
    expect(other.stderr).toContain('refused the operator token');
    expect(readFileSync(tokenPath(otherHome), 'utf8')).toBe(otherIdentity);
    expect(readFileSync(tokenPath(fx.daemonHome), 'utf8')).toBe(identity.bytes);
    expect(await first.stop()).toBe(0);
  } finally { await first.close(); }

  const restarted = fx.launch(args, { composed: true });
  try {
    await restarted.waitFor('host started');
    expect(readIdentity(fx.daemonHome)).toEqual(identity!);
    expect(await httpStatus(port, '/api/channels/inbox', identity!.token)).toBe(200);
    expect(await readyFrame(port, identity!.token)).toMatchObject({ type: 'event', event: 'ready' });
    expect((await fx.oneShot(statusArgs(port))).code).toBe(0);
    expect(existsSync(tokenPath(fx.envDaemonHome))).toBe(false);
    expect(existsSync(tokenPath(fx.defaultDaemonHome))).toBe(false);
    expect(await restarted.stop()).toBe(0);
  } finally { await restarted.close(); }
}, 60_000);

test('emitted launcher reports an unreadable identity once, preserves it and serves with the replacement', async () => {
  const fx = companionCliFixture();
  const [port] = await availableLoopbackPorts(1);
  configure(fx.daemonHome);
  const malformedBytes = '{ "token": "synthetic-private-unreadable-token", broken identity';
  writeFileSync(tokenPath(fx.daemonHome), malformedBytes, { mode: 0o600 });
  const child = fx.launch([...selectedHomeFlags, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    composed: true,
  });
  try {
    await child.waitFor('host started');
    const identity = readIdentity(fx.daemonHome);
    expect(readFileSync(`${tokenPath(fx.daemonHome)}.unrecognized`, 'utf8')).toBe(malformedBytes);
    expect(await httpStatus(port, '/api/channels/inbox', identity.token)).toBe(200);
    expect(await readyFrame(port, identity.token)).toMatchObject({ type: 'event', event: 'ready' });
    const status = await fx.oneShot(statusArgs(port));
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ ok: true });
    expect(await child.stop()).toBe(0);
    const { stdout, stderr } = child.output();
    const warning = 'The selected daemon operator token store was unreadable. A new shared token was created; paired clients must pair again. '
      + 'The previous file was preserved beside the token store.';
    expect(stderr.split('\n').filter((line) => line === warning)).toHaveLength(1);
    for (const output of [stdout, stderr, status.stdout, status.stderr]) {
      expect(output).not.toContain('synthetic-private-unreadable-token');
      expect(output).not.toContain(identity.token);
    }
    expect(readFileSync(tokenPath(fx.daemonHome), 'utf8')).toBe(identity.bytes);
    expect(readFileSync(`${tokenPath(fx.daemonHome)}.unrecognized`, 'utf8')).toBe(malformedBytes);
    expect(existsSync(tokenPath(fx.envDaemonHome))).toBe(false);
    expect(existsSync(tokenPath(fx.defaultDaemonHome))).toBe(false);
  } finally { await child.close(); }
}, 45_000);

for (const mode of ['stored fallback', 'daemon override', 'HTTP override'] as const) {
  test(`emitted launcher applies ${mode} to the optional HTTP listener without replacing the stored identity`, async () => {
    const fx = companionCliFixture();
    const [port, httpPort] = await availableLoopbackPorts(2);
    configure(fx.daemonHome, httpPort);
    const storedToken = 'synthetic-existing-companion-token';
    // Noncanonical formatting and extra metadata expose any accidental rewrite.
    const storedBytes = '{ "token": "synthetic-existing-companion-token", "peerId": "original-peer", "createdAt": 123, "fixture": true }\n';
    writeFileSync(tokenPath(fx.daemonHome), storedBytes, { mode: 0o600 });
    const daemonToken = mode === 'stored fallback' ? storedToken : 'synthetic-daemon-override';
    const httpToken = mode === 'HTTP override' ? 'synthetic-http-override' : daemonToken;
    const child = fx.launch([...selectedHomeFlags, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      composed: true,
      env: {
        ...(mode === 'stored fallback' ? {} : { GOODVIBES_DAEMON_TOKEN: daemonToken }),
        ...(mode === 'HTTP override' ? { GOODVIBES_HTTP_TOKEN: httpToken } : {}),
      },
    });
    try {
      await child.waitFor('host started');
      expect(await httpStatus(port, '/api/channels/inbox', daemonToken)).toBe(200);
      expect(await readyFrame(port, daemonToken)).toMatchObject({ type: 'event', event: 'ready' });
      expect(await httpStatus(httpPort, '/health', httpToken)).toBe(200);
      expect(await httpStatus(httpPort, '/health')).toBe(401);
      expect(await httpStatus(httpPort, '/health', 'wrong-http-token')).toBe(401);
      if (mode !== 'stored fallback') {
        expect(await httpStatus(port, '/api/channels/inbox', storedToken)).toBe(401);
        expect(await upgradeStatus(port, storedToken)).toMatch(/^HTTP\/1\.1 401\b/);
        expect(await httpStatus(httpPort, '/health', storedToken)).toBe(401);
        const storedStatus = await fx.oneShot(statusArgs(port));
        expect(storedStatus.code).toBe(1);
        expect(storedStatus.stderr).toContain('refused the operator token');
      }
      if (mode === 'HTTP override') {
        expect(await httpStatus(httpPort, '/health', daemonToken)).toBe(401);
        expect(await httpStatus(port, '/api/channels/inbox', httpToken)).toBe(401);
        expect(await upgradeStatus(port, httpToken)).toMatch(/^HTTP\/1\.1 401\b/);
      }
      const status = await fx.oneShot([...statusArgs(port), '--token', daemonToken]);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ ok: true });
      expect(readFileSync(tokenPath(fx.daemonHome), 'utf8')).toBe(storedBytes);
      expect(await child.stop()).toBe(0);
      expect(readFileSync(tokenPath(fx.daemonHome), 'utf8')).toBe(storedBytes);
      expect(existsSync(tokenPath(fx.envDaemonHome))).toBe(false);
      expect(existsSync(tokenPath(fx.defaultDaemonHome))).toBe(false);
    } finally { await child.close(); }
  }, 45_000);
}
