import { describe, it, expect, afterEach } from 'bun:test';
import { rmSync } from 'node:fs';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
  DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
  runMemoryConsolidation,
  type MemoryConsolidationUsageLookup,
} from '@goodvibes-jev/engine/sdk/platform/state';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function makeRegistry(): Promise<{ registry: MemoryRegistry; paths: ReturnType<typeof createShellPathService> }> {
  const root = makeProjectTempDir('goodvibes-agent-consolidation');
  roots.push(root);
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const store = new MemoryStore(paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory.sqlite'), { embeddingRegistry });
  await store.init();
  return { registry: new MemoryRegistry(store), paths };
}

describe('runMemoryConsolidation', () => {
  it('merges exact duplicates into a survivor and marks losers stale without deleting', async () => {
    const { registry } = await makeRegistry();
    const survivor = await registry.add({ scope: 'project', cls: 'fact', summary: 'Deploy uses the release script', tags: ['deploy'], review: { state: 'reviewed', confidence: 80 } });
    const dup = await registry.add({ scope: 'project', cls: 'fact', summary: 'Deploy uses the release script', tags: ['ci'], review: { state: 'fresh', confidence: 60 } });

    const receipt = runMemoryConsolidation({ memoryRegistry: registry, config: DEFAULT_MEMORY_CONSOLIDATION_CONFIG, now: Date.now(), trigger: 'manual', idle: true });

    expect(receipt.merged).toHaveLength(1);
    expect(receipt.merged[0]!.survivorId).toBe(survivor.id);
    expect(receipt.merged[0]!.duplicateIds).toContain(dup.id);
    // No deletes: both records still exist.
    expect(registry.getAll()).toHaveLength(2);
    expect(registry.get(dup.id)?.reviewState).toBe('stale');
    // Survivor keeps its tags plus the loser's, unioned.
    expect(registry.get(survivor.id)?.tags.sort()).toEqual(['ci', 'deploy']);
  });

  it('decays never-referenced aged records first and archives once past the floor', async () => {
    const { registry } = await makeRegistry();
    const record = await registry.add({ scope: 'project', cls: 'fact', summary: 'Rarely useful note', review: { state: 'fresh', confidence: 60 } });
    const usage: MemoryConsolidationUsageLookup = () => ({ injectedCount: 3, referencedCount: 0, lastReferencedAt: null });

    const decayReceipt = runMemoryConsolidation({
      memoryRegistry: registry,
      config: { ...DEFAULT_MEMORY_CONSOLIDATION_CONFIG, decayAgeDays: 0, decayConfidenceStep: 10, archiveConfidenceFloor: 40 },
      now: Date.now() + 1000,
      trigger: 'idle',
      idle: true,
      usageLookup: usage,
    });
    expect(decayReceipt.usageSignalAvailable).toBe(true);
    expect(decayReceipt.decayed).toHaveLength(1);
    expect(decayReceipt.decayed[0]!.toConfidence).toBe(50);
    expect(registry.get(record.id)?.confidence).toBe(50);

    // A higher floor archives instead of decaying.
    const archiveReceipt = runMemoryConsolidation({
      memoryRegistry: registry,
      config: { ...DEFAULT_MEMORY_CONSOLIDATION_CONFIG, decayAgeDays: 0, decayConfidenceStep: 10, archiveConfidenceFloor: 55 },
      now: Date.now() + 2000,
      trigger: 'idle',
      idle: true,
      usageLookup: usage,
    });
    expect(archiveReceipt.archived).toHaveLength(1);
    expect(registry.get(record.id)?.reviewState).toBe('stale');
  });

  it('never decays a record that has been referenced', async () => {
    const { registry } = await makeRegistry();
    const record = await registry.add({ scope: 'project', cls: 'fact', summary: 'Referenced note', review: { state: 'fresh', confidence: 60 } });
    const usage: MemoryConsolidationUsageLookup = () => ({ injectedCount: 5, referencedCount: 4, lastReferencedAt: Date.now() });

    const receipt = runMemoryConsolidation({
      memoryRegistry: registry,
      config: { ...DEFAULT_MEMORY_CONSOLIDATION_CONFIG, decayAgeDays: 0 },
      now: Date.now() + 1000,
      trigger: 'idle',
      idle: true,
      usageLookup: usage,
    });
    expect(receipt.decayed).toHaveLength(0);
    expect(receipt.archived).toHaveLength(0);
    expect(registry.get(record.id)?.confidence).toBe(60);
  });

  it('proposes cross-scope duplicates and long-stale deletes instead of acting', async () => {
    const { registry } = await makeRegistry();
    await registry.add({ scope: 'project', cls: 'fact', summary: 'Shared naming convention', review: { state: 'reviewed', confidence: 80 } });
    await registry.add({ scope: 'team', cls: 'fact', summary: 'Shared naming convention', review: { state: 'reviewed', confidence: 80 } });
    const stale = await registry.add({ scope: 'project', cls: 'fact', summary: 'Ancient stale note', review: { state: 'stale', confidence: 30 } });

    const receipt = runMemoryConsolidation({ memoryRegistry: registry, config: DEFAULT_MEMORY_CONSOLIDATION_CONFIG, now: Date.now() + 200 * 24 * 60 * 60 * 1000, trigger: 'manual', idle: true });

    expect(receipt.proposed.some((p) => p.kind === 'cross-scope-duplicate')).toBe(true);
    const deleteProposal = receipt.proposed.find((p) => p.kind === 'stale-delete');
    expect(deleteProposal?.ids).toContain(stale.id);
    expect(deleteProposal?.route).toContain('memory action:"delete"');
    // Proposals do not act: the stale record still exists.
    expect(registry.get(stale.id)).not.toBeNull();
  });
});
