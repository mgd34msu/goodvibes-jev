import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { createLocalMemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { createShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createLocalEditor } from '../../input/agent-workspace-editors.ts';
import type { AgentWorkspaceLocalEditor } from '../../input/agent-workspace-types.ts';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { registerAgentLocalRegistryTool } from '../../tools/agent-local-registry-tool.ts';
import { runLocalWorkspaceAction, runLocalWorkspaceEditorAction } from '../../tools/agent-harness-local-operations.ts';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { nativeMemoryWorkAdmission } from '../helpers/native-memory-work-readings.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
const owned: Array<{ readonly root: string; readonly store: MemoryStore }> = [];
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  previous = installJudgmentPort(withDecisionLog(nativeMemoryWorkAdmission(undefined, 'read').port, log));
});
afterEach(() => {
  installJudgmentPort(previous); log[Symbol.dispose]();
  for (const { root, store } of owned.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); }
});

async function scene(editor: AgentWorkspaceLocalEditor, partialTarget = false, operation: 'note-edit' | 'skill-edit' | 'routine-edit' = 'note-edit') {
  const root = makeProjectTempDir('harness-local-producer');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT), workingDir: root });
  const store = new MemoryStore(paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory.sqlite'),
    { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }) });
  await store.init(); owned.push({ root, store });
  const memory = new MemoryRegistry(store);
  const parent: Tool = { definition: { name: 'agent_harness', description: 'Isolated native local editor producer.',
    parameters: { type: 'object', properties: {}, additionalProperties: true } },
    execute(args, options) {
      const deps = { commandContext: { workspace: { shellPaths: partialTarget ? undefined : paths } }, toolRegistry: effect.registry };
      return partialTarget || operation !== 'note-edit'
        ? runLocalWorkspaceAction(deps, { id: operation, label: 'Edit native record', detail: 'Native partial update',
          kind: 'local-operation', safety: 'safe', localOperation: operation }, args, options)
        : runLocalWorkspaceEditorAction(deps, editor, args, options);
    } };
  const effect = recordedEffectFixture(parent, 'prompt', {}, root);
  registerAgentLocalRegistryTool(effect.registry, paths, memory, createLocalMemoryAccess(memory));
  return { ...effect, paths, memory };
}

test('owned create forms omit absent ids and dispatch schema-native confidence and yes/no booleans', async () => {
  const memory = await scene(createLocalEditor('memory'));
  const memoryChild = spyOn(memory.registry, 'executeNested');
  try {
    expect(await memory.run({ mode: 'run_workspace_action', fields: { summary: 'Typed local confidence', confidence: '82.5' } })).toMatchObject({ success: true });
    expect(memoryChild.mock.calls[0]?.[2]).toMatchObject({ domain: 'memory', confidence: 82.5 });
    expect(memory.memory.getAll()[0]?.confidence).toBe(83);
  } finally { memoryChild.mockRestore(); }
  const persona = await scene(createLocalEditor('persona'));
  expect(await persona.run({ mode: 'run_workspace_action', fields: { name: 'Active guide', description: 'Temporary guide', body: 'Use concise language.', activate: 'yes' } })).toMatchObject({ success: true });
  expect(AgentPersonaRegistry.fromShellPaths(persona.paths).snapshot().activePersonaId).toBe('active-guide');
  const skill = await scene(createLocalEditor('skill'));
  expect(await skill.run({ mode: 'run_workspace_action', fields: { name: 'Held skill', description: 'Temporary skill', procedure: 'Review the local queue.', enabled: 'no' } })).toMatchObject({ success: true });
  expect(AgentSkillRegistry.fromShellPaths(skill.paths).get('held-skill')?.enabled).toBe(false);
});

test.each(['NaN', 'Infinity', '-1', '101'])('invalid confidence %s refuses before fresh child preparation and native persistence', async confidence => {
  const f = await scene(createLocalEditor('memory'));
  const child = spyOn(f.registry, 'executeNested');
  try {
    expect(await f.run({ mode: 'run_workspace_action', fields: { summary: 'Held invalid confidence', confidence } })).toMatchObject({ success: false });
    expect(child).not.toHaveBeenCalled();
    expect(f.memory.getAll()).toEqual([]);
  } finally { child.mockRestore(); }
});

test.each(['activate', 'enabled'] as const)('undeclared %s enum refuses before child preparation or native writes', async field => {
  const f = await scene(createLocalEditor(field === 'activate' ? 'persona' : 'skill'));
  const child = spyOn(f.registry, 'executeNested');
  try {
    for (const value of ['maybe', 'on', 'true', 'false']) {
      expect(await f.run({ mode: 'run_workspace_action', fields: { name: 'Held enum', description: 'Temporary record',
        body: 'Temporary instructions', procedure: 'Temporary procedure', [field]: value } })).toMatchObject({ success: false });
    }
    expect(child).not.toHaveBeenCalled();
    expect(AgentPersonaRegistry.fromShellPaths(f.paths).list()).toEqual([]);
    expect(AgentSkillRegistry.fromShellPaths(f.paths).list()).toEqual([]);
  } finally { child.mockRestore(); }
});

test('partial target update omits absent optional fields and preserves native title, tags and source', async () => {
  const f = await scene(createLocalEditor('note'), true);
  const notes = AgentNoteRegistry.fromShellPaths(f.paths);
  const original = notes.create({ title: 'Retained partial note', body: 'Original body', tags: ['retained'], sourceUrl: 'https://example.test/source' });
  expect(await f.run({ mode: 'run_workspace_action', recordId: original.id, fields: { body: 'Updated body' } })).toMatchObject({ success: true });
  expect(notes.get(original.id)).toMatchObject({ title: original.title, body: 'Updated body', tags: original.tags, sourceUrl: original.sourceUrl });
});

test.each([
  { kind: 'skill', field: 'requiresEnv' }, { kind: 'skill', field: 'requiresCommands' },
  { kind: 'routine', field: 'requiresEnv' }, { kind: 'routine', field: 'requiresCommands' },
] as const)('partial $kind $field update retains the native paired requirement and unrelated fields', async ({ kind, field }) => {
  const f = await scene(createLocalEditor(kind), false, kind === 'skill' ? 'skill-edit' : 'routine-edit');
  const requirements = [{ kind: 'env', name: 'ORIGINAL_ENV' }, { kind: 'command', name: 'git' }] as const;
  const registry = kind === 'skill' ? AgentSkillRegistry.fromShellPaths(f.paths) : AgentRoutineRegistry.fromShellPaths(f.paths);
  const original = kind === 'skill'
    ? AgentSkillRegistry.fromShellPaths(f.paths).create({ name: 'Retained skill', description: 'Retained summary',
      procedure: 'Retained native procedure', requirements, tags: ['retained'], enabled: true })
    : AgentRoutineRegistry.fromShellPaths(f.paths).create({ name: 'Retained routine', description: 'Retained summary',
      steps: 'Retained native steps', requirements, tags: ['retained'], enabled: true });
  const child = spyOn(f.registry, 'executeNested');
  try {
    const updated = field === 'requiresEnv' ? 'NEXT_ENV' : 'bun';
    const args = { mode: 'run_workspace_action', recordId: original.id, fields: { [field]: updated } };
    expect(await f.run(args)).toMatchObject({ success: true });
    expect(child.mock.calls[0]?.[2]).toMatchObject({
      requiresEnv: field === 'requiresEnv' ? ['NEXT_ENV'] : ['ORIGINAL_ENV'],
      requiresCommands: field === 'requiresCommands' ? ['bun'] : ['git'],
    });
    expect(registry.get(original.id)).toMatchObject({ name: original.name, description: original.description,
      tags: original.tags, enabled: original.enabled,
      requirements: [{ kind: 'env', name: field === 'requiresEnv' ? 'NEXT_ENV' : 'ORIGINAL_ENV' },
        { kind: 'command', name: field === 'requiresCommands' ? 'bun' : 'git' }] });
    if (kind === 'skill') expect(AgentSkillRegistry.fromShellPaths(f.paths).get(original.id)?.procedure).toBe('Retained native procedure');
    else expect(AgentRoutineRegistry.fromShellPaths(f.paths).get(original.id)?.steps).toBe('Retained native steps');
    const retainedRequirements = registry.get(original.id)?.requirements;
    expect(await f.run({ mode: 'run_workspace_action', recordId: original.id,
      fields: { description: 'Updated summary only' } })).toMatchObject({ success: true });
    expect(child).toHaveBeenCalledTimes(2);
    expect(child.mock.calls[1]?.[2]).not.toHaveProperty('requiresEnv');
    expect(child.mock.calls[1]?.[2]).not.toHaveProperty('requiresCommands');
    expect(registry.get(original.id)?.requirements).toEqual(retainedRequirements);
  } finally { child.mockRestore(); }
});

test('partial requirement fallback refuses without the observed counterpart before fresh child or persistence', async () => {
  const f = await scene(createLocalEditor('skill'), true, 'skill-edit');
  const skills = AgentSkillRegistry.fromShellPaths(f.paths);
  const original = skills.create({ name: 'Retained fallback skill', description: 'Retained summary',
    procedure: 'Retained procedure', requirements: [{ kind: 'env', name: 'ORIGINAL_ENV' }, { kind: 'command', name: 'git' }] });
  const child = spyOn(f.registry, 'executeNested');
  try {
    expect(await f.run({ mode: 'run_workspace_action', recordId: original.id, fields: { requiresEnv: 'NEXT_ENV' } }))
      .toMatchObject({ success: false, error: 'Workspace requirement update needs the current paired requirement field.' });
    expect(child).not.toHaveBeenCalled();
    expect(skills.get(original.id)).toEqual(original);
    expect(await f.run({ mode: 'run_workspace_action', recordId: original.id,
      fields: { requiresEnv: 'NEXT_ENV', requiresCommands: 'bun' } })).toMatchObject({ success: true });
    expect(child).toHaveBeenCalledTimes(1);
    expect(skills.get(original.id)?.requirements).toEqual([{ kind: 'env', name: 'NEXT_ENV' }, { kind: 'command', name: 'bun' }]);
  } finally { child.mockRestore(); }
});
