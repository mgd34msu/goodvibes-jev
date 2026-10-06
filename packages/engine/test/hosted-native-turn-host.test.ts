import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { RouteBindingManager } from '../sdk/src/platform/channels/index.ts';
import { SharedSessionBroker } from '../sdk/src/platform/control-plane/session-broker.ts';
import { createNativeHostedTurnHost, NATIVE_HOSTED_TURN_SCOPES, type NativeHostedTurnHost } from '../sdk/src/platform/hosted-sessions/native-turn-host.ts';
import { NativeHostedTurnJournal, type NativeHostedTurnIdentity, type NativeHostedTurnJournalIO } from '../sdk/src/platform/hosted-sessions/native-turn-journal.ts';
import type { NativeHostedTurnLookup, NativeHostedTurnSnapshot } from '../sdk/src/platform/hosted-sessions/native-turn-wire.ts';
import { HostedSessionManager } from '../sdk/src/platform/hosted-sessions/manager.ts';
import { HostedSessionStore } from '../sdk/src/platform/hosted-sessions/store.ts';
import type { HostedSessionRuntime } from '../sdk/src/platform/hosted-sessions/session-runtime.ts';
import { createClientRuntimeServices } from '../sdk/src/platform/runtime/client-services.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';
import { AtomicWriteDurabilityError, confirmFileDurable, writeJsonFileAtomic } from '../sdk/src/platform/state/durable-file-io.ts';
import { createOperatorNativeConversationIntakeClient, readNativeConversationTurnPermit, type NativeConversationIntakeResult, type NativeConversationTurnPermit, type NativeConversationTurnSource } from '../sdk/src/platform/workflow/work-ledger/native-intake-client.ts';
import type { OperatorRemoteClient } from '../operator-sdk/src/client-core.ts';
import type { NativePairedExecutionAuthority, NativePairedExecutionSnapshot } from '../sdk/src/platform/workflow/work-ledger/native-execution.ts';
import type { ChatRequest, ChatResponse, LLMProvider } from '../sdk/src/platform/providers/interface.ts';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry.ts';
import { installHostedSessionReadings } from './_helpers/hosted-session-readings.ts';

const exactText = '  Answer café e\u0301 🧭\r\n\tPreserve this source.  ';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function snapshot(value: NativeHostedTurnLookup): NativeHostedTurnSnapshot {
  if ('kind' in value) throw new Error('Expected a persisted native hosted turn');
  return value;
}
async function eventually<T>(read: () => Promise<T> | T, check: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5_000;
  while (true) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() >= end) throw new Error(`Timed out waiting for native hosted turn: ${JSON.stringify(value)}`);
    await Bun.sleep(2);
  }
}
const answer = (): ChatResponse => ({ content: 'Owned synthetic answer', toolCalls: [], stopReason: 'completed', usage: { inputTokens: 1, outputTokens: 1 } });

async function fixture(options: {
  journalIO?: Partial<NativeHostedTurnJournalIO>;
  beforeCreate?: () => Promise<void>;
  beforeDeliver?: (permit: NativeConversationTurnPermit) => Promise<void>;
  afterDeliver?: (permit: NativeConversationTurnPermit) => Promise<void>;
  chat?: (request: ChatRequest) => Promise<ChatResponse>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hosted-native-host-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const projectId = `project-${randomUUID()}`, inputId = randomUUID();
  const source: NativeConversationTurnSource = { kind: 'turn', projectId, requestId: `request-${inputId}`,
    sourceRef: { version: 1, inputId, sourceId: `source-${inputId}`, sourceRevision: 'revision-1', sessionId: 'native-source-session' },
    route: 'answer', text: exactText };
  let current: NativeConversationIntakeResult = structuredClone(source);
  let authoritySnapshot: NativePairedExecutionSnapshot | null = {
    kind: 'pairing-token', principalId: 'owned-principal', authorityId: 'owned-principal', tokenId: 'owned-token', authorityRevision: 'owned-token', scopes: [...NATIVE_HOSTED_TURN_SCOPES],
  };
  let authorized = true;
  const authority: NativePairedExecutionAuthority = {
    current: () => authoritySnapshot,
    async withCurrent(expected, callback) {
      return callback(() => {
        if (JSON.stringify(expected) !== JSON.stringify(authoritySnapshot) || !authoritySnapshot) throw new Error('Authority changed');
        return authoritySnapshot;
      });
    },
  };
  const counts = { creates: 0, deliveries: 0, cancellations: 0, admits: 0, gets: 0, legacySends: 0, continuations: 0 };
  const requests: ChatRequest[] = [];
  const runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({ surfaceRoot: 'goodvibes', configDir: join(root, 'config'), workingDir: workspace, homeDir: root });
  const services = createClientRuntimeServices({ configManager, runtimeBus, runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes',
    workingDir: workspace, homeDirectory: root, requestApproval: async () => ({ approved: false }), modelDiscovery: 'skip' });
  const model: ModelDefinition = { id: 'native-fixture', provider: 'native-fixture', registryKey: 'native-fixture:native-fixture', displayName: 'Native fixture', description: '',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false }, contextWindow: 8192, selectable: true };
  services.providerRegistry.registerRuntimeProvider({ models: [model], replace: true, provider: {
    name: 'native-fixture', models: ['native-fixture'], credentialAuthority: 'anonymous', modelSource: { kind: 'dated-static', asOf: '2026-01-01' }, isConfigured: () => true,
    chat: async (request: ChatRequest) => { requests.push(request); return options.chat ? options.chat(request) : answer(); },
  } as unknown as LLMProvider });
  services.providerRegistry.setCurrentModel(model.registryKey);
  const readings = installHostedSessionReadings();
  const brokerPath = join(root, 'broker.json');
  const broker = new SharedSessionBroker({ storePath: brokerPath,
    routeBindings: { start: async () => {}, stop: async () => {}, list: () => [], find: () => null, getBinding: () => null } as unknown as RouteBindingManager,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => { counts.legacySends++; return true; } },
  });
  broker.setContinuationRunner(async () => { counts.continuations++; throw new Error('Legacy continuation ran'); });
  const manager = new HostedSessionManager({ floorFactory: () => ({ services, contractRunner: services.contractRunner, dispose: () => services.dispose() }),
    store: new HostedSessionStore(join(root, 'sessions'), { maxSessions: 20, maxMessagesPerSession: 100, terminatedRetentionMs: 60_000 }),
    settings: { detachPolicy: () => 'survive', maxSessions: () => 10, attachmentTtlMs: () => 60_000 },
    runtimeBus, systemPrompt: () => 'Owned native-host fixture', spine: broker, isWorkspaceUsable: () => true, intakeIntervalMs: 60_000,
  });
  await manager.init();
  const journalPath = join(root, 'native-turns.json');
  const identity: NativeHostedTurnIdentity = { projectId, principalId: 'owned-principal', requestId: source.requestId, inputId,
    sourceId: source.sourceRef.sourceId, sourceRevision: source.sourceRef.sourceRevision, sourceSessionId: source.sourceRef.sessionId };
  const journal = new NativeHostedTurnJournal(journalPath, options.journalIO);
  const getHooks: (() => void | Promise<void>)[] = [];
  const admitHooks: (() => void | Promise<void>)[] = [];
  const deps = { projectId, projectRoot: workspace, journalPath, journal, broker,
    intake: {
      get: async () => { counts.gets++; await getHooks.shift()?.(); return structuredClone(current); },
      admit: async () => { counts.admits++; await admitHooks.shift()?.(); return structuredClone(current); },
    },
    manager: {
      create: async (input: Parameters<HostedSessionManager['create']>[0]) => { counts.creates++; await options.beforeCreate?.(); return manager.create(input); },
      deliverNative: async (sessionId: string, brokerInputId: string, permit: NativeConversationTurnPermit) => {
        counts.deliveries++;
        expect(readNativeConversationTurnPermit(permit)).toEqual(source);
        await options.beforeDeliver?.(permit);
        await manager.deliverNative(sessionId, brokerInputId, permit);
        await options.afterDeliver?.(permit);
      },
      kill: (sessionId: string) => manager.kill(sessionId),
      cancelNative: (sessionId: string, permit: NativeConversationTurnPermit) => { counts.cancellations++; manager.cancelNative(sessionId, permit); },
    },
  };
  const hosts: NativeHostedTurnHost[] = [createNativeHostedTurnHost(deps)];
  const request = { projectId, inputId, sourceRevision: source.sourceRef.sourceRevision };
  const access = { isAuthorized: () => authorized };
  cleanups.push(async () => {
    await Promise.all(hosts.map(host => host.close()));
    await manager.dispose(); await broker.stop(); readings.restore(); services.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, brokerPath, journalPath, source, request, authority, access, journal, identity, broker, manager, counts, requests, readings,
    host: hosts[0]!, getHooks, admitHooks,
    setSource(value: NativeConversationIntakeResult) { current = value; },
    revoke() { authoritySnapshot = null; },
    deny() { authorized = false; },
    setAuthority(value: NativePairedExecutionSnapshot | null) { authoritySnapshot = value; },
    newHost() { const host = createNativeHostedTurnHost({ ...deps, journal: new NativeHostedTurnJournal(journalPath) }); hosts.push(host); return host; },
    async status() { return hosts[0]!.status(request, authority, access); },
    async settled() { return snapshot(await eventually(() => hosts[0]!.status(request, authority, access), value => !('kind' in value) && ['completed', 'cancelled', 'recovery-required'].includes(value.state))); },
    runtime(sessionId: string) {
      const live = (manager as unknown as { sessions: Map<string, { runtime: HostedSessionRuntime | null }> }).sessions.get(sessionId);
      if (!live?.runtime) throw new Error('Expected real hosted runtime');
      return live.runtime;
    },
  };
}

describe('native hosted owner through real broker, manager and runtime', () => {
  test('preserves exact source bytes, canonical broker identity, and consumes only the real completed turn', async () => {
    const gate = deferred();
    const f = await fixture({ chat: async () => { await gate.promise; return answer(); } });
    try {
      expect(await f.status()).toEqual({ kind: 'not-found' });
      expect(existsSync(f.journalPath)).toBe(false);
      expect(f.counts).toMatchObject({ creates: 0, admits: 0, deliveries: 0 });
      const started = snapshot(await f.host.start(f.request, f.authority, f.access));
      expect(started.state).toBe('running');
      await eventually(() => f.requests.length, value => value === 1);
      const input = f.broker.getInputsSince(started.sessionId!)[0]!;
      expect(input).toMatchObject({ id: started.brokerInputId, correlationId: `session-input:${started.brokerInputId}`, body: exactText, state: 'delivered' });
      expect(started.correlationId).toBe(input.correlationId);
      expect(input.id).not.toBe(f.request.inputId);
      expect(input.id).not.toBe(input.correlationId);
      expect(f.requests[0]!.messages.find(message => message.role === 'user')?.content).toBe(exactText);
      expect(f.manager.historyOf(started.sessionId!).find(message => message.role === 'user')?.content).toBe(exactText);
      expect(JSON.parse(readFileSync(f.brokerPath, 'utf8')).inputs.find((value: { id: string }) => value.id === input.id)).toMatchObject({ id: input.id, body: exactText, state: 'delivered' });
      expect(await f.host.start(f.request, f.authority, f.access)).toEqual(started);
      expect(await f.status()).toEqual(started);
      expect(f.counts).toMatchObject({ creates: 1, admits: 1, deliveries: 1, legacySends: 0, continuations: 0 });
      gate.resolve();
      const complete = await f.settled();
      expect(complete).toEqual({ ...started, state: 'completed' });
      expect(f.broker.getInputsSince(started.sessionId!)[0]!.state).toBe('completed');
      expect(await f.host.start(f.request, f.authority, f.access)).toEqual(complete);
      expect(await f.newHost().start(f.request, f.authority, f.access)).toEqual(complete);
      expect(f.requests).toHaveLength(1);
      expect(f.readings.requests.filter(value => value.context?.battery === 'contract.request-route')).toHaveLength(0);
    } finally { gate.resolve(); }
  });

  test('concurrent duplicate starts share one preparation and broker reservation', async () => {
    const created = deferred(), gate = deferred();
    const f = await fixture({ beforeCreate: async () => { created.resolve(); await gate.promise; } });
    const first = f.host.start(f.request, f.authority, f.access);
    await created.promise;
    const second = f.host.start(f.request, f.authority, f.access);
    try {
      expect(snapshot(await f.status()).state).toBe('preparing');
      expect(f.counts.creates).toBe(1);
    } finally { gate.resolve(); }
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect((await f.settled()).state).toBe('completed');
    expect(f.counts).toMatchObject({ creates: 1, admits: 1, deliveries: 1 });
    expect(f.broker.getInputsSince(snapshot(left).sessionId!)).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
  });

  test('cancel before start persists a tombstone that status, retries and restart cannot execute', async () => {
    const f = await fixture();
    const cancelled = snapshot(await f.host.cancel(f.request, f.authority, f.access));
    expect(cancelled).toMatchObject({ state: 'cancelled', sessionId: null, brokerInputId: null, correlationId: null });
    expect(await f.host.start(f.request, f.authority, f.access)).toEqual(cancelled);
    expect(await f.newHost().start(f.request, f.authority, f.access)).toEqual(cancelled);
    expect(await f.status()).toEqual(cancelled);
    expect(f.counts).toMatchObject({ creates: 0, admits: 0, deliveries: 0 });
    expect(f.requests).toHaveLength(0);
  });

  test('cancel during preparation fences model and reservation even if session creation finishes later', async () => {
    const created = deferred(), gate = deferred();
    const f = await fixture({ beforeCreate: async () => { created.resolve(); await gate.promise; } });
    const starting = f.host.start(f.request, f.authority, f.access).then(value => ({ value }), error => ({ error }));
    await created.promise;
    const cancelling = f.host.cancel(f.request, f.authority, f.access);
    try { await eventually(() => f.journal.read(f.identity), record => record?.state === 'cancelled'); }
    finally { gate.resolve(); }
    expect(await starting).toHaveProperty('error');
    expect(snapshot(await cancelling).state).toBe('cancelled');
    expect(f.counts.deliveries).toBe(0); expect(f.requests).toHaveLength(0);
    expect(f.manager.list()).toHaveLength(0);
    expect(f.manager.list({ includeTerminated: true }).flatMap(session => f.broker.getInputsSince(session.id))).toHaveLength(0);
    expect(snapshot(await f.host.start(f.request, f.authority, f.access)).state).toBe('cancelled');
  });

  test('cancel while running drains ownership without a completed receipt or replay', async () => {
    const gate = deferred(), entered = deferred();
    const f = await fixture({ chat: async () => { entered.resolve(); await gate.promise; return answer(); } });
    const started = snapshot(await f.host.start(f.request, f.authority, f.access));
    await entered.promise;
    let cancellationReturned = false;
    const cancelling = f.host.cancel(f.request, f.authority, f.access).then(value => { cancellationReturned = true; return value; });
    try {
      await eventually(() => f.counts.cancellations, value => value > 0);
      expect(f.requests[0]!.signal?.aborted).toBe(true);
      expect(snapshot(await f.status())).toEqual({ ...started, state: 'cancelling' });
      expect(snapshot(await f.host.start(f.request, f.authority, f.access))).toEqual({ ...started, state: 'cancelling' });
      expect((await f.journal.read(f.identity))?.state).toBe('dispatching');
      expect(f.broker.getInputsSince(started.sessionId!)[0]!.state).toBe('delivered');
      expect(cancellationReturned).toBe(false);
    } finally { gate.resolve(); }
    expect(snapshot(await cancelling)).toEqual({ ...started, state: 'cancelled' });
    expect(snapshot(await f.status()).state).toBe('cancelled');
    expect(['failed', 'cancelled']).toContain(f.broker.getInputsSince(started.sessionId!)[0]!.state);
    expect(f.broker.countBusySessions()).toBe(0);
    expect(snapshot(await f.host.start(f.request, f.authority, f.access)).state).toBe('cancelled');
    expect(f.requests).toHaveLength(1);
  });

  test('revocation before the runtime executes is revalidated by the genuine permit', async () => {
    const reached = deferred(), gate = deferred();
    const f = await fixture({ beforeDeliver: async () => { reached.resolve(); await gate.promise; } });
    const started = snapshot(await f.host.start(f.request, f.authority, f.access));
    await reached.promise; f.revoke(); gate.resolve();
    await eventually(() => f.journal.read(f.identity), record => record?.state === 'recovery-required');
    expect(f.requests).toHaveLength(0);
    expect(f.manager.historyOf(started.sessionId!).filter(message => message.role === 'user')).toHaveLength(0);
    expect(f.broker.getInputsSince(started.sessionId!)[0]!.state).not.toBe('completed');
    await expect(f.status()).rejects.toThrow('forbidden');
  });

  test('an admitted source changing before execution cannot reach the model', async () => {
    const reached = deferred(), gate = deferred();
    const f = await fixture({ beforeDeliver: async () => { reached.resolve(); await gate.promise; } });
    const started = snapshot(await f.host.start(f.request, f.authority, f.access));
    await reached.promise;
    f.setSource({ ...f.source, text: 'Different source content' }); gate.resolve();
    expect((await f.settled()).state).toBe('recovery-required');
    expect(f.requests).toHaveLength(0);
    expect(f.manager.historyOf(started.sessionId!).filter(message => message.role === 'user')).toHaveLength(0);
    expect(f.broker.getInputsSince(started.sessionId!)[0]!.state).not.toBe('completed');
  });

  test('a real provider failure remains recovery-required and never consumes or replays the input', async () => {
    const f = await fixture({ chat: async () => { throw new Error('Owned synthetic provider failure'); } });
    const started = snapshot(await f.host.start(f.request, f.authority, f.access));
    expect((await f.settled()).state).toBe('recovery-required');
    const attempts = f.requests.length;
    expect(attempts).toBeGreaterThan(0);
    expect(f.broker.getInputsSince(started.sessionId!)[0]!.state).toBe('failed');
    expect(f.broker.countBusySessions()).toBe(0);
    expect(snapshot(await f.host.start(f.request, f.authority, f.access)).state).toBe('recovery-required');
    expect(snapshot(await f.newHost().start(f.request, f.authority, f.access)).state).toBe('recovery-required');
    expect(f.requests).toHaveLength(attempts);
    expect(f.counts.deliveries).toBe(1);
  });
});

describe('native hosted authority and input boundaries', () => {
  test('forged request fields and wrong source identities cause no claim, session or model effects', async () => {
    const f = await fixture();
    for (const extra of [{ text: 'forged' }, { brokerInputId: 'sin-forged' }, { correlationId: 'forged' }, { sourceRef: f.source.sourceRef }, { permit: {} }]) {
      await expect(f.host.start({ ...f.request, ...extra }, f.authority, f.access)).rejects.toThrow();
    }
    for (const changed of [{ projectId: 'another-project' }, { inputId: 'another-input' }, { sourceRevision: 'another-revision' }]) {
      await expect(f.host.start({ ...f.request, ...changed }, f.authority, f.access)).rejects.toThrow('stale');
    }
    for (const changed of [
      { ...f.source, projectId: 'another-project' },
      { ...f.source, sourceRef: { ...f.source.sourceRef, inputId: 'another-input' } },
      { ...f.source, sourceRef: { ...f.source.sourceRef, sourceRevision: 'another-revision' } },
    ]) {
      f.setSource(changed);
      await expect(f.host.start(f.request, f.authority, f.access)).rejects.toThrow('stale');
    }
    f.setSource({ kind: 'cancelled', projectId: f.source.projectId, requestId: f.source.requestId, sourceRef: f.source.sourceRef });
    await expect(f.host.start(f.request, f.authority, f.access)).rejects.toThrow('not-turn');
    expect(await f.journal.read(f.identity)).toBeNull();
    expect(f.counts).toMatchObject({ creates: 0, admits: 0, deliveries: 0 });
    expect(f.requests).toHaveLength(0);
  });

  test('only current, matching paired authority with all three scopes may read or start', async () => {
    const f = await fixture();
    const valid = f.authority.current()!;
    for (const invalid of [null, { ...valid, kind: 'local' }, { ...valid, principalId: 'other' }, { ...valid, authorityRevision: 'other' },
      ...NATIVE_HOSTED_TURN_SCOPES.map(scope => ({ ...valid, scopes: valid.scopes.filter(value => value !== scope) }))]) {
      f.setAuthority(invalid as NativePairedExecutionSnapshot | null);
      await expect(f.host.start(f.request, f.authority, f.access)).rejects.toThrow('forbidden');
      await expect(f.status()).rejects.toThrow('forbidden');
      await expect(f.host.cancel(f.request, f.authority, f.access)).rejects.toThrow('forbidden');
    }
    f.setAuthority(valid); f.deny();
    await expect(f.host.start(f.request, f.authority, f.access)).rejects.toThrow('forbidden');
    expect(f.counts).toMatchObject({ gets: 0, creates: 0, admits: 0, deliveries: 0 });
    expect(await f.journal.read(f.identity)).toBeNull();
  });

  test('a revoked authority or changed source during admission never creates a hosted session', async () => {
    for (const change of ['revoke', 'source'] as const) {
      const f = await fixture();
      f.admitHooks.push(() => {
        if (change === 'revoke') f.revoke();
        else f.setSource({ ...f.source, text: 'Replaced during admission' });
      });
      await expect(f.host.start(f.request, f.authority, f.access)).rejects.toThrow(change === 'revoke' ? 'forbidden' : 'stale');
      expect(f.counts).toMatchObject({ creates: 0, deliveries: 0 });
      expect(f.requests).toHaveLength(0);
      expect(await f.journal.read(f.identity)).not.toBeNull();
    }
  });

  test('principal and token replacement during source lookup cannot borrow the original claim', async () => {
    for (const change of ['principal', 'token'] as const) {
      const f = await fixture();
      const valid = f.authority.current()!;
      f.getHooks.push(() => f.setAuthority(change === 'principal'
        ? { ...valid, principalId: 'replacement', authorityId: 'replacement' }
        : { ...valid, tokenId: 'replacement', authorityRevision: 'replacement' }));
      await expect(f.host.start(f.request, f.authority, f.access)).rejects.toThrow('stale');
      expect(f.counts.creates).toBe(0); expect(f.requests).toHaveLength(0);
      expect(await f.journal.read(f.identity)).toBeNull();
    }
  });

  test('principal and token replacement after source lookup cannot execute under a stale claim', async () => {
    for (const change of ['principal', 'token'] as const) {
      const f = await fixture();
      const valid = f.authority.current()!;
      f.admitHooks.push(() => f.setAuthority(change === 'principal'
        ? { ...valid, principalId: 'replacement', authorityId: 'replacement' }
        : { ...valid, tokenId: 'replacement', authorityRevision: 'replacement' }));
      await expect(f.host.start(f.request, f.authority, f.access)).rejects.toThrow();
      expect(f.counts.creates).toBe(0); expect(f.requests).toHaveLength(0);
    }
  });

  test('manager requires the actual canonical broker input ID; source and correlation metadata cannot substitute', async () => {
    const reached = deferred<NativeConversationTurnPermit>(), gate = deferred();
    const f = await fixture({ beforeDeliver: async permit => { reached.resolve(permit); await gate.promise; } });
    const started = snapshot(await f.host.start(f.request, f.authority, f.access));
    const permit = await reached.promise;
    try {
      for (const forgedId of [f.request.inputId, f.source.sourceRef.sourceId, started.correlationId!, 'sin-forged']) {
        await expect(f.manager.deliverNative(started.sessionId!, forgedId, permit)).rejects.toThrow('identity mismatch');
        await expect(f.broker.settleNativeTurnInput(started.sessionId!, forgedId, permit, 'completed')).rejects.toThrow('settlement mismatch');
      }
      await expect(f.manager.deliverNative(started.sessionId!, started.brokerInputId!, {} as NativeConversationTurnPermit)).rejects.toThrow('invalid_turn_permit');
      await expect(f.broker.settleNativeTurnInput(started.sessionId!, started.brokerInputId!, {} as NativeConversationTurnPermit, 'completed')).rejects.toThrow('invalid_turn_permit');
      expect(f.requests).toHaveLength(0);
      expect(f.broker.getInputsSince(started.sessionId!)[0]!.state).toBe('delivered');
    } finally { gate.resolve(); }
    expect((await f.settled()).state).toBe('completed');
    expect(f.requests).toHaveLength(1);
  });

  test('runtime refuses compaction and thinking queues rather than treating an enqueue as completion', async () => {
    for (const busy of ['isCompacting', 'isThinking', 'turnInFlight'] as const) {
      const reached = deferred(), gate = deferred();
      const f = await fixture({ beforeDeliver: async () => { reached.resolve(); await gate.promise; } });
      const started = snapshot(await f.host.start(f.request, f.authority, f.access));
      await reached.promise;
      const runtime = f.runtime(started.sessionId!);
      const internals = runtime.orchestrator as unknown as Record<typeof busy, boolean>;
      internals[busy] = true;
      try {
        gate.resolve();
        expect((await f.settled()).state).toBe('recovery-required');
        expect(runtime.orchestrator.messageQueue).toHaveLength(0);
        expect(f.requests).toHaveLength(0);
        expect(f.broker.getInputsSince(started.sessionId!)[0]!.state).not.toBe('completed');
      } finally { internals[busy] = false; gate.resolve(); }
    }
  });
});

describe('native hosted strict persistence and recovery fences', () => {
  test('a strict claim write failure causes no intake admission, session or turn', async () => {
    const failure = new Error('Owned synthetic claim write failure');
    const f = await fixture({ journalIO: { writeJsonFileAtomic() { throw failure; } } });
    await expect(f.host.start(f.request, f.authority, f.access)).rejects.toBe(failure);
    expect(await f.status()).toEqual({ kind: 'not-found' });
    expect(f.counts).toMatchObject({ creates: 0, admits: 0, deliveries: 0 });
    expect(f.requests).toHaveLength(0);
  });

  test('an ambiguously published claim remains fenced through status and a new host', async () => {
    let failure: AtomicWriteDurabilityError | undefined;
    const f = await fixture({ journalIO: { writeJsonFileAtomic(path, value, options) {
      expect(options?.durable).toBe(true); writeJsonFileAtomic(path, value, options);
      failure = new AtomicWriteDurabilityError(path, 'published-indeterminate', new Error('Owned synthetic sync failure')); throw failure;
    } } });
    await expect(f.host.start(f.request, f.authority, f.access)).rejects.toBeInstanceOf(AtomicWriteDurabilityError);
    expect(failure).toBeDefined();
    const recovered = snapshot(await f.status());
    expect(recovered).toMatchObject({ state: 'recovery-required', sessionId: null, brokerInputId: null });
    expect(await f.host.start(f.request, f.authority, f.access)).toEqual(recovered);
    expect(await f.newHost().start(f.request, f.authority, f.access)).toEqual(recovered);
    expect(f.counts).toMatchObject({ creates: 0, admits: 0, deliveries: 0 });
    expect(f.requests).toHaveLength(0);
  });

  test('failed and ambiguously published dispatch writes never execute or reserve a second broker input', async () => {
    for (const published of [false, true]) {
      let writes = 0;
      const f = await fixture({ journalIO: { writeJsonFileAtomic(path, value, options) {
        expect(options?.durable).toBe(true); writes++;
        if (writes === 2) {
          if (published) writeJsonFileAtomic(path, value, options);
          throw new AtomicWriteDurabilityError(path, published ? 'published-indeterminate' : 'before-publication', new Error('Owned synthetic dispatch failure'));
        }
        writeJsonFileAtomic(path, value, options);
      } } });
      await expect(f.host.start(f.request, f.authority, f.access)).rejects.toBeInstanceOf(AtomicWriteDurabilityError);
      expect(snapshot(await f.status()).state).toBe('recovery-required');
      expect(snapshot(await f.host.start(f.request, f.authority, f.access)).state).toBe('recovery-required');
      expect(snapshot(await f.newHost().start(f.request, f.authority, f.access)).state).toBe('recovery-required');
      expect(f.counts).toMatchObject({ creates: 1, admits: 1, deliveries: 0 });
      expect(f.requests).toHaveLength(0);
      expect(f.manager.list()).toHaveLength(0);
      expect(f.broker.countBusySessions()).toBe(0);
      const retained = f.manager.list({ includeTerminated: true }).flatMap(session => f.broker.getInputsSince(session.id));
      expect(retained).toHaveLength(1);
      expect(retained[0]!.state).toBe('failed');
    }
  });

  test('recovered preparing and dispatching records are observations, never permission to resume execution', async () => {
    for (const state of ['preparing', 'dispatching'] as const) {
      const f = await fixture();
      await f.journal.claim(f.identity);
      if (state === 'dispatching') await f.journal.transition(f.identity, 'preparing', {
        state, sessionId: 'hosted-old', brokerInputId: 'sin-old', correlationId: 'session-input:sin-old',
      });
      const observed = snapshot(await f.newHost().start(f.request, f.authority, f.access));
      expect(observed.state).toBe('recovery-required');
      expect(await f.host.start(f.request, f.authority, f.access)).toEqual(observed);
      expect(f.counts).toMatchObject({ creates: 0, admits: 0, deliveries: 0 });
      expect(f.requests).toHaveLength(0);
    }
  });

  test('a failed completion journal write remains recovery-required after the real answer', async () => {
    let writes = 0;
    const f = await fixture({ journalIO: { writeJsonFileAtomic(path, value, options) {
      if (++writes === 3) throw new Error('Owned synthetic completion write failure');
      writeJsonFileAtomic(path, value, options);
    } } });
    await f.host.start(f.request, f.authority, f.access);
    expect((await f.settled()).state).toBe('recovery-required');
    expect(f.requests).toHaveLength(1);
    expect(snapshot(await f.host.start(f.request, f.authority, f.access)).state).toBe('recovery-required');
    expect(f.requests).toHaveLength(1);
  });
});

describe('native manager broker ownership', () => {
  test('a completed broker input is not fresh authority to execute an unclaimed native permit', async () => {
    const reached = deferred<NativeConversationTurnPermit>(), gate = deferred();
    const f = await fixture({ beforeDeliver: async permit => { reached.resolve(permit); await gate.promise; } });
    const started = snapshot(await f.host.start(f.request, f.authority, f.access));
    const permit = await reached.promise;
    try {
      await f.broker.markInputDelivered(started.sessionId!, started.brokerInputId!, { consumed: true });
      await expect(f.manager.deliverNative(started.sessionId!, started.brokerInputId!, permit)).rejects.toThrow();
      expect(f.requests).toHaveLength(0);
    } finally { gate.resolve(); }
    expect((await f.settled()).state).toBe('recovery-required');
  });

  test('matching source text cannot substitute a different genuine source permit for a reserved broker input', async () => {
    const reached = deferred(), gate = deferred();
    const f = await fixture({ beforeDeliver: async () => { reached.resolve(); await gate.promise; } });
    const started = snapshot(await f.host.start(f.request, f.authority, f.access));
    await reached.promise;
    const variants: NativeConversationTurnSource[] = [
      { ...f.source, projectId: 'different-project' },
      { ...f.source, requestId: 'different-request' },
      ...(['inputId', 'sourceId', 'sourceRevision', 'sessionId'] as const).map(key => ({
        ...f.source, sourceRef: { ...f.source.sourceRef, [key]: `different-${key}` },
      })),
    ];
    try {
      for (const otherSource of variants) {
        const invoke: OperatorRemoteClient['invoke'] = async <T>() => structuredClone(otherSource) as T;
        const client = createOperatorNativeConversationIntakeClient({ invoke }, otherSource.projectId);
        try {
          const eligible = await client.admit({ inputId: otherSource.sourceRef.inputId, sourceRevision: otherSource.sourceRef.sourceRevision });
          const otherPermit = client.bindTurn(eligible);
          expect(readNativeConversationTurnPermit(otherPermit).text).toBe(exactText);
          await expect(f.manager.deliverNative(started.sessionId!, started.brokerInputId!, otherPermit)).rejects.toThrow('identity mismatch');
          for (const state of ['completed', 'cancelled', 'failed'] as const) {
            await expect(f.broker.settleNativeTurnInput(started.sessionId!, started.brokerInputId!, otherPermit, state)).rejects.toThrow('settlement mismatch');
          }
          expect(f.broker.getInputsSince(started.sessionId!)[0]!.state).toBe('delivered');
          expect(f.broker.countBusySessions()).toBe(1);
          expect(f.requests).toHaveLength(0);
        } finally { client.dispose(); }
      }
    } finally { gate.resolve(); }
    expect((await f.settled()).state).toBe('completed');
    expect(f.requests).toHaveLength(1);
  });
});

test('ambiguous completion publication cannot produce a success receipt until terminal durability is confirmed', async () => {
  let writes = 0, confirmations = 0, unavailable = true;
  const f = await fixture({ journalIO: {
    writeJsonFileAtomic(path, value, options) {
      writeJsonFileAtomic(path, value, options);
      if (++writes === 3) throw new AtomicWriteDurabilityError(path, 'published-indeterminate', new Error('Owned synthetic completion fsync failure'));
    },
    confirmFileDurable(path) {
      confirmations++;
      if (unavailable) throw new Error('Owned synthetic confirmation remains unavailable');
      confirmFileDurable(path);
    },
  } });
  await f.host.start(f.request, f.authority, f.access);
  await eventually(() => JSON.parse(readFileSync(f.journalPath, 'utf8')).records[0].state as string, state => state === 'completed');
  await expect(f.status()).rejects.toThrow('confirmation remains unavailable');
  await expect(f.host.start(f.request, f.authority, f.access)).rejects.toThrow('confirmation remains unavailable');
  expect(confirmations).toBeGreaterThan(0);
  expect(f.requests).toHaveLength(1);
  unavailable = false;
  expect(snapshot(await f.status()).state).toBe('completed');
  expect(snapshot(await f.host.start(f.request, f.authority, f.access)).state).toBe('completed');
  expect(f.requests).toHaveLength(1);
});

describe('native cancellation owns only its actual turn lifetime', () => {
  test('another host cannot cancel or mutate a live owner dispatch in the shared journal', async () => {
    const entered = deferred(), gate = deferred();
    const f = await fixture({ chat: async () => { entered.resolve(); await gate.promise; return answer(); } });
    const started = snapshot(await f.host.start(f.request, f.authority, f.access));
    await entered.promise;
    const otherHost = f.newHost();
    try {
      const before = readFileSync(f.journalPath, 'utf8');
      const inputs = structuredClone(f.broker.getInputsSince(started.sessionId!));
      expect(snapshot(await otherHost.cancel(f.request, f.authority, f.access))).toEqual({ ...started, state: 'recovery-required' });
      expect(readFileSync(f.journalPath, 'utf8')).toBe(before);
      expect(f.broker.getInputsSince(started.sessionId!)).toEqual(inputs);
      expect(f.broker.countBusySessions()).toBe(1);
      expect(snapshot(await f.status())).toEqual(started);
      expect(snapshot(await otherHost.start(f.request, f.authority, f.access))).toEqual({ ...started, state: 'recovery-required' });
      expect(f.counts).toMatchObject({ deliveries: 1, cancellations: 0 });
      expect(f.requests[0]!.signal?.aborted).toBe(false);
    } finally { gate.resolve(); }
    expect((await f.settled()).state).toBe('completed');
    expect(f.requests).toHaveLength(1);
  });

  test('nonlocal recovery records cannot be rewritten into cancellation receipts', async () => {
    for (const bound of [false, true]) {
      const f = await fixture();
      await f.journal.claim(f.identity);
      await f.journal.transition(f.identity, 'preparing', { state: 'recovery-required',
        sessionId: bound ? 'hosted-recovered' : null, brokerInputId: bound ? 'sin-recovered' : null, correlationId: bound ? 'session-input:sin-recovered' : null,
      });
      const before = readFileSync(f.journalPath, 'utf8');
      expect(snapshot(await f.host.cancel(f.request, f.authority, f.access)).state).toBe('recovery-required');
      expect(readFileSync(f.journalPath, 'utf8')).toBe(before);
      expect(f.counts).toMatchObject({ creates: 0, deliveries: 0, cancellations: 0 });
    }
  });

  test('a native completion neither waits for nor cancels an unrelated queued ordinary turn', async () => {
    const nativeEntered = deferred(), nativeGate = deferred(), ordinaryEntered = deferred<ChatRequest>(), ordinaryGate = deferred();
    const permitReady = deferred<NativeConversationTurnPermit>();
    const ordinaryText = 'An unrelated ordinary turn after the native answer';
    const f = await fixture({
      beforeDeliver: async permit => { permitReady.resolve(permit); },
      chat: async request => {
        if (request.messages.findLast(message => message.role === 'user')?.content === exactText) {
          nativeEntered.resolve(); await nativeGate.promise;
        } else { ordinaryEntered.resolve(request); await ordinaryGate.promise; }
        return answer();
      },
    });
    const started = snapshot(await f.host.start(f.request, f.authority, f.access));
    const permit = await permitReady.promise;
    await nativeEntered.promise;
    const runtime = f.runtime(started.sessionId!);
    try {
      await runtime.submit(ordinaryText);
      expect(runtime.orchestrator.messageQueue).toHaveLength(1);
      nativeGate.resolve();
      const ordinary = await ordinaryEntered.promise;
      expect(ordinary.signal?.aborted).toBe(false);
      expect((await f.settled()).state).toBe('completed');
      expect(f.broker.getInputsSince(started.sessionId!)[0]!.state).toBe('completed');
      expect(runtime.isRunning()).toBe(true);
      expect(snapshot(await f.host.cancel(f.request, f.authority, f.access)).state).toBe('completed');
      f.manager.cancelNative(started.sessionId!, permit);
      runtime.cancelNative(permit);
      expect(ordinary.signal?.aborted).toBe(false);
      expect(runtime.isRunning()).toBe(true);
      expect(f.requests).toHaveLength(2);
    } finally { nativeGate.resolve(); ordinaryGate.resolve(); }
    await eventually(() => runtime.isRunning(), running => !running);
    expect(f.manager.historyOf(started.sessionId!).filter(message => message.role === 'user').map(message => message.content)).toEqual([exactText, ordinaryText]);
  });

  test('native cancellation joins its own body but leaves the next queued ordinary turn running', async () => {
    const nativeEntered = deferred(), nativeGate = deferred(), ordinaryEntered = deferred<ChatRequest>(), ordinaryGate = deferred();
    const ordinaryText = 'Keep this separate queued ordinary turn alive';
    const f = await fixture({ chat: async request => {
      if (request.messages.findLast(message => message.role === 'user')?.content === exactText) {
        nativeEntered.resolve(); await nativeGate.promise;
      } else { ordinaryEntered.resolve(request); await ordinaryGate.promise; }
      return answer();
    } });
    const started = snapshot(await f.host.start(f.request, f.authority, f.access));
    await nativeEntered.promise;
    const runtime = f.runtime(started.sessionId!);
    let cancellationReturned = false;
    try {
      await runtime.submit(ordinaryText);
      const cancelled = f.host.cancel(f.request, f.authority, f.access).then(value => { cancellationReturned = true; return value; });
      await eventually(() => f.counts.cancellations, count => count > 0);
      expect(snapshot(await f.status()).state).toBe('cancelling');
      expect(cancellationReturned).toBe(false);
      nativeGate.resolve();
      const ordinary = await ordinaryEntered.promise;
      await eventually(() => cancellationReturned, returned => returned);
      expect(snapshot(await cancelled).state).toBe('cancelled');
      expect(ordinary.signal?.aborted).toBe(false);
      expect(runtime.isRunning()).toBe(true);
      expect(f.broker.getInputsSince(started.sessionId!)[0]!.state).not.toBe('completed');
    } finally { nativeGate.resolve(); ordinaryGate.resolve(); }
    await eventually(() => runtime.isRunning(), running => !running);
    expect(f.requests).toHaveLength(2);
  });
});

test('a dispatch that wins the cancellation CAS remains owned and cannot be relabelled cancelled', async () => {
  const f = await fixture();
  await f.journal.claim(f.identity);
  const transition = f.journal.transition.bind(f.journal);
  const dispatch = { state: 'dispatching' as const, sessionId: 'hosted-competing-owner', brokerInputId: 'sin-competing-owner', correlationId: 'session-input:sin-competing-owner' };
  let raced = false;
  f.journal.transition = async (identity, expected, next) => {
    if (!raced && expected === 'preparing' && next.state === 'cancelled') {
      raced = true;
      // A separate journal instance wins the real durable CAS after cancel read preparing.
      await new NativeHostedTurnJournal(f.journalPath).transition(identity, 'preparing', dispatch);
    }
    return transition(identity, expected, next);
  };
  const cancelled = snapshot(await f.host.cancel(f.request, f.authority, f.access));
  expect(raced).toBe(true);
  expect(cancelled).toMatchObject({ ...dispatch, state: 'recovery-required' });
  expect(await f.journal.read(f.identity)).toEqual({ identity: f.identity, ...dispatch });
  expect(f.counts).toMatchObject({ creates: 0, deliveries: 0, cancellations: 0 });
  expect(f.requests).toHaveLength(0);
});

test('broker settlement rejects nonterminal runtime state values without changing memory or durable bytes', async () => {
  const reached = deferred<NativeConversationTurnPermit>(), gate = deferred();
  const f = await fixture({ beforeDeliver: async permit => { reached.resolve(permit); await gate.promise; } });
  const started = snapshot(await f.host.start(f.request, f.authority, f.access));
  const permit = await reached.promise;
  try {
    const before = structuredClone(f.broker.getInputsSince(started.sessionId!));
    const persisted = readFileSync(f.brokerPath, 'utf8');
    for (const state of ['queued', 'spawned', 'delivered']) {
      await expect(f.broker.settleNativeTurnInput(started.sessionId!, started.brokerInputId!, permit,
        state as Parameters<SharedSessionBroker['settleNativeTurnInput']>[3])).rejects.toThrow();
      expect(f.broker.getInputsSince(started.sessionId!)).toEqual(before);
      expect(readFileSync(f.brokerPath, 'utf8')).toBe(persisted);
    }
    expect(f.broker.countBusySessions()).toBe(1);
    expect((await f.journal.read(f.identity))?.state).toBe('dispatching');
    expect(f.requests).toHaveLength(0);
  } finally { gate.resolve(); }
  expect((await f.settled()).state).toBe('completed');
  expect(f.requests).toHaveLength(1);
});

test('visible cancelled broker memory cannot certify cancellation while strict terminal persistence keeps failing', async () => {
  const returned = deferred<NativeConversationTurnPermit>(), gate = deferred();
  const f = await fixture({ afterDeliver: async permit => { returned.resolve(permit); await gate.promise; } });
  const started = snapshot(await f.host.start(f.request, f.authority, f.access));
  await returned.promise;
  expect(f.runtime(started.sessionId!).isRunning()).toBe(false);
  const store = (f.broker as unknown as { store: NonNullable<ConstructorParameters<typeof SharedSessionBroker>[0]['store']> }).store;
  const persist = store.persist.bind(store);
  const failure = new Error('Owned synthetic cancelled broker fsync failure');
  let attempts = 0;
  store.persist = async (data, options) => {
    if (options?.durable && data.inputs.some(input => input.id === started.brokerInputId && input.state === 'cancelled')) {
      attempts++;
      throw failure;
    }
    return persist(data, options);
  };
  try {
    const cancellation = f.host.cancel(f.request, f.authority, f.access).then(value => ({ value }), error => ({ error }));
    await eventually(() => f.counts.cancellations, count => count > 0);
    expect(snapshot(await f.status()).state).toBe('cancelling');
    gate.resolve();
    expect(await cancellation).toEqual({ error: failure });
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(f.broker.getInputsSince(started.sessionId!)[0]!.state).toBe('cancelled');
    expect(JSON.parse(readFileSync(f.brokerPath, 'utf8')).inputs.find((input: { id: string }) => input.id === started.brokerInputId).state).toBe('delivered');
    expect((await f.journal.read(f.identity))?.state).toBe('dispatching');
    expect(snapshot(await f.status()).state).toBe('recovery-required');
    expect(snapshot(await f.host.start(f.request, f.authority, f.access)).state).toBe('recovery-required');
    expect(snapshot(await f.host.cancel(f.request, f.authority, f.access)).state).toBe('recovery-required');
    expect((await f.journal.read(f.identity))?.state).toBe('dispatching');
    expect(f.requests).toHaveLength(1);
  } finally { store.persist = persist; gate.resolve(); }
});
