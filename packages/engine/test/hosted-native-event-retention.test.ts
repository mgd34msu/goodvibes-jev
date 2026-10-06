import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { ControlPlaneGateway } from '../sdk/src/platform/control-plane/gateway.ts';
import { SharedSessionBroker } from '../sdk/src/platform/control-plane/session-broker.ts';
import { HostedSessionManager } from '../sdk/src/platform/hosted-sessions/manager.ts';
import { createNativeHostedTurnHost, NATIVE_HOSTED_TURN_SCOPES } from '../sdk/src/platform/hosted-sessions/native-turn-host.ts';
import { HostedSessionStore } from '../sdk/src/platform/hosted-sessions/store.ts';
import { createClientRuntimeServices } from '../sdk/src/platform/runtime/client-services.ts';
import { RuntimeEventBus, type RuntimeEventDomain } from '../sdk/src/platform/runtime/events/index.ts';
import { emitStreamDelta, emitToolReceived, emitToolSucceeded, emitTurnCompleted, emitTurnSubmitted } from '../sdk/src/platform/runtime/emitters/index.ts';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';
import type { RouteBindingManager } from '../sdk/src/platform/channels/index.ts';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.ts';
import type { NativeConversationTurnSource } from '../sdk/src/platform/workflow/work-ledger/native-intake-client.ts';
import type { NativePairedExecutionAuthority, NativePairedExecutionSnapshot } from '../sdk/src/platform/workflow/work-ledger/native-execution.ts';
import { installHostedSessionReadings } from './_helpers/hosted-session-readings.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function flush(): Promise<void> { for (let index = 0; index < 8; index++) await Promise.resolve(); }

interface Frame {
  id?: string | undefined;
  event: string;
  payload: {
    type?: string;
    sessionId?: string;
    payload?: { turnId?: string; content?: string; origin?: { metadata?: Record<string, unknown> } };
  };
}
function parseFrames(text: string): Frame[] {
  return text.trim().split('\n\n').filter(Boolean).map(chunk => ({
    id: chunk.match(/^id: (.+)$/m)?.[1],
    event: chunk.match(/^event: (.+)$/m)![1]!,
    payload: JSON.parse(chunk.match(/^data: (.+)$/m)![1]!),
  }));
}
function openStream(gateway: ControlPlaneGateway, sessionId: string, domains: readonly RuntimeEventDomain[] = ['turn', 'tools'], sinceId?: string) {
  const abort = new AbortController();
  const response = gateway.createEventStream(new Request(`http://localhost/api/sessions/${sessionId}/events`, {
    signal: abort.signal,
    ...(sinceId ? { headers: { 'last-event-id': sinceId } } : {}),
  }), { sessionId, sessionScopedDelivery: true, domains, heartbeatIntervalMs: 60_000 });
  cleanups.push(async () => { abort.abort(); });
  return async () => { abort.abort(); return parseFrames(await response.text()); };
}
function renderFrames(frames: readonly Frame[]): Frame[] { return frames.filter(frame => frame.event === 'turn' || frame.event === 'tools'); }
function emitTurn(bus: RuntimeEventBus, sessionId: string): void {
  const ctx = { sessionId, source: 'orchestrator', traceId: `trace:${sessionId}` };
  const turnId = `turn:${sessionId}`;
  emitTurnSubmitted(bus, ctx, { turnId, prompt: 'read', origin: { metadata: { correlationId: 'correlation-1', inputId: 'input-1' } } });
  emitStreamDelta(bus, ctx, { turnId, content: 'reading', accumulated: 'reading' });
  emitToolReceived(bus, ctx, { turnId, callId: 'call-1', tool: 'read', args: { path: 'note.txt' } });
  emitToolSucceeded(bus, ctx, { turnId, callId: 'call-1', tool: 'read', durationMs: 1, result: { kind: 'text', byteSize: 4, preview: 'done' } });
  emitTurnCompleted(bus, ctx, { turnId, response: 'done', stopReason: 'completed' });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hosted-native-retention-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const bus = new RuntimeEventBus();
  const gateway = new ControlPlaneGateway({ runtimeBus: bus });
  const configManager = new ConfigManager({ surfaceRoot: 'goodvibes', configDir: join(root, 'config'), workingDir: workspace, homeDir: root });
  const services = createClientRuntimeServices({ configManager, runtimeBus: bus, runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes',
    workingDir: workspace, homeDirectory: root, requestApproval: async () => ({ approved: false }), modelDiscovery: 'skip' });
  services.providerRegistry.registerRuntimeProvider({ replace: true, models: [{
    id: 'retention', provider: 'retention', registryKey: 'retention:retention', displayName: 'Retention fixture', description: '',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false }, contextWindow: 8192, selectable: true,
  }], provider: {
    name: 'retention', models: ['retention'], credentialAuthority: 'anonymous', modelSource: { kind: 'dated-static', asOf: '2026-01-01' }, isConfigured: () => true,
    chat: async () => ({ content: 'Real native turn answer', toolCalls: [], stopReason: 'completed', usage: { inputTokens: 1, outputTokens: 1 } }),
  } as unknown as LLMProvider });
  services.providerRegistry.setCurrentModel('retention:retention');
  const readings = installHostedSessionReadings();
  const broker = new SharedSessionBroker({ storePath: join(root, 'broker.json'),
    routeBindings: { start: async () => {}, stop: async () => {}, list: () => [], find: () => null, getBinding: () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => { throw new Error('Legacy send must not run'); } },
  });
  const manager = new HostedSessionManager({ floorFactory: () => ({ services, contractRunner: services.contractRunner, dispose: () => services.dispose() }),
    store: new HostedSessionStore(join(root, 'sessions'), { maxSessions: 20, maxMessagesPerSession: 100, terminatedRetentionMs: 60_000 }),
    settings: { detachPolicy: () => 'survive', maxSessions: () => 10 }, runtimeBus: bus, systemPrompt: () => 'Retention fixture', spine: broker, intakeIntervalMs: 60_000,
  });
  manager.setEventPublisher(gateway);
  await manager.init();
  const inputId = randomUUID();
  const source: NativeConversationTurnSource = { kind: 'turn', projectId: 'project-retention', requestId: `request-${inputId}`,
    sourceRef: { version: 1, inputId, sourceId: `source-${inputId}`, sourceRevision: 'revision-1', sessionId: 'source-session' }, route: 'answer', text: 'Answer exactly once' };
  const host = createNativeHostedTurnHost({ projectId: source.projectId, projectRoot: workspace, journalPath: join(root, 'native-turns.json'), manager, broker,
    intake: { get: async () => structuredClone(source), admit: async () => structuredClone(source) },
  });
  const authoritySnapshot: NativePairedExecutionSnapshot = {
    kind: 'pairing-token', principalId: 'principal-retention', authorityId: 'principal-retention', tokenId: 'token-retention', authorityRevision: 'token-retention', scopes: [...NATIVE_HOSTED_TURN_SCOPES],
  };
  const authority: NativePairedExecutionAuthority = { current: () => authoritySnapshot, withCurrent: async (_expected, callback) => callback(() => authoritySnapshot) };
  const request = { projectId: source.projectId, inputId, sourceRevision: source.sourceRef.sourceRevision };
  const access = { isAuthorized: () => true };
  cleanups.push(async () => {
    await host.close(); await manager.dispose(); await broker.stop(); readings.restore(); services.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { bus, gateway, manager, workspace, host, authority, request, access,
    createNative: () => manager.create({ workspaceRoot: workspace }, { nativeConversation: true }),
  };
}

describe('native hosted runtime frame retention', () => {
  test('the real native Agent start finishes before first SSE and replays its correlated start and terminal once', async () => {
    const f = await fixture();
    const started = await f.host.startAgent(f.request, f.authority, f.access);
    if ('kind' in started || !started.sessionId) throw new Error('Expected owned native turn');
    const deadline = Date.now() + 5_000;
    while (true) {
      const status = await f.host.status(f.request, f.authority, f.access);
      if (!('kind' in status) && status.state === 'completed') break;
      if (Date.now() >= deadline) throw new Error(`Native turn did not complete: ${JSON.stringify(status)}`);
      await Bun.sleep(2);
    }
    expect(f.gateway.listClients()).toEqual([]);
    const frames = renderFrames(await openStream(f.gateway, started.sessionId)());
    const submitted = frames.filter(frame => frame.payload.type === 'TURN_SUBMITTED');
    const completed = frames.filter(frame => frame.payload.type === 'TURN_COMPLETED');
    expect(submitted).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(submitted[0]!.payload.payload?.origin?.metadata).toMatchObject({ inputId: started.brokerInputId, correlationId: started.correlationId });
    expect(completed[0]!.payload.payload?.turnId).toBe(submitted[0]!.payload.payload?.turnId);
    expect(frames.every(frame => frame.payload.sessionId === started.sessionId)).toBe(true);
    expect(new Set(frames.map(frame => frame.id)).size).toBe(frames.length);
  });

  test('two live SSE readers and a websocket reuse retained IDs without duplicate live or replay frames', async () => {
    const f = await fixture();
    const session = await f.createNative();
    const left = openStream(f.gateway, session.id), right = openStream(f.gateway, session.id);
    const websocket: Frame[] = [];
    const client = f.gateway.openWebSocketClient({ domains: ['turn', 'tools'] }, (event, payload, id) => { websocket.push({ event, payload: payload as Frame['payload'], id }); });
    try {
      emitTurn(f.bus, session.id); await flush();
      const leftFrames = renderFrames(await left()), rightFrames = renderFrames(await right());
      const wsFrames = renderFrames(websocket);
      expect(leftFrames).toHaveLength(5);
      expect(rightFrames).toEqual(leftFrames);
      expect(wsFrames).toEqual(leftFrames);
      const retained = f.gateway.listRecentEvents(500).filter(frame => frame.event === 'turn' || frame.event === 'tools');
      expect(retained).toHaveLength(5);
      expect(leftFrames.map(frame => frame.id)).toEqual(retained.map(frame => frame.id).reverse());
      const replay = renderFrames(await openStream(f.gateway, session.id)());
      expect(replay).toEqual(leftFrames);
      const resumed = renderFrames(await openStream(f.gateway, session.id, ['turn', 'tools'], leftFrames[0]!.id)());
      expect(resumed).toEqual(leftFrames.slice(1));
    } finally { f.gateway.closeWebSocketClient(client.clientId); }
  });

  test('unobserved ordinary/foreign sessions are not captured, and native replay/live delivery respect session and domain filters', async () => {
    const f = await fixture();
    const owned = await f.createNative(), foreign = await f.createNative();
    const ordinary = await f.manager.create({ workspaceRoot: f.workspace });
    emitTurn(f.bus, ordinary.id); emitTurn(f.bus, 'not-hosted'); await flush();
    expect(f.gateway.listRecentEvents(500).filter(frame => frame.event === 'turn' || frame.event === 'tools')).toEqual([]);
    emitTurn(f.bus, foreign.id); emitTurn(f.bus, owned.id); await flush();
    const replay = renderFrames(await openStream(f.gateway, owned.id, ['turn'])());
    expect(replay).toHaveLength(3);
    expect(replay.every(frame => frame.event === 'turn' && frame.payload.sessionId === owned.id)).toBe(true);
    f.gateway.trimRetainedEvents('flush');
    const live = openStream(f.gateway, owned.id, ['turn']);
    emitTurn(f.bus, foreign.id); emitTurn(f.bus, owned.id); await flush();
    expect(renderFrames(await live()).map(frame => [frame.event, frame.payload.sessionId])).toEqual(Array(3).fill(['turn', owned.id]));
  });

  test('dispose stops new capture, including callbacks already queued before unsubscribe', async () => {
    const f = await fixture();
    const session = await f.createNative();
    const ctx = { sessionId: session.id, source: 'orchestrator', traceId: 'dispose' };
    emitStreamDelta(f.bus, ctx, { turnId: 'queued', content: 'queued', accumulated: 'queued' });
    await f.manager.dispose();
    emitStreamDelta(f.bus, ctx, { turnId: 'after', content: 'after', accumulated: 'after' });
    await flush();
    expect(f.gateway.listRecentEvents(500).filter(frame => frame.event === 'turn' || frame.event === 'tools')).toEqual([]);
  });

  test('native retention stays in the existing bounded ring and honors trim and unknown resume', async () => {
    const f = await fixture();
    const session = await f.createNative();
    const ctx = { sessionId: session.id, source: 'orchestrator', traceId: 'bounded' };
    f.gateway.trimRetainedEvents('flush');
    emitStreamDelta(f.bus, ctx, { turnId: 'turn', content: 'first', accumulated: 'first' }); await flush();
    const firstId = f.gateway.listRecentEvents()[0]!.id;
    for (let index = 0; index < 501; index++) emitStreamDelta(f.bus, ctx, { turnId: 'turn', content: String(index), accumulated: String(index) });
    await flush();
    expect(f.gateway.retainedEventCount()).toBe(500);
    expect(f.gateway.listRecentEvents(1000).some(frame => frame.id === firstId)).toBe(false);
    const catchup = renderFrames(await openStream(f.gateway, session.id, ['turn'])());
    expect(catchup).toHaveLength(20);
    expect(catchup.map(frame => frame.payload.payload?.content)).toEqual(Array.from({ length: 20 }, (_, index) => String(481 + index)));
    expect(catchup.every(frame => frame.payload.type === 'STREAM_DELTA' && frame.payload.payload?.origin === undefined)).toBe(true);
    expect(renderFrames(await openStream(f.gateway, session.id, ['turn'], firstId)())).toEqual([]);
    f.gateway.trimRetainedEvents('floor');
    expect(f.gateway.retainedEventCount()).toBe(250);
    f.gateway.trimRetainedEvents('flush');
    expect(f.gateway.retainedEventCount()).toBe(0);
    expect(renderFrames(await openStream(f.gateway, session.id)())).toEqual([]);
  });
});
