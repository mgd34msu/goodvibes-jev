import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager, SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createLaunchTolerantProviderRegistry, ProviderCapabilityRegistry, CacheHitTracker, FavoritesStore, BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { AgentManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createAgentExecutionGraph } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import * as composition from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { ExecutionPlanManager } from '@goodvibes-jev/engine/sdk/platform/core';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { createDaemonContractServices } from '../../runtime/contract-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture() {
  const root = makeOwnedTempDir('agent-graph-base');
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const providerRegistry = createLaunchTolerantProviderRegistry({
    configManager,
    subscriptionManager: new SubscriptionManager(join(root, 'subscriptions.json')),
    capabilityRegistry: new ProviderCapabilityRegistry(), cacheHitTracker: new CacheHitTracker(),
    favoritesStore: new FavoritesStore({ dir: root }), benchmarkStore: new BenchmarkStore({ dir: root }),
    secretsManager: { async get() { return null; }, async listDetailed() { return []; } },
    serviceRegistry: { getAll() { return {}; }, async inspect() { return null; } },
  });
  return { workingDirectory: root, configManager, providerRegistry, runtimeBus: new RuntimeEventBus() };
}

test('daemon dependencies compose one runner, count its ACP ownership, and resume only at the root boundary', async () => {
  const f = fixture(); const graph = createAgentExecutionGraph(f);
  const store = new KnowledgeStore({ configManager: f.configManager, dbFileName: 'fixture-plans.sqlite' });
  await store.init();
  const workPlanService = new ProjectPlanningService(store, { defaultProjectId: 'fixture-project' });
  const planManager = new ExecutionPlanManager(f.workingDirectory);
  const runtimeStore = createRuntimeStore();
  const acpSessions = [{ id: 'fixture-acp-one' }, { id: 'fixture-acp-two' }];
  const original = composition.composeContractRunner;
  let resumed: ReturnType<typeof spyOn> | undefined;
  const compose = spyOn(composition, 'composeContractRunner').mockImplementation((options) => {
    const composed = original(options);
    resumed = spyOn(composed.runner, 'resumeAll');
    return composed;
  });
  const install = spyOn(AgentManager.prototype, 'setContractRunner');
  let contracts: ReturnType<typeof createDaemonContractServices> | undefined;
  try {
    contracts = createDaemonContractServices({ ...f, projectRoot: f.workingDirectory,
      agentManager: graph.agentManager, agentMessageBus: graph.agentMessageBus,
      acpHost: { list: () => acpSessions }, runtimeStore, workPlanService, planManager,
    });
    expect(compose).toHaveBeenCalledTimes(1); expect(install).toHaveBeenCalledTimes(1);
    const passed = compose.mock.calls[0]![0];
    expect(passed.workPlanService).toBe(workPlanService); expect(passed.planManager).toBe(planManager); expect(passed.runtimeStore).toBe(runtimeStore);
    expect(passed.fleetCapacity()).toMatchObject({ active: 2, capKey: 'fleet.maxSize' });
    acpSessions.push({ id: 'fixture-acp-three' });
    expect(passed.fleetCapacity()).toMatchObject({ active: 3 });
    expect(resumed).toHaveBeenCalledTimes(0);
    await composition.resumeContracts(contracts.runner, f.workingDirectory);
    await composition.resumeContracts(contracts.runner, f.workingDirectory);
    expect(resumed).toHaveBeenCalledTimes(1);
  } finally { contracts?.dispose(); graph.agentOrchestrator.dispose(); resumed?.mockRestore(); install.mockRestore(); compose.mockRestore(); }
});
