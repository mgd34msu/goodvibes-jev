import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceEditorSpec, AgentWorkspaceEditorSpecEntry } from './agent-workspace-command-editor-engine.ts';
import { createAgentWorkspaceEditorFromTable } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceSkillBundleCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  | 'skill-bundle-search'
  | 'skill-bundle-show'
  | 'skill-bundle-update'
  | 'skill-bundle-enable'
  | 'skill-bundle-disable'
  | 'skill-bundle-review'
  | 'skill-bundle-stale'
  | 'skill-bundle-delete'
>;

export function isAgentWorkspaceSkillBundleCommandEditorKind(kind: AgentWorkspaceEditorKind): kind is AgentWorkspaceSkillBundleCommandEditorKind {
  return kind === 'skill-bundle-search'
    || kind === 'skill-bundle-show'
    || kind === 'skill-bundle-update'
    || kind === 'skill-bundle-enable'
    || kind === 'skill-bundle-disable'
    || kind === 'skill-bundle-review'
    || kind === 'skill-bundle-stale'
    || kind === 'skill-bundle-delete';
}

function skillBundleEnableDisableReviewSpec(kind: AgentWorkspaceSkillBundleCommandEditorKind): AgentWorkspaceEditorSpec {
  const verb = kind === 'skill-bundle-enable'
    ? 'Enable'
    : kind === 'skill-bundle-disable'
      ? 'Disable'
      : 'Review';
  return {
    mode: 'update',
    title: `${verb} Skill Bundle`,
    selectedFieldIndex: 0,
    message: `${verb} one Agent-local skill bundle. Type yes on the final field to confirm.`,
    fields: [
      { id: 'id', label: 'Bundle id', value: '', required: true, multiline: false, hint: 'Existing local skill bundle id.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: `Type yes to run /skills bundle ${verb.toLowerCase()}.` },
    ],
  };
}

const SKILL_BUNDLE_COMMAND_EDITOR_SPECS: Readonly<Record<AgentWorkspaceSkillBundleCommandEditorKind, AgentWorkspaceEditorSpecEntry<AgentWorkspaceSkillBundleCommandEditorKind>>> = {
  'skill-bundle-search': {
    mode: 'create',
    title: 'Search Skill Bundles',
    selectedFieldIndex: 0,
    message: 'Search Agent-local skill bundles by name, description, or member skill.',
    fields: [
      { id: 'query', label: 'Search query', value: '', required: false, multiline: false, hint: 'Optional text query. Blank lists every bundle.' },
    ],
  },
  'skill-bundle-show': {
    mode: 'create',
    title: 'Show Skill Bundle',
    selectedFieldIndex: 0,
    message: 'Show one Agent-local skill bundle with readiness and member skills.',
    fields: [
      { id: 'id', label: 'Bundle id', value: '', required: true, multiline: false, hint: 'Existing local skill bundle id.' },
    ],
  },
  'skill-bundle-update': {
    mode: 'update',
    title: 'Update Skill Bundle',
    selectedFieldIndex: 0,
    message: 'Update one Agent-local skill bundle. Type yes on the final field to confirm.',
    fields: [
      { id: 'id', label: 'Bundle id', value: '', required: true, multiline: false, hint: 'Existing local skill bundle id.' },
      { id: 'name', label: 'Name', value: '', required: false, multiline: false, hint: 'Optional replacement name.' },
      { id: 'description', label: 'Description', value: '', required: false, multiline: false, hint: 'Optional replacement one-line description.' },
      { id: 'skills', label: 'Skill ids', value: '', required: false, multiline: false, hint: 'Optional replacement comma-separated local skill ids.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /skills bundle update.' },
    ],
  },
  'skill-bundle-stale': {
    mode: 'update',
    title: 'Mark Skill Bundle Stale',
    selectedFieldIndex: 0,
    message: 'Mark one Agent-local skill bundle stale with a review reason. Type yes on the final field to confirm.',
    fields: [
      { id: 'id', label: 'Bundle id', value: '', required: true, multiline: false, hint: 'Existing local skill bundle id.' },
      { id: 'reason', label: 'Reason', value: '', required: true, multiline: true, hint: 'Why this bundle needs review. Ctrl-J inserts a new line.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /skills bundle stale.' },
    ],
  },
  'skill-bundle-delete': {
    mode: 'delete',
    title: 'Delete Skill Bundle',
    selectedFieldIndex: 0,
    message: 'Delete one Agent-local skill bundle. This does not delete member skills. Type yes to confirm.',
    fields: [
      { id: 'id', label: 'Bundle id', value: '', required: true, multiline: false, hint: 'Existing local skill bundle id.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to run /skills bundle delete with --yes.' },
    ],
  },
  'skill-bundle-enable': skillBundleEnableDisableReviewSpec,
  'skill-bundle-disable': skillBundleEnableDisableReviewSpec,
  'skill-bundle-review': skillBundleEnableDisableReviewSpec,
};

export function createAgentWorkspaceSkillBundleCommandEditor(kind: AgentWorkspaceSkillBundleCommandEditorKind): AgentWorkspaceLocalEditor {
  return createAgentWorkspaceEditorFromTable(kind, SKILL_BUNDLE_COMMAND_EDITOR_SPECS);
}
