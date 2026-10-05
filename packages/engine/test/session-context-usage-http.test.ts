/** Real context-usage REST bytes for the WebUI provenance proof. */
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstJsonSchemaFailure } from '../transport-http/src/client-plumbing.js';
import type { OperatorMethodOutput } from '../contracts/src/index.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { buildOperatorContract } from '../sdk/src/platform/control-plane/operator-contract.js';
import { createSessionRuntimeControls, registerSessionRuntimeGatewayMethods, SessionLiveTurnControlsHolder } from '../sdk/src/platform/control-plane/routes/session-runtime.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.js';
import { ModelLimitsService } from '../sdk/src/platform/providers/model-limits.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import { createDaemonControlRouteHandlers } from '../daemon-sdk/src/control-routes.js';
import { dispatchGatewayRestRoutes } from '../daemon-sdk/src/gateway-rest-routes.js';
import { createOperatorSdk } from '../operator-sdk/src/client.js';

const SESSION_ID = 's-context-local';
const HOSTED_SESSION_ID = 's-context-hosted';
const TOKEN = 'synthetic-context-fixture-token';
const model: ModelDefinition = {
  id: 'fixture-model', provider: 'fixture-provider', registryKey: 'fixture-provider:fixture-model',
  displayName: 'Fixture model', description: '', selectable: true, contextWindow: 100_000,
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
};
const definitions: Record<string, ModelDefinition | null> = {
  provider_api: { ...model, contextWindowProvenance: 'provider_api' },
  configured_cap: { ...model, contextWindow: 80_000, contextWindowProvenance: 'configured_cap', contextWindowOrigin: { kind: 'user_override' } },
  observed_limit: { ...model, contextWindow: 90_000, contextWindowProvenance: 'observed_limit' },
  fallback: { ...model, contextWindow: 128_000, contextWindowProvenance: 'fallback', contextWindowOrigin: { kind: 'family_default' } },
  consensus: { ...model, contextWindowProvenance: 'catalog', contextWindowOrigin: { kind: 'consensus', providers: 4, agreeing: 3 } },
  accepted_floor: { ...model, contextWindow: 128_000, contextWindowProvenance: 'accepted_floor', contextWindowAcceptedFloor: 24_000 },
  catalog: { ...model, contextWindowProvenance: 'catalog', contextWindowOrigin: { kind: 'catalog', catalogProviderId: 'fixture-provider' } },
  no_model: null,
};
interface WireResponse { method: string; path: string; status: number; body: string }

test('real HTTP facade carries nullable capacity and provenance without exposing another hosted session snapshot', async () => {
  let current: ModelDefinition | null = definitions.provider_api!;
  const store = createRuntimeStore();
  store.setState(state => ({ session: { ...state.session, id: SESSION_ID }, conversation: { ...state.conversation, estimatedContextTokens: 40_000 } }));
  // Leave the real store's initial 200,000 budget intact to catch false ceilings.
  expect(store.getState().model.tokenLimits.contextWindow).toBe(200_000);
  const limits = new ModelLimitsService({ cachePath: '/unused/session-context-http-limits.json' });
  const holder = new SessionLiveTurnControlsHolder();
  holder.bindSession(HOSTED_SESSION_ID, {
    cancelToolCall: () => true, listQueuedMessages: () => [], editQueuedMessage: () => false, deleteQueuedMessage: () => false,
  });
  const controls = createSessionRuntimeControls({ config: { get: () => 'prompt', set: () => {} }, store, liveTurnHolder: holder,
    providerRegistry: { getCurrentModel() { if (!current) throw new Error('Model is not available'); return current; },
      getContextWindowForModel: entry => limits.getContextWindowForModel(entry),
      getKnownContextWindowForModel: entry => limits.getKnownContextWindowForModel(entry) } });
  const catalog = new GatewayMethodCatalog();
  registerSessionRuntimeGatewayMethods(catalog, controls);
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, authToken: () => TOKEN,
    controlPlaneGateway: { touchWebSocketClient() {} } } as unknown as DaemonControlPlaneContext);
  // Only credential resolution and unrelated daemon facilities are fixtures.
  // The controls, model limits, store, catalog, policy helper and REST facade are real.
  const handlers = createDaemonControlRouteHandlers({
    authToken: TOKEN, version: 'fixture', sessionCookieName: 'fixture-session',
    controlPlaneGateway: { getSnapshot: () => ({}), renderWebUi: () => new Response(''), listRecentEvents: () => [],
      listSurfaceMessages: () => [], listClients: () => [], createEventStream: () => new Response('') },
    extractAuthToken: request => request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
    resolveAuthenticatedPrincipal: request => helper.describeAuthenticatedPrincipal(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''),
    gatewayMethods: catalog, getOperatorContract: () => buildOperatorContract(catalog),
    invokeGatewayMethodCall: input => helper.invokeGatewayMethodCall(input),
    parseOptionalJsonBody: async request => { const body = await request.text(); return body ? JSON.parse(body) : null; },
    requireAdmin: request => request.headers.get('authorization') === `Bearer ${TOKEN}` ? null : Response.json({ error: 'Unauthorized' }, { status: 401 }),
    requireAuthenticatedSession: () => null,
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: async request => await dispatchGatewayRestRoutes(request, handlers) ?? new Response('Not found', { status: 404 }) });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const schema = catalog.get('sessions.contextUsage.get')!.outputSchema!;
  const scenarios: Record<string, WireResponse> = {};
  try {
    for (const [name, definition] of Object.entries(definitions)) {
      current = definition;
      const path = `/api/sessions/${SESSION_ID}/context-usage`;
      const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const body = await response.text();
      expect(response.status, name).toBe(200);
      const value = JSON.parse(body) as OperatorMethodOutput<'sessions.contextUsage.get'>;
      expect(firstJsonSchemaFailure(schema, value), name).toBeUndefined();
      expect(value.estimatedContextTokens).toBe(40_000);
      expect(value.estimated).toBe(true);
      if (['fallback', 'consensus', 'accepted_floor', 'no_model'].includes(name)) {
        expect(value.contextWindow, name).toBeNull();
        expect(value.contextUsagePct, name).toBeNull();
        expect(value.contextRemainingTokens, name).toBeNull();
      } else {
        expect(value.contextWindow, name).toBe(definition!.contextWindow);
      }
      if (name === 'accepted_floor') expect(value.contextWindowAcceptedFloor).toBe(24_000);
      scenarios[name] = { method: 'GET', path, status: response.status, body };
    }
    current = definitions.provider_api!;
    const sdk = createOperatorSdk({ baseUrl, authToken: TOKEN });
    const local = await sdk.invoke<OperatorMethodOutput<'sessions.contextUsage.get'>>('sessions.contextUsage.get', { sessionId: SESSION_ID });
    expect(local).toMatchObject({ contextWindow: 100_000, contextUsagePct: 40, contextWindowSource: 'provider_api' });
    expect(await sdk.invoke<OperatorMethodOutput<'sessions.contextUsage.get'>>('sessions.contextUsage.get', { sessionId: 'runtime' })).toEqual({ ...local, sessionId: 'runtime' });
    for (const id of [HOSTED_SESSION_ID, 'not-hosted']) {
      const path = `/api/sessions/${id}/context-usage`;
      const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(JSON.parse(body)).toMatchObject({ code: 'SESSION_NOT_LOCAL' });
      expect(body).not.toContain('estimatedContextTokens');
      if (id === HOSTED_SESSION_ID) scenarios.hosted_refusal = { method: 'GET', path, status: response.status, body };
    }
    // Broader local control identity is intentionally unchanged.
    expect(controls.isLocalSession(HOSTED_SESSION_ID)).toBe(true);
    expect((await sdk.invoke<OperatorMethodOutput<'sessions.queuedMessages.list'>>('sessions.queuedMessages.list', { sessionId: HOSTED_SESSION_ID })).messages).toEqual([]);
    const capture = {
      source: 'packages/engine/test/session-context-usage-http.test.ts', sessionId: SESSION_ID, hostedSessionId: HOSTED_SESSION_ID, scenarios,
    };
    const directory = process.env.GOODVIBES_TEST_CONTEXT_USAGE_FIXTURE_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'session-context-usage.json'), JSON.stringify(capture, null, 2) + '\n');
    }
    // The browser replays these exact real HTTP bodies; schema-valid hand-written
    // substitutes or stale captures must fail this route proof as well.
    const recorded = JSON.parse(readFileSync(new URL('../../../products/webui/e2e/support/fixtures/session-context-usage.json', import.meta.url), 'utf8')) as unknown;
    expect(recorded).toEqual(capture);
  } finally { server.stop(true); }
});
