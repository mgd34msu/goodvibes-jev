import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { createShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import {
  createAgentLearningConsolidationTool,
  registerAgentLearningConsolidationTool,
} from '../../tools/agent-learning-consolidation-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ReturnType<typeof createShellPathService>;

interface Fixture {
  readonly root: string;
  readonly paths: ShellPaths;
  readonly memoryRegistry: MemoryRegistry;
  readonly tool: ReturnType<typeof createAgentLearningConsolidationTool>;
  readonly cleanup: () => void;
}

async function createMemoryRegistry(paths: ShellPaths): Promise<MemoryRegistry> {
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const store = new MemoryStore(paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory.sqlite'), { embeddingRegistry });
  await store.init();
  return new MemoryRegistry(store);
}

async function makeFixture(): Promise<Fixture> {
  const root = makeProjectTempDir('goodvibes-agent-learning-consolidation');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const memoryRegistry = await createMemoryRegistry(paths);
  return {
    root,
    paths,
    memoryRegistry,
    tool: createAgentLearningConsolidationTool(paths, memoryRegistry),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedDuplicateSkills(paths: ShellPaths): { readonly survivorId: string; readonly duplicateId: string } {
  const registry = AgentSkillRegistry.fromShellPaths(paths);
  const survivor = registry.create({
    name: 'Release checklist',
    description: 'Run package verification before release.',
    procedure: 'Run package verification and summarize release risks.',
    tags: ['release'],
    triggers: ['release'],
    enabled: true,
    source: 'agent',
  });
  registry.markReviewed(survivor.id);
  const duplicate = registry.create({
    name: 'Release checklist!',
    description: 'Also run UX inventory before release.',
    procedure: 'Run UX inventory and package verification.',
    tags: ['ux-inventory'],
    triggers: ['ux'],
    source: 'agent',
  });
  return { survivorId: survivor.id, duplicateId: duplicate.id };
}

describe('agent_learning_consolidation tool', () => {
  test('previews and applies duplicate consolidation phases with receipts', async () => {
    const fixture = await makeFixture();
    try {
      const ids = seedDuplicateSkills(fixture.paths);

      const preview = await fixture.tool.execute({ mode: 'preview', query: 'release checklist' });
      expect(preview.success).toBe(true);
      const previewJson = JSON.parse(preview.output ?? '{}') as {
        readonly candidateId: string;
        readonly survivorId: string;
        readonly duplicateIds: readonly string[];
        readonly phases: readonly { readonly id: string; readonly route: string }[];
      };
      expect(previewJson.candidateId).toContain('consolidation:skill');
      expect(previewJson.survivorId).toBe(ids.survivorId);
      expect(previewJson.duplicateIds).toContain(ids.duplicateId);
      expect(previewJson.phases.find((phase) => phase.id === 'merge')?.route).toContain('agent_learning_consolidation');

      const unconfirmedMerge = await fixture.tool.execute({
        mode: 'merge',
        candidateId: previewJson.candidateId,
        explicitUserRequest: 'Merge duplicate release checklist skill records.',
      });
      expect(unconfirmedMerge.success).toBe(false);
      expect(unconfirmedMerge.error).toContain('confirm:true');

      const merged = await fixture.tool.execute({
        mode: 'merge',
        candidateId: previewJson.candidateId,
        confirm: true,
        explicitUserRequest: 'Merge duplicate release checklist skill records.',
      });
      expect(merged.success).toBe(true);
      const mergedJson = JSON.parse(merged.output ?? '{}') as {
        readonly receipt: { readonly receiptId: string; readonly rollbackRoute: string };
      };
      expect(mergedJson.receipt.receiptId).toContain('lcon-merge');
      expect(mergedJson.receipt.rollbackRoute).toContain('mode:"rollback"');
      let survivor = AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.survivorId);
      expect(survivor?.description).toContain('UX inventory');
      expect(survivor?.tags).toContain('ux-inventory');
      expect(survivor?.triggers).toContain('ux');

      const rollbackMerge = await fixture.tool.execute({
        mode: 'rollback',
        receiptId: mergedJson.receipt.receiptId,
        confirm: true,
        explicitUserRequest: 'Undo the survivor merge.',
      });
      expect(rollbackMerge.success).toBe(true);
      survivor = AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.survivorId);
      expect(survivor?.description).toBe('Run package verification before release.');
      expect(survivor?.tags).toEqual(['release']);
      expect(survivor?.triggers).toEqual(['release']);
      expect(survivor?.reviewState).toBe('reviewed');

      const refusedDelete = await fixture.tool.execute({
        mode: 'delete',
        candidateId: previewJson.candidateId,
        confirm: true,
        explicitUserRequest: 'Delete duplicate release checklist skill records.',
      });
      expect(refusedDelete.success).toBe(false);
      expect(refusedDelete.error).toContain('Stage duplicates stale first');

      const stale = await fixture.tool.execute({
        mode: 'stale',
        candidateId: previewJson.candidateId,
        confirm: true,
        explicitUserRequest: 'Stage duplicate release checklist skill records stale.',
      });
      expect(stale.success).toBe(true);
      const staleJson = JSON.parse(stale.output ?? '{}') as {
        readonly receipt: { readonly receiptId: string };
      };
      let duplicate = AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.duplicateId);
      expect(duplicate?.reviewState).toBe('stale');

      const rollbackStale = await fixture.tool.execute({
        mode: 'rollback',
        receiptId: staleJson.receipt.receiptId,
        confirm: true,
        explicitUserRequest: 'Undo the duplicate stale staging.',
      });
      expect(rollbackStale.success).toBe(true);
      duplicate = AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.duplicateId);
      expect(duplicate?.reviewState).toBe('fresh');

      await fixture.tool.execute({
        mode: 'stale',
        candidateId: previewJson.candidateId,
        confirm: true,
        explicitUserRequest: 'Stage duplicate release checklist skill records stale.',
      });
      const deleted = await fixture.tool.execute({
        mode: 'delete',
        candidateId: previewJson.candidateId,
        confirm: true,
        explicitUserRequest: 'Delete duplicate release checklist skill records.',
      });
      expect(deleted.success).toBe(true);
      const deletedJson = JSON.parse(deleted.output ?? '{}') as {
        readonly receipt: {
          readonly receiptId: string;
          readonly recreateRoute: string;
          readonly deleteRecovery: {
            readonly records: readonly {
              readonly previousId: string;
              readonly expectedId: string;
              readonly exactId: { readonly possible: boolean };
              readonly createArguments: Record<string, unknown>;
            }[];
          };
        };
        readonly recreateGuidance: {
          readonly records: readonly {
            readonly previousId: string;
            readonly expectedId: string;
            readonly exactId: { readonly possible: boolean };
          }[];
        };
      };
      expect(deletedJson.receipt.recreateRoute).toContain('mode:"recreate"');
      expect(deletedJson.recreateGuidance.records[0]).toEqual(expect.objectContaining({
        previousId: ids.duplicateId,
        expectedId: ids.duplicateId,
        exactId: expect.objectContaining({ possible: true }),
      }));
      expect(deletedJson.receipt.deleteRecovery.records[0]?.createArguments).toEqual(expect.objectContaining({
        domain: 'skill',
        action: 'create',
        name: 'Release checklist!',
      }));
      expect(AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.duplicateId)).toBeNull();

      const deleteRollback = await fixture.tool.execute({
        mode: 'rollback',
        receiptId: deletedJson.receipt.receiptId,
        confirm: true,
        explicitUserRequest: 'Undo the duplicate delete.',
      });
      expect(deleteRollback.success).toBe(false);
      expect(deleteRollback.error).toContain('mode:"recreate"');

      const recreated = await fixture.tool.execute({
        mode: 'recreate',
        receiptId: deletedJson.receipt.receiptId,
        confirm: true,
        explicitUserRequest: 'Recreate the deleted duplicate release checklist skill record.',
      });
      expect(recreated.success).toBe(true);
      const recreatedJson = JSON.parse(recreated.output ?? '{}') as {
        readonly recreatedIds: readonly string[];
        readonly exactIdsPreserved: boolean;
        readonly receipt: { readonly receiptId: string; readonly phase: string };
      };
      expect(recreatedJson.exactIdsPreserved).toBe(true);
      expect(recreatedJson.recreatedIds).toContain(ids.duplicateId);
      expect(recreatedJson.receipt.receiptId).toContain('lcon-recreate');
      expect(recreatedJson.receipt.phase).toBe('recreate');
      duplicate = AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.duplicateId);
      expect(duplicate?.name).toBe('Release checklist!');
      expect(duplicate?.reviewState).toBe('stale');

      const receipts = await fixture.tool.execute({ mode: 'receipts' });
      expect(receipts.success).toBe(true);
      expect(receipts.output).toContain('lcon-delete');
      expect(receipts.output).toContain('lcon-recreate');
      expect(receipts.output).toContain('deleteRecovery');
      expect(existsSync(fixture.paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'learning', 'consolidation-receipts.json'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('refuses to delete duplicate skills still referenced by bundles', async () => {
    const fixture = await makeFixture();
    try {
      const ids = seedDuplicateSkills(fixture.paths);
      AgentSkillRegistry.fromShellPaths(fixture.paths).createBundle({
        name: 'Release bundle',
        description: 'Bundle still points at the duplicate.',
        skillIds: [ids.survivorId, ids.duplicateId],
        source: 'agent',
      });
      const preview = await fixture.tool.execute({ mode: 'preview', query: 'release checklist' });
      const candidateId = (JSON.parse(preview.output ?? '{}') as { readonly candidateId: string }).candidateId;
      await fixture.tool.execute({
        mode: 'stale',
        candidateId,
        confirm: true,
        explicitUserRequest: 'Stage duplicate release checklist skill records stale.',
      });

      const deleted = await fixture.tool.execute({
        mode: 'delete',
        candidateId,
        confirm: true,
        explicitUserRequest: 'Delete duplicate release checklist skill records.',
      });

      expect(deleted.success).toBe(false);
      expect(deleted.error).toContain('still referenced by bundles');
      expect(AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.duplicateId)).not.toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  test('registers the learning consolidation tool', async () => {
    const fixture = await makeFixture();
    try {
      const registry = new ToolRegistry();
      registerAgentLearningConsolidationTool(registry, fixture.paths, fixture.memoryRegistry);
      expect(registry.has('agent_learning_consolidation')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
  test('a receipts page cut short by limit reports how many receipts are stored', async () => {
    const fixture = await makeFixture();
    try {
      const receiptFile = fixture.paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'learning', 'consolidation-receipts.json');
      mkdirSync(dirname(receiptFile), { recursive: true });
      const stored = 7;
      writeFileSync(receiptFile, JSON.stringify({
        version: 1,
        receipts: Array.from({ length: stored }, (_value, index) => ({
          id: `lcon-stored-${index}`,
          createdAt: new Date(1_700_000_000_000 + index).toISOString(),
          domain: 'memory',
          candidateId: `candidate-${index}`,
          phase: 'merge',
          explicitUserRequest: 'Consolidate these.',
          survivorId: `survivor-${index}`,
          duplicateIds: [`duplicate-${index}`],
          beforeDuplicates: [],
        })),
      }));

      const short = await fixture.tool.execute({ mode: 'receipts', limit: 2 });
      expect(short.success).toBe(true);
      const shortBody = JSON.parse(short.output!) as {
        readonly receipts: readonly unknown[];
        readonly returned: number;
        readonly total: number;
        readonly note?: string;
      };
      expect(shortBody.receipts).toHaveLength(2);
      expect(shortBody.returned).toBe(2);
      expect(shortBody.total).toBe(stored);
      expect(shortBody.note).toContain(`2 newest of ${stored} receipts`);

      const whole = await fixture.tool.execute({ mode: 'receipts', limit: 50 });
      expect(whole.success).toBe(true);
      const wholeBody = JSON.parse(whole.output!) as {
        readonly returned: number;
        readonly total: number;
        readonly note?: string;
      };
      expect(wholeBody.returned).toBe(stored);
      expect(wholeBody.total).toBe(stored);
      expect(wholeBody.note).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

});
