import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkEntry } from '../../sdk/src/platform/providers/model-benchmarks.ts';
import { createShellPathService } from '../../sdk/src/platform/runtime/shell-paths.ts';

export const fixtureBenchmark: BenchmarkEntry = {
  modelId: 'fixture-benchmark-model',
  name: 'Fixture benchmark model',
  organization: 'Test fixture',
  benchmarks: { gpqa: 0.5 },
};

/** Exercise real benchmark startup without fetching the live leaderboard. */
export function seedBenchmarkCache(homeDirectory: string, surfaceRoot: string): void {
  const paths = createShellPathService({ workingDirectory: homeDirectory, homeDirectory });
  const directory = paths.resolveUserPath(surfaceRoot);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'benchmarks.json'), JSON.stringify({
    version: 1,
    fetchedAt: Date.now(),
    ttlMs: 86_400_000,
    entries: [fixtureBenchmark],
  }));
}
