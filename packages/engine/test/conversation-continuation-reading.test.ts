import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { configureDaemonSessionContinuation } from '../sdk/src/platform/daemon/facade-composition.js';
import { WorkProposalStore } from '../sdk/src/platform/agents/work-proposal-store.js';
import type { SharedSessionContinuationRunner, SharedSessionInputRecord } from '../sdk/src/platform/control-plane/session-intents.js';
import type { SharedSessionBroker } from '../sdk/src/platform/control-plane/session-broker.js';
import type { DaemonSurfaceActionHelper } from '../sdk/src/platform/daemon/surface-actions.js';
import type { AutomationRouteBinding } from '../sdk/src/platform/automation/routes.js';
let previous: ReturnType<typeof installJudgmentPort>; let pause: (() => Promise<void>) | undefined; let calls = 0;
beforeEach(() => {
  pause = undefined; calls = 0;
  const fake = fakePort((_name, question) => choiceAnswer(question, 'work', 0.99));
  previous = installJudgmentPort({ model: fake.port.model, async ask(request) { request.beforeAttempt?.(); calls++; await pause?.(); request.beforeAttempt?.(); return fake.port.ask(request); } });
});
afterEach(() => installJudgmentPort(previous));
function harness(delivery?: () => Promise<{ delivered: true } | { delivered: false; reason: 'delivery-failed' }>) {
  let runner!: SharedSessionContinuationRunner;
  const input: SharedSessionInputRecord = { id: 'input', sessionId: 'session', intent: 'follow-up', state: 'queued', correlationId: 'correlation', body: 'Fix login', createdAt: 1, updatedAt: 1, metadata: {}, surfaceKind: 'ntfy', externalId: 'topic', threadId: 'topic', routeId: 'route' };
  let currentInput = input;
  let session = { id: 'session', status: 'active', createdAt: 1, routeIds: ['route'] };
  const route = { id: 'route', surfaceKind: 'ntfy', channelId: 'topic', externalId: 'topic' } as AutomationRouteBinding;
  let currentRoute = route;
  const store = new WorkProposalStore(); const spawns: unknown[] = []; let delivered = 0;
  const broker = { setContinuationRunner: (value: SharedSessionContinuationRunner) => { runner = value; }, getSession: () => session,
    getInputs: () => [currentInput], markInputDelivered: async (_session: string, _input: string, options: { beforeApply?: () => void }) => { options.beforeApply?.(); delivered++; currentInput = { ...currentInput, state: 'completed' }; return currentInput; }, bindAgent: async () => null };
  const deps = { configManager: { get: () => undefined }, routeBindings: { getBinding: () => currentRoute, resolve: () => currentRoute }, sessionBroker: broker,
    trySpawnAgent: (value: unknown) => { spawns.push(value); return Response.json({}); }, queueSurfaceReplyFromBinding: () => {}, workProposals: store,
    deliverSurfaceNotice: delivery ?? (async () => ({ delivered: true })), readingOptions: {}, captureReadingSource: () => () => {} };
  configureDaemonSessionContinuation({ sessionBroker: broker as unknown as SharedSessionBroker, trySpawnAgent: deps.trySpawnAgent, queueSurfaceReplyFromBinding: () => {},
    surfaceActionHelper: { conversationGateDeps: () => deps } as unknown as Pick<DaemonSurfaceActionHelper, 'conversationGateDeps'> });
  return { store, spawns, run: () => runner({ sessionId: 'session', input, task: 'Fix login', routeBinding: route }), delivered: () => delivered,
    invalidate: (kind: string) => { if (kind === 'closed') session = { ...session, status: 'closed' }; else if (kind === 'route') currentRoute = { ...route, channelId: 'other' }; else currentInput = { ...input, ...(kind === 'failed' ? { state: 'failed' as const } : {}) }; } };
}
for (const kind of ['closed', 'failed', 'replacement', 'route']) test(`queued ${kind} source invalidation blocks proposal after reading`, async () => {
  const h = harness(); pause = async () => { h.invalidate(kind); };
  try { await expect(h.run()).rejects.toThrow('no longer current'); expect(h.store.listPending()).toEqual([]); expect(h.spawns).toEqual([]); expect(h.delivered()).toBe(0); }
  finally { h.store.dispose(); }
});
test('channel-as-thread session key never changes actual proposal thread binding; proposal consumes input once', async () => {
  const h = harness();
  try {
    expect(await h.run()).toMatchObject({ disposition: 'transferred' });
    expect(h.store.listPending()).toHaveLength(1); expect(h.store.listPending()[0]?.threadId).toBeUndefined(); expect(h.delivered()).toBe(1);
    await expect(h.run()).rejects.toThrow('no longer current'); expect(calls).toBe(1); expect(h.store.listPending()).toHaveLength(1);
  } finally { h.store.dispose(); }
});
test('concurrent completion cannot launch two readings or proposals', async () => {
  const h = harness(); let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }); const waiting = new Promise<void>(resolve => { release = resolve; });
  pause = async () => { started(); await waiting; };
  try { const first = h.run(); await ready; expect(await h.run()).toMatchObject({ disposition: 'held' }); release(); await first; expect(calls).toBe(1); expect(h.store.listPending()).toHaveLength(1); }
  finally { h.store.dispose(); }
});

for (const outcome of ['false', 'throw', 'closed', 'replacement', 'dispose']) test(`delivery ${outcome} does not consume queued work`, async () => {
  let invalidate!: () => void;
  const h = harness(async () => {
    await Promise.resolve(); invalidate();
    if (outcome === 'throw') throw new Error('synthetic delivery failure');
    return outcome === 'false' ? { delivered: false, reason: 'delivery-failed' } : { delivered: true };
  });
  invalidate = () => { if (outcome === 'dispose') h.store.dispose(); else if (outcome === 'closed' || outcome === 'replacement') h.invalidate(outcome); };
  try {
    if (outcome === 'closed' || outcome === 'replacement') await expect(h.run()).rejects.toThrow('no longer current');
    else expect(await h.run()).toBeNull();
    expect(h.delivered()).toBe(0); expect(h.store.listPending()).toEqual([]); expect(h.spawns).toEqual([]);
  } finally { h.store.dispose(); }
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedSessionBroker as RealBroker } from '../sdk/src/platform/control-plane/session-broker.js';
import { DaemonSurfaceActionHelper as RealHelper } from '../sdk/src/platform/daemon/surface-actions.js';
import type { RouteBindingManager } from '../sdk/src/platform/channels/index.js';

for (const outcome of ['success', 'refused', 'claim-race', 'policy-race', 'config-race']) test(`real broker ${outcome} transfer owns exactly one guarded input completion`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'conversation-transfer-'));
  const proposalStore = new WorkProposalStore();
  const route = { id: 'route', surfaceKind: 'ntfy', channelId: 'topic', externalId: 'topic' } as AutomationRouteBinding;
  const routes = { start: async () => {}, stop: async () => {}, getBinding: () => route, resolve: () => route, patchBinding: async () => route } as unknown as RouteBindingManager;
  const broker = new RealBroker({ storePath: join(directory, 'sessions.json'), routeBindings: routes, agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false } });
  const events: string[] = [];
  broker.setEventPublisher((_event, payload) => { events.push((payload as { event: string }).event); });
  let inputId = '';
  let policy = { surface: 'ntfy', allowlistUserIds: [], enabled: true };
  let configMode = 'propose';
  const helper = new RealHelper({ configManager: { get: (key: string) => key === 'conversationGate.mode' ? configMode : undefined }, routeBindings: routes, sessionBroker: broker, workProposals: proposalStore,
    channelPolicy: { getPolicy: () => policy, listPolicies: () => [policy] }, trySpawnAgent: () => { throw new Error('Must propose, not spawn'); }, queueSurfaceReplyFromBinding: () => {},
    deliverSurfaceNotice: async () => {
      if (outcome === 'refused') return { delivered: false, reason: 'delivery-failed' };
      if (outcome.endsWith('-race')) {
        const start = broker.start.bind(broker); let once = true;
        broker.start = async () => { await start(); if (once) { once = false; if (outcome === 'claim-race') await broker.failInput('session', inputId, 'synthetic cancellation'); else if (outcome === 'policy-race') policy = { ...policy, enabled: false }; else configMode = 'off'; } };
      }
      return { delivered: true };
    },
  } as unknown as ConstructorParameters<typeof RealHelper>[0]);
  configureDaemonSessionContinuation({ sessionBroker: broker, trySpawnAgent: () => { throw new Error('Must not spawn'); }, queueSurfaceReplyFromBinding: () => {}, surfaceActionHelper: helper });
  try {
    await broker.createSession({ id: 'session' });
    const submission = await broker.followUpMessage({ sessionId: 'session', routeId: 'route', surfaceKind: 'ntfy', surfaceId: 'ntfy', externalId: 'topic', threadId: 'topic', body: 'Fix login' });
    inputId = submission.input.id;
    if (outcome.endsWith('-race')) {
      await expect(broker.completeAgent('session', 'old-agent', 'Done')).rejects.toBeDefined();
      expect(broker.getInputs('session')[0]?.state).toBe(outcome === 'claim-race' ? 'failed' : 'queued');
      expect(proposalStore.listPending()).toEqual([]);
    } else {
      await broker.completeAgent('session', 'old-agent', 'Done');
      expect(broker.getInputs('session')[0]?.state).toBe(outcome === 'success' ? 'completed' : 'queued');
      expect(proposalStore.listPending()).toHaveLength(outcome === 'success' ? 1 : 0);
      if (outcome === 'success') await broker.completeAgent('session', 'old-agent', 'Duplicate completion reporter');
    }
    expect(events.filter(event => event === 'session-input-completed')).toHaveLength(outcome === 'success' ? 1 : 0);
  } finally { proposalStore.dispose(); await broker.stop(); rmSync(directory, { recursive: true, force: true }); }
});
