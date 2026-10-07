import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { SessionLiveTurnControlsHolder } from '../sdk/src/platform/control-plane/routes/session-runtime.js';
import { HostedSessionManager, type HostedSessionSpine } from '../sdk/src/platform/hosted-sessions/manager.js';
import type { HostedSessionSpineIntake } from '../sdk/src/platform/hosted-sessions/spine-intake.js';
import type { HostedWorkspaceFloor } from '../sdk/src/platform/hosted-sessions/workspace-floor.js';
import { HostedSessionStore } from '../sdk/src/platform/hosted-sessions/store.js';
import type { HostedDetachPolicy, HostedSessionUpdatePayload } from '../sdk/src/platform/hosted-sessions/types.js';
import { createClientRuntimeServices } from '../sdk/src/platform/runtime/client-services.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.js';

let root: string;
let workspace: string;
let managers: HostedSessionManager[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-explicit-kill-'));
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
  readonly onFloor?: (floor: HostedWorkspaceFloor) => HostedWorkspaceFloor | Promise<HostedWorkspaceFloor>;
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
      const floor = { services, contractRunner: services.contractRunner, dispose() {
        cleanup.count += 1;
        services.dispose();
      } };
      return options.onFloor?.(floor) ?? floor;
    },
    store,
    settings: { detachPolicy: () => options.policy ?? 'kill', maxSessions: () => 8 },
    runtimeBus, liveTurns, intakeIntervalMs: 60_000, systemPrompt: () => 'owned explicit kill fixture',
    ...(options.spine ? { spine: options.spine } : {}),
    ...(options.closeNativeTurns ? { closeNativeTurns: options.closeNativeTurns } : {}),
  });
  manager.setEventPublisher({ publishEvent: (_event, payload) => { events.push(payload as HostedSessionUpdatePayload); } });
  managers.push(manager);
  return { manager, store, events, liveTurns, cleanup };
}

// Hold before the REAL save, so a late initialization write could overwrite a
// termination record even though the store itself correctly serializes writes.
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

for (const native of [false, true]) {
  for (const phase of ['registration', 'initial-save'] as const) {
    test(`${native ? 'native' : 'ordinary'} kill drains held ${phase}, suppresses creation and leaves real disk terminated`, async () => {
      const entered = deferred();
      const release = deferred();
      const registered = new Set<string>();
      let closes = 0;
      const { manager, store, events, cleanup, liveTurns } = buildManager({ spine: {
        register: async ({ sessionId }) => {
          if (phase === 'registration') { entered.resolve(); await release.promise; }
          registered.add(sessionId);
        },
        closeSession: async sessionId => { closes += 1; registered.delete(sessionId); },
        getInputsSince: () => [], markInputDelivered: async () => undefined,
      } });
      await manager.init();
      // The registration case deliberately uses the unmodified real saver.
      const held = phase === 'initial-save' ? holdFirstSave(store) : undefined;
      const prompts: string[] = [];
      manager.deliver = async (_id, text) => { prompts.push(text); };
      const creating = Promise.allSettled([manager.create({
        workspaceRoot: workspace, clientId: 'initial-client', initialPrompt: 'must not start',
      }, native ? { nativeConversation: true } : undefined)]);
      let killing: Promise<unknown> | undefined;
      try {
        await (held?.entered.promise ?? entered.promise);
        const id = manager.list()[0]!.id;
        const live = (manager as unknown as { sessions: Map<string, { runtime: { dispose(): void } }> }).sessions.get(id)!;
        const originalDispose = live.runtime.dispose.bind(live.runtime);
        let runtimeDisposals = 0;
        live.runtime.dispose = () => { runtimeDisposals += 1; originalDispose(); };
        let killed = false;
        killing = Promise.all([manager.kill(id), manager.kill(id)]).then(records => { killed = true; return records; });
        expect(manager.hosts(id)).toBe(false);
        expect(manager.get(id)?.terminatedReason).toBe('killed');
        await expect(manager.attach(id, 'late-client')).rejects.toThrow('terminated');
        await settle();
        expect(killed).toBe(false);
        expect(events).toEqual([]);
        expect(cleanup.count).toBe(0);
        expect(runtimeDisposals).toBe(0);
        expect(closes).toBe(0);
        held?.release.resolve();
        release.resolve();
        expect((await creating)[0]?.status).toBe('rejected');
        await killing;
        expect(manager.get(id)?.status).toBe('terminated');
        expect((await store.load()).restored[0]?.record).toEqual(manager.get(id));
        expect(events.map(event => event.event)).toEqual(['hosted-session-terminated']);
        expect(prompts).toEqual([]);
        expect(registered.size).toBe(0);
        expect(closes).toBe(1);
        expect(runtimeDisposals).toBe(1);
        expect(liveTurns.hasSession(id)).toBe(false);
        await manager.dispose();
        expect(cleanup.count).toBe(1);
      } finally {
        held?.release.resolve(); release.resolve();
        await creating; await killing;
      }
    });
  }
}

for (const policy of ['kill', 'survive'] as const) {
  for (const phase of ['save', 'close'] as const) {
    test(`repeated kill and ${policy} shutdown join held termination ${phase}`, async () => {
      const entered = deferred();
      const release = deferred();
      let closes = 0;
      const { manager, store, events, cleanup } = buildManager({ policy, spine: {
        register: async () => undefined,
        closeSession: async () => { closes += 1; if (phase === 'close') { entered.resolve(); await release.promise; } },
        getInputsSince: () => [], markInputDelivered: async () => undefined,
      } });
      await manager.init();
      const record = await manager.create({ workspaceRoot: workspace });
      const held = phase === 'save' ? holdFirstSave(store) : undefined;
      const killing = manager.kill(record.id);
      let joined: Promise<unknown> | undefined;
      try {
        await (held?.entered.promise ?? entered.promise);
        let completed = false;
        joined = Promise.all([killing, manager.kill(record.id), manager.detach(record.id, 'late-client'), manager.dispose(), manager.dispose()])
          .then(results => { completed = true; return results; });
        await settle();
        expect(completed).toBe(false);
        expect(events.map(event => event.event)).toEqual(['hosted-session-created']);
        held?.release.resolve(); release.resolve();
        await joined;
        expect(manager.get(record.id)?.terminatedReason).toBe('killed');
        expect((await store.load()).restored[0]?.record).toEqual(manager.get(record.id));
        expect(events.map(event => event.event)).toEqual(['hosted-session-created', 'hosted-session-terminated']);
        expect(closes).toBe(1);
        expect(cleanup.count).toBe(1);
        if (held) expect(held.writes).toHaveLength(1);
      } finally { held?.release.resolve(); release.resolve(); await killing; await joined; }
    });
  }
}

for (const phase of ['registration', 'initial-save', 'native-save', 'final-save', 'close'] as const) {
  for (const asynchronous of [false, true]) {
    test(`${phase} ${asynchronous ? 'async' : 'sync'} callback rejects same-session kill without deadlock or false completion`, async () => {
      const entered = deferred();
      const release = deferred();
      let callbackError: unknown;
      const reenter = async (id: string) => {
        if (asynchronous) await Promise.resolve();
        try { await fixture.manager.kill(id); }
        catch (error) { callbackError = error; }
        entered.resolve();
        await release.promise;
      };
      const fixture = buildManager({ spine: {
        register: async ({ sessionId }) => { if (phase === 'registration') await reenter(sessionId); },
        closeSession: async sessionId => { if (phase === 'close') await reenter(sessionId); },
        getInputsSince: () => [], markInputDelivered: async () => undefined,
      } });
      const { manager, store, events } = fixture;
      const save = store.save.bind(store);
      store.save = async (...args) => {
        const terminal = args[0].status === 'terminated';
        if ((phase === 'final-save' && terminal) || ((phase === 'initial-save' || phase === 'native-save') && !terminal)) await reenter(args[0].id);
        await save(...args);
      };
      await manager.init();
      const creating = manager.create({ workspaceRoot: workspace }, phase === 'native-save' ? { nativeConversation: true } : undefined);
      const initial = !['final-save', 'close'].includes(phase);
      let id: string | undefined;
      let killing: Promise<unknown> | undefined;
      if (!initial) { id = (await creating).id; killing = manager.kill(id); }
      try {
        await entered.promise;
        id ??= manager.list()[0]!.id;
        expect(String(callbackError)).toContain('lifecycle callback cannot await its own termination');
        expect(manager.get(id)?.status).toBe(initial ? 'idle' : 'terminated');
        if (initial) killing = manager.kill(id);
        let killed = false;
        void killing!.then(() => { killed = true; });
        await settle();
        expect(killed).toBe(false);
        expect(events.some(event => event.event === 'hosted-session-terminated')).toBe(false);
      } finally { release.resolve(); await Promise.allSettled([creating, killing]); }
      expect((await store.load()).restored[0]?.record.terminatedReason).toBe('killed');
      expect(events.filter(event => event.event === 'hosted-session-terminated')).toHaveLength(1);
    });
  }
}

test('a detached continuation from a settled save callback joins the real termination drain', async () => {
  const invoke = deferred();
  const requested = deferred();
  const release = deferred();
  const { manager, store } = buildManager({ spine: {
    register: async () => undefined, closeSession: async () => { await release.promise; },
    getInputsSince: () => [], markInputDelivered: async () => undefined,
  } });
  await manager.init();
  const save = store.save.bind(store);
  let detached: Promise<unknown> | undefined;
  store.save = async (...args) => {
    if (!detached) detached = (async () => {
      await invoke.promise;
      const killing = manager.kill(args[0].id);
      requested.resolve();
      return await killing;
    })();
    await save(...args);
  };
  const record = await manager.create({ workspaceRoot: workspace });
  invoke.resolve();
  try {
    await requested.promise;
    let completed = false;
    void detached!.then(() => { completed = true; });
    await settle();
    expect(completed).toBe(false);
    expect(manager.get(record.id)?.status).toBe('terminated');
  } finally { release.resolve(); await detached; }
  expect((await store.load()).restored[0]?.record.terminatedReason).toBe('killed');
});

test('a lifecycle callback can kill another session while its own registration is held', async () => {
  const entered = deferred();
  const release = deferred();
  let otherId: string | undefined;
  let killedOther = false;
  const { manager } = buildManager({ spine: {
    register: async () => {
      if (!otherId) return;
      killedOther = (await manager.kill(otherId)).status === 'terminated';
      entered.resolve(); await release.promise;
    },
    closeSession: async () => undefined, getInputsSince: () => [], markInputDelivered: async () => undefined,
  } });
  await manager.init();
  otherId = (await manager.create({ workspaceRoot: workspace })).id;
  const creating = manager.create({ workspaceRoot: workspace });
  try { await entered.promise; expect(killedOther).toBe(true); }
  finally { release.resolve(); await creating; }
});

test('kill drains a held heartbeat registration and fences stale tick registrations before close', async () => {
  const entered = deferred();
  const release = deferred();
  let registrations = 0;
  let closes = 0;
  const registered = new Set<string>();
  const { manager, store, events } = buildManager({ spine: {
    register: async ({ sessionId }) => {
      registrations += 1;
      if (registrations === 2) { entered.resolve(); await release.promise; }
      registered.add(sessionId);
    },
    closeSession: async id => { closes += 1; registered.delete(id); },
    getInputsSince: () => [], markInputDelivered: async () => undefined,
  } });
  await manager.init();
  const record = await manager.create({ workspaceRoot: workspace });
  const intake = (manager as unknown as { spine: HostedSessionSpineIntake }).spine;
  const tick = intake.tick();
  let killing: Promise<unknown> | undefined;
  try {
    await entered.promise;
    let killed = false;
    killing = manager.kill(record.id).then(value => { killed = true; return value; });
    await intake.register(record);
    await settle();
    expect(killed).toBe(false);
    expect(registrations).toBe(2);
    expect(closes).toBe(0);
    expect((await store.load()).restored[0]?.record.status).toBe('idle');
    expect(events.map(event => event.event)).toEqual(['hosted-session-created']);
  } finally { release.resolve(); await tick; await killing; }
  await intake.register(record);
  expect(registrations).toBe(2);
  expect(registered.size).toBe(0);
  expect(closes).toBe(1);
  expect((await store.load()).restored[0]?.record.terminatedReason).toBe('killed');
});

test('attach cannot resume after kill crosses its already composed await boundary', async () => {
  const { manager, events } = buildManager();
  await manager.init();
  const record = await manager.create({ workspaceRoot: workspace });
  const attaching = manager.attach(record.id, 'late-client');
  const killing = manager.kill(record.id);
  await expect(attaching).rejects.toThrow('terminated');
  await killing;
  expect(manager.get(record.id)?.attachedClients).toEqual([]);
  expect(events.some(event => event.event === 'hosted-session-attached')).toBe(false);
});

test('kill drains restored composition and releases its late floor without runtime admission', async () => {
  const original = buildManager({ policy: 'survive' });
  await original.manager.init();
  const record = await original.manager.create({ workspaceRoot: workspace });
  await original.manager.dispose();
  const entered = deferred();
  const release = deferred();
  const { manager, store, events, cleanup, liveTurns } = buildManager({ policy: 'survive', onFloor: async floor => {
    entered.resolve(); await release.promise; return floor;
  } });
  await manager.init();
  const attaching = Promise.allSettled([manager.attach(record.id, 'late-client')]);
  let killing: Promise<unknown> | undefined;
  try {
    await entered.promise;
    let killed = false;
    killing = manager.kill(record.id).then(value => { killed = true; return value; });
    await settle();
    expect(killed).toBe(false);
    expect(cleanup.count).toBe(0);
  } finally { release.resolve(); await attaching; await killing; }
  expect((await attaching)[0]?.status).toBe('rejected');
  expect(liveTurns.hasSession(record.id)).toBe(false);
  expect(events.some(event => event.event === 'hosted-session-attached')).toBe(false);
  expect((await store.load()).restored[0]?.record.terminatedReason).toBe('killed');
  await manager.dispose();
  expect(cleanup.count).toBe(1);
});

test('a created publisher can fence the session before its initial prompt or returned record', async () => {
  const { manager, store } = buildManager();
  await manager.init();
  let killing: Promise<unknown> | undefined;
  const prompts: string[] = [];
  manager.deliver = async (_id, text) => { prompts.push(text); };
  manager.setEventPublisher({ publishEvent: (_name, value) => {
    const event = value as HostedSessionUpdatePayload;
    if (event.event === 'hosted-session-created') killing = manager.kill(event.session.id);
  } });
  await expect(manager.create({ workspaceRoot: workspace, initialPrompt: 'must not start' })).rejects.toThrow('terminated');
  await killing;
  expect(prompts).toEqual([]);
  expect((await store.load()).restored[0]?.record.terminatedReason).toBe('killed');
});

for (const native of [false, true]) {
  test(`${native ? 'native' : 'ordinary'} successful creation returns the saved live record and starts its initial prompt`, async () => {
    const { manager, store, events } = buildManager();
    await manager.init();
    const prompts: string[] = [];
    manager.deliver = async (_id, text) => { prompts.push(text); };
    const record = await manager.create({ workspaceRoot: workspace, initialPrompt: 'owned prompt' }, native ? { nativeConversation: true } : undefined);
    expect(record.status).toBe('idle');
    expect((await store.load()).restored[0]?.record).toEqual(record);
    expect(events.map(event => event.event)).toEqual(['hosted-session-created']);
    expect(prompts).toEqual(['owned prompt']);
  });

  test(`${native ? 'native' : 'ordinary'} failing initial save during explicit kill preserves its failure contract`, async () => {
    const { manager, store, events } = buildManager();
    await manager.init();
    const failure = new Error('owned initial save failure');
    const held = holdFirstSave(store, failure);
    const creating = Promise.allSettled([manager.create({ workspaceRoot: workspace }, native ? { nativeConversation: true } : undefined)]);
    await held.entered.promise;
    const id = manager.list()[0]!.id;
    const killing = manager.kill(id);
    held.release.resolve();
    const [result] = await creating;
    expect(result?.status).toBe('rejected');
    if (result?.status === 'rejected') {
      if (native) expect(result.reason).toBe(failure);
      else expect(String(result.reason)).toContain('terminated');
    }
    await killing;
    expect((await store.load()).restored[0]?.record.terminatedReason).toBe('killed');
    expect(events.map(event => event.event)).toEqual(['hosted-session-terminated']);
  });
}

for (const policy of ['kill', 'survive'] as const) {
  test(`${policy} shutdown from a heartbeat callback drains that callback outside its invocation`, async () => {
    const requested = deferred();
    const release = deferred();
    let registrations = 0;
    const { manager, store, cleanup, events } = buildManager({ policy, spine: {
      register: async () => {
        registrations += 1;
        if (registrations === 2) {
          await manager.dispose();
          requested.resolve();
          await release.promise;
        }
      },
      closeSession: async () => undefined, getInputsSince: () => [], markInputDelivered: async () => undefined,
    } });
    await manager.init();
    const record = await manager.create({ workspaceRoot: workspace });
    const intake = (manager as unknown as { spine: HostedSessionSpineIntake }).spine;
    const ticking = intake.tick();
    let closing: Promise<void> | undefined;
    try {
      await requested.promise;
      let closed = false;
      closing = manager.dispose().then(() => { closed = true; });
      await settle();
      expect(closed).toBe(false);
      expect(cleanup.count).toBe(0);
      expect(events.map(event => event.event)).toEqual(['hosted-session-created']);
    } finally { release.resolve(); await ticking; await closing; }
    expect((await store.load()).restored[0]?.record.status).toBe(policy === 'kill' ? 'terminated' : 'idle');
    expect(manager.get(record.id)?.terminatedReason).toBe(policy === 'kill' ? 'daemon-shutdown' : undefined);
    expect(cleanup.count).toBe(1);
    expect(events.map(event => event.event)).toEqual(['hosted-session-created', policy === 'kill' ? 'hosted-session-terminated' : 'hosted-session-detached']);
  });
}

test('explicit kill during shutdown of held restored composition keeps its reason under survive policy', async () => {
  const original = buildManager({ policy: 'survive' });
  await original.manager.init();
  const record = await original.manager.create({ workspaceRoot: workspace });
  await original.manager.dispose();
  const entered = deferred();
  const release = deferred();
  const { manager, store, events } = buildManager({ policy: 'survive', onFloor: async floor => {
    entered.resolve(); await release.promise; return floor;
  } });
  await manager.init();
  const attaching = Promise.allSettled([manager.attach(record.id, 'late-client')]);
  await entered.promise;
  const closing = manager.dispose();
  await settle();
  const killing = manager.kill(record.id);
  release.resolve();
  await Promise.all([attaching, killing, closing]);
  expect((await attaching)[0]?.status).toBe('rejected');
  expect(manager.get(record.id)?.terminatedReason).toBe('killed');
  expect((await store.load()).restored[0]?.record).toEqual(manager.get(record.id));
  expect(events.filter(event => event.event === 'hosted-session-terminated')).toHaveLength(1);
  expect(events.some(event => event.event === 'hosted-session-detached')).toBe(false);
});

test('explicit kill drains a survive shutdown parking save before final persistence and skips late detached publication', async () => {
  const { manager, store, events } = buildManager({ policy: 'survive' });
  await manager.init();
  const record = await manager.create({ workspaceRoot: workspace });
  const held = holdFirstSave(store);
  const closing = manager.dispose();
  let killing: Promise<unknown> | undefined;
  try {
    await held.entered.promise;
    expect(held.writes[0]?.[0].status).toBe('idle');
    let killed = false;
    killing = manager.kill(record.id).then(value => { killed = true; return value; });
    await settle();
    expect(killed).toBe(false);
    expect(held.writes).toHaveLength(1);
    expect(events.map(event => event.event)).toEqual(['hosted-session-created']);
  } finally { held.release.resolve(); await closing; await killing; }
  expect(manager.get(record.id)?.terminatedReason).toBe('killed');
  expect((await store.load()).restored[0]?.record).toEqual(manager.get(record.id));
  expect(events.map(event => event.event)).toEqual(['hosted-session-created', 'hosted-session-terminated']);
  expect(held.writes.map(([record]) => record.status)).toEqual(['idle', 'terminated']);
});

test('survive parking unbind callback cannot recursively kill its own session', async () => {
  const { manager, store, liveTurns, events } = buildManager({ policy: 'survive' });
  await manager.init();
  const record = await manager.create({ workspaceRoot: workspace });
  let recursive: Promise<unknown> | undefined;
  const unbind = liveTurns.unbindSession.bind(liveTurns);
  liveTurns.unbindSession = (...args) => {
    recursive = Promise.allSettled([manager.kill(record.id)]);
    unbind(...args);
  };
  await manager.dispose();
  const results = await recursive as PromiseSettledResult<unknown>[];
  expect(results[0]?.status).toBe('rejected');
  if (results[0]?.status === 'rejected') expect(String(results[0].reason)).toContain('lifecycle callback cannot await its own termination');
  expect(manager.get(record.id)?.status).toBe('idle');
  expect((await store.load()).restored[0]?.record).toEqual(manager.get(record.id));
  expect(events.map(event => event.event)).toEqual(['hosted-session-created', 'hosted-session-detached']);
});
