import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceChannelCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  'channel-show' | 'channel-doctor' | 'channel-setup' | 'channel-send'
>;

export function isAgentWorkspaceChannelCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceChannelCommandEditorKind {
  return kind === 'channel-show' || kind === 'channel-doctor' || kind === 'channel-setup' || kind === 'channel-send';
}

const CHANNEL_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceChannelCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceChannelCommandEditorKind>>> = {
  'channel-send': {
    mode: 'create',
    title: 'Send Channel Message',
    selectedFieldIndex: 0,
    message: 'Send one message through a configured delivery target. Fill exactly one target field and type yes to confirm.',
    fields: [
      { id: 'message', label: 'Message', value: '', required: true, multiline: true, hint: 'Plain-text message. Ctrl-J inserts a new line.' },
      { id: 'title', label: 'Title', value: '', required: false, multiline: false, hint: 'Optional delivery title. Blank uses the Agent default.' },
      { id: 'channel', label: 'Channel target', value: '', required: false, multiline: false, hint: 'Optional surface[:route[:label]], such as slack:ops:Ops or telephony:+15551234567.' },
      { id: 'route', label: 'Route target', value: '', required: false, multiline: false, hint: 'Optional route id or route:label.' },
      { id: 'webhook', label: 'Webhook URL', value: '', required: false, multiline: false, hint: 'Optional http(s) webhook target.' },
      { id: 'link', label: 'Link target', value: '', required: false, multiline: false, hint: 'Optional link delivery target.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /channels send with --yes.' },
    ],
  },
  'channel-doctor': {
    mode: 'create',
    title: 'Run Channel Doctor',
    selectedFieldIndex: 0,
    message: 'Inspect one connected channel route without sending messages or changing delivery state.',
    fields: [
      { id: 'channel', label: 'Channel id', value: '', required: true, multiline: false, hint: 'Channel id, such as slack, telegram, discord, ntfy, signal, whatsapp, or telephony.' },
    ],
  },
  'channel-setup': {
    mode: 'create',
    title: 'Show Channel Setup',
    selectedFieldIndex: 0,
    message: 'Show read-only setup guidance for one channel. This does not pair, enable, or send through the channel.',
    fields: [
      { id: 'channel', label: 'Channel id', value: '', required: true, multiline: false, hint: 'Channel id, such as slack, telegram, discord, ntfy, signal, whatsapp, or telephony.' },
    ],
  },
  'channel-show': {
    mode: 'create',
    title: 'Show Channel Detail',
    selectedFieldIndex: 0,
    message: 'Show one channel readiness record from the Agent workspace without changing channel state.',
    fields: [
      { id: 'channel', label: 'Channel id', value: '', required: true, multiline: false, hint: 'Channel id, such as slack, telegram, discord, ntfy, signal, whatsapp, or telephony.' },
    ],
  },
};

export function createAgentWorkspaceChannelCommandEditor(kind: AgentWorkspaceChannelCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, CHANNEL_COMMAND_EDITOR_SPECS);
}
