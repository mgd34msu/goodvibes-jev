import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

export type AgentWorkspaceNotifyEditorKind = 'notify-webhook' | 'notify-webhook-remove' | 'notify-webhook-clear' | 'notify-webhook-test' | 'notify-send';

export type AgentWorkspaceNotifyEditorSubmission =
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

export function isAgentWorkspaceNotifyEditorKind(kind: string): kind is AgentWorkspaceNotifyEditorKind {
  return kind === 'notify-webhook'
    || kind === 'notify-webhook-remove'
    || kind === 'notify-webhook-clear'
    || kind === 'notify-webhook-test'
    || kind === 'notify-send';
}

function isAffirmative(value: string): boolean {
  return /^(y|yes|true)$/i.test(value.trim());
}

function unconfirmed(editor: AgentWorkspaceLocalEditor, message: string, status: string): AgentWorkspaceNotifyEditorSubmission {
  return {
    kind: 'editor',
    editor: { ...editor, message },
    status,
  };
}

function dispatch(command: string, title: string, status: string, detail: string): AgentWorkspaceNotifyEditorSubmission {
  return {
    kind: 'dispatch',
    command,
    status,
    actionResult: {
      kind: 'dispatched',
      title,
      detail,
      command,
      safety: 'safe',
    },
  };
}

export function buildAgentWorkspaceNotifyEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceNotifyEditorSubmission {
  if (editor.kind === 'notify-webhook') {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Notification webhook add not confirmed. Type yes, then press Enter.', 'Notification webhook add not confirmed.');
    }
    const command = `/notify add ${quoteSlashCommandArg(readField('url'))} --yes`;
    return dispatch(
      command,
      'Opening notification webhook add',
      'Opening notification webhook add.',
      'The workspace handed a confirmed notification target command to the shell-owned command router.',
    );
  }

  if (editor.kind === 'notify-webhook-remove') {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Notification webhook remove not confirmed. Type yes, then press Enter.', 'Notification webhook remove not confirmed.');
    }
    const command = `/notify remove ${quoteSlashCommandArg(readField('url'))} --yes`;
    return dispatch(
      command,
      'Opening notification webhook remove',
      'Opening notification webhook remove.',
      'The workspace handed a confirmed notification target remove command to the shell-owned command router.',
    );
  }

  if (editor.kind === 'notify-webhook-clear') {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Notification webhook clear not confirmed. Type yes, then press Enter.', 'Notification webhook clear not confirmed.');
    }
    return dispatch(
      '/notify clear --yes',
      'Opening notification webhook clear',
      'Opening notification webhook clear.',
      'The workspace handed a confirmed notification target cleanup command to the shell-owned command router.',
    );
  }

  if (editor.kind === 'notify-send') {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Notification send not confirmed. Type yes, then press Enter.', 'Notification send not confirmed.');
    }
    const command = `/notify send ${quoteSlashCommandArg(readField('message'))} --yes`;
    return dispatch(
      command,
      'Opening notification send',
      'Opening notification send.',
      'The workspace handed a confirmed notification send command to the shell-owned command router.',
    );
  }

  if (!isAffirmative(readField('confirm'))) {
    return unconfirmed(editor, 'Notification webhook test not confirmed. Type yes, then press Enter.', 'Notification webhook test not confirmed.');
  }
  return dispatch(
    '/notify test --yes',
    'Opening notification webhook test',
    'Opening notification webhook test.',
    'The workspace handed a confirmed notification test command to the shell-owned command router.',
  );
}
