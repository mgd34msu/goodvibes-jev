import { useMemoryReadings } from '../../../../../packages/engine/test/_helpers/memory-readings.ts';
import { describe, it, expect, afterEach } from 'bun:test';
import { rmSync } from 'node:fs';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createMemoryUsageTracker, extractInjectedMemoryIds } from '../../runtime/memory-usage-wiring.ts';
import type { PromptContextReceiptDraft } from '../../agent/prompt-context-receipts.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

async function makeRegistry(): Promise<{ registry: MemoryRegistry; paths: ReturnType<typeof createShellPathService> }> {
  const root = makeProjectTempDir('goodvibes-agent-usage-wiring');
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

function draftWithMemory(ids: readonly string[]): PromptContextReceiptDraft {
  return {
    sessionId: 's', turnId: 't', source: 'turn', provider: 'p', model: 'm', contextWindow: 1000,
    promptHash: 'h', promptChars: 0, approxPromptTokens: 0, activeRecords: ids.length, suppressedRecords: 0,
    segments: [{
      id: 'memory', label: 'Reviewed memory', order: 5, status: 'active',
      activeCount: ids.length, suppressedCount: 0, promptChars: 0, approxTokens: 0,
      selected: ids.map((id) => ({ id })),
    }],
  } as unknown as PromptContextReceiptDraft;
}

useMemoryReadings();

describe('MemoryUsageTracker', () => {
  it('extracts injected memory ids from the memory receipt segment', () => {
    expect(extractInjectedMemoryIds(draftWithMemory(['m1', 'm2']))).toEqual(['m1', 'm2']);
  });

  it('records injection at compose and a reference when the output overlaps the memory', async () => {
    const { registry, paths } = await makeRegistry();
    const record = await registry.add({ scope: 'project', cls: 'fact', summary: 'Deploys use the Kubernetes rollout script', review: { state: 'reviewed', confidence: 80 } });
    const tracker = createMemoryUsageTracker(paths, registry);

    tracker.onComposed('turn-1', draftWithMemory([record.id]));
    expect(tracker.lookup(record.id)).toMatchObject({ injectedCount: 1, referencedCount: 0 });

    await tracker.onTurnCompleted('turn-1', 'I triggered the kubernetes rollout as planned.');
    expect(tracker.lookup(record.id)?.referencedCount).toBe(1);
  });

  it('does not credit a reference when the turn is aborted', async () => {
    const { registry, paths } = await makeRegistry();
    const record = await registry.add({ scope: 'project', cls: 'fact', summary: 'Distinctive kubernetes rollout note', review: { state: 'reviewed', confidence: 80 } });
    const tracker = createMemoryUsageTracker(paths, registry);

    tracker.onComposed('turn-2', draftWithMemory([record.id]));
    tracker.onTurnAborted('turn-2');
    await tracker.onTurnCompleted('turn-2', 'kubernetes rollout kubernetes rollout');
    expect(tracker.lookup(record.id)?.referencedCount).toBe(0);
  });

  it('marks injected-but-unused memory as present (no reference)', async () => {
    const { registry, paths } = await makeRegistry();
    const record = await registry.add({ scope: 'project', cls: 'fact', summary: 'Distinctive kubernetes rollout note', review: { state: 'reviewed', confidence: 80 } });
    const tracker = createMemoryUsageTracker(paths, registry);

    tracker.onComposed('turn-3', draftWithMemory([record.id]));
    await tracker.onTurnCompleted('turn-3', 'Here is an unrelated answer about the weather.');
    expect(tracker.lookup(record.id)).toMatchObject({ injectedCount: 1, referencedCount: 0 });
  });
});
