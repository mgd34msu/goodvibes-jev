import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceSessionCommandEditorKind } from './agent-workspace-session-command-editors.ts';
import { isAgentWorkspaceSessionCommandEditorKind } from './agent-workspace-session-command-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceSessionCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

export function isAgentWorkspaceSessionCommandSubmissionKind(kind: string): kind is AgentWorkspaceSessionCommandEditorKind {
  return isAgentWorkspaceSessionCommandEditorKind(kind as AgentWorkspaceSessionCommandEditorKind);
}

function unconfirmed(editor: AgentWorkspaceLocalEditor, message: string): AgentWorkspaceCommandEditorSubmission {
  return editorMessageSubmission(editor, message);
}

const SESSION_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceSessionCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'conversation-export': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Conversation export not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/export ${quoteSlashCommandArg(readField('format'))} ${quoteSlashCommandArg(readField('path'))} --yes`,
      'Opening conversation export',
      'The workspace handed a confirmed conversation export command to the shell-owned command router.',
      'safe',
    );
  },
  'conversation-events': (editor, readField) => conversationEventsOrGroups(editor, readField),
  'conversation-groups': (editor, readField) => conversationEventsOrGroups(editor, readField),
  'conversation-find': (_editor, readField) => {
    const kind = readField('kind');
    const command = kind.length > 0
      ? `/conversation find ${quoteSlashCommandArg(readField('query'))} ${quoteSlashCommandArg(kind)}`
      : `/conversation find ${quoteSlashCommandArg(readField('query'))}`;
    return dispatchCommandEditorSubmission(
      command,
      'Opening transcript search',
      'The workspace handed read-only transcript search to the shell-owned command router.',
      'read-only',
    );
  },
  'effort-level': (_editor, readField) => dispatchCommandEditorSubmission(
    `/effort ${quoteSlashCommandArg(readField('level'))}`,
    'Opening reasoning effort change',
    'The workspace handed reasoning effort selection to the shell-owned command router.',
    'safe',
  ),
  'session-save': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Session save not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/save ${quoteSlashCommandArg(readField('name'))}`,
      'Opening session save',
      'The workspace handed a confirmed session save command to the shell-owned command router.',
      'safe',
    );
  },
  'session-load': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Session load not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/load ${quoteSlashCommandArg(readField('name'))}`,
      'Opening session load',
      'The workspace handed a confirmed session load command to the shell-owned command router.',
      'safe',
    );
  },
  'session-rename': (_editor, readField) => dispatchCommandEditorSubmission(
    `/session rename ${quoteSlashCommandArg(readField('name'))}`,
    'Opening session rename',
    'The workspace handed current-session rename to the shell-owned command router.',
    'safe',
  ),
  'session-resume': (_editor, readField) => dispatchCommandEditorSubmission(
    `/session resume ${quoteSlashCommandArg(readField('target'))}`,
    'Opening session resume',
    'The workspace handed saved-session resume to the shell-owned command router.',
    'safe',
  ),
  'session-info': (_editor, readField) => dispatchCommandEditorSubmission(
    `/session info ${quoteSlashCommandArg(readField('target'))}`,
    'Opening session inspection',
    'The workspace handed read-only saved-session inspection to the shell-owned command router.',
    'read-only',
  ),
  'session-export-saved': (_editor, readField) => dispatchCommandEditorSubmission(
    `/session export ${quoteSlashCommandArg(readField('target'))} ${quoteSlashCommandArg(readField('format'))}`,
    'Opening saved-session export',
    'The workspace handed saved-session transcript export to the shell-owned command router.',
    'read-only',
  ),
  'session-search': (_editor, readField) => dispatchCommandEditorSubmission(
    `/session search ${quoteSlashCommandArg(readField('query'))}`,
    'Opening saved-session search',
    'The workspace handed saved-session search to the shell-owned command router.',
    'read-only',
  ),
  'session-delete': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Session delete not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/session delete ${quoteSlashCommandArg(readField('target'))} --yes`,
      'Opening saved-session delete',
      'The workspace handed confirmed saved-session deletion to the shell-owned command router.',
      'safe',
    );
  },
  'session-fork': (_editor, readField) => {
    const name = readField('name');
    return dispatchCommandEditorSubmission(
      name.length > 0 ? `/session fork ${quoteSlashCommandArg(name)}` : '/session fork',
      'Opening session fork',
      'The workspace handed current-session fork to the shell-owned command router.',
      'safe',
    );
  },
  'session-graph': (_editor, readField) => {
    const sessionId = readField('sessionId');
    const format = readField('format');
    const parts = ['/session', 'graph'];
    if (sessionId.length > 0) parts.push('--session', quoteSlashCommandArg(sessionId));
    if (format.length > 0) parts.push('--format', quoteSlashCommandArg(format));
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening session graph',
      'The workspace handed read-only session graph inspection to the shell-owned command router.',
      'read-only',
    );
  },
  'mode-preset': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Interaction mode change not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/mode ${quoteSlashCommandArg(readField('preset'))} --yes`,
      'Opening interaction mode change',
      'The workspace handed a confirmed interaction mode command to the shell-owned command router.',
      'safe',
    );
  },
  'mode-domain': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Domain verbosity change not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/mode set-domain ${quoteSlashCommandArg(readField('domain'))} ${quoteSlashCommandArg(readField('verbosity'))} --yes`,
      'Opening domain verbosity change',
      'The workspace handed a confirmed domain verbosity command to the shell-owned command router.',
      'safe',
    );
  },
};

function conversationEventsOrGroups(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  const subcommand = editor.kind === 'conversation-groups' ? 'groups' : 'events';
  const eventKind = readField('kind');
  const command = eventKind.length > 0
    ? `/conversation ${subcommand} ${quoteSlashCommandArg(eventKind)}`
    : `/conversation ${subcommand}`;
  return dispatchCommandEditorSubmission(
    command,
    editor.kind === 'conversation-groups' ? 'Opening transcript groups' : 'Opening transcript events',
    'The workspace handed read-only transcript structure inspection to the shell-owned command router.',
    'read-only',
  );
}

export function buildAgentWorkspaceSessionCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceSessionCommandEditorKind,
    editor,
    readField,
    SESSION_COMMAND_SUBMISSION_HANDLERS,
  );
}
