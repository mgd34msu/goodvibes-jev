import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

export type AgentWorkspaceWorkPlanEditorKind = 'workplan-add' | 'workplan-show' | 'workplan-status' | 'workplan-delete' | 'workplan-clear-completed';

export type AgentWorkspaceWorkPlanEditorSubmission =
  | {
    readonly kind: 'editor';
    readonly editor: AgentWorkspaceLocalEditor;
    readonly status: string;
    readonly actionResult?: AgentWorkspaceActionResult;
  }
  | {
    readonly kind: 'dispatch';
    readonly command: string;
    readonly status: string;
    readonly actionResult: AgentWorkspaceActionResult;
  };

const STATUS_COMMANDS: Record<string, string> = {
  pending: 'pending',
  todo: 'pending',
  start: 'start',
  active: 'start',
  progress: 'start',
  in_progress: 'start',
  blocked: 'blocked',
  block: 'blocked',
  done: 'done',
  complete: 'done',
  completed: 'done',
  failed: 'failed',
  fail: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  cancel: 'cancelled',
};

export function isAgentWorkspaceWorkPlanEditorKind(kind: string): kind is AgentWorkspaceWorkPlanEditorKind {
  return kind === 'workplan-add'
    || kind === 'workplan-show'
    || kind === 'workplan-status'
    || kind === 'workplan-delete'
    || kind === 'workplan-clear-completed';
}

function isAffirmative(value: string): boolean {
  return /^(y|yes|true)$/i.test(value.trim());
}

function unconfirmed(editor: AgentWorkspaceLocalEditor, message: string, status: string): AgentWorkspaceWorkPlanEditorSubmission {
  return {
    kind: 'editor',
    editor: { ...editor, message },
    status,
  };
}

function dispatch(command: string, title: string, status: string, detail: string, safety: 'safe' | 'read-only' | 'delegates' | 'blocked'): AgentWorkspaceWorkPlanEditorSubmission {
  return {
    kind: 'dispatch',
    command,
    status,
    actionResult: {
      kind: 'dispatched',
      title,
      detail,
      command,
      safety,
    },
  };
}

export function buildAgentWorkspaceWorkPlanEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceWorkPlanEditorSubmission {
  if (editor.kind === 'workplan-add') {
    const parts = ['/workplan', 'add', quoteSlashCommandArg(readField('title'))];
    const owner = readField('owner');
    const source = readField('source');
    const notes = readField('notes');
    if (owner.length > 0) parts.push('--owner', quoteSlashCommandArg(owner));
    if (source.length > 0) parts.push('--source', quoteSlashCommandArg(source));
    if (notes.length > 0) parts.push('--notes', quoteSlashCommandArg(notes));
    return dispatch(
      parts.join(' '),
      'Opening work plan item creation',
      'Opening work plan item creation.',
      'The workspace handed a visible work plan item creation command to the shell-owned command router.',
      'safe',
    );
  }

  if (editor.kind === 'workplan-show') {
    const format = readField('format').trim().toLowerCase();
    const command = format === 'markdown' ? '/workplan markdown' : '/workplan show';
    return dispatch(
      command,
      'Opening work plan detail',
      'Opening work plan detail.',
      'The workspace handed read-only work plan detail inspection to the shell-owned command router.',
      'read-only',
    );
  }

  if (editor.kind === 'workplan-status') {
    const requested = readField('status').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const commandStatus = STATUS_COMMANDS[requested];
    if (!commandStatus) {
      return {
        kind: 'editor',
        editor: { ...editor, message: 'Invalid status. Use pending, start, blocked, done, failed, or cancelled.' },
        status: 'Work plan status update needs a valid status.',
      };
    }
    const command = `/workplan ${commandStatus} ${quoteSlashCommandArg(readField('id'))}`;
    return dispatch(
      command,
      'Opening work plan status update',
      'Opening work plan status update.',
      'The workspace handed a visible work plan status update command to the shell-owned command router.',
      'safe',
    );
  }

  if (editor.kind === 'workplan-delete') {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Work plan removal not confirmed. Type yes, then press Enter.', 'Work plan removal not confirmed.');
    }
    const command = `/workplan remove ${quoteSlashCommandArg(readField('id'))} --yes`;
    return dispatch(
      command,
      'Opening work plan item removal',
      'Opening work plan item removal.',
      'The workspace handed a confirmed work plan removal command to the shell-owned command router.',
      'safe',
    );
  }

  if (!isAffirmative(readField('confirm'))) {
    return unconfirmed(editor, 'Clear completed work plan items not confirmed. Type yes, then press Enter.', 'Clear completed work plan items not confirmed.');
  }
  return dispatch(
    '/workplan clear-completed --yes',
    'Opening completed work plan cleanup',
    'Opening completed work plan cleanup.',
    'The workspace handed a confirmed work plan cleanup command to the shell-owned command router.',
    'safe',
  );
}
