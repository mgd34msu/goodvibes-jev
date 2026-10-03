import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createShellPathService } from '@/runtime/index.ts';

/** Valid empty metadata for tests that exercise runtime ownership, not remote leaderboards. */
export function seedBenchmarkCacheFixture(options: {
  readonly homeDirectory: string;
  readonly workingDirectory: string;
  readonly surfaceRoot: 'tui' | 'goodvibes';
}): string {
  const paths = createShellPathService(options);
  const store = new BenchmarkStore({ dir: paths.resolveUserPath(options.surfaceRoot) });
  const path = store.getCachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
  return path;
}
