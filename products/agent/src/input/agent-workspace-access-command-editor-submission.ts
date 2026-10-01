import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceAccessCommandEditorKind } from './agent-workspace-access-command-editors.ts';
import { isAgentWorkspaceAccessCommandEditorKind } from './agent-workspace-access-command-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceAccessCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

export function isAgentWorkspaceAccessCommandSubmissionKind(kind: string): kind is AgentWorkspaceAccessCommandEditorKind {
  return isAgentWorkspaceAccessCommandEditorKind(kind as AgentWorkspaceAccessCommandEditorKind);
}

function unconfirmed(editor: AgentWorkspaceLocalEditor, message: string): AgentWorkspaceCommandEditorSubmission {
  return editorMessageSubmission(editor, message);
}

const ACCESS_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceAccessCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'auth-show': (_editor, readField) => dispatchCommandEditorSubmission(
    `/auth show ${quoteSlashCommandArg(readField('provider'))}`,
    'Opening provider auth inspection',
    'The workspace handed a read-only provider auth inspection command to the shell-owned command router.',
    'read-only',
  ),
  'auth-repair': (_editor, readField) => dispatchCommandEditorSubmission(
    `/auth repair ${quoteSlashCommandArg(readField('provider'))}`,
    'Opening provider auth repair review',
    'The workspace handed a read-only provider auth repair review command to the shell-owned command router.',
    'read-only',
  ),
  'auth-bundle-export': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Auth review bundle export not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/auth bundle export ${quoteSlashCommandArg(readField('path'))} --yes`,
      'Opening auth review bundle export',
      'The workspace handed a confirmed auth review bundle export command to the shell-owned command router.',
      'safe',
    );
  },
  'auth-bundle-inspect': (_editor, readField) => dispatchCommandEditorSubmission(
    `/auth bundle inspect ${quoteSlashCommandArg(readField('path'))}`,
    'Opening auth review bundle inspection',
    'The workspace handed a read-only auth review bundle inspect command to the shell-owned command router.',
    'read-only',
  ),
  'trust-bundle-export': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Trust bundle export not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/trust bundle export ${quoteSlashCommandArg(readField('path'))} --yes`,
      'Opening trust bundle export',
      'The workspace handed a confirmed trust bundle export command to the shell-owned command router.',
      'safe',
    );
  },
  'trust-bundle-inspect': (_editor, readField) => dispatchCommandEditorSubmission(
    `/trust bundle inspect ${quoteSlashCommandArg(readField('path'))}`,
    'Opening trust bundle inspection',
    'The workspace handed a read-only trust bundle inspect command to the shell-owned command router.',
    'read-only',
  ),
  'subscription-bundle-export': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Subscription bundle export not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/subscription bundle export ${quoteSlashCommandArg(readField('path'))} --yes`,
      'Opening subscription bundle export',
      'The workspace handed a confirmed subscription bundle export command to the shell-owned command router.',
      'safe',
    );
  },
  'subscription-bundle-inspect': (_editor, readField) => dispatchCommandEditorSubmission(
    `/subscription bundle inspect ${quoteSlashCommandArg(readField('path'))}`,
    'Opening subscription bundle inspection',
    'The workspace handed a read-only subscription bundle inspect command to the shell-owned command router.',
    'read-only',
  ),
  'voice-enable': (editor, readField) => voiceEnableDisable(editor, readField),
  'voice-disable': (editor, readField) => voiceEnableDisable(editor, readField),
  'voice-bundle-export': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Voice bundle export not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/voice bundle export ${quoteSlashCommandArg(readField('path'))} --yes`,
      'Opening voice bundle export',
      'The workspace handed a confirmed voice bundle export command to the shell-owned command router.',
      'safe',
    );
  },
  'voice-bundle-inspect': (_editor, readField) => dispatchCommandEditorSubmission(
    `/voice bundle inspect ${quoteSlashCommandArg(readField('path'))}`,
    'Opening voice bundle inspection',
    'The workspace handed a read-only voice bundle inspect command to the shell-owned command router.',
    'read-only',
  ),
};

function voiceEnableDisable(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, `Voice interaction ${editor.kind === 'voice-enable' ? 'enable' : 'disable'} not confirmed. Type yes, then press Enter.`);
  const mode = editor.kind === 'voice-enable' ? 'enable' : 'disable';
  return dispatchCommandEditorSubmission(
    `/voice ${mode} --yes`,
    `Opening voice interaction ${mode}`,
    `The workspace handed a confirmed voice ${mode} command to the shell-owned command router.`,
    'safe',
  );
}

export function buildAgentWorkspaceAccessCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceAccessCommandEditorKind,
    editor,
    readField,
    ACCESS_COMMAND_SUBMISSION_HANDLERS,
  );
}
