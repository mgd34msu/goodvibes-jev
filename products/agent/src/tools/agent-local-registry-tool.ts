import { installAgentMemoryInputGuard } from './agent-memory-input-guard.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import { MemoryRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import type { MemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { AgentPersonaRegistry, type AgentPersonaRecord } from '../agent/persona-registry.ts';
import { AgentNoteRegistry, type AgentNoteRecord } from '../agent/note-registry.ts';
import { AgentRoutineRegistry, type AgentRoutineRecord } from '../agent/routine-registry.ts';
import { AgentSkillRegistry, type AgentSkillBundleRecord, type AgentSkillRecord } from '../agent/skill-registry.ts';
import { formatAgentRecordOrigin, formatAgentRecordReviewState } from '../agent/record-labels.ts';
import { buildAgentLocalRequirements } from './agent-local-registry-requirements.ts';
import {
  AGENT_TOOL_PROVENANCE,
  type AgentLocalRegistryToolArgs,
  readAffirmative,
  readString,
  readStringList,
  registryError,
  registryOutput,
  requireConfirmedDelete,
  requireDescription,
  requireId,
  requireName,
  requireTextField,
} from './agent-local-registry-args.ts';
import { handleMemory, MEMORY_CLASSES, MEMORY_SCOPES } from './agent-local-registry-memory.ts';

export type AgentLocalRegistryDomain = 'memory' | 'note' | 'persona' | 'skill' | 'skill_bundle' | 'routine';
export type AgentLocalRegistryAction = 'list' | 'search' | 'get' | 'create' | 'update' | 'enable' | 'disable' | 'review' | 'stale' | 'use' | 'clear_active' | 'start' | 'delete';
export type { AgentLocalRegistryToolArgs } from './agent-local-registry-args.ts';

const DOMAINS: readonly AgentLocalRegistryDomain[] = ['memory', 'note', 'persona', 'skill', 'skill_bundle', 'routine'];
const ACTIONS: readonly AgentLocalRegistryAction[] = ['list', 'search', 'get', 'create', 'update', 'enable', 'disable', 'review', 'stale', 'use', 'clear_active', 'start', 'delete'];

function isDomain(value: unknown): value is AgentLocalRegistryDomain {
  return typeof value === 'string' && DOMAINS.includes(value as AgentLocalRegistryDomain);
}

function isAction(value: unknown): value is AgentLocalRegistryAction {
  return typeof value === 'string' && ACTIONS.includes(value as AgentLocalRegistryAction);
}

function formatNote(note: AgentNoteRecord): string {
  const tags = note.tags.length > 0 ? ` tags ${note.tags.join(', ')}` : '';
  const sourceUrl = note.sourceUrl ? ` source ${note.sourceUrl}` : '';
  return `${note.id}  ${formatAgentRecordReviewState(note.reviewState)}  ${formatAgentRecordOrigin(note.source, note.provenance)}${tags}${sourceUrl}  ${note.title}`;
}

function listNotes(records: readonly AgentNoteRecord[], title: string): string {
  return records.length === 0
    ? `${title}\nNo Agent-local notes.`
    : [title, ...records.map(formatNote)].join('\n');
}

function handleNote(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs): string {
  const registry = AgentNoteRegistry.fromShellPaths(shellPaths);
  if (action === 'list') return listNotes(registry.list(), 'Agent-local notes');
  if (action === 'search') return listNotes(registry.search(readString(args.query)), 'Agent-local notes search');
  if (action === 'get') {
    const note = registry.get(requireId(args));
    if (!note) return `Unknown Agent-local note ${readString(args.id)}`;
    return [
      formatNote(note),
      `created ${note.createdAt}`,
      `updated ${note.updatedAt}`,
      `origin ${formatAgentRecordOrigin(note.source, note.provenance)}`,
      '',
      note.body,
    ].join('\n');
  }
  if (action === 'create') {
    const note = registry.create({
      title: requireTextField(args.title ?? args.name ?? args.summary, 'title'),
      body: requireTextField(args.body ?? args.detail ?? args.description, 'body'),
      tags: readStringList(args.tags),
      sourceUrl: readString(args.sourceUrl) || undefined,
      source: 'agent',
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      'Created Agent-local note',
      `  id ${note.id}`,
      `  title ${note.title}`,
    ].join('\n');
  }
  if (action === 'update') {
    const note = registry.update(requireId(args), {
      title: readString(args.title ?? args.name ?? args.summary) || undefined,
      body: readString(args.body ?? args.detail ?? args.description) || undefined,
      tags: args.tags === undefined ? undefined : readStringList(args.tags),
      sourceUrl: args.sourceUrl === undefined ? undefined : readString(args.sourceUrl),
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      'Updated Agent-local note',
      `  id ${note.id}`,
      `  title ${note.title}`,
    ].join('\n');
  }
  if (action === 'review') {
    const note = registry.markReviewed(requireId(args));
    return [
      'Reviewed Agent-local note',
      `  id ${note.id}`,
    ].join('\n');
  }
  if (action === 'stale') {
    const note = registry.markStale(requireId(args), readString(args.reason));
    return [
      'Marked Agent-local note stale',
      `  id ${note.id}`,
    ].join('\n');
  }
  if (action === 'delete') {
    requireConfirmedDelete(args, 'Agent-local note');
    const note = registry.deleteNote(requireId(args));
    return [
      'Deleted Agent-local note',
      `  id ${note.id}`,
      `  title ${note.title}`,
    ].join('\n');
  }
  throw new Error(`Action ${action} is not valid for notes.`);
}

function formatPersona(persona: AgentPersonaRecord, activeId: string | null): string {
  const active = persona.id === activeId ? 'active' : 'inactive';
  return `${persona.id}  ${active}  ${formatAgentRecordReviewState(persona.reviewState)}  ${persona.name} - ${persona.description}`;
}

function formatSkill(skill: AgentSkillRecord): string {
  const enabled = skill.enabled ? 'enabled' : 'disabled';
  return `${skill.id}  ${enabled}  ${formatAgentRecordReviewState(skill.reviewState)}  ${skill.name} - ${skill.description}`;
}

function formatSkillBundle(bundle: AgentSkillBundleRecord): string {
  const enabled = bundle.enabled ? 'enabled' : 'disabled';
  return `${bundle.id}  ${enabled}  ${formatAgentRecordReviewState(bundle.reviewState)}  ${bundle.name} - ${bundle.description} skills ${bundle.skillIds.join(', ')}`;
}

function formatRoutine(routine: AgentRoutineRecord): string {
  const enabled = routine.enabled ? 'enabled' : 'disabled';
  return `${routine.id}  ${enabled}  ${formatAgentRecordReviewState(routine.reviewState)}  starts ${routine.startCount}  ${routine.name} - ${routine.description}`;
}

function listPersonas(registry: AgentPersonaRegistry, records: readonly AgentPersonaRecord[], title: string): string {
  const snapshot = registry.snapshot();
  return records.length === 0
    ? `${title}\nNo Agent-local personas.`
    : [title, ...records.map((persona) => formatPersona(persona, snapshot.activePersonaId))].join('\n');
}

function listSkills(records: readonly AgentSkillRecord[], title: string): string {
  return records.length === 0
    ? `${title}\nNo Agent-local skills.`
    : [title, ...records.map(formatSkill)].join('\n');
}

function listSkillBundles(records: readonly AgentSkillBundleRecord[], title: string): string {
  return records.length === 0
    ? `${title}\nNo Agent-local skill bundles.`
    : [title, ...records.map(formatSkillBundle)].join('\n');
}

function listRoutines(records: readonly AgentRoutineRecord[], title: string): string {
  return records.length === 0
    ? `${title}\nNo Agent-local routines.`
    : [title, ...records.map(formatRoutine)].join('\n');
}

function handlePersona(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs): string {
  const registry = AgentPersonaRegistry.fromShellPaths(shellPaths);
  if (action === 'list') return listPersonas(registry, registry.list(), 'Agent-local personas');
  if (action === 'search') return listPersonas(registry, registry.search(readString(args.query)), 'Agent-local personas search');
  if (action === 'get') {
    const persona = registry.get(requireId(args));
    if (!persona) return `Unknown Agent-local persona ${readString(args.id)}`;
    return [
      formatPersona(persona, registry.snapshot().activePersonaId),
      `origin ${formatAgentRecordOrigin(persona.source, persona.provenance)}`,
      `triggers ${persona.triggers.join(', ') || '(manual)'}`,
      `tags ${persona.tags.join(', ') || '(none)'}`,
      '',
      persona.body,
    ].join('\n');
  }
  if (action === 'create') {
    const persona = registry.create({
      name: requireName(args),
      description: requireDescription(args),
      body: requireTextField(args.body, 'body'),
      tags: readStringList(args.tags),
      triggers: readStringList(args.triggers),
      source: 'agent',
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    if (args.activate !== undefined && readAffirmative(args.activate)) registry.setActive(persona.id);
    return [
      'Created Agent-local persona',
      `  id ${persona.id}`,
      `  name ${persona.name}`,
    ].join('\n');
  }
  if (action === 'update') {
    const wasActive = registry.snapshot().activePersonaId === requireId(args);
    const persona = registry.update(requireId(args), {
      name: readString(args.name) || undefined,
      description: readString(args.description) || undefined,
      body: readString(args.body) || undefined,
      tags: args.tags === undefined ? undefined : readStringList(args.tags),
      triggers: args.triggers === undefined ? undefined : readStringList(args.triggers),
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    if (args.activate !== undefined) { if (readAffirmative(args.activate)) registry.setActive(persona.id); else if (wasActive) registry.clearActive(); }
    return [
      'Updated Agent-local persona',
      `  id ${persona.id}`,
      `  name ${persona.name}`,
    ].join('\n');
  }
  if (action === 'use') {
    const persona = registry.setActive(requireId(args));
    return [
      'Active Agent-local persona set',
      `  id ${persona.id}`,
      `  name ${persona.name}`,
    ].join('\n');
  }
  if (action === 'clear_active') {
    registry.clearActive();
    return 'Cleared active Agent-local persona.';
  }
  if (action === 'review') {
    const persona = registry.markReviewed(requireId(args));
    return [
      'Reviewed Agent-local persona',
      `  id ${persona.id}`,
    ].join('\n');
  }
  if (action === 'stale') {
    const persona = registry.markStale(requireId(args), readString(args.reason));
    return [
      'Marked Agent-local persona stale',
      `  id ${persona.id}`,
    ].join('\n');
  }
  if (action === 'delete') {
    requireConfirmedDelete(args, 'Agent-local persona');
    const persona = registry.deletePersona(requireId(args));
    return [
      'Deleted Agent-local persona',
      `  id ${persona.id}`,
      `  name ${persona.name}`,
    ].join('\n');
  }
  throw new Error(`Action ${action} is not valid for personas.`);
}

function handleSkill(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs): string {
  const registry = AgentSkillRegistry.fromShellPaths(shellPaths);
  if (action === 'list') return listSkills(registry.list(), 'Agent-local skills');
  if (action === 'search') return listSkills(registry.search(readString(args.query)), 'Agent-local skills search');
  if (action === 'get') {
    const skill = registry.get(requireId(args));
    if (!skill) return `Unknown Agent-local skill ${readString(args.id)}`;
    return [
      formatSkill(skill),
      `origin ${formatAgentRecordOrigin(skill.source, skill.provenance)}`,
      `provenance: ${skill.provenance}`,
      `triggers ${skill.triggers.join(', ') || '(manual)'}`,
      `tags ${skill.tags.join(', ') || '(none)'}`,
      '',
      skill.procedure,
    ].join('\n');
  }
  if (action === 'create') {
    const skill = registry.create({
      name: requireName(args),
      description: requireDescription(args),
      procedure: requireTextField(args.procedure, 'procedure'),
      triggers: readStringList(args.triggers),
      tags: readStringList(args.tags),
      requirements: buildAgentLocalRequirements(args.requiresEnv, args.requiresCommands),
      enabled: args.enabled === true,
      source: 'agent',
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      `Created Agent-local skill ${skill.id}`,
      `  id ${skill.id}`,
      `  name ${skill.name}`,
    ].join('\n');
  }
  if (action === 'update') {
    const skill = registry.update(requireId(args), {
      name: readString(args.name) || undefined,
      description: readString(args.description) || undefined,
      procedure: readString(args.procedure) || undefined,
      triggers: args.triggers === undefined ? undefined : readStringList(args.triggers),
      tags: args.tags === undefined ? undefined : readStringList(args.tags),
      requirements: buildAgentLocalRequirements(args.requiresEnv, args.requiresCommands),
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      'Updated Agent-local skill',
      `  id ${skill.id}`,
      `  name ${skill.name}`,
    ].join('\n');
  }
  if (action === 'enable' || action === 'disable') {
    const skill = registry.setEnabled(requireId(args), action === 'enable');
    return [
      `${action === 'enable' ? 'Enabled' : 'Disabled'} Agent-local skill`,
      `  id ${skill.id}`,
      `  name ${skill.name}`,
    ].join('\n');
  }
  if (action === 'review') {
    const skill = registry.markReviewed(requireId(args));
    return [
      'Reviewed Agent-local skill',
      `  id ${skill.id}`,
    ].join('\n');
  }
  if (action === 'stale') {
    const skill = registry.markStale(requireId(args), readString(args.reason));
    return [
      'Marked Agent-local skill stale',
      `  id ${skill.id}`,
    ].join('\n');
  }
  if (action === 'delete') {
    requireConfirmedDelete(args, 'Agent-local skill');
    const skill = registry.deleteSkill(requireId(args));
    return [
      'Deleted Agent-local skill',
      `  id ${skill.id}`,
      `  name ${skill.name}`,
    ].join('\n');
  }
  throw new Error(`Action ${action} is not valid for skills.`);
}

function handleSkillBundle(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs): string {
  const registry = AgentSkillRegistry.fromShellPaths(shellPaths);
  if (action === 'list') return listSkillBundles(registry.listBundles(), 'Agent-local skill bundles');
  if (action === 'search') return listSkillBundles(registry.searchBundles(readString(args.query)), 'Agent-local skill bundles search');
  if (action === 'get') {
    const bundle = registry.getBundle(requireId(args));
    if (!bundle) return `Unknown Agent-local skill bundle ${readString(args.id)}`;
    return [
      formatSkillBundle(bundle),
      `origin ${formatAgentRecordOrigin(bundle.source, bundle.provenance)}`,
      `skills ${bundle.skillIds.join(', ')}`,
      '',
      bundle.description,
    ].join('\n');
  }
  if (action === 'create') {
    const bundle = registry.createBundle({
      name: requireName(args),
      description: requireDescription(args),
      skillIds: readStringList(args.skillIds ?? args.skills),
      enabled: args.enabled === true,
      source: 'agent',
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      `Created Agent-local skill bundle ${bundle.id}`,
      `  id ${bundle.id}`,
      `  name ${bundle.name}`,
    ].join('\n');
  }
  if (action === 'update') {
    const bundle = registry.updateBundle(requireId(args), {
      name: readString(args.name) || undefined,
      description: readString(args.description) || undefined,
      skillIds: args.skillIds === undefined && args.skills === undefined ? undefined : readStringList(args.skillIds ?? args.skills),
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      'Updated Agent-local skill bundle',
      `  id ${bundle.id}`,
      `  name ${bundle.name}`,
    ].join('\n');
  }
  if (action === 'enable' || action === 'disable') {
    const bundle = registry.setBundleEnabled(requireId(args), action === 'enable');
    return [
      `${action === 'enable' ? 'Enabled' : 'Disabled'} Agent-local skill bundle`,
      `  id ${bundle.id}`,
      `  name ${bundle.name}`,
    ].join('\n');
  }
  if (action === 'review') {
    const bundle = registry.markBundleReviewed(requireId(args));
    return [
      'Reviewed Agent-local skill bundle',
      `  id ${bundle.id}`,
    ].join('\n');
  }
  if (action === 'stale') {
    const bundle = registry.markBundleStale(requireId(args), readString(args.reason));
    return [
      'Marked Agent-local skill bundle stale',
      `  id ${bundle.id}`,
    ].join('\n');
  }
  if (action === 'delete') {
    requireConfirmedDelete(args, 'Agent-local skill bundle');
    const bundle = registry.deleteBundle(requireId(args));
    return [
      'Deleted Agent-local skill bundle',
      `  id ${bundle.id}`,
      `  name ${bundle.name}`,
    ].join('\n');
  }
  throw new Error(`Action ${action} is not valid for skill bundles.`);
}

function handleRoutine(shellPaths: ShellPathService, action: AgentLocalRegistryAction, args: AgentLocalRegistryToolArgs): string {
  const registry = AgentRoutineRegistry.fromShellPaths(shellPaths);
  if (action === 'list') return listRoutines(registry.list(), 'Agent-local routines');
  if (action === 'search') return listRoutines(registry.search(readString(args.query)), 'Agent-local routines search');
  if (action === 'get') {
    const routine = registry.get(requireId(args));
    if (!routine) return `Unknown Agent-local routine ${readString(args.id)}`;
    return [
      formatRoutine(routine),
      `origin ${formatAgentRecordOrigin(routine.source, routine.provenance)}`,
      `triggers ${routine.triggers.join(', ') || '(manual)'}`,
      `tags ${routine.tags.join(', ') || '(none)'}`,
      '',
      routine.steps,
    ].join('\n');
  }
  if (action === 'create') {
    const routine = registry.create({
      name: requireName(args),
      description: requireDescription(args),
      steps: requireTextField(args.steps, 'steps'),
      triggers: readStringList(args.triggers),
      tags: readStringList(args.tags),
      requirements: buildAgentLocalRequirements(args.requiresEnv, args.requiresCommands),
      enabled: args.enabled === true,
      source: 'agent',
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      'Created Agent-local routine',
      `  id ${routine.id}`,
      `  name ${routine.name}`,
    ].join('\n');
  }
  if (action === 'update') {
    const routine = registry.update(requireId(args), {
      name: readString(args.name) || undefined,
      description: readString(args.description) || undefined,
      steps: readString(args.steps) || undefined,
      triggers: args.triggers === undefined ? undefined : readStringList(args.triggers),
      tags: args.tags === undefined ? undefined : readStringList(args.tags),
      requirements: buildAgentLocalRequirements(args.requiresEnv, args.requiresCommands),
      provenance: readString(args.provenance) || AGENT_TOOL_PROVENANCE,
    });
    return [
      'Updated Agent-local routine',
      `  id ${routine.id}`,
      `  name ${routine.name}`,
    ].join('\n');
  }
  if (action === 'enable' || action === 'disable') {
    const routine = registry.setEnabled(requireId(args), action === 'enable');
    return [
      `${action === 'enable' ? 'Enabled' : 'Disabled'} Agent-local routine`,
      `  id ${routine.id}`,
      `  name ${routine.name}`,
    ].join('\n');
  }
  if (action === 'start') {
    const routine = registry.markStarted(requireId(args));
    return [
      'Started Agent-local routine',
      `  id ${routine.id}`,
      `  name ${routine.name}`,
      'Policy: same main conversation; no hidden background job, connected-host mutation, or external side effect was started.',
      '',
      routine.steps,
    ].join('\n');
  }
  if (action === 'review') {
    const routine = registry.markReviewed(requireId(args));
    return [
      'Reviewed Agent-local routine',
      `  id ${routine.id}`,
    ].join('\n');
  }
  if (action === 'stale') {
    const routine = registry.markStale(requireId(args), readString(args.reason));
    return [
      'Marked Agent-local routine stale',
      `  id ${routine.id}`,
    ].join('\n');
  }
  if (action === 'delete') {
    requireConfirmedDelete(args, 'Agent-local routine');
    const routine = registry.deleteRoutine(requireId(args));
    return [
      'Deleted Agent-local routine',
      `  id ${routine.id}`,
      `  name ${routine.name}`,
    ].join('\n');
  }
  throw new Error(`Action ${action} is not valid for routines.`);
}

export function createAgentLocalRegistryTool(shellPaths: ShellPathService, memoryRegistry: MemoryRegistry, memorySpine: MemoryAccess): Tool {
  return {
    definition: {
      name: 'agent_local_registry',
      description: 'Inspect or update Agent-local records.',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', enum: [...DOMAINS] },
          action: { type: 'string', enum: [...ACTIONS] },
          id: { type: 'string' },
          query: { type: 'string' },
          semantic: { type: 'boolean', description: 'Memory search: semantic by default; false forces literal matching.' },
          cls: { type: 'string', enum: [...MEMORY_CLASSES], description: 'Memory class when domain is memory.' },
          scope: { type: 'string', enum: [...MEMORY_SCOPES], description: 'Memory scope when domain is memory.' },
          summary: { type: 'string', description: 'Memory summary when domain is memory.' },
          detail: { type: 'string', description: 'Memory detail when domain is memory.' },
          confidence: { type: 'number', description: 'Memory review confidence from 0 to 100.' },
          title: { type: 'string', description: 'Note title when domain is note.' },
          name: { type: 'string' },
          description: { type: 'string' },
          body: { type: 'string', description: 'Note body or persona body/instructions.' },
          sourceUrl: { type: 'string', description: 'Optional source URL when domain is note.' },
          procedure: { type: 'string', description: 'Skill procedure.' },
          steps: { type: 'string', description: 'Routine steps.' },
          skills: { type: 'array', items: { type: 'string' }, description: 'Skill ids for skill_bundle create/update.' },
          skillIds: { type: 'array', items: { type: 'string' }, description: 'Skill ids for skill_bundle create/update.' },
          requiresEnv: { type: 'array', items: { type: 'string' }, description: 'Required environment variable names.' },
          requiresCommands: { type: 'array', items: { type: 'string' }, description: 'Command names required by a skill or routine.' },
          triggers: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          enabled: { type: 'boolean' },
          activate: { type: 'boolean', description: 'Activate or clear the persona.' },
          provenance: { type: 'string' },
          confirm: { type: 'boolean', description: 'Required true for delete after an explicit user request.' },
          explicitUserRequest: { type: 'string', description: 'Exact user request or faithful short summary authorizing delete.' },
        },
        required: ['domain', 'action'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
    },
    execute: async (rawArgs: unknown) => {
      const args = rawArgs as AgentLocalRegistryToolArgs;
      if (!isDomain(args.domain)) return registryError(`Unknown domain. Valid values ${DOMAINS.join(', ')}.`);
      if (!isAction(args.action)) return registryError(`Unknown action. Valid values ${ACTIONS.join(', ')}.`);
      try {
        if (args.domain === 'memory') return registryOutput(await handleMemory(memoryRegistry, memorySpine, args.action, args));
        if (args.domain === 'note') return registryOutput(handleNote(shellPaths, args.action, args));
        if (args.domain === 'persona') return registryOutput(handlePersona(shellPaths, args.action, args));
        if (args.domain === 'skill') return registryOutput(handleSkill(shellPaths, args.action, args));
        if (args.domain === 'skill_bundle') return registryOutput(handleSkillBundle(shellPaths, args.action, args));
        return registryOutput(handleRoutine(shellPaths, args.action, args));
      } catch (error) {
        return registryError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerAgentLocalRegistryTool(registry: ToolRegistry, shellPaths: ShellPathService, memoryRegistry: MemoryRegistry, memorySpine: MemoryAccess): void {
  installAgentMemoryInputGuard(registry);
  registry.register(createAgentLocalRegistryTool(shellPaths, memoryRegistry, memorySpine));
}
