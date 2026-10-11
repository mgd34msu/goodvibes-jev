import { makeProjectTempDir } from './project-temp.ts';
import { createTempDirRegistry } from './temp-registry.ts';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogModel } from '../../sdk/src/platform/providers/model-catalog.ts';
import type { BenchmarkEntry } from '../../sdk/src/platform/providers/model-benchmarks.ts';

export interface ProviderCacheFixture {
  readonly cacheDir: string;
  readonly cleanup: () => void;
  readonly restoreEnv: () => void;
}

export interface ProviderCachePaths {
  readonly catalogPath: string;
  readonly benchmarksPath: string;
}

/** Fresh runner-owned cache only. A caller path is deliberately not accepted. */
export function createProviderCacheFixture(prefix = 'provider-cache'): ProviderCacheFixture {
  const root = makeProjectTempDir(prefix);
  const registry = createTempDirRegistry(root);
  const cacheDir = join(root, 'cache');
  mkdirSync(cacheDir);
  registry.register(cacheDir);
  const identity = lstatSync(cacheDir);
  return {
    cacheDir,
    cleanup: () => {
      try {
        const current = lstatSync(cacheDir);
        if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
          throw new Error('Provider cache cleanup refused an unsafe or surviving owned path');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      registry.cleanup();
      if (registry.entries().length > 0) throw new Error('Provider cache cleanup refused an unsafe or surviving owned path');
    },
    restoreEnv: () => {},
  };
}

export function getProviderCachePaths(cacheDir: string): ProviderCachePaths {
  return {
    catalogPath: join(cacheDir, 'model-catalog.json'),
    benchmarksPath: join(cacheDir, 'benchmarks.json'),
  };
}

export function writeModelCatalogCache(models: CatalogModel[], cacheDir: string, fetchedAt = Date.now(), ttlMs = 86_400_000): void {
  const { catalogPath } = getProviderCachePaths(cacheDir);
  mkdirSync(cacheDir, { recursive: true });
  // Version 5 carries provider-access-derived tiers. Readers reject legacy v4.
  const payload = { version: 5 as const, fetchedAt, ttlMs, models };
  writeFileSync(catalogPath, JSON.stringify(payload, null, 2), 'utf-8');
}

export function writeBenchmarksCache(entries: BenchmarkEntry[], cacheDir: string, fetchedAt = Date.now(), ttlMs = 86_400_000): void {
  const { benchmarksPath } = getProviderCachePaths(cacheDir);
  mkdirSync(cacheDir, { recursive: true });
  const payload = { version: 1 as const, fetchedAt, ttlMs, entries };
  writeFileSync(benchmarksPath, JSON.stringify(payload, null, 2), 'utf-8');
}
