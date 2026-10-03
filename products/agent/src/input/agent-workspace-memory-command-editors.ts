import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceMemoryCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  | 'memory-search'
  | 'memory-get'
  | 'memory-explain'
  | 'memory-promote'
  | 'memory-link'
  | 'memory-export'
  | 'memory-import'
  | 'memory-handoff-export'
  | 'memory-handoff-inspect'
  | 'memory-handoff-import'
  | 'memory-vector-rebuild'
>;

export function isAgentWorkspaceMemoryCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceMemoryCommandEditorKind {
  return kind === 'memory-search'
    || kind === 'memory-get'
    || kind === 'memory-explain'
    || kind === 'memory-promote'
    || kind === 'memory-link'
    || kind === 'memory-export'
    || kind === 'memory-import'
    || kind === 'memory-handoff-export'
    || kind === 'memory-handoff-inspect'
    || kind === 'memory-handoff-import'
    || kind === 'memory-vector-rebuild';
}

const MEMORY_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceMemoryCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceMemoryCommandEditorKind>>> = {
  'memory-search': {
    mode: 'create',
    title: 'Search Agent Memory',
    selectedFieldIndex: 0,
    message: 'Search Agent-local memory only. This does not query default knowledge or other product routes.',
    fields: [
      { id: 'query', label: 'Query', value: '', required: false, multiline: false, hint: 'Optional text query. Blank searches by filters.' },
      { id: 'scope', label: 'Scope', value: '', required: false, multiline: false, hint: 'Optional session, project, or team.' },
      { id: 'class', label: 'Class', value: '', required: false, multiline: false, hint: 'Optional fact, constraint, pattern, runbook, risk, etc.' },
      { id: 'limit', label: 'Limit', value: '', required: false, multiline: false, hint: 'Optional result limit.' },
      { id: 'semantic', label: 'Semantic', value: 'no', required: false, multiline: false, hint: 'yes/no. Uses the local vector index when available.' },
    ],
  },
  'memory-get': {
    mode: 'create',
    title: 'Show Agent Memory',
    selectedFieldIndex: 0,
    message: 'Show one Agent-local memory record with provenance and links.',
    fields: [
      { id: 'id', label: 'Memory id', value: '', required: true, multiline: false, hint: 'Existing Agent memory id.' },
    ],
  },
  'memory-explain': {
    mode: 'create',
    title: 'Explain Memory Selection',
    selectedFieldIndex: 0,
    message: 'Preview which reviewed Agent-local memory records would be selected for a task.',
    fields: [
      { id: 'task', label: 'Task', value: '', required: true, multiline: true, hint: 'Task description. Ctrl-J inserts a new line.' },
      { id: 'scopes', label: 'Scopes', value: '', required: false, multiline: false, hint: 'Optional comma-separated write scopes.' },
    ],
  },
  'memory-promote': {
    mode: 'update',
    title: 'Promote Agent Memory',
    selectedFieldIndex: 0,
    message: 'Promote one Agent-local memory record to another scope. Type yes on the final field to confirm.',
    fields: [
      { id: 'id', label: 'Memory id', value: '', required: true, multiline: false, hint: 'Existing Agent memory id.' },
      { id: 'scope', label: 'Scope', value: '', required: true, multiline: false, hint: 'session, project, or team.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /memory promote with --yes.' },
    ],
  },
  'memory-link': {
    mode: 'update',
    title: 'Link Agent Memories',
    selectedFieldIndex: 0,
    message: 'Create one directed relation between two Agent-local memory records. Type yes on the final field to confirm.',
    fields: [
      { id: 'fromId', label: 'From memory id', value: '', required: true, multiline: false, hint: 'Source memory id.' },
      { id: 'toId', label: 'To memory id', value: '', required: true, multiline: false, hint: 'Target memory id.' },
      { id: 'relation', label: 'Relation', value: '', required: true, multiline: false, hint: 'Short relation label, such as supports, supersedes, or contradicts.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /memory link with --yes.' },
    ],
  },
  'memory-export': {
    mode: 'create',
    title: 'Export Agent Memory Bundle',
    selectedFieldIndex: 0,
    message: 'Export Agent-local memory records and links to a reviewable JSON bundle. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'Output path', value: 'agent-memory-bundle.json', required: true, multiline: false, hint: 'Workspace-relative JSON path to write.' },
      { id: 'scope', label: 'Scope', value: '', required: false, multiline: false, hint: 'Optional session, project, or team.' },
      { id: 'class', label: 'Class', value: '', required: false, multiline: false, hint: 'Optional fact, constraint, pattern, runbook, risk, etc.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /memory export with --yes.' },
    ],
  },
  'memory-import': {
    mode: 'update',
    title: 'Import Agent Memory Bundle',
    selectedFieldIndex: 0,
    message: 'Import a reviewed Agent memory bundle into the Agent-local memory registry. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'Bundle path', value: 'agent-memory-bundle.json', required: true, multiline: false, hint: 'Workspace-relative JSON bundle path.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /memory import with --yes.' },
    ],
  },
  'memory-handoff-export': {
    mode: 'create',
    title: 'Export Memory Handoff',
    selectedFieldIndex: 0,
    message: 'Export a scoped Agent memory handoff bundle for review. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'Output path', value: 'agent-memory-handoff.json', required: true, multiline: false, hint: 'Workspace-relative JSON path to write.' },
      { id: 'scope', label: 'Scope', value: 'team', required: false, multiline: false, hint: 'session, project, or team. Blank defaults to team.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /memory handoff-export with --yes.' },
    ],
  },
  'memory-handoff-inspect': {
    mode: 'create',
    title: 'Inspect Memory Handoff',
    selectedFieldIndex: 0,
    message: 'Inspect a memory handoff bundle before importing it.',
    fields: [
      { id: 'path', label: 'Bundle path', value: 'agent-memory-handoff.json', required: true, multiline: false, hint: 'Workspace-relative JSON handoff bundle path.' },
    ],
  },
  'memory-handoff-import': {
    mode: 'update',
    title: 'Import Memory Handoff',
    selectedFieldIndex: 0,
    message: 'Import a reviewed memory handoff bundle into Agent-local memory. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'Bundle path', value: 'agent-memory-handoff.json', required: true, multiline: false, hint: 'Workspace-relative JSON handoff bundle path.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /memory handoff-import with --yes.' },
    ],
  },
  'memory-vector-rebuild': {
    mode: 'update',
    title: 'Rebuild Memory Vector Index',
    selectedFieldIndex: 0,
    message: 'Rebuild the Agent-local memory vector index. Type yes on the final field to confirm.',
    fields: [
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /memory vector rebuild.' },
    ],
  },
};

export function createAgentWorkspaceMemoryCommandEditor(kind: AgentWorkspaceMemoryCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, MEMORY_COMMAND_EDITOR_SPECS);
}
