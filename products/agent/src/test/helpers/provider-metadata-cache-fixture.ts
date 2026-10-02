import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { seedBenchmarkCacheFixture } from './benchmark-cache-fixture.ts';

/** Current on-disk envelopes for metadata-independent command fixtures; no network interception. */
export function seedProviderMetadataCacheFixture(options: {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
}): void {
  const benchmarkPath = seedBenchmarkCacheFixture({ ...options, surfaceRoot: 'agent' });
  const root = options.configManager.getControlPlaneConfigDir();
  mkdirSync(root, { recursive: true });
  const envelope = { fetchedAt: Date.now(), ttlMs: 86_400_000 };
  writeFileSync(join(root, 'model-catalog.json'), JSON.stringify({ version: 5, ...envelope, models: [] }));
  writeFileSync(join(dirname(benchmarkPath), 'model-limits.json'), JSON.stringify({ version: 1, ...envelope, models: {} }));
  for (const providerId of ['aihubmix', 'vercel-ai-gateway']) {
    writeFileSync(join(root, `gateway-pricing-${providerId}.json`), JSON.stringify({ version: 1, ...envelope, models: {} }));
  }
}
