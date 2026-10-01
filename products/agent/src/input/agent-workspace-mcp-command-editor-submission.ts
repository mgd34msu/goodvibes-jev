import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { quoteSlashCommandArg, tokenizeSlashCommand } from './slash-command-parser.ts';
import type { AgentWorkspaceMcpCommandEditorKind } from './agent-workspace-mcp-command-editors.ts';
import { isAgentWorkspaceMcpCommandEditorKind } from './agent-workspace-mcp-command-editors.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative, splitCommaList } from './agent-workspace-command-editor-engine.ts';

export type { AgentWorkspaceMcpCommandEditorKind } from './agent-workspace-mcp-command-editors.ts';
export type AgentWorkspaceMcpCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

export function isAgentWorkspaceMcpCommandSubmissionKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceMcpCommandEditorKind {
  return isAgentWorkspaceMcpCommandEditorKind(kind);
}

const MCP_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceMcpCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'mcp-tools-server': (editor, readField) => mcpToolsOrRepair(editor, readField),
  'mcp-repair': (editor, readField) => mcpToolsOrRepair(editor, readField),
  'mcp-server': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return editorMessageSubmission(editor, 'MCP server add/update not confirmed. Type yes, then press Enter.', 'MCP server add/update not confirmed.');
    }
    const parts = [
      '/mcp',
      'add',
      quoteSlashCommandArg(readField('name')),
      quoteSlashCommandArg(readField('command')),
      ...tokenizeSlashCommand(readField('args')).map(quoteSlashCommandArg),
    ];
    const scope = readField('scope');
    const role = readField('role');
    const trust = readField('trust');
    if (scope.length > 0) parts.push('--scope', quoteSlashCommandArg(scope));
    if (role.length > 0) parts.push('--role', quoteSlashCommandArg(role));
    if (trust.length > 0) parts.push('--trust', quoteSlashCommandArg(trust));
    for (const env of splitCommaList(readField('env'))) parts.push('--env', quoteSlashCommandArg(env));
    for (const path of splitCommaList(readField('paths'))) parts.push('--path', quoteSlashCommandArg(path));
    for (const host of splitCommaList(readField('hosts'))) parts.push('--host', quoteSlashCommandArg(host));
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening MCP server add/update',
      'The workspace handed a confirmed MCP server add/update command to the shell-owned command router.',
      'safe',
    );
  },
};

function mcpToolsOrRepair(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  const server = quoteSlashCommandArg(readField('server'));
  const tools = editor.kind === 'mcp-tools-server';
  const command = tools ? `/mcp tools ${server}` : `/mcp repair ${server}`;
  const title = tools ? 'Opening MCP server tools' : 'Opening MCP repair guidance';
  return dispatchCommandEditorSubmission(
    command,
    title,
    tools
      ? 'The workspace handed read-only MCP server tool inspection to the shell-owned command router.'
      : 'The workspace handed read-only MCP repair guidance to the shell-owned command router.',
    'read-only',
  );
}

export function buildAgentWorkspaceMcpCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceMcpCommandEditorKind,
    editor,
    readField,
    MCP_COMMAND_SUBMISSION_HANDLERS,
  );
}
