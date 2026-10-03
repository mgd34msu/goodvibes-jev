import { expect, spyOn, test } from 'bun:test';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { KnowledgeService, KnowledgeStore } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { WorkLedgerActor } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';
import * as ledgerComposition from '../../runtime/work-ledger-composition.js';
import type { NativeWorkLedgerOwner } from '../../runtime/work-ledger-composition.js';
import type { DaemonBootOperations } from '../../runtime/boot-tasks.js';
import type { RuntimeServices } from '../../runtime/services.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const command = { type: 'create', requestId: 'native-restart', expectedRevision: 0,
  title: 'Native durable work', goal: 'Keep host ownership through restart', criteria: ['The receipt is durable'] };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function boot(overrides: Partial<DaemonBootOperations> = {}): DaemonBootOperations {
  return {
    async foldMemory() {}, startProviderWatch() {}, stopProviderWatch() {},
    createWebhooks: () => ({ attach() {}, close() {} }),
    createNotifier: () => ({ attach() {}, close() {} }),
    async synchronizeServices() {}, async initializePlugins() {}, async closePlugins() {},
    reportFailure() {}, ...overrides,
  };
}

test('native composition restores durable work in the regular KnowledgeStore but never restores actor handles', async () => {
  const root = makeOwnedTempDir('native-ledger-restart');
  const configManager = new ConfigManager({ configDir: join(root, 'config'), homeDir: root, workingDir: root, surfaceRoot: 'daemon' });
  const firstStore = new KnowledgeStore({ configManager, dbFileName: 'knowledge-wiki.sqlite' });
  const first = ledgerComposition.createNativeWorkLedgerOwner({ projectId: 'project-restart', knowledgeStore: firstStore });
  const identity = { actorId: 'authenticated-user', projectId: 'project-restart', role: 'coordinator' as const };
  const actor = first.authority.issueActor(identity);
  let second: NativeWorkLedgerOwner | undefined; let secondStore: KnowledgeStore | undefined;
  try {
    expect(await first.service.execute(command, actor)).toMatchObject({ kind: 'accepted', replayed: false });
    const before = await first.service.readSnapshot(actor);
    await first.close(); await firstStore.close();
    secondStore = new KnowledgeStore({ configManager, dbFileName: 'knowledge-wiki.sqlite' });
    second = ledgerComposition.createNativeWorkLedgerOwner({ projectId: identity.projectId, knowledgeStore: secondStore });
    await expect(second.service.readSnapshot(actor)).rejects.toMatchObject({ code: 'forbidden' });
    const newActor = second.authority.issueActor(identity);
    expect(await second.service.readSnapshot(newActor)).toEqual(before);
    expect(await second.service.execute(command, newActor)).toMatchObject({ kind: 'accepted', replayed: true });
    expect(await second.service.history(0, newActor)).toHaveLength(1);
  } finally {
    await second?.close(); await secondStore?.close(); await first.close(); await firstStore.close();
  }
});

test.each(['close', 'dispose'] as const)('actual runtime %s fences ledger before held boot cleanup and drains lazy work before closing its KnowledgeStore', async (method) => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
  const opening = gate(); const opened = gate(); const bootDrain = gate();
  const storesClosed: string[] = []; const storesOpened: string[] = [];
  const nativeFactory = ledgerComposition.createNativeWorkLedgerOwner;
  let owner: NativeWorkLedgerOwner | undefined;
  const composition = spyOn(ledgerComposition, 'createNativeWorkLedgerOwner').mockImplementation(options => {
    owner = nativeFactory(options); return owner;
  });
  const openStorage = KnowledgeStore.prototype.openWorkLedgerStorage;
  const open = spyOn(KnowledgeStore.prototype, 'openWorkLedgerStorage').mockImplementation(async function (this: KnowledgeStore, projectId) {
    storesOpened.push(this.storagePath); opening.resolve(); await opened.promise;
    return openStorage.call(this, projectId);
  });
  const closeStore = KnowledgeStore.prototype.close;
  const close = spyOn(KnowledgeStore.prototype, 'close').mockImplementation(function (this: KnowledgeStore) {
    storesClosed.push(this.storagePath); return closeStore.call(this);
  });
  let fx: DaemonFixture | undefined;
  try {
    fx = await startDaemonFixture({ root: makeOwnedTempDir('native-ledger-graph'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
      createBootOperations: () => boot({ closePlugins: () => bootDrain.promise }),
    });
    if (!owner) throw new Error('Native ledger was not composed');
    const runtime = fx.services;
    expect(runtime.workLedger).toBe(owner.service);
    expect('workLedgerOwner' in runtime).toBe(false);
    expect('workLedgerAuthority' in runtime).toBe(false);
    const actor = owner.authority.issueActor({ actorId: 'native-user', projectId: runtime.projectPlanningProjectId, role: 'coordinator' });
    await runtime.bootTasks!.start();
    const admitted = runtime.workLedger.execute(command, actor);
    await opening.promise;
    expect(storesOpened).toHaveLength(1);
    expect(storesOpened[0]).toEndWith('knowledge-wiki.sqlite');
    runtime[method]();
    const closing = runtime.close(); let settled = false;
    void closing.then(() => { settled = true; });
    expect(await runtime.workLedger.execute({ ...command, requestId: 'late' }, actor)).toMatchObject({ code: 'closed' });
    await expect(runtime.workLedger.readSnapshot(actor)).rejects.toMatchObject({ code: 'closed' });
    expect(() => runtime.workLedger.subscribe(actor, () => {})).toThrow('closed');
    expect(storesClosed).toEqual([]);
    bootDrain.resolve(); await setImmediate();
    expect(settled).toBe(false); expect(storesClosed).toEqual([]);
    opened.resolve();
    expect(await admitted).toMatchObject({ kind: 'accepted' });
    await closing;
    expect(storesClosed).toHaveLength(3);
    expect(storesClosed.at(-1)).toEndWith('knowledge-wiki.sqlite');
  } finally {
    bootDrain.resolve(); opened.resolve();
    try { await fx?.stop(); }
    finally { close.mockRestore(); open.mockRestore(); composition.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); }
  }
}, 30_000);

test('failed graph startup fences its unpublished ledger and releases each backing KnowledgeStore', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
  const storesClosed: string[] = [];
  const closeStore = KnowledgeStore.prototype.close;
  const close = spyOn(KnowledgeStore.prototype, 'close').mockImplementation(function (this: KnowledgeStore) {
    storesClosed.push(this.storagePath); return closeStore.call(this);
  });
  let runtime: RuntimeServices | undefined;
  const failure = new Error('fixture construction after ledger failed');
  try {
    await expect(startDaemonFixture({ root: makeOwnedTempDir('native-ledger-failed-graph'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
      createBootOperations(services) { runtime = services; throw failure; },
    })).rejects.toBe(failure);
    if (!runtime) throw new Error('Fixture did not reach runtime acquisition');
    expect(await runtime.workLedger.execute(command, {} as WorkLedgerActor)).toMatchObject({ code: 'closed' });
    expect(storesClosed).toHaveLength(3);
    expect(new Set(storesClosed).size).toBe(3);
  } finally {
    try { await runtime?.close(); }
    finally { close.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); }
  }
}, 30_000);

test('a failure inside knowledge construction releases owners acquired before the factory returns', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
  const failure = new Error('fixture runtime bus attachment failed');
  const attach = spyOn(KnowledgeService.prototype, 'attachRuntimeBus').mockImplementation(() => { throw failure; });
  const dispose = spyOn(KnowledgeService.prototype, 'dispose');
  const storesClosed: string[] = [];
  const closeStore = KnowledgeStore.prototype.close;
  const close = spyOn(KnowledgeStore.prototype, 'close').mockImplementation(function (this: KnowledgeStore) {
    storesClosed.push(this.storagePath); return closeStore.call(this);
  });
  try {
    await expect(startDaemonFixture({ root: makeOwnedTempDir('native-ledger-partial-knowledge'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    })).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(storesClosed).toHaveLength(3);
    expect(new Set(storesClosed).size).toBe(3);
  } finally {
    close.mockRestore(); dispose.mockRestore(); attach.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore();
  }
}, 30_000);


test('actual daemon exposes only authenticated project-bound ledger reads from its existing owner', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
  const nativeFactory = ledgerComposition.createNativeWorkLedgerOwner;
  let owner: NativeWorkLedgerOwner | undefined;
  const composition = spyOn(ledgerComposition, 'createNativeWorkLedgerOwner').mockImplementation(options => {
    owner = nativeFactory(options); return owner;
  });
  let fx: DaemonFixture | undefined;
  try {
    fx = await startDaemonFixture({ root: makeOwnedTempDir('native-ledger-read-wire'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
      createBootOperations: () => boot(),
    });
    if (!owner) throw new Error('Native ledger was not composed');
    const projectId = fx.services.projectPlanningProjectId;
    const actor = owner.authority.issueActor({ actorId: 'fixture-coordinator', projectId, role: 'coordinator' });
    expect(await owner.service.execute(command, actor)).toMatchObject({ kind: 'accepted' });
    const sdk = createOperatorSdk({ baseUrl: fx.baseUrl, authToken: fx.token });
    const reader = createOperatorWorkLedgerReadClient(sdk, projectId);
    try {
      const snapshot = await reader.readSnapshot();
      expect(snapshot.projectId).toBe(projectId); expect(snapshot.cursor).toBe(1);
      expect(snapshot.works).toHaveLength(1); expect('allowedActions' in snapshot.works[0]!).toBe(false);
      expect((await reader.history(0)).map(item => item.sequence)).toEqual([1]);
      expect((await fx.fetchAnonymous(`/api/work-ledger/snapshot?projectId=${encodeURIComponent(projectId)}`)).status).toBe(401);
      const wrong = createOperatorWorkLedgerReadClient(sdk, 'different-project');
      await expect(wrong.readSnapshot()).rejects.toMatchObject({ status: 403 }); wrong.dispose();
      expect('authority' in reader).toBe(false); expect('execute' in reader).toBe(false);
      const revoke = spyOn(owner.authority, 'revokeActor');
      const close = fx.services.close();
      expect(revoke).toHaveBeenCalledTimes(1);
      await close;
      await expect(reader.readSnapshot()).rejects.toMatchObject({ status: 503 });
      revoke.mockRestore();
    } finally { reader.dispose(); sdk.dispose(); }
  } finally {
    try { await fx?.stop(); }
    finally { composition.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); }
  }
}, 30_000);
