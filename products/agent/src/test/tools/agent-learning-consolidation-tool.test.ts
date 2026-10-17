import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ToolRegistry, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { ConfigManager, DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { createShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import {
  createAgentLearningConsolidationTool,
  registerAgentLearningConsolidationTool,
} from '../../tools/agent-learning-consolidation-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { judgmentPort, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(fakePort((name, question) => {
    if (name === 'match') return noulAnswer(0.99);
    if (question.type === 'score' && ['usefulness', 'freshness', 'source_quality', 'risk', 'priority', 'confidence', 'link'].includes(name)) {
      return scoreAnswer(question, name === 'risk' ? 0 : name === 'link' ? 2 : 4, 0.999);
    }
    if ((name === 'same_record' || name.startsWith('fits_')) && question.type === 'noul') return noulAnswer(0.999);
    if (question.type === 'choice') {
      const label = Object.hasOwn(question.criteria, '0') ? '0' : name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'hazard' ? 'none' : 'generic';
      return choiceAnswer(question, label, 0.999);
    }
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unscripted consolidation reading ${name}`);
  }).port, log));
});
afterEach(() => { installJudgmentPort(previousPort); log[Symbol.dispose](); });
afterAll(cleanupResearchScreeningFixtures);

type ShellPaths = ReturnType<typeof createShellPathService>;

interface Fixture {
  readonly root: string;
  readonly paths: ShellPaths;
  readonly memoryRegistry: MemoryRegistry;
  readonly tool: ReturnType<typeof createAgentLearningConsolidationTool>;
  readonly rawTool: Tool;
  readonly setMode: (mode: PermissionMode) => void;
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
  let mode: PermissionMode = 'prompt'; let sequence = 0;
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory: root }),
    getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => root,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
  registerAgentLearningConsolidationTool(registry, paths, memoryRegistry);
  const rawTool = createAgentLearningConsolidationTool(paths, memoryRegistry, registry);
  const tool: Tool = { ...rawTool, async execute(args, options) {
    const id = `consolidation-effect-${++sequence}`;
    const call = await registry.prepareCall(id, 'agent_learning_consolidation', args, { signal: options?.signal });
    const admission = await manager.admitAutonomous(id, 'agent_learning_consolidation', call.args, {
      sourceOf: () => ({ goal: 'Verify isolated local consolidation phases', criteria: ['Only modify the temporary fixture stores'] }),
      signal: options?.signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
    });
    if (!admission.result.approved) throw new Error(admission.result.reasonCode);
    return registry.executePrepared(call, admission);
  } };
  return {
    root,
    paths,
    memoryRegistry,
    tool, rawTool, setMode(next) { mode = next; },
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
  test('caller confirmation flags cannot write, while a recorded plan-mode read cannot authorize mutation', async () => {
    const fixture = await makeFixture();
    try {
      const ids = seedDuplicateSkills(fixture.paths);
      const preview = await fixture.rawTool.execute({ mode: 'preview', query: 'release checklist' });
      expect(preview).toMatchObject({ success: true });
      const value: unknown = JSON.parse(String(preview.output));
      if (!value || typeof value !== 'object' || !('candidateId' in value) || typeof value.candidateId !== 'string') throw new Error('Missing consolidation candidate.');
      const args = { mode: 'merge', candidateId: value.candidateId, confirm: true, explicitUserRequest: 'Caller assertion' };
      expect(await fixture.rawTool.execute(args)).toMatchObject({ success: false, error: expect.stringContaining('recorded effect admission') });
      fixture.setMode('plan');
      await expect(fixture.tool.execute(args)).rejects.toThrow();
      expect(AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.survivorId)?.description).toBe('Run package verification before release.');
    } finally { fixture.cleanup(); }
  });

  test.each(['cancel', 'revoke', 'receipt-source', 'backend-accessor'] as const)('a pending admitted consolidation fences %s before writing', async change => {
    const fixture = await makeFixture();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    let accessed = 0;
    try {
      const ids = seedDuplicateSkills(fixture.paths);
      const backend = judgmentPort('agent.test.consolidation-fence');
      installJudgmentPort({ ...backend, async ask(request) {
        if (request.context?.battery === 'engine.tools.registry-rank') { started.resolve(); await release.promise; }
        return backend.ask(request);
      } });
      const pending = fixture.tool.execute({ mode: 'merge', query: 'release checklist' }, { signal: controller.signal });
      await started.promise;
      if (change === 'cancel') controller.abort(new Error('Consolidation cancelled'));
      if (change === 'revoke') fixture.setMode('plan');
      if (change === 'receipt-source') {
        const path = fixture.paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'learning', 'consolidation-receipts.json');
        mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'Changed complete receipt source.');
      }
      if (change === 'backend-accessor') Object.defineProperty(fixture.memoryRegistry, 'getStore', { get() { accessed++; throw new Error('Replacement backend accessor invoked.'); } });
      release.resolve();
      await expect(pending).rejects.toThrow();
      expect(accessed).toBe(0);
      expect(AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.survivorId)?.description).toBe('Run package verification before release.');
    } finally { release.resolve(); fixture.cleanup(); }
  });

  test('a symlink receipt target cannot redirect an admitted consolidation write', async () => {
    const fixture = await makeFixture();
    const outside = makeProjectTempDir('consolidation-outside-receipt');
    try {
      const ids = seedDuplicateSkills(fixture.paths);
      const path = fixture.paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'learning', 'consolidation-receipts.json');
      const target = `${outside}/untouched.json`;
      writeFileSync(target, 'untouched'); mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path);
      await expect(fixture.tool.execute({ mode: 'merge', query: 'release checklist' })).rejects.toThrow();
      expect(await Bun.file(target).text()).toBe('untouched');
      expect(AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.survivorId)?.description).toBe('Run package verification before release.');
    } finally { fixture.cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  test('retains the selected survivor and applies reversible duplicate consolidation phases with receipts', async () => {
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

      const unconfirmedMerge = await fixture.rawTool.execute({
        mode: 'merge',
        candidateId: previewJson.candidateId,
        explicitUserRequest: 'Merge duplicate release checklist skill records.',
      });
      expect(unconfirmedMerge.success).toBe(false);
      expect(unconfirmedMerge.error).toContain('recorded effect admission');

      const merged = await fixture.tool.execute({
        mode: 'merge',
        candidateId: previewJson.candidateId,
      });
      expect(merged.success).toBe(false);
      expect(merged.error).toContain('no survivor merge fields');
      // Same-entity and survivor-selection readings do not authorize new
      // synthesized guidance, tags, or executable triggers.
      const survivor = AgentSkillRegistry.fromShellPaths(fixture.paths).get(ids.survivorId);
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
