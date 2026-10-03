import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceMemoryCommandEditorKind } from './agent-workspace-memory-command-editors.ts';
import { isAgentWorkspaceMemoryCommandEditorKind } from './agent-workspace-memory-command-editors.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { appendOptionalArg, buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative, splitCommaList } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceMemoryCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

function unconfirmed(editor: AgentWorkspaceLocalEditor, label: string): AgentWorkspaceCommandEditorSubmission {
  return editorMessageSubmission(editor, `${label} not confirmed. Type yes, then press Enter.`, `${label} not confirmed.`);
}

function requireConfirmation(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  label: string,
): AgentWorkspaceCommandEditorSubmission | null {
  return isAffirmative(readField('confirm')) ? null : unconfirmed(editor, label);
}

export function isAgentWorkspaceMemoryCommandSubmissionKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceMemoryCommandEditorKind {
  return isAgentWorkspaceMemoryCommandEditorKind(kind);
}

const MEMORY_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceMemoryCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'memory-search': (_editor, readField) => {
    const parts = ['/memory', 'search'];
    const query = readField('query');
    if (query.length > 0) parts.push(quoteSlashCommandArg(query));
    appendOptionalArg(parts, '--scope', readField('scope'));
    appendOptionalArg(parts, '--cls', readField('class'));
    appendOptionalArg(parts, '--limit', readField('limit'));
    if (isAffirmative(readField('semantic'))) parts.push('--semantic');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening Agent memory search',
      'The workspace handed an Agent-local memory search command to the shell-owned command router.',
      'read-only',
    );
  },
  'memory-get': (_editor, readField) => dispatchCommandEditorSubmission(
    `/memory get ${quoteSlashCommandArg(readField('id'))}`,
    'Opening Agent memory record',
    'The workspace handed an Agent-local memory lookup command to the shell-owned command router.',
    'read-only',
  ),
  'memory-explain': (_editor, readField) => {
    const parts = ['/memory', 'explain', quoteSlashCommandArg(readField('task'))];
    const scopes = splitCommaList(readField('scopes'));
    if (scopes.length > 0) {
      parts.push('--scope');
      for (const scope of scopes) parts.push(quoteSlashCommandArg(scope));
    }
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening Agent memory explanation',
      'The workspace handed an Agent-local memory explanation command to the shell-owned command router.',
      'read-only',
    );
  },
  'memory-promote': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Memory promotion');
    if (confirmation) return confirmation;
    return dispatchCommandEditorSubmission(
      `/memory promote ${quoteSlashCommandArg(readField('id'))} ${quoteSlashCommandArg(readField('scope'))} --yes`,
      'Opening Agent memory promotion',
      'The workspace handed a confirmed Agent-local memory promotion command to the shell-owned command router.',
      'safe',
    );
  },
  'memory-link': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Memory link');
    if (confirmation) return confirmation;
    return dispatchCommandEditorSubmission(
      `/memory link ${quoteSlashCommandArg(readField('fromId'))} ${quoteSlashCommandArg(readField('toId'))} ${quoteSlashCommandArg(readField('relation'))} --yes`,
      'Opening Agent memory link',
      'The workspace handed a confirmed Agent-local memory link command to the shell-owned command router.',
      'safe',
    );
  },
  'memory-export': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Memory bundle export');
    if (confirmation) return confirmation;
    const parts = ['/memory', 'export', quoteSlashCommandArg(readField('path'))];
    appendOptionalArg(parts, '--scope', readField('scope'));
    appendOptionalArg(parts, '--cls', readField('class'));
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening Agent memory bundle export',
      'The workspace handed a confirmed Agent-local memory export command to the shell-owned command router.',
      'safe',
    );
  },
  'memory-import': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Memory bundle import');
    if (confirmation) return confirmation;
    return dispatchCommandEditorSubmission(
      `/memory import ${quoteSlashCommandArg(readField('path'))} --yes`,
      'Opening Agent memory bundle import',
      'The workspace handed a confirmed Agent-local memory import command to the shell-owned command router.',
      'safe',
    );
  },
  'memory-handoff-export': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Memory handoff export');
    if (confirmation) return confirmation;
    const parts = ['/memory', 'handoff-export', quoteSlashCommandArg(readField('path'))];
    appendOptionalArg(parts, '--scope', readField('scope'));
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening Agent memory handoff export',
      'The workspace handed a confirmed Agent-local memory handoff export command to the shell-owned command router.',
      'safe',
    );
  },
  'memory-handoff-inspect': (_editor, readField) => dispatchCommandEditorSubmission(
    `/memory handoff-inspect ${quoteSlashCommandArg(readField('path'))}`,
    'Opening Agent memory handoff inspection',
    'The workspace handed an Agent-local memory handoff inspection command to the shell-owned command router.',
    'read-only',
  ),
  'memory-handoff-import': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Memory handoff import');
    if (confirmation) return confirmation;
    return dispatchCommandEditorSubmission(
      `/memory handoff-import ${quoteSlashCommandArg(readField('path'))} --yes`,
      'Opening Agent memory handoff import',
      'The workspace handed a confirmed Agent-local memory handoff import command to the shell-owned command router.',
      'safe',
    );
  },
  'memory-vector-rebuild': (editor, readField) => {
    const confirmation = requireConfirmation(editor, readField, 'Memory vector rebuild');
    if (confirmation) return confirmation;
    return dispatchCommandEditorSubmission(
      '/memory vector rebuild',
      'Opening Agent memory vector rebuild',
      'The workspace handed a confirmed Agent-local memory vector rebuild command to the shell-owned command router.',
      'safe',
    );
  },
};

export function buildAgentWorkspaceMemoryCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceMemoryCommandEditorKind,
    editor,
    readField,
    MEMORY_COMMAND_SUBMISSION_HANDLERS,
  );
}
