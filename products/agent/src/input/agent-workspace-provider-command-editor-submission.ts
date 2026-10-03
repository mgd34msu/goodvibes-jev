import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceProviderCommandEditorKind } from './agent-workspace-provider-command-editors.ts';
import { isAgentWorkspaceProviderCommandEditorKind } from './agent-workspace-provider-command-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceProviderCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

function unconfirmed(editor: AgentWorkspaceLocalEditor, label: string): AgentWorkspaceCommandEditorSubmission {
  return editorMessageSubmission(editor, `${label} not confirmed. Type yes, then press Enter.`, `${label} not confirmed.`);
}

export function isAgentWorkspaceProviderCommandSubmissionKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceProviderCommandEditorKind {
  return isAgentWorkspaceProviderCommandEditorKind(kind);
}

const PROVIDER_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceProviderCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'provider-use': (_editor, readField) => {
    const model = readField('model');
    const command = [
      '/provider',
      quoteSlashCommandArg(readField('provider')),
      ...(model.length > 0 ? [quoteSlashCommandArg(model)] : []),
    ].join(' ');
    return dispatchCommandEditorSubmission(
      command,
      'Opening provider selection',
      'The workspace handed provider selection to the shell-owned command router.',
      'safe',
    );
  },
  'provider-inspect': (_editor, readField) => dispatchCommandEditorSubmission(
    `/accounts show ${quoteSlashCommandArg(readField('provider'))}`,
    'Opening provider inspection',
    'The workspace handed read-only provider inspection to the shell-owned command router.',
    'read-only',
  ),
  'provider-routes': (_editor, readField) => dispatchCommandEditorSubmission(
    `/accounts routes ${quoteSlashCommandArg(readField('provider'))}`,
    'Opening provider route inspection',
    'The workspace handed read-only provider route inspection to the shell-owned command router.',
    'read-only',
  ),
  'provider-account-repair': (_editor, readField) => dispatchCommandEditorSubmission(
    `/accounts repair ${quoteSlashCommandArg(readField('provider'))}`,
    'Opening provider account repair review',
    'The workspace handed read-only provider account repair guidance to the shell-owned command router.',
    'read-only',
  ),
  'provider-add': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Custom provider add');
    }
    const key = readField('apiKey');
    const parts = [
      '/provider',
      'add',
      quoteSlashCommandArg(readField('name')),
      quoteSlashCommandArg(readField('baseUrl')),
    ];
    const redactedParts = [...parts];
    if (key.length > 0) {
      parts.push(quoteSlashCommandArg(key));
      redactedParts.push('<redacted-api-key>');
    }
    parts.push('--yes');
    redactedParts.push('--yes');
    // The dispatched command carries the real key; the actionResult.command shown
    // in the transcript is redacted. This is the one submission in this domain that
    // cannot use dispatchCommandEditorSubmission, whose actionResult.command always
    // matches the dispatched command.
    return {
      kind: 'dispatch',
      command: parts.join(' '),
      status: 'Opening custom provider add.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening custom provider add',
        detail: 'The workspace handed a confirmed custom provider add command to the shell-owned command router without rendering the raw API key.',
        command: redactedParts.join(' '),
        safety: 'safe',
      },
    };
  },
  'provider-remove': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Custom provider removal');
    }
    return dispatchCommandEditorSubmission(
      `/provider remove ${quoteSlashCommandArg(readField('name'))} --yes`,
      'Opening custom provider removal',
      'The workspace handed a confirmed custom provider removal command to the shell-owned command router.',
      'safe',
    );
  },
};

export function buildAgentWorkspaceProviderCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceProviderCommandEditorKind,
    editor,
    readField,
    PROVIDER_COMMAND_SUBMISSION_HANDLERS,
  );
}
