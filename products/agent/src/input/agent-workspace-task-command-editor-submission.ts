import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceTaskCommandEditorKind } from './agent-workspace-task-command-editors.ts';
import { isAgentWorkspaceTaskCommandEditorKind } from './agent-workspace-task-command-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceTaskCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

export function isAgentWorkspaceTaskCommandSubmissionKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceTaskCommandEditorKind {
  return isAgentWorkspaceTaskCommandEditorKind(kind);
}

const TASK_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceTaskCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'task-list-filter': (_editor, readField) => {
    const filter = readField('filter');
    const command = filter.length > 0 ? `/tasks list ${quoteSlashCommandArg(filter)}` : '/tasks list';
    return dispatchCommandEditorSubmission(
      command,
      'Opening filtered task list',
      'The workspace handed read-only connected-host task listing to the shell-owned command router.',
      'read-only',
    );
  },
  'task-output': (editor, readField) => taskInspection(editor, readField),
  'task-show': (editor, readField) => taskInspection(editor, readField),
};

function taskInspection(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  const subcommand = editor.kind === 'task-output' ? 'output' : 'show';
  const command = `/tasks ${subcommand} ${quoteSlashCommandArg(readField('taskId'))}`;
  const title = editor.kind === 'task-output' ? 'Opening task output' : 'Opening task inspection';
  return dispatchCommandEditorSubmission(
    command,
    title,
    'The workspace handed read-only connected-host task inspection to the shell-owned command router.',
    'read-only',
  );
}

export function buildAgentWorkspaceTaskCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceTaskCommandEditorKind,
    editor,
    readField,
    TASK_COMMAND_SUBMISSION_HANDLERS,
  );
}
