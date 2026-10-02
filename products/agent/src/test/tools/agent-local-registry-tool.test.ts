import { useMemoryReadings } from '../helpers/memory-readings.ts';
import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createAgentLocalRegistryTool, registerAgentLocalRegistryTool } from '../../tools/agent-local-registry-tool.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { createLocalMemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { buildReviewedMemoryPrompt } from '../../agent/memory-prompt.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ReturnType<typeof shellPaths>;

function shellPaths() {
  const root = makeProjectTempDir('goodvibes-agent-local-registry-tool');
  return createShellPathService({ workingDirectory: root, homeDirectory: root });
}

async function createMemoryRegistry(paths: ShellPaths): Promise<MemoryRegistry> {
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
  });
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const store = new MemoryStore(paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory.sqlite'), { embeddingRegistry });
  await store.init();
  return new MemoryRegistry(store);
}

async function toolFixture(): Promise<{
  readonly paths: ShellPaths;
  readonly memoryRegistry: MemoryRegistry;
  readonly tool: ReturnType<typeof createAgentLocalRegistryTool>;
}> {
  const paths = shellPaths();
  const memoryRegistry = await createMemoryRegistry(paths);
  return {
    paths,
    memoryRegistry,
    tool: createAgentLocalRegistryTool(paths, memoryRegistry, createLocalMemoryAccess(memoryRegistry)),
  };
}

describe('agent_local_registry tool', () => {
  test('creates and reviews Agent-local memory without external side effects', async () => {
    const { memoryRegistry, tool } = await toolFixture();

    const created = await tool.execute({
      domain: 'memory',
      action: 'create',
      cls: 'fact',
      scope: 'project',
      summary: 'User prefers concise morning operator briefings.',
      detail: 'Keep routine briefings under five bullets unless the user asks for detail.',
      confidence: 88,
      tags: ['preference', 'briefing'],
      provenance: 'test-turn',
    });

    expect(created.success).toBe(true);
    expect(created.output).toContain('Created Agent-local memory');
    let records = memoryRegistry.getAll();
    expect(records).toHaveLength(1);
    expect(records[0]?.summary).toBe('User prefers concise morning operator briefings.');
    expect(records[0]?.scope).toBe('project');
    expect(records[0]?.cls).toBe('fact');
    expect(records[0]?.confidence).toBe(88);

    const reviewed = await tool.execute({
      domain: 'memory',
      action: 'review',
      id: records[0]?.id,
      confidence: 92,
    });

    expect(reviewed.success).toBe(true);
    records = memoryRegistry.getAll();
    expect(records[0]?.reviewState).toBe('reviewed');
    expect(records[0]?.confidence).toBe(92);
    expect(await buildReviewedMemoryPrompt(memoryRegistry)).toContain('User prefers concise morning operator briefings.');
  });

  test('searches and shows Agent-local memory from the model-visible tool', async () => {
    const { memoryRegistry, tool } = await toolFixture();
    await tool.execute({
      domain: 'memory',
      action: 'create',
      cls: 'constraint',
      summary: 'Never fallback to non-Agent knowledge routes.',
      tags: ['knowledge', 'policy'],
    });

    const searched = await tool.execute({ domain: 'memory', action: 'search', query: 'fallback' });

    expect(searched.success).toBe(true);
    expect(searched.output).toContain('Never fallback');
    const [record] = memoryRegistry.getAll();
    const shown = await tool.execute({ domain: 'memory', action: 'get', id: record?.id });
    expect(shown.success).toBe(true);
    expect(shown.output).toContain('provenance:');
  });

  test('recall action defaults to semantic: a fact stored with different wording than the query still recalls', async () => {
    const { tool } = await toolFixture();
    await tool.execute({
      domain: 'memory',
      action: 'create',
      cls: 'fact',
      summary: 'User prefers concise morning operator briefings under five bullets.',
      tags: ['briefing'],
    });

    // The exact dogfood repro: the query is natural language that does NOT appear as a
    // literal substring in the stored summary, so a plain LIKE scan (the old default)
    // would never find it. The default recall action must still surface it.
    const naturalLanguageQuery = 'how long should morning briefings be';
    const semantic = await tool.execute({ domain: 'memory', action: 'search', query: naturalLanguageQuery });
    expect(semantic.success).toBe(true);
    expect(semantic.output).toContain('operator briefings');
    expect(semantic.output).toContain('semantic');

    // Prove the literal path really would have missed it, this is the bug being fixed,
    // not an assumption about it.
    const literal = await tool.execute({ domain: 'memory', action: 'search', query: naturalLanguageQuery, semantic: false });
    expect(literal.success).toBe(true);
    expect(literal.output).toContain('No Agent-local memory records matched');
    expect(literal.output).toContain('literal');
  });

  test('recall action reports a score/similarity with each semantic match, never a bare unexplained list', async () => {
    const { tool } = await toolFixture();
    await tool.execute({
      domain: 'memory',
      action: 'create',
      cls: 'fact',
      summary: 'The deploy pipeline requires a green typecheck before merge.',
    });

    const result = await tool.execute({ domain: 'memory', action: 'search', query: 'deploy pipeline typecheck' });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/match \d+% \(score -?\d+\)/);
  });

  test('an unhealthy semantic index falls back to literal search with a stated reason, never a silent empty result', async () => {
    const { paths } = await toolFixture();
    const configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
      workingDir: paths.workingDirectory,
    });
    const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
    const store = new MemoryStore(
      paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory-disabled-index.sqlite'),
      { embeddingRegistry, enableVectorIndex: false },
    );
    await store.init();
    const disabledIndexRegistry = new MemoryRegistry(store);
    const tool = createAgentLocalRegistryTool(paths, disabledIndexRegistry, createLocalMemoryAccess(disabledIndexRegistry));
    await tool.execute({
      domain: 'memory',
      action: 'create',
      cls: 'fact',
      summary: 'Recorded while the semantic index is disabled.',
    });

    const result = await tool.execute({ domain: 'memory', action: 'search', query: 'semantic index disabled' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('literal fallback');
    expect(result.output).toContain('disabled');
    // The stated reason must appear even though the query matched nothing (empty result
    // must still say WHY, not just "no records matched").
    const emptyResult = await tool.execute({ domain: 'memory', action: 'search', query: 'no match at all here' });
    expect(emptyResult.success).toBe(true);
    expect(emptyResult.output).toContain('literal fallback');
    await store.close();
  });

  test('deletes Agent-local records only after explicit confirmation', async () => {
    const { paths, tool } = await toolFixture();
    const created = await tool.execute({
      domain: 'note',
      action: 'create',
      title: 'Delete candidate',
      body: 'Temporary note that should be removable from model-visible parity.',
    });
    expect(created.success).toBe(true);
    expect(AgentNoteRegistry.fromShellPaths(paths).list()).toHaveLength(1);

    const preview = await tool.execute({
      domain: 'note',
      action: 'delete',
      id: 'delete-candidate',
      explicitUserRequest: 'Delete the temporary note.',
    });
    expect(preview.success).toBe(false);
    expect(preview.error).toContain('confirm:true');
    expect(AgentNoteRegistry.fromShellPaths(paths).list()).toHaveLength(1);

    const deleted = await tool.execute({
      domain: 'note',
      action: 'delete',
      id: 'delete-candidate',
      confirm: true,
      explicitUserRequest: 'Delete the temporary note.',
    });
    expect(deleted.success).toBe(true);
    expect(deleted.output).toContain('Deleted Agent-local note');
    expect(AgentNoteRegistry.fromShellPaths(paths).list()).toHaveLength(0);
  });

  test('rejects secret-looking Agent memory from the model-visible tool', async () => {
    const { memoryRegistry, tool } = await toolFixture();

    const result = await tool.execute({
      domain: 'memory',
      action: 'create',
      cls: 'fact',
      summary: 'api_key=super-secret-value',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent memory cannot store secret-looking values');
    expect(memoryRegistry.getAll()).toHaveLength(0);
  });

  test('creates and enables an Agent-local skill without external side effects', async () => {
    const { paths, tool } = await toolFixture();

    const created = await tool.execute({
      domain: 'skill',
      action: 'create',
      name: 'Inbox triage',
      description: 'Classify and summarize incoming requests.',
      procedure: 'Read the request, classify urgency, summarize the next action.',
      tags: ['mail', 'triage'],
      triggers: ['inbox', 'email'],
      requiresEnv: ['MAILBOX_TOKEN'],
      requiresCommands: ['mailctl'],
      enabled: true,
    });

    expect(created.success).toBe(true);
    expect(created.output).toContain('Created Agent-local skill inbox-triage');
    const snapshot = AgentSkillRegistry.fromShellPaths(paths).snapshot();
    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.enabledSkills[0]?.source).toBe('agent');
    expect(snapshot.enabledSkills[0]?.provenance).toBe('agent-local-registry-tool');
    expect(snapshot.enabledSkills[0]?.requirements.map((requirement) => `${requirement.kind}:${requirement.name}`)).toEqual([
      'env:MAILBOX_TOKEN',
      'command:mailctl',
    ]);
  });

  test('can activate and clear personas through model-visible registry fields', async () => {
    const { paths, tool } = await toolFixture();

    const created = await tool.execute({
      domain: 'persona',
      action: 'create',
      name: 'Incident lead',
      description: 'Drive incident response.',
      body: 'Keep status concise and identify owners.',
      activate: true,
    });
    expect(created.success).toBe(true);
    let snapshot = AgentPersonaRegistry.fromShellPaths(paths).snapshot();
    expect(snapshot.activePersonaId).toBe('incident-lead');

    const updated = await tool.execute({
      domain: 'persona',
      action: 'update',
      id: 'incident-lead',
      activate: false,
    });
    expect(updated.success).toBe(true);
    snapshot = AgentPersonaRegistry.fromShellPaths(paths).snapshot();
    expect(snapshot.activePersonaId).toBeNull();
  });

  test('rejects blank self-created behavior records from the model-visible tool', async () => {
    const { paths, tool } = await toolFixture();

    const persona = await tool.execute({
      domain: 'persona',
      action: 'create',
      name: 'Blank persona',
      description: 'Should be rejected.',
    });
    const skill = await tool.execute({
      domain: 'skill',
      action: 'create',
      name: 'Blank skill',
      description: 'Should be rejected.',
    });
    const routine = await tool.execute({
      domain: 'routine',
      action: 'create',
      name: 'Blank routine',
      description: 'Should be rejected.',
    });

    expect(persona.success).toBe(false);
    expect(persona.error).toContain('body is required');
    expect(skill.success).toBe(false);
    expect(skill.error).toContain('procedure is required');
    expect(routine.success).toBe(false);
    expect(routine.error).toContain('steps is required');
    expect(AgentPersonaRegistry.fromShellPaths(paths).list()).toHaveLength(0);
    expect(AgentSkillRegistry.fromShellPaths(paths).list()).toHaveLength(0);
    expect(AgentRoutineRegistry.fromShellPaths(paths).list()).toHaveLength(0);
  });

  test('creates and enables Agent-local skill bundles from the model-visible tool', async () => {
    const { paths, tool } = await toolFixture();
    await tool.execute({
      domain: 'skill',
      action: 'create',
      name: 'Research brief',
      description: 'Build concise source-backed research summaries.',
      procedure: 'Search sources, extract key facts, cite provenance, and summarize tradeoffs.',
      enabled: true,
    });
    await tool.execute({
      domain: 'skill',
      action: 'create',
      name: 'Action checklist',
      description: 'Turn findings into a short execution checklist.',
      procedure: 'Create a bounded checklist with owners, risks, and next actions.',
      enabled: false,
    });

    const created = await tool.execute({
      domain: 'skill_bundle',
      action: 'create',
      name: 'Research operator',
      description: 'Source-backed research followed by action planning.',
      skills: ['research-brief', 'action-checklist'],
      enabled: true,
    });

    expect(created.success).toBe(true);
    expect(created.output).toContain('Created Agent-local skill bundle research-operator');
    let snapshot = AgentSkillRegistry.fromShellPaths(paths).snapshot();
    expect(snapshot.bundles).toHaveLength(1);
    expect(snapshot.enabledBundles[0]?.skillIds).toEqual(['research-brief', 'action-checklist']);
    expect(snapshot.activeSkills.map((skill) => skill.id)).toEqual(['research-brief', 'action-checklist']);

    const reviewed = await tool.execute({ domain: 'skill_bundle', action: 'review', id: 'research-operator' });
    expect(reviewed.success).toBe(true);
    snapshot = AgentSkillRegistry.fromShellPaths(paths).snapshot();
    expect(snapshot.bundles[0]?.reviewState).toBe('reviewed');

    const searched = await tool.execute({ domain: 'skill_bundle', action: 'search', query: 'research' });
    expect(searched.success).toBe(true);
    expect(searched.output).toContain('research-operator');
  });

  test('rejects Agent-local skill bundles with unknown skill ids', async () => {
    const { paths, tool } = await toolFixture();

    const created = await tool.execute({
      domain: 'skill_bundle',
      action: 'create',
      name: 'Missing bundle',
      description: 'Should not create against missing skills.',
      skillIds: ['missing-skill'],
    });

    expect(created.success).toBe(false);
    expect(created.error).toContain('Unknown skill for bundle');
    expect(AgentSkillRegistry.fromShellPaths(paths).snapshot().bundles).toHaveLength(0);
  });

  test('creates and uses an Agent-local persona', async () => {
    const { paths, tool } = await toolFixture();

    const created = await tool.execute({
      domain: 'persona',
      action: 'create',
      name: 'Travel planner',
      description: 'Plan trips with constraints and clear tradeoffs.',
      body: 'Ask only for missing constraints, then build a practical itinerary.',
      tags: ['travel'],
    });
    expect(created.success).toBe(true);

    const used = await tool.execute({ domain: 'persona', action: 'use', id: 'travel-planner' });
    expect(used.success).toBe(true);
    expect(used.output).toContain('Active Agent-local persona set');
    expect(AgentPersonaRegistry.fromShellPaths(paths).snapshot().activePersona?.id).toBe('travel-planner');
  });

  test('starts a routine only in the same serial conversation', async () => {
    const { paths, tool } = await toolFixture();
    await tool.execute({
      domain: 'routine',
      action: 'create',
      name: 'Morning brief',
      description: 'Review operator state before the day starts.',
      steps: 'Check local memory, work plan, approvals, and Agent Knowledge status.',
      requiresEnv: ['GOODVIBES_OPERATOR_TOKEN'],
      requiresCommands: ['goodvibes-agent'],
      enabled: true,
    });

    const started = await tool.execute({ domain: 'routine', action: 'start', id: 'morning-brief' });

    expect(started.success).toBe(true);
    expect(started.output).toContain('same main conversation');
    expect(started.output).toContain('no hidden background job');
    expect(AgentRoutineRegistry.fromShellPaths(paths).get('morning-brief')?.startCount).toBe(1);
    expect(AgentRoutineRegistry.fromShellPaths(paths).get('morning-brief')?.requirements.map((requirement) => `${requirement.kind}:${requirement.name}`)).toEqual([
      'env:GOODVIBES_OPERATOR_TOKEN',
      'command:goodvibes-agent',
    ]);
  });

  test('gates destructive actions and rejects external actions instead of inventing behavior', async () => {
    const { tool } = await toolFixture();

    const deleted = await tool.execute({ domain: 'skill', action: 'delete', id: 'anything' });
    const deletedBundle = await tool.execute({ domain: 'skill_bundle', action: 'delete', id: 'anything' });
    const deletedMemory = await tool.execute({ domain: 'memory', action: 'delete', id: 'anything' });
    const scheduled = await tool.execute({ domain: 'routine', action: 'schedule', id: 'anything' });

    expect(deleted.success).toBe(false);
    expect(deleted.error).toContain('explicitUserRequest');
    expect(deletedBundle.success).toBe(false);
    expect(deletedBundle.error).toContain('explicitUserRequest');
    expect(deletedMemory.success).toBe(false);
    expect(deletedMemory.error).toContain('explicitUserRequest');
    expect(scheduled.success).toBe(false);
    expect(scheduled.error).toContain('Unknown action');
  });

  test('is registered in the tool registry for model use', async () => {
    const registry = new ToolRegistry();
    const paths = shellPaths();
    const memoryRegistry = await createMemoryRegistry(paths);
    registerAgentLocalRegistryTool(registry, paths, memoryRegistry, createLocalMemoryAccess(memoryRegistry));

    expect(registry.has('agent_local_registry')).toBe(true);
    const result = await registry.execute('call-1', 'agent_local_registry', {
      domain: 'memory',
      action: 'list',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Agent-local memory');
  });
});

useMemoryReadings();
