import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

export type AgentWorkspaceDelegationEditorSubmission =
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

function isAffirmative(value: string): boolean {
  return /^(y|yes|true)$/i.test(value.trim());
}

export function isAgentWorkspaceDelegationEditorKind(kind: string): kind is 'delegate-task' {
  return kind === 'delegate-task';
}

export function buildAgentWorkspaceDelegationEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceDelegationEditorSubmission {
  if (!isAffirmative(readField('confirm'))) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Build delegation not confirmed. Type yes, then press Enter.' },
      status: 'Build delegation not confirmed.',
    };
  }
  const parts = ['/delegate'];
  if (isAffirmative(readField('review')) || isAffirmative(readField('wrfc'))) parts.push('--review');
  const reason = readField('reason').trim();
  const success = readField('success').trim();
  const workspace = readField('workspace').trim();
  const priority = readField('priority').trim();
  if (reason) parts.push('--reason', quoteSlashCommandArg(reason));
  if (success) parts.push('--success', quoteSlashCommandArg(success));
  if (workspace) parts.push('--workspace', quoteSlashCommandArg(workspace));
  if (priority) parts.push('--priority', quoteSlashCommandArg(priority));
  parts.push(quoteSlashCommandArg(readField('task')));
  const command = parts.join(' ');
  return {
    kind: 'dispatch',
    command,
    status: 'Opening explicit build delegation.',
    actionResult: {
      kind: 'dispatched',
      title: 'Opening explicit build delegation',
      detail: 'The workspace handed a confirmed build/fix/review task to the shell-owned command router.',
      command,
      safety: 'delegates',
    },
  };
}
