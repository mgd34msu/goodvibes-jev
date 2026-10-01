import type { ShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import type { AgentWorkspaceLocalEditorKind } from './agent-workspace-types.ts';

export interface AgentWorkspaceLearnedBehaviorInput {
  readonly target: Exclude<AgentWorkspaceLocalEditorKind, 'memory' | 'note' | 'profile'>;
  readonly name: string;
  readonly description: string;
  readonly notes: string;
  readonly tags: readonly string[];
  readonly triggers: readonly string[];
  readonly enable: boolean;
}

export interface AgentWorkspaceLearnedBehaviorResult {
  readonly kind: Exclude<AgentWorkspaceLocalEditorKind, 'memory' | 'note' | 'profile'>;
  readonly id: string;
  readonly name: string;
}

export function createAgentWorkspaceLearnedBehavior(
  shellPaths: ShellPathService,
  input: AgentWorkspaceLearnedBehaviorInput,
): AgentWorkspaceLearnedBehaviorResult {
  if (input.target === 'persona') {
    const registry = AgentPersonaRegistry.fromShellPaths(shellPaths);
    const created = registry.create({
      name: input.name,
      description: input.description,
      body: input.notes,
      tags: input.tags,
      triggers: input.triggers,
      source: 'agent',
      provenance: 'agent-workspace-learned-behavior',
    });
    if (input.enable) registry.setActive(created.id);
    return { kind: 'persona', id: created.id, name: created.name };
  }

  if (input.target === 'skill') {
    const created = AgentSkillRegistry.fromShellPaths(shellPaths).create({
      name: input.name,
      description: input.description,
      procedure: input.notes,
      tags: input.tags,
      triggers: input.triggers,
      enabled: input.enable,
      source: 'agent',
      provenance: 'agent-workspace-learned-behavior',
    });
    return { kind: 'skill', id: created.id, name: created.name };
  }

  const created = AgentRoutineRegistry.fromShellPaths(shellPaths).create({
    name: input.name,
    description: input.description,
    steps: input.notes,
    tags: input.tags,
    triggers: input.triggers,
    enabled: input.enable,
    source: 'agent',
    provenance: 'agent-workspace-learned-behavior',
  });
  return { kind: 'routine', id: created.id, name: created.name };
}
