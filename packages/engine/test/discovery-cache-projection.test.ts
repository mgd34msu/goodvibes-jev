import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadPersistedProviders, type DiscoveredServer } from '../sdk/src/platform/discovery/scanner.js';
import { capturePersistedProviders } from '../sdk/src/platform/discovery/persisted-cache.js';
import { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
import { createProviderApi, type ProviderApiDependencies } from '../sdk/src/platform/providers/provider-api.js';
import { logger } from '../sdk/src/platform/utils/logger.js';

const server: DiscoveredServer = {
  name: 'Saved fixture', host: '192.0.2.42', port: 1234,
  baseURL: 'http://fixture-user:fixture-password@192.0.2.42:1234/private%2Froute/v1?token=fixture-token#fixture-fragment',
  models: ['fixture-model'], serverType: 'unknown',
  modelContextWindows: { 'fixture-model': 16384 },
  modelOutputLimits: { 'fixture-model': 2048 },
};

function fixture() {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'discovery-cache-private-'));
  const roots = { homeDirectory, surfaceRoot: 'fixture-surface' };
  const path = join(homeDirectory, '.goodvibes', roots.surfaceRoot, 'discovered-providers.json');
  mkdirSync(dirname(path), { recursive: true });
  return { roots, path, write: (value: unknown) => writeFileSync(path, JSON.stringify(value)),
    close: () => rmSync(homeDirectory, { recursive: true, force: true }) };
}

function registryFixture(root: string) {
  type Options = ConstructorParameters<typeof ProviderRegistry>[0];
  const favoritesStore: ProviderApiDependencies['favoritesStore'] = {
    load: async () => ({ pinned: [], history: [] }), pinModel: async () => {},
    unpinModel: async () => {}, recordUsage: async () => {},
  };
  const benchmarkStore = {
    getBenchmarks: () => undefined, getKnownBenchmarks: () => undefined,
    readBenchmarks: async () => undefined, refreshBenchmarks: async () => {},
    getTopBenchmarkModelIds: () => [], benchmarksSettled: async () => {},
  };
  const registry = new ProviderRegistry({
    configManager: { get: () => undefined, getCategory: () => ({}), getControlPlaneConfigDir: () => root } as Options['configManager'],
    subscriptionManager: { get: () => null, getPending: () => null, saveSubscription: async () => {}, resolveAccessToken: async () => null },
    capabilityRegistry: { getCapability: () => ({}), getRouteExplanation: () => ({ accepted: true }), invalidate: () => {} } as unknown as Options['capabilityRegistry'],
    cacheHitTracker: { record: () => {} } as unknown as Options['cacheHitTracker'],
    secretsManager: {} as Options['secretsManager'], serviceRegistry: {} as Options['serviceRegistry'],
    favoritesStore, benchmarkStore, featureFlags: null, runtimeBus: null,
  });
  return { registry, api: createProviderApi({ providerRegistry: registry, favoritesStore, benchmarkStore }) };
}

describe('persisted discovery cache boundary', () => {
  test('captures fresh arrays and maps without prototype mutation or inherited model limits', () => {
    const source = { ...server, models: ['__proto__', 'toString'],
      modelContextWindows: { ['__proto__']: 16384 }, modelOutputLimits: { ['constructor']: 1024 } };
    const captured = capturePersistedProviders([source]);
    const loaded = captured.servers[0]!;
    expect(captured.invalid).toBe(false);
    expect(loaded).not.toBe(source);
    expect(loaded.models).not.toBe(source.models);
    expect(loaded.modelContextWindows).not.toBe(source.modelContextWindows);
    expect(loaded.modelOutputLimits).not.toBe(source.modelOutputLimits);
    expect(Object.getPrototypeOf(loaded.modelContextWindows)).toBeNull();
    expect(Object.getPrototypeOf(loaded.modelOutputLimits)).toBeNull();
    expect(loaded.modelContextWindows?.['__proto__']).toBe(16384);
    expect(loaded.modelOutputLimits?.['constructor']).toBe(1024);
    expect(loaded.modelContextWindows?.['toString']).toBeUndefined();
    source.models.push('later');
    source.modelContextWindows['__proto__'] = 1;
    source.modelOutputLimits['constructor'] = 1;
    expect(loaded.models).toEqual(['__proto__', 'toString']);
    expect(loaded.modelContextWindows?.['__proto__']).toBe(16384);
    expect(loaded.modelOutputLimits?.['constructor']).toBe(1024);
  });

  test('missing cache is quiet; read, parse and shape diagnostics contain only fixed messages', () => {
    const f = fixture();
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(loadPersistedProviders(f.roots)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      for (const raw of ['fixture-secret-malformed-json', JSON.stringify({ secret: 'fixture-secret-shape' })]) {
        writeFileSync(f.path, raw);
        expect(loadPersistedProviders(f.roots)).toEqual([]);
      }
      rmSync(f.path);
      mkdirSync(f.path);
      expect(loadPersistedProviders(f.roots)).toEqual([]);
      expect(warn.mock.calls).toEqual([
        ['[Scanner] loadPersistedProviders failed; using empty discovery cache'],
        ['[Scanner] loadPersistedProviders ignored invalid discovery cache'],
        ['[Scanner] loadPersistedProviders failed; using empty discovery cache'],
      ]);
    } finally { warn.mockRestore(); f.close(); }
  });

  test('captures declared fields and nested numeric maps, dropping unknown credentials and persistence metadata', () => {
    const f = fixture();
    try {
      f.write([{ ...server, apiKey: 'fixture-extra-secret', headers: { Authorization: 'Bearer fixture-extra-secret' }, lastSeen: 123 }]);
      const before = readFileSync(f.path, 'utf8');
      const [loaded] = loadPersistedProviders(f.roots);
      expect(loaded).toEqual(server);
      expect(loaded?.baseURL).toBe(server.baseURL);
      expect(Object.keys(loaded!)).toEqual(Object.keys(server));
      loaded!.models.push('mutated');
      loaded!.modelContextWindows!['fixture-model'] = 1;
      loaded!.modelOutputLimits!['fixture-model'] = 1;
      expect(loadPersistedProviders(f.roots)).toEqual([server]);
      expect(readFileSync(f.path, 'utf8')).toBe(before);
    } finally { f.close(); }
  });

  test('retains valid siblings while rejecting every malformed declared field', () => {
    const f = fixture();
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const malformed = [null, [], { host: server.host, port: server.port, models: server.models },
        ...Object.keys(server).map((key) => ({ ...server, [key]: null })),
        { ...server, port: '1234' }, { ...server, models: [42] },
        { ...server, models: [{ id: 'fixture-private-model' }] },
        { ...server, serverType: 'fixture-private-type' },
        { ...server, modelContextWindows: [] }, { ...server, modelOutputLimits: [] },
        { ...server, modelContextWindows: { 'fixture-model': 'fixture-secret-limit' } },
        { ...server, modelOutputLimits: { 'fixture-model': {} } },
      ];
      const withoutLimits = { name: 'Second fixture', host: 'localhost', port: 2345,
        baseURL: 'http://localhost:2345/prefix/v1?tenant=fixture', models: [], serverType: 'ollama' };
      f.write([server, ...malformed, withoutLimits]);
      expect(loadPersistedProviders(f.roots)).toEqual([server, withoutLimits]);
      expect(warn.mock.calls).toEqual([['[Scanner] loadPersistedProviders ignored invalid discovery cache']]);
      writeFileSync(f.path, JSON.stringify([{ ...server, port: 'OVERFLOW' },
        { ...server, modelOutputLimits: { 'fixture-model': 'OVERFLOW' } }, server]).replaceAll('"OVERFLOW"', '1e400'));
      expect(loadPersistedProviders(f.roots)).toEqual([server]);
    } finally { warn.mockRestore(); f.close(); }
  });

  test('fully registers valid cache siblings and exposes route-free real catalog/API records', async () => {
    const f = fixture();
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] })), { preconnect() {} }));
    try {
      const sibling = { ...server, name: 'Second fixture', models: ['second-model'], serverType: 'vllm' };
      f.write([server, { host: server.host, port: server.port, models: server.models }, sibling]);
      const { registry, api } = registryFixture(f.roots.homeDirectory);
      await api.registerDiscoveredProviders(loadPersistedProviders(f.roots));
      expect(registry.has(server.name)).toBe(true);
      expect(registry.has(sibling.name)).toBe(true);
      expect(registry.listDiscoveredServers()).toEqual([server, sibling]);
      expect(registry.listModels().find((model) => model.provider === server.name)?.description).toBe('Discovered local unknown model');
      const records = await api.listModels({ providerId: server.name });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ modelId: 'fixture-model', providerId: server.name,
        registryKey: `${server.name}:fixture-model`, displayName: 'fixture-model',
        description: 'Discovered local unknown model', contextWindow: 16384 });
      expect(JSON.stringify(records)).not.toContain('fixture-password');
      expect(JSON.stringify(records)).not.toContain('fixture-token');
      expect(JSON.stringify(records)).not.toContain('private%2Froute');
      expect(fetchSpy).not.toHaveBeenCalled();
      // Only this explicit refresh invokes the fixture transport; the adapter
      // still holds the original route bytes, including query and fragment.
      await registry.require(server.name).refreshModels!(true);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`${server.baseURL}/models`);
    } finally { fetchSpy.mockRestore(); warn.mockRestore(); f.close(); }
  });
});
