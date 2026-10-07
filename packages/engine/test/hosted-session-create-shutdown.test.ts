import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { SessionLiveTurnControlsHolder } from '../sdk/src/platform/control-plane/routes/session-runtime.js';
import { HostedSessionManager, type HostedSessionSpine } from '../sdk/src/platform/hosted-sessions/manager.js';
import { HostedSessionStore } from '../sdk/src/platform/hosted-sessions/store.js';
import type { HostedDetachPolicy, HostedSessionUpdatePayload } from '../sdk/src/platform/hosted-sessions/types.js';
import { createClientRuntimeServices } from '../sdk/src/platform/runtime/client-services.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.js';

let root: string;
let workspace: string;
let managers: HostedSessionManager[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-create-shutdown-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace);
  managers = [];
});

afterEach(async () => {
  await Promise.allSettled(managers.map(manager => manager.dispose()));
  rmSync(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function buildManager(options: {
  readonly policy?: HostedDetachPolicy;
  readonly spine?: HostedSessionSpine;
  readonly closeNativeTurns?: () => Promise<void>;
} = {}) {
  const store = new HostedSessionStore(join(root, 'sessions'), {
    maxSessions: 20, maxMessagesPerSession: 100, terminatedRetentionMs: 60_000,
  });
  const runtimeBus = new RuntimeEventBus();
  const liveTurns = new SessionLiveTurnControlsHolder();
  const events: HostedSessionUpdatePayload[] = [];
  const cleanup = { count: 0 };
  const configManager = new ConfigManager({
    surfaceRoot: 'goodvibes', configDir: join(root, 'cfg'), workingDir: root, homeDir: root,
  });
  const manager = new HostedSessionManager({
    floorFactory: ({ workspaceRoot }) => {
      const services = createClientRuntimeServices({
        configManager, runtimeBus, runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes',
        workingDir: workspaceRoot, homeDirectory: root, modelDiscovery: 'skip',
        requestApproval: async () => ({ approved: false }),
      });
      return { services, contractRunner: services.contractRunner, dispose() {
        cleanup.count += 1;
        services.dispose();
      } };
    },
    store,
    settings: { detachPolicy: () => options.policy ?? 'kill', maxSessions: () => 8 },
    runtimeBus, liveTurns, systemPrompt: () => 'owned create shutdown fixture',
    ...(options.spine ? { spine: options.spine } : {}),
    ...(options.closeNativeTurns ? { closeNativeTurns: options.closeNativeTurns } : {}),
  });
  manager.setEventPublisher({ publishEvent: (_event, payload) => { events.push(payload as HostedSessionUpdatePayload); } });
  managers.push(manager);
  return { manager, store, events, liveTurns, cleanup };
}

// Hold before the REAL save, so a late initialization write could overwrite a
// shutdown record even though the store itself correctly serializes writes.
function holdFirstSave(store: HostedSessionStore, failure?: Error) {
  const entered = deferred();
  const release = deferred();
  const save = store.save.bind(store);
  const writes: Parameters<HostedSessionStore['save']>[] = [];
  store.save = async (...args) => {
    writes.push(args);
    if (writes.length === 1) {
      entered.resolve();
      await release.promise;
      if (failure) throw failure;
    }
    await save(...args);
  };
  return { entered, release, writes };
}

for (const policy of ['kill', 'survive'] as const) {
  for (const native of [false, true]) {
    test(`${native ? 'native' : 'ordinary'} create drains its held save before ${policy} shutdown persistence`, async () => {
      const { manager, store, events, liveTurns, cleanup } = buildManager({ policy });
      await manager.init();
      const held = holdFirstSave(store);
      const prompts: string[] = [];
      manager.deliver = async (_id, text) => { prompts.push(text); };
      const creating = Promise.allSettled([manager.create({
        workspaceRoot: workspace, clientId: 'owned-client', initialPrompt: 'must not start after shutdown',
      }, native ? { nativeConversation: true } : undefined)]);
      let closed = false;
      let closing: Promise<void> | undefined;
      try {
        await held.entered.promise;
        const record = held.writes[0]![0];
        closing = manager.dispose();
        expect(manager.dispose()).toBe(closing);
        void closing.then(() => { closed = true; });
        await settle();
        expect(closed).toBe(false);
        expect(held.writes).toHaveLength(1);
        expect(cleanup.count).toBe(0);
        held.release.resolve();
        const [result] = await creating;
        expect(result?.status).toBe('rejected');
        if (result?.status === 'rejected') expect(String(result.reason)).toContain('disposed');
        await closing;
        expect(events.some(event => event.event === 'hosted-session-created')).toBe(false);
        expect(prompts).toEqual([]);
        expect(cleanup.count).toBe(1);
        expect(liveTurns.hasSession(record.id)).toBe(false);
        expect(held.writes[0]![2]?.durable).toBe(native ? true : undefined);
        const final = manager.get(record.id)!;
        expect(final.status).toBe(policy === 'kill' ? 'terminated' : 'idle');
        expect(final.terminatedReason).toBe(policy === 'kill' ? 'daemon-shutdown' : undefined);
        expect(final.attachedClients).toEqual([]);
        const reloaded = await store.load();
        expect(reloaded.restored[0]?.record).toEqual(final);

        const restarted = buildManager({ policy });
        await restarted.manager.init();
        expect(restarted.manager.get(record.id)?.status).toBe(final.status);
        if (policy === 'survive') {
          const attached = await restarted.manager.attach(record.id, 'restored-client');
          expect(attached.history.some(message => message.content.includes('interrupted by a daemon restart'))).toBe(true);
          expect(restarted.liveTurns.hasSession(record.id)).toBe(true);
        }
      } finally {
        held.release.resolve();
        await creating;
        await closing;
      }
    });
  }
}

for (const native of [false, true]) {
  test(`${native ? 'native' : 'ordinary'} create stops after a registration held across shutdown`, async () => {
    const entered = deferred();
    const release = deferred();
    const registered = new Set<string>();
    const { manager, store, events, cleanup } = buildManager({ spine: {
      register: async ({ sessionId }) => { entered.resolve(); await release.promise; registered.add(sessionId); },
      closeSession: async sessionId => { registered.delete(sessionId); },
      getInputsSince: () => [],
      markInputDelivered: async () => undefined,
    } });
    await manager.init();
    const writes: Parameters<HostedSessionStore['save']>[] = [];
    const save = store.save.bind(store);
    store.save = async (...args) => { writes.push(args); await save(...args); };
    const creating = Promise.allSettled([manager.create({ workspaceRoot: workspace }, native ? { nativeConversation: true } : undefined)]);
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      await entered.promise;
      closing = manager.dispose();
      void closing.then(() => { closed = true; });
      await settle();
      expect(closed).toBe(false);
      release.resolve();
      expect((await creating)[0]?.status).toBe('rejected');
      await closing;
      expect(writes.map(([record]) => record.status)).toEqual(['terminated']);
      expect(registered.size).toBe(0);
      expect(events.map(event => event.event)).toEqual(['hosted-session-terminated']);
      expect(cleanup.count).toBe(1);
    } finally {
      release.resolve();
      await creating;
      await closing;
    }
  });

  test(`${native ? 'native' : 'ordinary'} save rejection during shutdown cannot abandon cleanup or publish creation`, async () => {
    const { manager, store, events, cleanup } = buildManager();
    await manager.init();
    const failure = new Error('owned interrupted save failure');
    const held = holdFirstSave(store, failure);
    const creating = Promise.allSettled([manager.create({ workspaceRoot: workspace }, native ? { nativeConversation: true } : undefined)]);
    await held.entered.promise;
    const closing = manager.dispose();
    held.release.resolve();
    const [result] = await creating;
    expect(result?.status).toBe('rejected');
    if (result?.status === 'rejected') {
      if (native) expect(result.reason).toBe(failure);
      else expect(String(result.reason)).toContain('disposed');
    }
    await closing;
    expect(cleanup.count).toBe(1);
    expect(events.some(event => event.event === 'hosted-session-created')).toBe(false);
    // Native initialization already has a failure policy. Keep its reason and
    // original error rather than disguising a durability failure as shutdown.
    expect((await store.load()).restored[0]?.record.terminatedReason).toBe(native ? 'killed' : 'daemon-shutdown');
  });
}

for (const callback of ['registration', 'ordinary-save', 'native-save'] as const) {
  test(`${callback} can await its own shutdown request while external callers await the complete create drain`, async () => {
    const requested = deferred();
    const release = deferred();
    const requestShutdown = async () => {
      await fixture.manager.dispose();
      requested.resolve();
      await release.promise;
    };
    const fixture = buildManager(callback === 'registration' ? { spine: {
      register: requestShutdown,
      closeSession: async () => undefined,
      getInputsSince: () => [],
      markInputDelivered: async () => undefined,
    } } : {});
    const { manager, store, events, cleanup } = fixture;
    if (callback !== 'registration') {
      const save = store.save.bind(store);
      let first = true;
      store.save = async (...args) => {
        if (first) {
          first = false;
          await requestShutdown();
        }
        await save(...args);
      };
    }
    await manager.init();
    const creating = Promise.allSettled([manager.create({ workspaceRoot: workspace }, callback === 'native-save' ? { nativeConversation: true } : undefined)]);
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      await requested.promise;
      closing = manager.dispose();
      expect(manager.dispose()).toBe(closing);
      void closing.then(() => { closed = true; });
      await settle();
      expect(closed).toBe(false);
      expect(cleanup.count).toBe(0);
    } finally {
      release.resolve();
      await creating;
      await closing;
    }
    expect((await creating)[0]?.status).toBe('rejected');
    expect(cleanup.count).toBe(1);
    expect(events.some(event => event.event === 'hosted-session-created')).toBe(false);
    expect((await store.load()).restored[0]?.record.terminatedReason).toBe('daemon-shutdown');
  });
}

for (const native of [false, true]) {
  test(`${native ? 'native' : 'ordinary'} initial save failure retains its persistence contract`, async () => {
    const { manager, store, events, cleanup } = buildManager();
    await manager.init();
    const failure = new Error('owned initial save failure');
    const held = holdFirstSave(store, failure);
    const creating = Promise.allSettled([manager.create({ workspaceRoot: workspace }, native ? { nativeConversation: true } : undefined)]);
    await held.entered.promise;
    held.release.resolve();
    const [result] = await creating;
    expect(result?.status).toBe(native ? 'rejected' : 'fulfilled');
    if (native && result?.status === 'rejected') expect(result.reason).toBe(failure);
    expect(events.some(event => event.event === 'hosted-session-created')).toBe(!native);
    await manager.dispose();
    expect(cleanup.count).toBe(1);
    expect((await store.load()).restored[0]?.record.status).toBe('terminated');
  });
}

test('native close rejection still drains a pending create save and every close caller sees the native error', async () => {
  const failure = new Error('owned native close failure');
  const { manager, store, cleanup, events } = buildManager({ closeNativeTurns: async () => { throw failure; } });
  await manager.init();
  const held = holdFirstSave(store);
  const creating = Promise.allSettled([manager.create({ workspaceRoot: workspace })]);
  await held.entered.promise;
  let closed = false;
  const closing = Promise.allSettled([manager.dispose(), manager.dispose()]).then(results => { closed = true; return results; });
  try {
    await settle();
    expect(closed).toBe(false);
  } finally {
    held.release.resolve();
  }
  expect((await creating)[0]?.status).toBe('rejected');
  for (const result of await closing) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toBe(failure);
  }
  expect(cleanup.count).toBe(1);
  expect(events.some(event => event.event === 'hosted-session-created')).toBe(false);
  expect((await store.load()).restored[0]?.record.terminatedReason).toBe('daemon-shutdown');
});
