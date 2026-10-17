import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext, type ControlPlaneWebSocketData } from '../sdk/src/platform/daemon/control-plane.js';
import { ControlPlaneGateway } from '../sdk/src/platform/control-plane/gateway.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerPairingGatewayMethods } from '../sdk/src/platform/control-plane/routes/pairing.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';

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
