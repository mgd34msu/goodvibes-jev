import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
import type { DiscoveredServer } from '../sdk/src/platform/discovery/index.js';

function makeRegistry(): ProviderRegistry {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-provider-registry-live-model-discovery-'));
  const configManager = {
    get: () => undefined,
    getCategory: () => ({}),
    getControlPlaneConfigDir: () => root,
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['configManager'];
  const subscriptionManager = {
    get: () => null,
    getPending: () => null,
    saveSubscription: async () => {},
    resolveAccessToken: async () => null,
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['subscriptionManager'];
  const capabilityRegistry = {
    getCapability: () => ({}),
    getRouteExplanation: () => ({ accepted: true }),
    invalidate: () => {},
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['capabilityRegistry'];
  const cacheHitTracker = { record: () => {} } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['cacheHitTracker'];
  const favoritesStore = { load: async () => ({ pinned: [], history: [] }) } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['favoritesStore'];
  const benchmarkStore = {
    getBenchmarks: () => undefined,
    getTopBenchmarkModelIds: () => [],
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['benchmarkStore'];
  const secretsManager = {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['secretsManager'];
  const serviceRegistry = {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['serviceRegistry'];

  return new ProviderRegistry({
    configManager,
    subscriptionManager,
    capabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    secretsManager,
    serviceRegistry,
    featureFlags: null,
    runtimeBus: null,
  });
}


const server = (name: string): DiscoveredServer => ({ name, host: '127.0.0.1', port: 9,
  baseURL: 'http://127.0.0.1:9', models: ['synthetic-model'], serverType: 'ollama' });

// Real registry mutation, with no discovery request or inference.
test.each(['repeated', 'overlapping'] as const)('%s discovered server sets replace rather than accumulate', variant => {
  const registry = makeRegistry();
  const [a, b, c] = ['Synthetic Alpha', 'Synthetic Beta', 'Synthetic Gamma'].map(server);
  const baseline = registry.listProviders().map(provider => provider.name);
  registry.registerDiscoveredProviders([a!, b!]);
  const firstCount = registry.listProviders().length;
  expect(firstCount).toBe(baseline.length + 2);
  registry.registerDiscoveredProviders(variant === 'repeated' ? [a!, b!] : [b!, c!]);
  expect(registry.listProviders()).toHaveLength(firstCount);
  expect(registry.listProviders().map(provider => provider.name).sort()).toEqual(
    [...baseline, b!.name, variant === 'repeated' ? a!.name : c!.name].sort());
});
