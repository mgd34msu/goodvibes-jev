import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceTaskCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  'task-list-filter' | 'task-show' | 'task-output'
>;

export function isAgentWorkspaceTaskCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceTaskCommandEditorKind {
  return kind === 'task-list-filter' || kind === 'task-show' || kind === 'task-output';
}

const TASK_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceTaskCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceTaskCommandEditorKind>>> = {
  'task-list-filter': {
    mode: 'create',
    title: 'Filter Host Tasks',
    selectedFieldIndex: 0,
    message: 'List connected-host tasks filtered by status or kind. This is read-only and never creates, retries, or cancels tasks.',
    fields: [
      { id: 'filter', label: 'Status or kind', value: '', required: false, multiline: false, hint: 'Optional task status or kind. Blank lists recent tasks.' },
    ],
  },
  'task-output': {
    mode: 'create',
    title: 'Show Task Output',
    selectedFieldIndex: 0,
    message: 'Print one connected-host task output from the Agent workspace. This is read-only and does not retry, cancel, or mutate the task.',
    fields: [
      { id: 'taskId', label: 'Task id', value: '', required: true, multiline: false, hint: 'Connected-host task id from Host tasks.' },
    ],
  },
  'task-show': {
    mode: 'create',
    title: 'Inspect Host Task',
    selectedFieldIndex: 0,
    message: 'Inspect one connected-host task from the Agent workspace. This is read-only and does not retry, cancel, or mutate the task.',
    fields: [
      { id: 'taskId', label: 'Task id', value: '', required: true, multiline: false, hint: 'Connected-host task id from Host tasks.' },
    ],
  },
};

export function createAgentWorkspaceTaskCommandEditor(kind: AgentWorkspaceTaskCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, TASK_COMMAND_EDITOR_SPECS);
}
