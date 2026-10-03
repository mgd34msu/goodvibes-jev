import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceMcpCommandEditorKind = Extract<AgentWorkspaceEditorKind, 'mcp-server' | 'mcp-tools-server' | 'mcp-repair'>;

export function isAgentWorkspaceMcpCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceMcpCommandEditorKind {
  return kind === 'mcp-server' || kind === 'mcp-tools-server' || kind === 'mcp-repair';
}

const MCP_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceMcpCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceMcpCommandEditorKind>>> = {
  'mcp-server': {
    mode: 'create',
    title: 'Add MCP Server',
    selectedFieldIndex: 0,
    message: 'Add or update one MCP server from the Agent workspace. Type yes on the final field to confirm.',
    fields: [
      { id: 'name', label: 'Server name', value: '', required: true, multiline: false, hint: 'Letters, numbers, dot, underscore, and dash only.' },
      { id: 'command', label: 'Command', value: '', required: true, multiline: false, hint: 'Executable command, such as bunx, npx, uvx, or a full local binary path.' },
      { id: 'args', label: 'Arguments', value: '', required: false, multiline: false, hint: 'Optional command arguments. Quotes are supported.' },
      { id: 'scope', label: 'Scope', value: '', required: false, multiline: false, hint: 'Optional. Defaults to project. Use project or global.' },
      { id: 'role', label: 'Role', value: '', required: false, multiline: false, hint: 'Optional. general, docs, filesystem, git, database, browser, automation, ops, or remote.' },
      { id: 'trust', label: 'Trust mode', value: '', required: false, multiline: false, hint: 'Optional. Defaults to constrained. Use constrained, ask-on-risk, or blocked. Use settings for allow-all.' },
      { id: 'env', label: 'Env refs', value: '', required: false, multiline: false, hint: 'Comma-separated KEY=VALUE entries. Prefer secret refs, not raw secrets.' },
      { id: 'paths', label: 'Allowed paths', value: '', required: false, multiline: false, hint: 'Comma-separated path allowlist entries.' },
      { id: 'hosts', label: 'Allowed hosts', value: '', required: false, multiline: false, hint: 'Comma-separated host allowlist entries.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to save the MCP server through the shell-owned command router.' },
    ],
  },
  'mcp-tools-server': {
    mode: 'create',
    title: 'Show MCP Server Tools',
    selectedFieldIndex: 0,
    message: 'List tools exposed by one MCP server without changing server trust, role, or config.',
    fields: [
      { id: 'server', label: 'Server name', value: '', required: true, multiline: false, hint: 'MCP server name from MCP Review or the fullscreen MCP workspace.' },
    ],
  },
  'mcp-repair': {
    mode: 'create',
    title: 'Show MCP Repair Guidance',
    selectedFieldIndex: 0,
    message: 'Show read-only repair guidance for one MCP server. This does not approve quarantine, change trust, or reload the runtime.',
    fields: [
      { id: 'server', label: 'Server name', value: '', required: true, multiline: false, hint: 'MCP server name from MCP Review or Auth review.' },
    ],
  },
};

export function createAgentWorkspaceMcpCommandEditor(kind: AgentWorkspaceMcpCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, MCP_COMMAND_EDITOR_SPECS);
}
