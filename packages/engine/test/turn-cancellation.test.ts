import { expect, test } from 'bun:test';
import { TurnCancellationFence } from '../sdk/src/platform/core/turn-cancellation.ts';
import { createSessionTurnCancelHandler, registerSessionRuntimeGatewayMethods, type SessionRuntimeControls } from '../sdk/src/platform/control-plane/routes/session-runtime.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.ts';

function fixture() {
  let aborts = 0;
  const fence = new TurnCancellationFence();
  fence.begin('turn-1', () => { aborts++; });
  const controls: SessionRuntimeControls = {
    isLocalSession: (id) => id === 'hosted-1',
    getPermissionMode: () => 'prompt', setPermissionMode: () => {},
    getContextUsage: () => ({ estimatedContextTokens: 0, contextWindow: 0, contextUsagePct: 0, contextRemainingTokens: 0 }),
    getLiveTurnControls: () => ({ cancelTurn: (id) => fence.cancel(id), cancelToolCall: () => false, listQueuedMessages: () => [], editQueuedMessage: () => false, deleteQueuedMessage: () => false }),
  };
  return { fence, controls, aborts: () => aborts };
}

test('identity fence bounds ended history and never converts expiry to cancellation success', () => {
  const fence = new TurnCancellationFence();
  let aborts = 0;
  for (let i = 0; i < 130; i++) { fence.begin(`${i}`, () => { aborts++; }); fence.end(`${i}`); }
  expect(fence.cancel('0').status).toBe('turn-not-found');
  expect(fence.cancel('129').status).toBe('already-ended');
  fence.begin('new', () => { aborts++; expect(fence.cancel('new').status).toBe('cancellation-requested'); });
  expect(fence.cancel('0').status).toBe('stale-turn');
  expect(fence.cancel('new').status).toBe('cancellation-requested');
  expect(fence.cancel('new').status).toBe('cancellation-requested');
  expect(aborts).toBe(1);
});

test('route validates required identity and local session without touching a turn', () => {
  const { controls, aborts } = fixture();
  const handle = createSessionTurnCancelHandler(controls);
  expect(() => handle({ body: { sessionId: 'absent', expectedTurnId: 'turn-1' }, context: {} })).toThrow('does not host');
  expect(() => handle({ body: { sessionId: 'hosted-1' }, context: {} })).toThrow('expectedTurnId');
  expect(aborts()).toBe(0);
});

test('real gateway policy denies read-only actors and allows session writers before invoking cancel', async () => {
  const { controls, aborts } = fixture();
  const catalog = new GatewayMethodCatalog();
  registerSessionRuntimeGatewayMethods(catalog, controls);
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog } as unknown as DaemonControlPlaneContext);
  const input = { authToken: 'fixture', methodId: 'sessions.turns.cancel', body: { sessionId: 'hosted-1', expectedTurnId: 'turn-1' } };
  const denied = await helper.invokeGatewayMethodCall({ ...input, context: { principalKind: 'user', scopes: ['read:sessions'] } });
  expect(denied.status).toBe(403);
  expect(aborts()).toBe(0);
  const allowed = await helper.invokeGatewayMethodCall({ ...input, context: { principalKind: 'user', scopes: ['write:sessions'] } });
  expect(allowed.status).toBe(200);
  expect(allowed.body).toEqual({ ...input.body, status: 'cancellation-requested', activeTurnId: 'turn-1' });
  expect(aborts()).toBe(1);
});

test('public typed operator client sends expected identity through the native REST contract', async () => {
  const { createOperatorSdk } = await import('../operator-sdk/src/index.ts');
  let captured: { url: string; body: unknown } | undefined;
  const sdk = createOperatorSdk({
    baseUrl: 'http://localhost:3210', authToken: 'fixture',
    fetch: Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), body: JSON.parse(String(init?.body)) as unknown };
      return Response.json({ sessionId: 'hosted-1', expectedTurnId: 'turn-1', status: 'cancellation-requested', activeTurnId: 'turn-1' });
    }, { preconnect: () => {} }),
  });
  const result = await sdk.sessions.turns.cancel({ sessionId: 'hosted-1', expectedTurnId: 'turn-1' });
  expect(result.status).toBe('cancellation-requested');
  expect(captured).toEqual({ url: 'http://localhost:3210/api/sessions/hosted-1/turns/cancel', body: { expectedTurnId: 'turn-1' } });
});


test('OpenAPI REST body requires only expectedTurnId while the path retains sessionId', async () => {
  for (const location of ['../contracts/artifacts/operator-openapi.json', '../docs/operator-openapi.json']) {
    const document = await Bun.file(new URL(location, import.meta.url)).json();
    const operation = document.paths['/api/sessions/{sessionId}/turns/cancel'].post;
    expect(operation.requestBody.content['application/json'].schema.required).toEqual(['expectedTurnId']);
    expect(operation.requestBody.content['application/json'].schema.properties.sessionId).toBeUndefined();
    expect(operation.parameters).toContainEqual({ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } });
    expect(operation['x-scopes']).toEqual(['write:sessions']);
  }
});
