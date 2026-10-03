import { useMemoryReadings } from '../helpers/memory-readings.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
  resolveCanonicalMemoryDbPath,
} from '@goodvibes-jev/engine/sdk/platform/state';
import { ConfigManager } from '../../config/index.ts';
import { foldAgentLegacyMemory } from '../../runtime/services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('Agent legacy memory fold covers the CLI-written store', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  test('a record written to the old agent/memory.sqlite (as the memory CLI used to write) is folded into the canonical store', async () => {
    root = makeProjectTempDir('goodvibes-agent-legacy-fold');
    const homeDir = join(root, 'home');
    mkdirSync(homeDir, { recursive: true });

    const configManager = new ConfigManager({ workingDir: homeDir, homeDir, surfaceRoot: 'agent' });
    const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
    const shellPaths = createShellPathService({ workingDirectory: homeDir, homeDirectory: homeDir });

    // Simulate a record written by the OLD memory CLI, before it was repointed at the
    // canonical store: it wrote to shellPaths.resolveUserPath('agent', 'memory.sqlite').
    const legacyPath = shellPaths.resolveUserPath('agent', 'memory.sqlite');
    const legacyStore = new MemoryStore(legacyPath, { embeddingRegistry });
    await legacyStore.init();
    await legacyStore.add({
      cls: 'fact',
      scope: 'project',
      summary: 'Written by the old CLI store, before the fix.',
    });
    await legacyStore.save();
    legacyStore.close();

    // The runtime's canonical store, as constructed at boot.
    const canonicalPath = resolveCanonicalMemoryDbPath(shellPaths.homeDirectory);
    const canonicalStore = new MemoryStore(canonicalPath, { embeddingRegistry });
    await canonicalStore.init();

    try {
      const report = await foldAgentLegacyMemory(canonicalStore, embeddingRegistry, shellPaths);
      expect(report.sources.some((source) => source.dbPath === legacyPath && source.existed)).toBe(true);
      expect(report.totalImported).toBeGreaterThanOrEqual(1);

      const registry = new MemoryRegistry(canonicalStore);
      const records = await registry.search({});
      expect(records.some((record) => record.summary === 'Written by the old CLI store, before the fix.')).toBe(true);

      // Idempotent: running the fold again imports nothing new (record is already present).
      const reportAgain = await foldAgentLegacyMemory(canonicalStore, embeddingRegistry, shellPaths);
      expect(reportAgain.totalImported).toBe(0);
      expect(reportAgain.totalSkipped).toBeGreaterThanOrEqual(1);
    } finally {
      canonicalStore.close();
    }
  });
});

useMemoryReadings();
