import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceProviderCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  'provider-add' | 'provider-remove' | 'provider-use' | 'provider-inspect' | 'provider-routes' | 'provider-account-repair'
>;

export function isAgentWorkspaceProviderCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceProviderCommandEditorKind {
  return kind === 'provider-add'
    || kind === 'provider-remove'
    || kind === 'provider-use'
    || kind === 'provider-inspect'
    || kind === 'provider-routes'
    || kind === 'provider-account-repair';
}

const PROVIDER_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceProviderCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceProviderCommandEditorKind>>> = {
  'provider-use': {
    mode: 'create',
    title: 'Use Provider',
    selectedFieldIndex: 0,
    message: 'Switch the Agent chat provider through the shell-owned command router. Add a model id when you want an exact provider/model route.',
    fields: [
      { id: 'provider', label: 'Provider id', value: '', required: true, multiline: false, hint: 'Provider row id, such as openai-subscriber, openai, anthropic, or a custom provider.' },
      { id: 'model', label: 'Model id', value: '', required: false, multiline: false, hint: 'Optional model id or provider:model registry key. Blank uses the provider default selectable model.' },
    ],
  },
  'provider-inspect': {
    mode: 'create',
    title: 'Inspect Provider',
    selectedFieldIndex: 0,
    message: 'Inspect provider auth and setup routes from the Agent TUI without changing provider selection.',
    fields: [
      { id: 'provider', label: 'Provider id', value: '', required: true, multiline: false, hint: 'Provider row id to inspect.' },
    ],
  },
  'provider-routes': {
    mode: 'create',
    title: 'Inspect Provider Routes',
    selectedFieldIndex: 0,
    message: 'Inspect provider account routes from the Agent TUI without changing routing or auth.',
    fields: [
      { id: 'provider', label: 'Provider id', value: '', required: true, multiline: false, hint: 'Provider row id to inspect.' },
    ],
  },
  'provider-account-repair': {
    mode: 'create',
    title: 'Review Provider Account Repair',
    selectedFieldIndex: 0,
    message: 'Show provider account repair guidance from the Agent TUI without starting login or storing tokens.',
    fields: [
      { id: 'provider', label: 'Provider id', value: '', required: true, multiline: false, hint: 'Provider row id to inspect.' },
    ],
  },
  'provider-add': {
    mode: 'create',
    title: 'Add Custom Provider',
    selectedFieldIndex: 0,
    message: 'Add an OpenAI-compatible provider for Agent chat/model routing. Type yes on the final field to confirm.',
    fields: [
      { id: 'name', label: 'Provider name', value: '', required: true, multiline: false, hint: 'Letters, numbers, hyphens, and underscores only.' },
      { id: 'baseUrl', label: 'Base URL', value: '', required: true, multiline: false, hint: 'OpenAI-compatible base URL, such as http://127.0.0.1:8000/v1.' },
      { id: 'apiKey', label: 'API key', value: '', required: false, multiline: false, hint: 'Optional API key. Prefer a local provider or a secret-backed provider config when possible.', redact: true },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /provider add with --yes.' },
    ],
  },
  'provider-remove': {
    mode: 'delete',
    title: 'Remove Custom Provider',
    selectedFieldIndex: 0,
    message: 'Remove one custom provider config from the Agent provider list. Type yes on the final field to confirm.',
    fields: [
      { id: 'name', label: 'Provider name', value: '', required: true, multiline: false, hint: 'Existing custom provider name.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /provider remove with --yes.' },
    ],
  },
};

export function createAgentWorkspaceProviderCommandEditor(kind: AgentWorkspaceProviderCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, PROVIDER_COMMAND_EDITOR_SPECS);
}
