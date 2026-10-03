import { expect, test } from 'bun:test';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { runLiveModelRefresh } from '@goodvibes-jev/engine/sdk/platform/providers';
import { makeProjectTempDir } from './project-temp.ts';
import { seedProviderModelListCacheFixture } from './provider-metadata-cache-fixture.ts';

test('fresh fixture model cache is accepted even for a configured provider without fetching', async () => {
  const root = makeProjectTempDir('provider-list-cache');
  const config = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'goodvibes' });
  const cachePath = seedProviderModelListCacheFixture(config, 'openai');
  let fetches = 0;
  const result = await runLiveModelRefresh({
    providerName: 'openai', cachePath, datedStaticModels: ['fallback'], datedStaticAsOf: '2026-10-02',
    isConfigured: true,
    fetchLive: async () => { fetches++; throw new Error('Unexpected discovery for fresh fixture cache'); },
  });
  expect(result).toEqual({ models: [], source: 'cache', added: [], removed: [] });
  expect(fetches).toBe(0);
});
