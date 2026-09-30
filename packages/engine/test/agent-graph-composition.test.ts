import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { createAgentExecutionGraph, createAgentGraph } from '../sdk/src/platform/runtime/agent-graph-composition.ts';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { SubscriptionManager } from '../sdk/src/platform/config/subscriptions.ts';
import { createLaunchTolerantProviderRegistry } from '../sdk/src/platform/providers/launch-tolerant-registry.ts';
import { ProviderCapabilityRegistry } from '../sdk/src/platform/providers/capabilities.ts';
import { CacheHitTracker } from '../sdk/src/platform/providers/cache-strategy.ts';
import { FavoritesStore } from '../sdk/src/platform/providers/favorites.ts';
import { BenchmarkStore } from '../sdk/src/platform/providers/model-benchmarks.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { AgentManager } from '../sdk/src/platform/tools/agent/index.ts';
import * as composition from '../sdk/src/platform/runtime/contract-composition.ts';
import { makeProjectTempDir } from '../test/_helpers/project-temp.ts';

function fixture() {
  const root = makeProjectTempDir('agent-graph-base');
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

test('execution collaborators do not allocate or resume a competing contract runner', () => {
  const f = fixture(); const original = composition.composeContractRunner;
  const compose = spyOn(composition, 'composeContractRunner').mockImplementation(original);
  const install = spyOn(AgentManager.prototype, 'setContractRunner');
  let graph: ReturnType<typeof createAgentExecutionGraph> | undefined;
  try {
    graph = createAgentExecutionGraph(f);
    expect(compose).toHaveBeenCalledTimes(0); expect(install).toHaveBeenCalledTimes(0);
    expect('contractRunner' in graph).toBe(false);
    expect(graph.agentManager.list()).toEqual([]);
  } finally { graph?.agentOrchestrator.dispose(); install.mockRestore(); compose.mockRestore(); }
});

test('default graph retains exactly one canonical runner and one startup resume', async () => {
  const f = fixture(); const original = composition.composeContractRunner;
  let resumed: ReturnType<typeof spyOn> | undefined;
  const compose = spyOn(composition, 'composeContractRunner').mockImplementation((options) => {
    const composed = original(options);
    resumed = spyOn(composed.runner, 'resumeAll');
    return composed;
  });
  const install = spyOn(AgentManager.prototype, 'setContractRunner');
  let graph: ReturnType<typeof createAgentGraph> | undefined;
  try {
    graph = createAgentGraph(f);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]?.[0]).toBe(graph.contractRunner);
    expect(resumed).toHaveBeenCalledTimes(1);
    await composition.resumeContracts(graph.contractRunner, f.workingDirectory);
    expect(resumed).toHaveBeenCalledTimes(1);
  } finally { graph?.dispose(); graph?.agentOrchestrator.dispose(); resumed?.mockRestore(); install.mockRestore(); compose.mockRestore(); }
});
