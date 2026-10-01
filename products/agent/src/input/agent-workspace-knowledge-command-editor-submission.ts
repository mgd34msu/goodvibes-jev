import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceKnowledgeCommandEditorKind } from './agent-workspace-knowledge-command-editors.ts';
import { isAgentWorkspaceKnowledgeCommandEditorKind } from './agent-workspace-knowledge-command-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative, splitCommaList } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceKnowledgeCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

export function isAgentWorkspaceKnowledgeCommandSubmissionKind(kind: string): kind is AgentWorkspaceKnowledgeCommandEditorKind {
  return isAgentWorkspaceKnowledgeCommandEditorKind(kind as AgentWorkspaceKnowledgeCommandEditorKind);
}

const KNOWLEDGE_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceKnowledgeCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'knowledge-get': (_editor, readField) => dispatchCommandEditorSubmission(
    `/knowledge get ${quoteSlashCommandArg(readField('id'))}`,
    'Opening Agent Knowledge item',
    'The workspace handed a read-only Agent Knowledge item command to the shell-owned command router.',
    'read-only',
  ),
  'knowledge-map': (_editor, readField) => {
    const query = readField('query');
    const limit = readField('limit');
    const parts = ['/knowledge', 'map'];
    if (query.length > 0) parts.push(quoteSlashCommandArg(query));
    if (limit.length > 0) parts.push('--limit', quoteSlashCommandArg(limit));
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening Agent Knowledge map',
      'The workspace handed a read-only Agent Knowledge map command to the shell-owned command router.',
      'read-only',
    );
  },
  'knowledge-connector-show': (_editor, readField) => dispatchCommandEditorSubmission(
    `/knowledge connectors ${quoteSlashCommandArg(readField('connectorId'))}`,
    'Opening Agent Knowledge connector',
    'The workspace handed a read-only Agent Knowledge connector detail command to the shell-owned command router.',
    'read-only',
  ),
  'knowledge-connector-doctor': (_editor, readField) => dispatchCommandEditorSubmission(
    `/knowledge connectors doctor ${quoteSlashCommandArg(readField('connectorId'))}`,
    'Opening Agent Knowledge connector doctor',
    'The workspace handed a read-only Agent Knowledge connector doctor command to the shell-owned command router.',
    'read-only',
  ),
  'knowledge-review-issue': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return editorMessageSubmission(editor, 'Agent Knowledge issue review not confirmed. Type yes, then press Enter.');
    const parts = [
      '/knowledge',
      'review-issue',
      quoteSlashCommandArg(readField('issueId')),
      quoteSlashCommandArg(readField('action')),
    ];
    const reviewer = readField('reviewer');
    const value = readField('value');
    if (reviewer.length > 0) parts.push('--reviewer', quoteSlashCommandArg(reviewer));
    if (value.length > 0) parts.push('--value', quoteSlashCommandArg(value));
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening Agent Knowledge issue review',
      'The workspace handed a confirmed Agent Knowledge issue review command to the shell-owned command router.',
      'safe',
    );
  },
  'knowledge-consolidate': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return editorMessageSubmission(editor, 'Agent Knowledge consolidation not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/knowledge consolidate ${quoteSlashCommandArg(readField('mode'))} --yes`,
      'Opening Agent Knowledge consolidation',
      'The workspace handed a confirmed Agent Knowledge consolidation command to the shell-owned command router.',
      'safe',
    );
  },
  'knowledge-explain': (editor, readField) => knowledgeExplainOrPacket(editor, readField),
  'knowledge-packet': (editor, readField) => knowledgeExplainOrPacket(editor, readField),
};

function knowledgeExplainOrPacket(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  const subcommand = editor.kind === 'knowledge-explain' ? 'explain' : 'packet';
  const parts = ['/knowledge', subcommand, quoteSlashCommandArg(readField('task'))];
  for (const scope of splitCommaList(readField('scopes'))) {
    parts.push('--scope', quoteSlashCommandArg(scope));
  }
  return dispatchCommandEditorSubmission(
    parts.join(' '),
    subcommand === 'explain' ? 'Opening Agent Knowledge explanation' : 'Opening Agent Knowledge prompt packet',
    'The workspace handed a read-only Agent Knowledge context command to the shell-owned command router.',
    'read-only',
  );
}

export function buildAgentWorkspaceKnowledgeCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceKnowledgeCommandEditorKind,
    editor,
    readField,
    KNOWLEDGE_COMMAND_SUBMISSION_HANDLERS,
  );
}
