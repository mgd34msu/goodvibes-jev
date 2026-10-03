import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceLibraryCommandEditorKind } from './agent-workspace-library-command-editors.ts';
import { isAgentWorkspaceLibraryCommandEditorKind } from './agent-workspace-library-command-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { dispatchCommandEditorSubmission } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceLibraryCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

export function isAgentWorkspaceLibraryCommandSubmissionKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceLibraryCommandEditorKind {
  return isAgentWorkspaceLibraryCommandEditorKind(kind);
}

export function buildAgentWorkspaceLibraryCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  const target = editor.kind.startsWith('persona') ? 'persona' : editor.kind.startsWith('skill') ? 'skill' : 'routine';
  const root = target === 'persona' ? '/personas' : target === 'skill' ? '/skills' : '/routines';
  const search = editor.kind.endsWith('search');
  const command = search
    ? `${root} search ${quoteSlashCommandArg(readField('query'))}`
    : `${root} show ${quoteSlashCommandArg(readField('id'))}`;
  const label = target === 'persona' ? 'persona' : target === 'skill' ? 'skill' : 'routine';
  const title = search ? `Opening ${label} search` : `Opening ${label} detail`;
  return dispatchCommandEditorSubmission(
    command,
    title,
    `The workspace handed read-only local ${label} ${search ? 'search' : 'detail inspection'} to the shell-owned command router.`,
    'read-only',
  );
}
