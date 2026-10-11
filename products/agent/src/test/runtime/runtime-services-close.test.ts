import { expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { KnowledgeSemanticService, KnowledgeStore } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { RuntimeEventBus } from '../../runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeShutdown } from '../../runtime/bootstrap-shutdown.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';

test.each(['HomeGraph', 'rewind'] as const)('Agent close waits for %s last while cancellation is immediate and dependencies remain open', async (lastOwner) => {
  const root = makeProjectTempDir('Agent-runtime-close');
  const home = join(root, 'home'); const work = join(root, 'work');
  mkdirSync(home, { recursive: true }); mkdirSync(work, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: work, timeout: 10_000 });
  const releaseRewind = Promise.withResolvers<void>();
  const rewindEntered = Promise.withResolvers<void>();
  let releases = 0;
  const peer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/rewind.conversation.host.register/invoke')) return Response.json({ host: { hostId: 'synthetic-close-host' } });
    if (path.endsWith('/rewind.conversation.requests.take/invoke')) return Response.json({ requests: [] });
    if (path.endsWith('/rewind.conversation.host.release/invoke')) {
      releases++; rewindEntered.resolve(); await releaseRewind.promise; return Response.json({});
    }
    return Response.json({ error: 'No other provider or daemon effect belongs to this fixture.' }, { status: 422 });
  } });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', configDir: join(home, 'config'), workingDir: work, homeDir: home });
  configManager.set('controlPlane.host', '127.0.0.1'); configManager.set('controlPlane.port', peer.port!);
  configManager.set('daemon.connectedHost.enabled', true);
  const previousToken = process.env.GOODVIBES_CONNECTED_HOST_TOKEN;
  process.env.GOODVIBES_CONNECTED_HOST_TOKEN = 'synthetic-native-close-token';
  seedProviderMetadataCacheFixture({ configManager, homeDirectory: home, workingDirectory: work });
  const services = createRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(),
    workingDir: work, homeDirectory: home, modelDiscovery: 'skip' });
  const entered = Promise.withResolvers<AbortSignal>(); const releaseHomeGraph = Promise.withResolvers<void>();
  const nativeSelfImprove = KnowledgeSemanticService.prototype.selfImprove;
  const background = spyOn(KnowledgeSemanticService.prototype, 'selfImprove').mockImplementation(async function(this: KnowledgeSemanticService, input = {}, options = {}) {
    if (input.reason !== 'homegraph-sync') return nativeSelfImprove.call(this, input, options);
    const signal = input.signal; if (!signal) throw new Error('The native HomeGraph pump must retain cancellation ownership.');
    entered.resolve(signal); await releaseHomeGraph.promise; return nativeSelfImprove.call(this, input, options);
  });
  const homeGraphDispose = spyOn(services.homeGraphService, 'dispose');
  const rewindStop = spyOn(services.conversationRewindHost, 'stop');
  const capturedStore = Promise.withResolvers<KnowledgeStore>();
  const nativeInit = KnowledgeStore.prototype.init;
  const storeInit = spyOn(KnowledgeStore.prototype, 'init').mockImplementation(function(this: KnowledgeStore) {
    if (basename(this.storagePath) === 'knowledge-home-graph.sqlite') {
      const path = relative(root, this.storagePath);
      if (path.startsWith('..') || path.startsWith('/')) throw new Error('The native HomeGraph store must belong to this fixture root.');
      capturedStore.resolve(this);
    }
    return nativeInit.call(this);
  });
  let restoreStoreClose: () => void = () => {};
  const clientLogClose = spyOn(services.judgment.decisionLog, Symbol.dispose);
  const governorStop = spyOn(services.memoryGovernor, 'stop');
  const registryStop = spyOn(services.processRegistry, 'dispose');
  const watcherStop = spyOn(services.watcherRegistry, 'dispose');
  const records = (store: KnowledgeStore) => JSON.stringify({ sources: store.listSources(), nodes: store.listNodes(),
    edges: store.listEdges(), issues: store.listIssues() });
  const graphEntered = Promise.withResolvers<void>();
  const shutdown = createRuntimeShutdown({
      sessionId: 'synthetic-close-session', model: 'synthetic-model', provider: 'synthetic-provider', conversationTitle: () => 'Product shutdown proof',
      sessionSpineClient: services.sessionSpineClient, takeMemorySpineTimer: () => null,
      bootstrapUnsubs: [], runtimeUnsubs: [], forensicsCollector: { dispose() {} }, executionLedger: services.executionLedger,
      disposeSessionWriteLedger: services.disposeSessionWriteLedger, deferredStartup: { async drain() {} },
      agentExternalServices: { async stop() {} }, agentStatusIntervalRef: { value: null },
      scheduleManager: services.workflow.scheduleManager, hookDispatcher: services.hookDispatcher,
      providerRegistry: services.providerRegistry, sessionOrchestration: services.sessionOrchestration,
      shutdownOptions: { surface: services.surface },
      disposeRuntimeGraph: () => {
        expect(services.sessionManager.load('synthetic-close-session').meta.title).toBe('Product shutdown proof');
        const pending = services.close(); graphEntered.resolve(); return pending;
      },
    });
  let closing: Promise<void> | undefined;
  try {
    await services.agentKnowledgeService.whenReady();
    await services.homeGraphService.syncSnapshot({ installationId: 'product-close-house', pageAutomation: { enabled: false },
      devices: [{ id: 'reference-device', name: 'Reference device' }] });
    const store = await capturedStore.promise;
    const storeClose = spyOn(store, 'close'); restoreStoreClose = () => storeClose.mockRestore();
    const signal = await entered.promise; const before = records(store);
    services.conversationRewindHost.offer('synthetic-close-session');
    await services.conversationRewindHost.pump();
    expect(services.conversationRewindHost.hostId()).toBe('synthetic-close-host');
    closing = shutdown({ messages: [] });
    expect(shutdown({ messages: [] })).toBe(closing);
    await graphEntered.promise;
    const graphClosing = services.close(); services.dispose();
    expect(services.close()).toBe(graphClosing);
    expect(signal.aborted).toBe(true);
    expect(services.conversationRewindHost.hostId()).toBeNull();
    expect(governorStop).toHaveBeenCalledTimes(1); expect(registryStop).toHaveBeenCalledTimes(1);
    expect(watcherStop).toHaveBeenCalledTimes(1);
    expect(homeGraphDispose).toHaveBeenCalledTimes(1); expect(rewindStop).toHaveBeenCalledTimes(1);
    let settled = false; void closing.then(() => { settled = true; });
    await rewindEntered.promise; await Promise.resolve();
    expect(settled).toBe(false); expect(storeClose).not.toHaveBeenCalled(); expect(clientLogClose).not.toHaveBeenCalled();
    expect(records(store)).toBe(before);
    if (lastOwner === 'HomeGraph') {
      releaseRewind.resolve();
      const stopped = rewindStop.mock.results[0]?.value;
      if (!(stopped instanceof Promise)) throw new Error('The actual rewind stop must return its owned release promise.');
      await stopped;
    } else {
      releaseHomeGraph.resolve();
      const stopped = homeGraphDispose.mock.results[0]?.value;
      if (!(stopped instanceof Promise)) throw new Error('The actual HomeGraph stop must return its owned background drain.');
      await stopped;
    }
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false); expect(storeClose).not.toHaveBeenCalled(); expect(clientLogClose).not.toHaveBeenCalled();
    releaseHomeGraph.resolve(); releaseRewind.resolve(); await closing;
    expect(releases).toBe(1); expect(storeClose).toHaveBeenCalledTimes(1); expect(clientLogClose).toHaveBeenCalledTimes(1);
    expect(services.close()).toBe(graphClosing); expect(shutdown({ messages: [] })).toBe(closing); services.dispose();
    expect(homeGraphDispose).toHaveBeenCalledTimes(1); expect(rewindStop).toHaveBeenCalledTimes(1);
    const reopened = new KnowledgeStore({ dbPath: store.storagePath });
    try { await reopened.init(); expect(records(reopened)).toBe(before); } finally { await reopened.close(); }
  } finally {
    releaseHomeGraph.resolve(); releaseRewind.resolve();
    try { await (closing ?? services.close()); } finally {
      background.mockRestore(); homeGraphDispose.mockRestore(); rewindStop.mockRestore(); restoreStoreClose(); storeInit.mockRestore();
      clientLogClose.mockRestore(); governorStop.mockRestore(); registryStop.mockRestore(); watcherStop.mockRestore();
      await peer.stop(true); rmSync(root, { recursive: true, force: true });
      if (previousToken === undefined) delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN;
      else process.env.GOODVIBES_CONNECTED_HOST_TOKEN = previousToken;
    }
  }
}, 30_000);

