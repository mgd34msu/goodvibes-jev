import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpec, AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceSessionCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  | 'conversation-export'
  | 'conversation-events'
  | 'conversation-groups'
  | 'conversation-find'
  | 'effort-level'
  | 'session-save'
  | 'session-load'
  | 'session-rename'
  | 'session-resume'
  | 'session-info'
  | 'session-export-saved'
  | 'session-search'
  | 'session-delete'
  | 'session-fork'
  | 'session-graph'
  | 'mode-preset'
  | 'mode-domain'
>;

export function isAgentWorkspaceSessionCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceSessionCommandEditorKind {
  return kind === 'conversation-export'
    || kind === 'conversation-events'
    || kind === 'conversation-groups'
    || kind === 'conversation-find'
    || kind === 'effort-level'
    || kind === 'session-save'
    || kind === 'session-load'
    || kind === 'session-rename'
    || kind === 'session-resume'
    || kind === 'session-info'
    || kind === 'session-export-saved'
    || kind === 'session-search'
    || kind === 'session-delete'
    || kind === 'session-fork'
    || kind === 'session-graph'
    || kind === 'mode-preset'
    || kind === 'mode-domain';
}

function conversationEventsOrGroupsSpec(kind: AgentWorkspaceSessionCommandEditorKind): AgentWorkspaceEditorSpec {
  const groups = kind === 'conversation-groups';
  return {
    mode: 'create',
    title: groups ? 'Show Transcript Groups' : 'Show Transcript Events',
    selectedFieldIndex: 0,
    message: groups
      ? 'Inspect grouped transcript structure from the Agent workspace.'
      : 'Inspect transcript events from the Agent workspace.',
    fields: [
      { id: 'kind', label: 'Event kind', value: '', required: false, multiline: false, hint: 'Optional transcript event kind. Blank shows all.' },
    ],
  };
}

const SESSION_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceSessionCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceSessionCommandEditorKind>>> = {
  'conversation-export': {
    mode: 'create',
    title: 'Export Conversation',
    selectedFieldIndex: 0,
    message: 'Export the current conversation to a workspace file. Type yes on the final field to confirm.',
    fields: [
      { id: 'format', label: 'Format', value: 'markdown', required: true, multiline: false, hint: 'markdown or text.' },
      { id: 'path', label: 'Output path', value: './conversation.md', required: true, multiline: false, hint: 'Workspace-relative output path.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /export with --yes.' },
    ],
  },
  'conversation-events': conversationEventsOrGroupsSpec,
  'conversation-groups': conversationEventsOrGroupsSpec,
  'conversation-find': {
    mode: 'create',
    title: 'Find Transcript Text',
    selectedFieldIndex: 0,
    message: 'Search the current Agent transcript from the workspace.',
    fields: [
      { id: 'query', label: 'Search query', value: '', required: true, multiline: false, hint: 'Text to find in the current transcript.' },
      { id: 'kind', label: 'Event kind', value: '', required: false, multiline: false, hint: 'Optional transcript event kind.' },
    ],
  },
  'effort-level': {
    mode: 'update',
    title: 'Set Reasoning Effort',
    selectedFieldIndex: 0,
    message: 'Set the reasoning effort used by normal Agent chat turns when the selected model supports it.',
    fields: [
      { id: 'level', label: 'Effort level', value: 'medium', required: true, multiline: false, hint: 'instant, low, medium, or high.' },
    ],
  },
  'session-save': {
    mode: 'create',
    title: 'Save Session',
    selectedFieldIndex: 0,
    message: 'Save the current Agent session under a reviewable name. Type yes on the final field to confirm.',
    fields: [
      { id: 'name', label: 'Session name', value: '', required: true, multiline: false, hint: 'Local saved-session name.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /save.' },
    ],
  },
  'session-load': {
    mode: 'update',
    title: 'Load Session',
    selectedFieldIndex: 0,
    message: 'Load a saved Agent session into the current conversation. Type yes on the final field to confirm.',
    fields: [
      { id: 'name', label: 'Session name', value: '', required: true, multiline: false, hint: 'Existing saved-session name from /sessions.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /load.' },
    ],
  },
  'session-rename': {
    mode: 'update',
    title: 'Rename Current Session',
    selectedFieldIndex: 0,
    message: 'Rename the active Agent session from the workspace.',
    fields: [
      { id: 'name', label: 'New session name', value: '', required: true, multiline: false, hint: 'New reviewable name for the current session.' },
    ],
  },
  'session-resume': {
    mode: 'update',
    title: 'Resume Saved Session',
    selectedFieldIndex: 0,
    message: 'Resume one saved Agent session by id, prefix, or title.',
    fields: [
      { id: 'target', label: 'Session id or name', value: '', required: true, multiline: false, hint: 'Use /session list or the Saved sessions action to find ids.' },
    ],
  },
  'session-info': {
    mode: 'create',
    title: 'Inspect Saved Session',
    selectedFieldIndex: 0,
    message: 'Inspect saved session metadata without changing the current conversation.',
    fields: [
      { id: 'target', label: 'Session id or name', value: '', required: true, multiline: false, hint: 'Saved session id, prefix, or name.' },
    ],
  },
  'session-export-saved': {
    mode: 'create',
    title: 'Export Saved Session',
    selectedFieldIndex: 0,
    message: 'Print one saved session transcript as markdown or text.',
    fields: [
      { id: 'target', label: 'Session id or name', value: '', required: true, multiline: false, hint: 'Use . for the current session, or a saved session id/name.' },
      { id: 'format', label: 'Format', value: 'markdown', required: true, multiline: false, hint: 'markdown or text.' },
    ],
  },
  'session-search': {
    mode: 'create',
    title: 'Search Saved Sessions',
    selectedFieldIndex: 0,
    message: 'Search saved Agent sessions from the workspace.',
    fields: [
      { id: 'query', label: 'Search query', value: '', required: true, multiline: false, hint: 'Keyword or phrase to find in saved sessions.' },
    ],
  },
  'session-delete': {
    mode: 'delete',
    title: 'Delete Saved Session',
    selectedFieldIndex: 0,
    message: 'Delete one saved Agent session. Type yes on the final field to confirm.',
    fields: [
      { id: 'target', label: 'Session id or name', value: '', required: true, multiline: false, hint: 'Saved session id or prefix. The active session cannot be deleted.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /session delete with --yes.' },
    ],
  },
  'session-fork': {
    mode: 'create',
    title: 'Fork Current Session',
    selectedFieldIndex: 0,
    message: 'Fork the current Agent session into a new local saved session.',
    fields: [
      { id: 'name', label: 'Fork name', value: '', required: false, multiline: false, hint: 'Optional new session name. Blank uses the default fork name.' },
    ],
  },
  'session-graph': {
    mode: 'create',
    title: 'Inspect Session Graph',
    selectedFieldIndex: 0,
    message: 'Inspect the read-only cross-session graph. Mutating graph actions remain blocked in Agent.',
    fields: [
      { id: 'sessionId', label: 'Session id', value: '', required: false, multiline: false, hint: 'Optional session id filter.' },
      { id: 'format', label: 'Format', value: 'text', required: false, multiline: false, hint: 'text or json.' },
    ],
  },
  'mode-preset': {
    mode: 'update',
    title: 'Set Interaction Mode',
    selectedFieldIndex: 0,
    message: 'Set the Agent interaction noise level. Type yes on the final field to confirm.',
    fields: [
      { id: 'preset', label: 'Preset', value: 'balanced', required: true, multiline: false, hint: 'quiet, balanced, or operator.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /mode <preset> with --yes.' },
    ],
  },
  'mode-domain': {
    mode: 'update',
    title: 'Set Domain Verbosity',
    selectedFieldIndex: 0,
    message: 'Set interaction verbosity for one notification domain. Type yes on the final field to confirm.',
    fields: [
      { id: 'domain', label: 'Domain', value: '', required: true, multiline: false, hint: 'Domain name from mode output.' },
      { id: 'verbosity', label: 'Verbosity', value: 'normal', required: true, multiline: false, hint: 'minimal, normal, or verbose.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /mode set-domain.' },
    ],
  },
};

export function createAgentWorkspaceSessionCommandEditor(kind: AgentWorkspaceSessionCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, SESSION_COMMAND_EDITOR_SPECS);
}
