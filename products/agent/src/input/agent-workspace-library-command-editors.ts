import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpec } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceLibraryCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  'persona-search' | 'persona-show' | 'skill-search' | 'skill-show' | 'routine-search' | 'routine-show'
>;

export function isAgentWorkspaceLibraryCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceLibraryCommandEditorKind {
  return kind === 'persona-search'
    || kind === 'persona-show'
    || kind === 'skill-search'
    || kind === 'skill-show'
    || kind === 'routine-search'
    || kind === 'routine-show';
}

function librarySpec(kind: AgentWorkspaceLibraryCommandEditorKind): AgentWorkspaceEditorSpec {
  const target = kind.startsWith('persona') ? 'persona' : kind.startsWith('skill') ? 'skill' : 'routine';
  const search = kind.endsWith('search');
  const label = target === 'persona' ? 'Persona' : target === 'skill' ? 'Skill' : 'Routine';
  return {
    mode: 'create',
    title: search ? `Search ${label}s` : `Show ${label}`,
    selectedFieldIndex: 0,
    message: search
      ? `Search Agent-local ${target}s by name, description, tags, triggers, or body.`
      : `Show one Agent-local ${target} by id.`,
    fields: [
      search
        ? { id: 'query', label: 'Search query', value: '', required: false, multiline: false, hint: `Optional text query. Blank lists every local ${target}.` }
        : { id: 'id', label: `${label} id`, value: '', required: true, multiline: false, hint: `Existing local ${target} id.` },
    ],
  };
}

const LIBRARY_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceLibraryCommandEditorKind, typeof librarySpec>> = {
  'persona-search': librarySpec,
  'persona-show': librarySpec,
  'skill-search': librarySpec,
  'skill-show': librarySpec,
  'routine-search': librarySpec,
  'routine-show': librarySpec,
};

export function createAgentWorkspaceLibraryCommandEditor(kind: AgentWorkspaceLibraryCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, LIBRARY_COMMAND_EDITOR_SPECS);
}
