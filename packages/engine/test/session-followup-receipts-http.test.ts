/** Real session HTTP bytes for the WebUI's input-receipt lifecycle proof. */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import operatorContract from '@goodvibes-jev/engine/contracts/operator-contract.json' with { type: 'json' };
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import { SharedSessionBroker } from '../sdk/src/platform/control-plane/session-broker.js';
import type { RouteBindingManager } from '../sdk/src/platform/channels/index.js';
import { createDaemonRuntimeSessionRouteHandlers } from '../daemon-sdk/src/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../daemon-sdk/src/runtime-route-types.js';
import { dispatchSessionRoutes } from '../daemon-sdk/src/sessions.js';

const SESSION_ID = 's-tui-idle';
const BODY = 'Queue a cleanup pass for later';
const FAILURE = 'The TUI could not hand the follow-up to its execution loop.';

function serveSessions(spawnResponse?: ReturnType<DaemonRuntimeRouteContext['trySpawnAgent']>) {
  const root = mkdtempSync(join(tmpdir(), 'session-followup-http-'));
  const broker = new SharedSessionBroker({
    storePath: join(root, 'sessions.json'),
    routeBindings: {
      start: async () => {}, getBinding: () => null, resolve: () => null,
      patchBinding: async () => null,
    } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => false },
  });
  let spawnCount = 0;
  // Authentication, channels and executors are explicit fixture boundaries. The
  // real broker, registration, dispatcher and lifecycle handlers are not mocked.
  const context = {
    sessionBroker: broker,
    requireAdmin: () => null,
    parseJsonBody: (request: Request) => request.json(),
    parseOptionalJsonBody: (request: Request) => request.json(),
    recordApiResponse: (_request: Request, _path: string, response: Response) => response,
    queueSurfaceReplyFromBinding: () => {},
    trySpawnAgent: () => {
      spawnCount += 1;
      if (spawnResponse) return spawnResponse;
      throw new Error('A surface-owned follow-up must not spawn a daemon agent');
    },
  } as unknown as DaemonRuntimeRouteContext;
  const handlers = {
    ...createDaemonRuntimeSessionRouteHandlers(context),
    getIntegrationSessions: () => { throw new Error('Union list is outside this route capture'); },
  };
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: async request => await dispatchSessionRoutes(request, handlers) ?? new Response('Not found', { status: 404 }),
  });
  return {
    broker, get spawnCount() { return spawnCount; },
    setSpawnResponse(response: ReturnType<DaemonRuntimeRouteContext['trySpawnAgent']>) { spawnResponse = response; },
    baseUrl: `http://127.0.0.1:${server.port}`,
    async stop() { server.stop(true); await broker.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('surfaceless follow-up can return a bare 429 after the broker has queued the input', async () => {
  const refusal = { error: 'Daemon agent capacity exceeded', code: 'CAPACITY_EXCEEDED' };
  const fixture = serveSessions(Response.json(refusal, { status: 429 }));
  try {
    await fixture.broker.createSession({ id: 's-capacity', kind: 'tui' });
    const path = '/api/sessions/s-capacity/follow-up';
    const response = await fetch(`${fixture.baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: BODY }),
    });
    expect(response.status).toBe(429);
    const bytes = await response.text();
    expect(JSON.parse(bytes)).toEqual(refusal);
    expect(JSON.parse(bytes).input).toBeUndefined();
    const queued = await capture(fixture.baseUrl, 'sessions.inputs.list', '/api/sessions/s-capacity/inputs');
    expect(queued.value.inputs).toHaveLength(1);
    expect(queued.value.inputs[0]).toMatchObject({ sessionId: 's-capacity', state: 'queued', intent: 'follow-up', body: BODY });
    expect(fixture.spawnCount).toBe(1);
    // A later spawn claims the oldest queued input, not necessarily the new
    // follow-up named in this POST response. The list is authoritative for id B.
    fixture.setSpawnResponse({ id: 'agent-capacity-recovered', status: 'running', task: 'Second follow-up', tools: [], startedAt: Date.now() });
    const second = await capture(fixture.baseUrl, 'sessions.followUp', path, { body: 'Second follow-up after capacity returns' });
    expect(second.wire.status).toBe(202);
    expect(second.value.input.state).toBe('spawned');
    const afterSpawn = await capture(fixture.baseUrl, 'sessions.inputs.list', '/api/sessions/s-capacity/inputs');
    expect(afterSpawn.value.inputs).toHaveLength(2);
    expect(afterSpawn.value.inputs.find(input => input.id === queued.value.inputs[0]?.id)).toMatchObject({ state: 'spawned', activeAgentId: 'agent-capacity-recovered' });
    expect(afterSpawn.value.inputs.find(input => input.id === second.value.input.id)).toMatchObject({ state: 'queued' });
    expect(fixture.spawnCount).toBe(2);
    const directory = process.env.GOODVIBES_TEST_SESSION_FOLLOWUP_FIXTURE_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'capacity.json'), JSON.stringify({
        source: 'packages/engine/test/session-followup-receipts-http.test.ts',
        post: { methodId: 'sessions.followUp', method: 'POST', path, requestBody: { body: BODY }, status: response.status, body: bytes },
        queued: queued.wire, second: second.wire, afterSpawn: afterSpawn.wire,
      }, null, 2) + '\n');
    }
  } finally { await fixture.stop(); }
});

async function capture<M extends 'sessions.register' | 'sessions.get' | 'sessions.messages.list' | 'sessions.followUp' | 'sessions.inputs.list' | 'sessions.inputs.deliver' | 'sessions.inputs.cancel'>(
  baseUrl: string, methodId: M, path: string, body?: unknown,
) {
  const method = body === undefined ? 'GET' : 'POST';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const bytes = await response.text();
  const value: unknown = JSON.parse(bytes);
  const schema = operatorContract.operator.methods.find(entry => entry.id === methodId)?.outputSchema;
  expect(schema, methodId).toBeDefined();
  expect(firstJsonSchemaFailure(schema!, value), methodId).toBeUndefined();
  return {
    wire: { methodId, method, path, ...(body === undefined ? {} : { requestBody: body }), status: response.status, body: bytes },
    value: value as OperatorMethodOutput<M>,
  };
}

for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
  test(`HTTP follow-up: registered TUI queues, then real inputs.list reports ${outcome}`, async () => {
    const fixture = serveSessions();
    const path = `/api/sessions/${SESSION_ID}`;
    try {
      const registration = await capture(fixture.baseUrl, 'sessions.register', '/api/sessions/register', {
        sessionId: SESSION_ID, kind: 'tui', project: 'goodvibes-tui', title: 'Earlier TUI coding pass',
        participant: { surfaceKind: 'tui', surfaceId: 'surface:tui:receipt-proof' },
      });
      expect(registration.wire.status).toBe(200);
      expect(registration.value.session.activeAgentId).toBeUndefined();
      expect(registration.value.session.participants).toHaveLength(1);
      const initialMessages = await capture(fixture.baseUrl, 'sessions.messages.list', `${path}/messages`);
      const initialSession = await capture(fixture.baseUrl, 'sessions.get', path);
      const post = await capture(fixture.baseUrl, 'sessions.followUp', `${path}/follow-up`, { body: BODY });
      expect(post.wire.status).toBe(202);
      expect(post.value.mode).toBe('queued-for-surface');
      expect(post.value.agentId).toBeNull();
      expect(post.value.input).toMatchObject({ sessionId: SESSION_ID, intent: 'follow-up', state: 'queued', body: BODY });
      const inputId = post.value.input.id;
      const inputsPath = `${path}/inputs`;
      const queued = await capture(fixture.baseUrl, 'sessions.inputs.list', inputsPath);
      expect(queued.value.inputs).toEqual([post.value.input]);
      const collected = await capture(fixture.baseUrl, 'sessions.inputs.list', `${inputsPath}?state=queued&since=0`);
      expect(collected.value.inputs.map(input => input.id)).toEqual([inputId]);
      const messages = await capture(fixture.baseUrl, 'sessions.messages.list', `${path}/messages`);
      const sessionAfterPost = await capture(fixture.baseUrl, 'sessions.get', path);
      expect(messages.value.messages).toHaveLength(1);
      expect(messages.value.messages[0]?.body).toBe(BODY);

      let delivered: Awaited<ReturnType<typeof capture<'sessions.inputs.list'>>> | undefined;
      let delivery: Awaited<ReturnType<typeof capture<'sessions.inputs.deliver'>>> | undefined;
      if (outcome !== 'cancelled') {
        delivery = await capture(fixture.baseUrl, 'sessions.inputs.deliver', `${inputsPath}/${inputId}/deliver`, { consumed: false });
        expect(delivery.wire.status).toBe(200);
        expect(delivery.value.input.state).toBe('delivered');
        delivered = await capture(fixture.baseUrl, 'sessions.inputs.list', inputsPath);
        expect(delivered.value.inputs[0]?.state).toBe('delivered');
      }
      let terminalWrite;
      if (outcome === 'completed') {
        terminalWrite = await capture(fixture.baseUrl, 'sessions.inputs.deliver', `${inputsPath}/${inputId}/deliver`, { consumed: true });
        expect(terminalWrite.value.input.state).toBe('completed');
      } else if (outcome === 'failed') {
        // This is the real TUI failure boundary, not a new public endpoint.
        expect((await fixture.broker.failInput(SESSION_ID, inputId, FAILURE))?.state).toBe('failed');
      } else {
        terminalWrite = await capture(fixture.baseUrl, 'sessions.inputs.cancel', `${inputsPath}/${inputId}/cancel`, {});
        expect(terminalWrite.value.input.state).toBe('cancelled');
      }
      const terminal = await capture(fixture.baseUrl, 'sessions.inputs.list', inputsPath);
      expect(terminal.wire.status).toBe(200);
      expect(terminal.value.inputs).toHaveLength(1);
      expect(terminal.value.inputs[0]).toMatchObject({ id: inputId, sessionId: SESSION_ID, state: outcome });
      if (outcome === 'failed') expect(terminal.value.inputs[0]?.error).toBe(FAILURE);
      expect(fixture.broker.getInputsSince(SESSION_ID, { state: 'queued' })).toEqual([]);
      expect(fixture.spawnCount).toBe(0);
      const directory = process.env.GOODVIBES_TEST_SESSION_FOLLOWUP_FIXTURE_DIR;
      if (directory) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${outcome}.json`), JSON.stringify({
          source: 'packages/engine/test/session-followup-receipts-http.test.ts', outcome,
          registration: registration.wire, initialSession: initialSession.wire, initialMessages: initialMessages.wire,
          post: post.wire, queued: queued.wire, messages: messages.wire, sessionAfterPost: sessionAfterPost.wire,
          ...(delivery && delivered ? { delivery: delivery.wire, delivered: delivered.wire } : {}),
          ...(terminalWrite ? { terminalWrite: terminalWrite.wire } : { terminalMutation: { method: 'SharedSessionBroker.failInput', error: FAILURE } }),
          terminal: terminal.wire,
        }, null, 2) + '\n');
      }
    } finally { await fixture.stop(); }
  });
}
