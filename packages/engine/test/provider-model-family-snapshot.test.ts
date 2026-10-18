import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ModelPickerDataProvider } from '@goodvibes-jev/engine/sdk/platform/runtime/ui';
import { createInitialModelState } from '../sdk/src/platform/runtime/store/domains/model.ts';
import { createInitialProviderHealthState } from '../sdk/src/platform/runtime/store/domains/provider-health.ts';
import { getProviderRuntimeSnapshot, listProviderRuntimeSnapshots, type ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import { installCatalogModelFacts } from '../sdk/src/platform/providers/model-catalog-facts.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); installCatalogModelFacts([]); });
afterEach(() => { installJudgmentPort(previous); installCatalogModelFacts([]); });
function model(): ModelDefinition {
  return { id: 'alias', registryKey: 'local:alias', displayName: 'Opaque alias', provider: 'local',
    description: '', selectable: true, contextWindow: 8192,
    capabilities: { reasoning: false, toolCalling: true, codeEditing: true, multimodal: false } };
}
function publish(family: string): void {
  installCatalogModelFacts([{ id: 'alias', name: 'Published model', family, provider: 'Local', providerId: 'local',
    providerEnvVars: [], pricing: null, tier: 'paid' }]);
}
function registry(): Parameters<typeof getProviderRuntimeSnapshot>[0] {
  return { getRegistered: () => ({ name: 'local', models: ['alias'], chat: async () => { throw new Error('unused'); } }),
    getCurrentModel: model, listModels: () => [model()], describeRuntime: async () => null, resolveModelPricing: () => ({ status: 'unknown' }) };
}

test('runtime snapshots publish repository families immediately and preserve the enrichment switch', async () => {
  publish('llama');
  let calls = 0;
  installJudgmentPort({ model: 'synthetic', async ask() { calls++; throw new Error('Unexpected judgment'); } });
  const source = registry();
  const snapshots = await listProviderRuntimeSnapshots({ ...source, listProviders: () => [source.getRegistered('local')] });
  expect(snapshots[0]?.models[0]).toMatchObject({ family: 'Llama', contextWindow: 8192, registryKey: 'local:alias' });
  expect((await getProviderRuntimeSnapshot(source, 'local', { modelFamilyEnrichment: 'none' }))?.models[0]).not.toHaveProperty('family');
  expect(calls).toBe(0);
});

test('repository refresh replaces family metadata while earlier snapshots remain stable', async () => {
  publish('gpt');
  const source = registry();
  const old = await getProviderRuntimeSnapshot(source, 'local');
  publish('llama');
  expect((await getProviderRuntimeSnapshot(source, 'local'))?.models[0]?.family).toBe('Llama');
  expect(old?.models[0]?.family).toBe('GPT');
  installCatalogModelFacts([]);
  const missing = await getProviderRuntimeSnapshot(source, 'local');
  expect(missing?.models).toHaveLength(1);
  expect(missing?.models[0]).not.toHaveProperty('family');
});

test('the picker uses local metadata in its initial snapshot and updates with the registry', () => {
  publish('gpt');
  const provider = new ModelPickerDataProvider([model()], createInitialProviderHealthState(), createInitialModelState(), {
    benchmarkStore: { getBenchmarks: () => undefined }, providerRegistry: {
      getSyntheticModelInfoFromCatalog: () => null,
      getContextWindowForModel: candidate => candidate.contextWindow,
      getKnownContextWindowForModel: candidate => candidate.contextWindow,
    },
  });
  try {
    expect(provider.getSnapshot().entries[0]?.family).toBe('GPT');
    publish('claude-haiku'); provider.updateModels([model()]);
    expect(provider.getSnapshot().entries[0]?.family).toBe('Claude');
  } finally { provider.dispose(); }
});
