import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

export type AgentWorkspaceProfileEditorKind = Extract<
  AgentWorkspaceEditorKind,
  | 'profile-template-export'
  | 'profile-template-import'
  | 'profile-template-show'
  | 'profile-show'
  | 'profile-template-from-discovered'
  | 'profile-from-discovered'
  | 'profile-default'
  | 'profile-default-clear'
  | 'profile-delete'
>;

export function isAgentWorkspaceProfileEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceProfileEditorKind {
  return kind === 'profile-template-export'
    || kind === 'profile-template-import'
    || kind === 'profile-template-show'
    || kind === 'profile-show'
    || kind === 'profile-template-from-discovered'
    || kind === 'profile-from-discovered'
    || kind === 'profile-default'
    || kind === 'profile-default-clear'
    || kind === 'profile-delete';
}

export function createAgentWorkspaceProfileEditor(kind: AgentWorkspaceProfileEditorKind): AgentWorkspaceLocalEditor {
  if (kind === 'profile-template-export') {
    return {
      kind,
      mode: 'create',
      title: 'Export Agent Starter Template',
      selectedFieldIndex: 0,
      message: 'Export a starter template JSON file for review and customization. Type yes on the final field to confirm.',
      fields: [
        { id: 'templateId', label: 'Starter id', value: '', required: true, multiline: false, hint: 'Existing starter id from /agent-profile templates.' },
        { id: 'path', label: 'Output path', value: '', required: true, multiline: false, hint: 'Workspace-relative JSON path to write.' },
        { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /agent-profile template export with --yes.' },
      ],
    };
  }
  if (kind === 'profile-template-import') {
    return {
      kind,
      mode: 'create',
      title: 'Import Agent Starter Template',
      selectedFieldIndex: 0,
      message: 'Import a reviewed starter template JSON file into this Agent home. Type yes on the final field to confirm.',
      fields: [
        { id: 'path', label: 'Template path', value: '', required: true, multiline: false, hint: 'Workspace-relative JSON path to import.' },
        { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /agent-profile template import with --yes.' },
      ],
    };
  }
  if (kind === 'profile-template-show') {
    return {
      kind,
      mode: 'create',
      title: 'Preview Agent Starter Template',
      selectedFieldIndex: 0,
      message: 'Preview one built-in or local starter template before creating or exporting a profile.',
      fields: [
        { id: 'id', label: 'Starter id', value: '', required: true, multiline: false, hint: 'Starter template id from /agent-profile templates.' },
      ],
    };
  }
  if (kind === 'profile-show') {
    return {
      kind,
      mode: 'create',
      title: 'Show Agent Profile',
      selectedFieldIndex: 0,
      message: 'Show one isolated Agent profile home, starter metadata, and launch command.',
      fields: [
        { id: 'profile', label: 'Profile name', value: '', required: true, multiline: false, hint: 'Existing isolated Agent profile name from /agent-profile list.' },
      ],
    };
  }
  if (kind === 'profile-template-from-discovered') {
    return {
      kind,
      mode: 'create',
      title: 'Create Starter from Discovered Behavior',
      selectedFieldIndex: 0,
      message: 'Create an Agent-local starter template from reviewed discovered persona, skill, and routine markdown. Type yes on the final field to confirm.',
      fields: [
        { id: 'id', label: 'Starter id', value: '', required: true, multiline: false, hint: 'New local starter id, for example research-desk.' },
        { id: 'name', label: 'Starter name', value: '', required: false, multiline: false, hint: 'Optional display name. Defaults to the selected persona name.' },
        { id: 'description', label: 'Description', value: '', required: false, multiline: false, hint: 'Optional one-line summary.' },
        { id: 'persona', label: 'Persona', value: '', required: false, multiline: false, hint: 'Optional discovered persona name/path. Blank uses the first discovered persona.' },
        { id: 'skills', label: 'Skills', value: '', required: false, multiline: false, hint: 'all or comma-separated discovered skill names. Blank includes all.' },
        { id: 'routines', label: 'Routines', value: '', required: false, multiline: false, hint: 'all or comma-separated discovered routine names. Blank includes all.' },
        { id: 'replace', label: 'Replace existing', value: 'no', required: false, multiline: false, hint: 'yes/no. Existing starter ids are protected unless this is yes.' },
        { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /agent-profile template from-discovered with --yes.' },
      ],
    };
  }
  if (kind === 'profile-from-discovered') {
    return {
      kind,
      mode: 'create',
      title: 'Create Profile from Discovered Behavior',
      selectedFieldIndex: 0,
      message: 'Create a local starter template and isolated Agent profile from reviewed discovered behavior markdown. Type yes on the final field to confirm.',
      fields: [
        { id: 'profile', label: 'Profile name', value: '', required: true, multiline: false, hint: 'New isolated Agent profile name, for example research-desk.' },
        { id: 'templateId', label: 'Starter id', value: '', required: false, multiline: false, hint: 'Optional local starter id. Blank uses the profile name.' },
        { id: 'name', label: 'Starter name', value: '', required: false, multiline: false, hint: 'Optional display name for the generated starter.' },
        { id: 'description', label: 'Description', value: '', required: false, multiline: false, hint: 'Optional one-line summary.' },
        { id: 'persona', label: 'Persona', value: '', required: false, multiline: false, hint: 'Optional discovered persona name/path. Blank uses the first discovered persona.' },
        { id: 'skills', label: 'Skills', value: '', required: false, multiline: false, hint: 'all or comma-separated discovered skill names. Blank includes all.' },
        { id: 'routines', label: 'Routines', value: '', required: false, multiline: false, hint: 'all or comma-separated discovered routine names. Blank includes all.' },
        { id: 'replace', label: 'Replace starter', value: 'no', required: false, multiline: false, hint: 'yes/no. Existing starter ids are protected unless this is yes.' },
        { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /agent-profile create-from-discovered with --yes.' },
      ],
    };
  }
  if (kind === 'profile-default') {
    return {
      kind,
      mode: 'update',
      title: 'Use Default Agent Profile',
      selectedFieldIndex: 0,
      message: 'Select which isolated Agent profile the next plain goodvibes-agent run should use. Type yes on the final field to confirm.',
      fields: [
        { id: 'profile', label: 'Profile name', value: '', required: true, multiline: false, hint: 'Existing isolated Agent profile name from /agent-profile list.' },
        { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /agent-profile use with --yes.' },
      ],
    };
  }
  if (kind === 'profile-default-clear') {
    return {
      kind,
      mode: 'update',
      title: 'Clear Default Agent Profile',
      selectedFieldIndex: 0,
      message: 'Return the next plain goodvibes-agent run to the base Agent home. Type yes to confirm.',
      fields: [
        { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /agent-profile default clear with --yes.' },
      ],
    };
  }
  return {
    kind,
    mode: 'delete',
    title: 'Delete Agent Profile',
    selectedFieldIndex: 0,
    message: 'Delete one isolated Agent profile home. Type yes on the final field to confirm.',
    fields: [
      { id: 'profile', label: 'Profile name', value: '', required: true, multiline: false, hint: 'Existing isolated Agent profile name from /agent-profile list.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /agent-profile delete with --yes.' },
    ],
  };
}
