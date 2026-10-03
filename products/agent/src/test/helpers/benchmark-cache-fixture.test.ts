import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { makeProjectTempDir } from './project-temp.ts';
import { seedBenchmarkCacheFixture } from './benchmark-cache-fixture.ts';

test.each(['agent', 'goodvibes'] as const)('runtime %s accepts the exact fresh empty benchmark cache without fetching', async surfaceRoot => {
  const root = makeProjectTempDir('benchmark-cache-fixture');
  const before = Date.now();
  const path = seedBenchmarkCacheFixture({ homeDirectory: root, workingDirectory: root, surfaceRoot });
  expect(path).toBe(join(root, '.goodvibes', surfaceRoot, 'benchmarks.json'));
  const bytes = readFileSync(path, 'utf8');
  const cache = JSON.parse(bytes);
  expect(cache).toMatchObject({ version: 1, ttlMs: 86_400_000, entries: [] });
  expect(cache.fetchedAt).toBeGreaterThanOrEqual(before);
  expect(cache.fetchedAt).toBeLessThanOrEqual(Date.now());
  const store = new BenchmarkStore({ dir: dirname(path) });
  store.initBenchmarks();
  await store.benchmarksSettled();
  expect(store.getTopBenchmarkModelIds(5)).toEqual([]);
  expect(readFileSync(path, 'utf8')).toBe(bytes);
});
