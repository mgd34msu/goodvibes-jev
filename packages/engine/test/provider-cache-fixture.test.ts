import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadCatalogCache, isCatalogCacheStale, type CatalogModel } from '../sdk/src/platform/providers/model-catalog.ts';
import { BenchmarkStore, type BenchmarkEntry } from '../sdk/src/platform/providers/model-benchmarks.ts';
import { createProviderCacheFixture, getProviderCachePaths, writeModelCatalogCache, writeBenchmarksCache } from './_helpers/provider-cache.ts';
import { seedBenchmarkCache, fixtureBenchmark } from './_helpers/benchmark-cache.ts';
const fixtures: ReturnType<typeof createProviderCacheFixture>[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
function fixture() {
  const value = createProviderCacheFixture();
  fixtures.push(value);
  return value;
}
const model: CatalogModel = { id: 'fixture-model', name: 'Fixture model', provider: 'Fixture', providerId: 'fixture', providerEnvVars: [], pricing: { input: 1, output: 2 }, tier: 'paid', inputModalities: ['text'] };
const benchmark: BenchmarkEntry = { modelId: model.id, name: model.name, organization: 'Fixture', benchmarks: { gpqa: 0.73 } };

test('fixture allocates fresh owned paths and cleanup is idempotent', () => {
  const first = fixture(); const second = fixture();
  expect(first.cacheDir).not.toBe(second.cacheDir);
  expect(existsSync(first.cacheDir)).toBe(true);
  first.restoreEnv();
  first.cleanup(); first.cleanup();
  expect(existsSync(first.cacheDir)).toBe(false);
  expect(existsSync(second.cacheDir)).toBe(true);
});
test('refuses a caller-supplied directory and preserves its contents', () => {
  const f = fixture();
  const sentinel = join(f.cacheDir, 'sentinel'); writeFileSync(sentinel, 'keep');
  expect(() => createProviderCacheFixture(f.cacheDir)).toThrow(/single nonempty path component/);
  expect(readFileSync(sentinel, 'utf8')).toBe('keep');
});
for (const target of ['owner', 'cache'] as const) for (const replacement of ['directory', 'symlink'] as const) test(`cleanup preserves a replaced ${target} (${replacement})`, () => {
  const f = fixture(); const root = target === 'owner' ? dirname(f.cacheDir) : f.cacheDir; const moved = `${root}-original`;
  renameSync(root, moved);
  if (replacement === 'directory') mkdirSync(root);
  else symlinkSync(moved, root);
  const sentinel = join(root, 'sentinel'); writeFileSync(sentinel, 'keep');
  try {
    expect(() => f.cleanup()).toThrow(/unsafe or surviving/);
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
    expect(existsSync(moved)).toBe(true);
  } finally {
    if (replacement === 'symlink') unlinkSync(root);
    else rmSync(root, { recursive: true, force: true });
    renameSync(moved, root);
  }
});
test('arbitrary catalog models round-trip through the real current-schema reader with caller TTL', () => {
  const f = fixture();
  const paths = getProviderCachePaths(f.cacheDir);
  const now = Date.now();
  writeModelCatalogCache([model], f.cacheDir, now, 123456);
  const fresh = loadCatalogCache(paths.catalogPath);
  expect(fresh?.models).toEqual([model]);
  expect(fresh?.fetchedAt).toBe(now);
  expect(fresh?.ttlMs).toBe(123456);
  expect(isCatalogCacheStale(fresh!)).toBe(false);
  writeModelCatalogCache([model], f.cacheDir, now - 10000, 1);
  expect(isCatalogCacheStale(loadCatalogCache(paths.catalogPath)!)).toBe(true);
  expect(JSON.parse(readFileSync(paths.catalogPath, 'utf8')).version).toBe(5);
});
test('benchmark fixtures load arbitrary entries and refresh only when the caller TTL expires', async () => {
  const f = fixture();
  let fetches = 0;
  globalThis.fetch = Object.assign(async () => { fetches++; return new Response('[]'); }, { preconnect: originalFetch.preconnect });
  writeBenchmarksCache([benchmark], f.cacheDir);
  const fresh = new BenchmarkStore({ dir: f.cacheDir });
  expect(fresh.getCachePath()).toBe(getProviderCachePaths(f.cacheDir).benchmarksPath);
  fresh.initBenchmarks(); await fresh.benchmarksSettled();
  expect(fresh.getKnownBenchmarks(model.id)).toEqual(benchmark);
  expect(fetches).toBe(0);
  writeBenchmarksCache([benchmark], f.cacheDir, Date.now() - 10000, 1);
  const stale = new BenchmarkStore({ dir: f.cacheDir });
  stale.initBenchmarks(); await stale.benchmarksSettled();
  expect(fetches).toBe(1);
  expect(stale.getKnownBenchmarks(model.id)).toEqual(benchmark);
});
test('existing benchmark seed consumer still seeds its canonical surface path', async () => {
  const f = fixture();
  let fetches = 0;
  globalThis.fetch = Object.assign(async () => { fetches++; return new Response('[]'); }, { preconnect: originalFetch.preconnect });
  seedBenchmarkCache(f.cacheDir, 'tui');
  const store = new BenchmarkStore({ dir: join(f.cacheDir, '.goodvibes', 'tui') });
  store.initBenchmarks(); await store.benchmarksSettled();
  expect(store.getKnownBenchmarks(fixtureBenchmark.modelId)).toEqual(fixtureBenchmark);
  expect(fetches).toBe(0);
});
