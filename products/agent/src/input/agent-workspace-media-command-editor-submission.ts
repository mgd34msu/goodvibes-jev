import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceMediaCommandEditorKind } from './agent-workspace-media-command-editors.ts';
import { isAgentWorkspaceMediaCommandEditorKind } from './agent-workspace-media-command-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceMediaCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

export function isAgentWorkspaceMediaCommandSubmissionKind(kind: string): kind is AgentWorkspaceMediaCommandEditorKind {
  return isAgentWorkspaceMediaCommandEditorKind(kind as AgentWorkspaceMediaCommandEditorKind);
}

export function buildAgentWorkspaceMediaCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  if (!isAffirmative(readField('confirm'))) {
    return editorMessageSubmission(editor, 'Media generation not confirmed. Type yes, then press Enter.', 'Agent media generation not confirmed.');
  }
  const parts = ['/media', 'generate'];
  const provider = readField('provider');
  const model = readField('model');
  const mime = readField('mime');
  if (provider) parts.push('--provider', quoteSlashCommandArg(provider));
  if (model) parts.push('--model', quoteSlashCommandArg(model));
  if (mime) parts.push('--mime', quoteSlashCommandArg(mime));
  parts.push(quoteSlashCommandArg(readField('prompt')), '--yes');
  return dispatchCommandEditorSubmission(
    parts.join(' '),
    'Opening media generation',
    'The workspace handed confirmed media generation to the shell-owned command router.',
    'safe',
  );
}
