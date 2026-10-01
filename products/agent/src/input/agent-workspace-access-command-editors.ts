import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpec, AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceAccessCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  | 'auth-show'
  | 'auth-repair'
  | 'auth-bundle-export'
  | 'auth-bundle-inspect'
  | 'trust-bundle-export'
  | 'trust-bundle-inspect'
  | 'subscription-bundle-export'
  | 'subscription-bundle-inspect'
  | 'voice-enable'
  | 'voice-disable'
  | 'voice-bundle-export'
  | 'voice-bundle-inspect'
>;

export function isAgentWorkspaceAccessCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceAccessCommandEditorKind {
  return kind === 'auth-show'
    || kind === 'auth-repair'
    || kind === 'auth-bundle-export'
    || kind === 'auth-bundle-inspect'
    || kind === 'trust-bundle-export'
    || kind === 'trust-bundle-inspect'
    || kind === 'subscription-bundle-export'
    || kind === 'subscription-bundle-inspect'
    || kind === 'voice-enable'
    || kind === 'voice-disable'
    || kind === 'voice-bundle-export'
    || kind === 'voice-bundle-inspect';
}

const ACCESS_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceAccessCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceAccessCommandEditorKind>>> = {
  'auth-show': {
    mode: 'create',
    title: 'Inspect Provider Auth',
    selectedFieldIndex: 0,
    message: 'Inspect one provider auth route without printing token values.',
    fields: [
      { id: 'provider', label: 'Provider', value: 'openai', required: true, multiline: false, hint: 'Provider id, such as openai.' },
    ],
  },
  'auth-repair': {
    mode: 'create',
    title: 'Review Provider Auth Repair',
    selectedFieldIndex: 0,
    message: 'Show provider auth repair guidance without storing tokens or starting login.',
    fields: [
      { id: 'provider', label: 'Provider', value: 'openai', required: true, multiline: false, hint: 'Provider id to inspect.' },
    ],
  },
  'auth-bundle-export': {
    mode: 'create',
    title: 'Export Auth Review Bundle',
    selectedFieldIndex: 0,
    message: 'Export a redacted auth review bundle. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'Output path', value: 'auth-review-bundle.json', required: true, multiline: false, hint: 'Workspace-relative JSON path to write.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /auth bundle export with --yes.' },
    ],
  },
  'auth-bundle-inspect': {
    mode: 'create',
    title: 'Inspect Auth Review Bundle',
    selectedFieldIndex: 0,
    message: 'Inspect a redacted auth review bundle before import or sharing.',
    fields: [
      { id: 'path', label: 'Bundle path', value: 'auth-review-bundle.json', required: true, multiline: false, hint: 'Workspace-relative auth bundle JSON path.' },
    ],
  },
  'trust-bundle-export': {
    mode: 'create',
    title: 'Export Trust Bundle',
    selectedFieldIndex: 0,
    message: 'Export a redacted trust review bundle. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'Output path', value: 'trust-review-bundle.json', required: true, multiline: false, hint: 'Workspace-relative JSON path to write.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /trust bundle export with --yes.' },
    ],
  },
  'trust-bundle-inspect': {
    mode: 'create',
    title: 'Inspect Trust Bundle',
    selectedFieldIndex: 0,
    message: 'Inspect a trust review bundle before using it for setup review.',
    fields: [
      { id: 'path', label: 'Bundle path', value: 'trust-review-bundle.json', required: true, multiline: false, hint: 'Workspace-relative trust bundle JSON path.' },
    ],
  },
  'subscription-bundle-export': {
    mode: 'create',
    title: 'Export Subscription Bundle',
    selectedFieldIndex: 0,
    message: 'Export a redacted provider subscription bundle. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'Output path', value: 'subscription-bundle.json', required: true, multiline: false, hint: 'Workspace-relative JSON path to write.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /subscription bundle export with --yes.' },
    ],
  },
  'subscription-bundle-inspect': {
    mode: 'create',
    title: 'Inspect Subscription Bundle',
    selectedFieldIndex: 0,
    message: 'Inspect a provider subscription bundle before setup review.',
    fields: [
      { id: 'path', label: 'Bundle path', value: 'subscription-bundle.json', required: true, multiline: false, hint: 'Workspace-relative subscription bundle JSON path.' },
    ],
  },
  'voice-enable': (kind) => voiceEnableDisableSpec(kind),
  'voice-disable': (kind) => voiceEnableDisableSpec(kind),
  'voice-bundle-export': {
    mode: 'create',
    title: 'Export Voice Bundle',
    selectedFieldIndex: 0,
    message: 'Export a voice setup bundle. Type yes on the final field to confirm.',
    fields: [
      { id: 'path', label: 'Output path', value: 'voice-bundle.json', required: true, multiline: false, hint: 'Workspace-relative JSON path to write.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /voice bundle export with --yes.' },
    ],
  },
  'voice-bundle-inspect': {
    mode: 'create',
    title: 'Inspect Voice Bundle',
    selectedFieldIndex: 0,
    message: 'Inspect a voice setup bundle before setup review.',
    fields: [
      { id: 'path', label: 'Bundle path', value: 'voice-bundle.json', required: true, multiline: false, hint: 'Workspace-relative voice bundle JSON path.' },
    ],
  },
};

function voiceEnableDisableSpec(kind: AgentWorkspaceAccessCommandEditorKind): AgentWorkspaceEditorSpec {
  const enabling = kind === 'voice-enable';
  return {
    mode: 'update',
    title: enabling ? 'Enable Voice Interaction' : 'Disable Voice Interaction',
    selectedFieldIndex: 0,
    message: `${enabling ? 'Enable' : 'Disable'} local voice interaction for this Agent runtime. Type yes to confirm.`,
    fields: [
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: `Type yes to run /voice ${enabling ? 'enable' : 'disable'} with --yes.` },
    ],
  };
}

export function createAgentWorkspaceAccessCommandEditor(kind: AgentWorkspaceAccessCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, ACCESS_COMMAND_EDITOR_SPECS);
}
