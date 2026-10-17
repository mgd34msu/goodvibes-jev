import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext, type ControlPlaneWebSocketData } from '../sdk/src/platform/daemon/control-plane.js';
import { ControlPlaneGateway } from '../sdk/src/platform/control-plane/gateway.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerPairingGatewayMethods } from '../sdk/src/platform/control-plane/routes/pairing.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { UserAuthManager } from '../sdk/src/platform/security/user-auth.js';
import { HttpListener } from '../sdk/src/platform/daemon/http-listener.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function authFixture() {
  const root = mkdtempSync(join(tmpdir(), 'origin-auth-')); roots.push(root);
  const users = new UserAuthManager({ bootstrapFilePath: join(root, 'users.json'), bootstrapCredentialPath: join(root, 'bootstrap.txt'),
    users: [{ username: 'owner', roles: ['admin'], passwordHash: 'unused' }] });
  return { root, users };
}

test('secondary HTTP listener honors live legacy and paired-token revocation', async () => {
  const { root, users } = authFixture();
  const pairing = new PairingTokenManager(join(root, 'pairing.json'));
  const config = new ConfigManager({ configDir: root });
  const listener = new HttpListener({ configManager: config, userAuth: users, pairingTokens: pairing });
  listener.enable({ httpListener: true }, 'synthetic-legacy');
  const handle = (token: string) => (listener as unknown as { handleRequest(req: Request): Promise<Response> }).handleRequest(
    new Request('http://localhost/health', { headers: { authorization: `Bearer ${token}` } }));
  try {
    expect((await handle('synthetic-legacy')).status).toBe(200);
    pairing.revokeLegacyShared();
    expect((await handle('synthetic-legacy')).status).toBe(401);
    const device = pairing.mint({ name: 'replacement' });
    expect((await handle(device.token)).status).toBe(200);
    pairing.revoke(device.id);
    expect((await handle(device.token)).status).toBe(401);
  } finally { await listener.stop(); config.stopWatchingConfigFiles(); }
});

test('WebSocket upgrades check browser origins while permitting authenticated native clients', () => {
  const { users } = authFixture();
  const session = users.createSession('owner');
  const helper = new DaemonControlPlaneHelper({ authToken: () => 'synthetic-operator', userAuth: users,
    gatewayMethods: new GatewayMethodCatalog(),
    trustProxyEnabled: () => false, allowedBrowserOrigins: () => ['https://trusted.example'] } as unknown as DaemonControlPlaneContext);
  let upgraded = 0;
  const server = { upgrade: () => { upgraded++; return true; } };
  for (const origin of ['https://sibling.example', 'null', undefined]) {
    const result = helper.tryUpgradeControlPlaneWebSocket(new Request('https://daemon.example/api/control-plane/ws', {
      headers: { cookie: `goodvibes_session=${session.token}`, ...(origin ? { origin } : {}) },
    }), server);
    expect(result instanceof Response && result.status).toBe(403);
  }
  for (const origin of ['https://daemon.example', 'https://trusted.example']) {
    expect(helper.tryUpgradeControlPlaneWebSocket(new Request('https://daemon.example/api/control-plane/ws', {
      headers: { cookie: `goodvibes_session=${session.token}`, origin },
    }), server)).toBe('upgraded');
  }
  expect(helper.tryUpgradeControlPlaneWebSocket(new Request('https://daemon.example/api/control-plane/ws', {
    headers: { authorization: 'Bearer synthetic-operator' },
  }), server)).toBe('upgraded');
  expect(upgraded).toBe(3);
});

test('an open WebSocket loses event and mint authority when its pairing is revoked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-revocation-'));
  const pairing = new PairingTokenManager(join(dir, 'pairing.json'));
  const device = pairing.mint({ name: 'connected device' });
  const catalog = new GatewayMethodCatalog();
  registerPairingGatewayMethods(catalog, pairing);
  const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, controlPlaneGateway: gateway, pairingTokens: pairing,
    authToken: () => 'synthetic-operator', trustProxyEnabled: () => false,
    userAuth: { validateSession: () => null },
  } as unknown as DaemonControlPlaneContext);
  const server = Bun.serve<ControlPlaneWebSocketData>({
    hostname: '127.0.0.1', port: 0,
    fetch(req, server) {
      const result = helper.tryUpgradeControlPlaneWebSocket(req, server);
      return result === 'upgraded' ? undefined : result ?? new Response(null, { status: 404 });
    },
    websocket: {
      open: ws => helper.handleControlPlaneWebSocketOpen(ws),
      message: (ws, message) => helper.handleControlPlaneWebSocketMessage(ws, message),
      close: ws => helper.handleControlPlaneWebSocketClose(ws),
    },
  });
  // lib.dom's constructor omits Bun's supported header overload.
  const Socket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };
  const ws = new Socket(`ws://127.0.0.1:${server.port}/api/control-plane/ws`, { headers: { Authorization: `Bearer ${device.token}` } });
  const events: string[] = [];
  const responses = new Map<string, (value: { status: number }) => void>();
  ws.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === 'event') events.push(frame.event);
    if (frame.type === 'response') responses.get(frame.id)?.(frame);
  });
  const call = (id: string, methodId: string, body?: unknown) => new Promise<{ status: number }>(resolve => {
    responses.set(id, resolve);
    ws.send(JSON.stringify({ type: 'call', id, methodId, body }));
  });
  try {
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    expect((await call('before', 'pairing.tokens.list')).status).toBe(200);
    pairing.revoke(device.id);
    events.length = 0;
    gateway.publishEvent('session-update', { secret: 'after revocation' });
    gateway.publishEvent('approval-update', { secret: 'after revocation' });
    expect((await call('after', 'pairing.tokens.create', { name: 'replacement' })).status).toBe(401);
    expect(pairing.list()).toHaveLength(0);
    expect(events).toEqual([]);
  } finally {
    ws.close();
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
