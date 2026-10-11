import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { FavoritesStore } from '../sdk/src/platform/providers/favorites.js';
import { createProviderApi, type ProviderApiDependencies } from '../sdk/src/platform/providers/provider-api.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function deferred() { let resolve: () => void = () => {}; const promise = new Promise<void>(finish => { resolve = finish; }); return { promise, resolve }; }
function temporaryStages(root: string): string[] { return readdirSync(root).filter(name => name.startsWith('.favorites-usage-')); }
function fixture(relativeDirectory = false) {
  const root = mkdtempSync(join(tmpdir(), 'provider-usage-native-')); roots.push(root);
  const store = new FavoritesStore({ dir: relativeDirectory ? relative(process.cwd(), root) : root });
  const model: ModelDefinition = { id: 'model', provider: 'synthetic', registryKey: 'synthetic:model', displayName: 'Synthetic model', description: 'Synthetic usage fixture',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false }, contextWindow: 8192, selectable: true, tier: 'standard' };
  const unexpected = (): never => { throw new Error('Unexpected synthetic provider operation.'); };
  const registry: ProviderApiDependencies['providerRegistry'] = {
    listModels: () => [model], getCurrentModel: () => model, getSelectableModels: () => [model],
    describeRuntime: unexpected, findAlternativeModel: unexpected, getCostFromCatalog: unexpected, getPricingForModel: unexpected,
    resolveModelPricing: unexpected, getCatalogModelDefinitions: unexpected, has: unexpected, require: unexpected, tryGet: unexpected,
    getContextWindowForModel: unexpected, getKnownContextWindowForModel: unexpected, getForModel: unexpected, getRegistered: unexpected,
    getSyntheticModelInfoFromCatalog: unexpected, listProviders: unexpected, registerDiscoveredProviders: unexpected,
    refreshCatalog: unexpected, refreshLiveModelDiscovery: unexpected, refreshModelLimits: unexpected, setCurrentModel: unexpected,
  };
  const api = createProviderApi({ providerRegistry: registry, favoritesStore: store,
    benchmarkStore: { getBenchmarks: unexpected, getKnownBenchmarks: unexpected, readBenchmarks: unexpected, refreshBenchmarks: unexpected } });
  return { root, store, api };
}

test('real provider API forwards current usage restrictions into a durable native favorites publication', async () => {
  const f = fixture(); await f.store.pinModel('synthetic:model'); let checks = 0;
  const result = await f.api.recordModelUsage('synthetic:model', { assertCurrent() { checks++; } });
  expect(checks).toBeGreaterThan(1); expect(result.recent[0]?.registryKey).toBe('synthetic:model');
  const saved = await new FavoritesStore({ dir: f.root }).load();
  expect(saved.pinned[0]?.registryKey).toBe('synthetic:model'); expect(saved.history).toHaveLength(1); expect(saved.history[0]?.count).toBe(1);
  expect(temporaryStages(f.root)).toEqual([]);
});

test('guarded native usage creates an absent favorites file and removes its private stage', async () => {
  const f = fixture();
  const result = await f.api.recordModelUsage('synthetic:model', { assertCurrent() {} });
  expect(result.recent[0]?.registryKey).toBe('synthetic:model');
  expect((await new FavoritesStore({ dir: f.root }).load()).history[0]?.count).toBe(1);
  expect(temporaryStages(f.root)).toEqual([]);
});

test.each(['revoke', 'cancel', 'symlink', 'parent-aba', 'stage-symlink', 'cwd'] as const)('actual %s during native temp write prevents usage publication and cleans only its own stage', async mutation => {
  const f = fixture(mutation === 'cwd'); await f.store.save({ pinned: [], history: [] });
  const entered = deferred(); const controller = new AbortController(); let active = true;
  const pending = f.api.recordModelUsage('synthetic:model', { signal: controller.signal, assertCurrent() {
    if (!active) throw new Error('Synthetic usage authority retired.');
    if (temporaryStages(f.root).some(name => readdirSync(join(f.root, name)).some(file => file.startsWith('favorites.json.tmp.')))) entered.resolve();
  } });
  await Promise.race([entered.promise, pending.then(() => { throw new Error('Native usage completed before its temp write.'); })]);
  const outside = join(f.root, 'outside.json');
  if (mutation === 'revoke') active = false;
  else if (mutation === 'cancel') controller.abort();
  else if (mutation === 'parent-aba') { const transient = join(f.root, 'unrelated-entry'); writeFileSync(transient, ''); unlinkSync(transient); }
  else if (mutation === 'cwd') {
    const originalDirectory = process.cwd(), outsideRoot = mkdtempSync(join(tmpdir(), 'provider-usage-cwd-')); roots.push(outsideRoot);
    const outsideDirectory = join(outsideRoot, ...originalDirectory.split('/').filter(Boolean)); mkdirSync(outsideDirectory, { recursive: true });
    try {
      process.chdir(outsideDirectory);
      await expect(pending).rejects.toThrow();
      expect(readdirSync(outsideDirectory)).toEqual([]);
    } finally { process.chdir(originalDirectory); }
    expect(await f.store.getRecentModels(10)).toEqual([]);
    expect(temporaryStages(f.root)).toEqual([]);
    expect((await new FavoritesStore({ dir: f.root }).load()).history).toEqual([]);
    return;
  }
  else if (mutation === 'stage-symlink') {
    const stageName = temporaryStages(f.root)[0];
    if (!stageName) throw new Error('Native usage stage is absent.');
    const stage = join(f.root, stageName), retired = `${stage}-retired`;
    const tempName = readdirSync(stage).find(name => name.startsWith('favorites.json.tmp.'));
    if (!tempName) throw new Error('Native usage temp is absent.');
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'provider-usage-outside-')); roots.push(outsideDirectory);
    writeFileSync(join(outsideDirectory, tempName), '{"private":"unchanged"}');
    renameSync(stage, retired); symlinkSync(outsideDirectory, stage);
    await expect(pending).rejects.toThrow();
    expect(await f.store.getRecentModels(10)).toEqual([]);
    expect(await Bun.file(join(outsideDirectory, tempName)).text()).toBe('{"private":"unchanged"}');
    expect((await new FavoritesStore({ dir: f.root }).load()).history).toEqual([]);
    return;
  } else { writeFileSync(outside, '{"private":"unchanged"}'); unlinkSync(f.store.getPath()); symlinkSync(outside, f.store.getPath()); }
  await expect(pending).rejects.toThrow();
  expect(await f.store.getRecentModels(10)).toEqual([]);
  expect(temporaryStages(f.root)).toEqual([]);
  if (mutation === 'symlink') expect(await Bun.file(outside).text()).toBe('{"private":"unchanged"}');
  else expect((await new FavoritesStore({ dir: f.root }).load()).history).toEqual([]);
});

test.each(['revoke', 'source-change'] as const)('guarded favorites reread refuses %s during native text acquisition before cache adoption', async mutation => {
  const f = fixture(); await f.store.save({ pinned: [], history: [] });
  const history = [{ registryKey: 'synthetic:model', lastUsed: '2026-01-01T00:00:00.000Z', count: 7 }];
  writeFileSync(f.store.getPath(), JSON.stringify({ pinned: [], history }));
  const entered = deferred(); let active = true, checks = 0;
  const pending = f.store.load({ assertCurrent() {
    if (!active) throw new Error('Synthetic favorites read authority retired.');
    if (++checks === 2) entered.resolve();
  } });
  await Promise.race([entered.promise, pending.then(() => { throw new Error('Native favorites read completed before its text acquisition.'); })]);
  if (mutation === 'revoke') active = false;
  else writeFileSync(f.store.getPath(), JSON.stringify({ pinned: [], history: [{ ...history[0], count: 9 }] }));
  await expect(pending).rejects.toThrow();
  expect(await f.store.getRecentModels(10)).toEqual([]);
});
