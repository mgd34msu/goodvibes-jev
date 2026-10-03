import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import type { AgentWorkspaceSkillBundleCommandEditorKind } from './agent-workspace-skill-bundle-command-editors.ts';
import { isAgentWorkspaceSkillBundleCommandEditorKind } from './agent-workspace-skill-bundle-command-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceSkillBundleCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

export function isAgentWorkspaceSkillBundleCommandSubmissionKind(kind: string): kind is AgentWorkspaceSkillBundleCommandEditorKind {
  return isAgentWorkspaceSkillBundleCommandEditorKind(kind as AgentWorkspaceSkillBundleCommandEditorKind);
}

function unconfirmed(editor: AgentWorkspaceLocalEditor, message: string): AgentWorkspaceCommandEditorSubmission {
  return editorMessageSubmission(editor, message);
}

const SKILL_BUNDLE_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceSkillBundleCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'skill-bundle-search': (_editor, readField) => {
    const query = readField('query').trim();
    const command = query.length > 0 ? `/skills bundle search ${quoteSlashCommandArg(query)}` : '/skills bundle search';
    return dispatchCommandEditorSubmission(command, 'Opening skill bundle search', 'The workspace handed a read-only skill bundle search command to the shell-owned command router.', 'read-only');
  },
  'skill-bundle-show': (_editor, readField) => dispatchCommandEditorSubmission(
    `/skills bundle show ${quoteSlashCommandArg(readField('id'))}`,
    'Opening skill bundle detail',
    'The workspace handed a read-only skill bundle detail command to the shell-owned command router.',
    'read-only',
  ),
  'skill-bundle-update': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Skill bundle update not confirmed. Type yes, then press Enter.');
    const parts = ['/skills', 'bundle', 'update', quoteSlashCommandArg(readField('id'))];
    const name = readField('name');
    const description = readField('description');
    const skills = readField('skills');
    if (name.length > 0) parts.push('--name', quoteSlashCommandArg(name));
    if (description.length > 0) parts.push('--description', quoteSlashCommandArg(description));
    if (skills.length > 0) parts.push('--skills', quoteSlashCommandArg(skills));
    return dispatchCommandEditorSubmission(parts.join(' '), 'Opening skill bundle update', 'The workspace handed a confirmed skill bundle update command to the shell-owned command router.', 'safe');
  },
  'skill-bundle-enable': (editor, readField) => skillBundleAction(editor, readField),
  'skill-bundle-disable': (editor, readField) => skillBundleAction(editor, readField),
  'skill-bundle-review': (editor, readField) => skillBundleAction(editor, readField),
  'skill-bundle-stale': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Skill bundle stale action not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/skills bundle stale ${quoteSlashCommandArg(readField('id'))} ${quoteSlashCommandArg(readField('reason'))}`,
      'Opening skill bundle stale review',
      'The workspace handed a confirmed skill bundle stale command to the shell-owned command router.',
      'safe',
    );
  },
  'skill-bundle-delete': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Skill bundle delete not confirmed. Type yes, then press Enter.');
    return dispatchCommandEditorSubmission(
      `/skills bundle delete ${quoteSlashCommandArg(readField('id'))} --yes`,
      'Opening skill bundle delete',
      'The workspace handed a confirmed skill bundle delete command to the shell-owned command router.',
      'safe',
    );
  },
};

function skillBundleAction(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  if (!isAffirmative(readField('confirm'))) return unconfirmed(editor, 'Skill bundle action not confirmed. Type yes, then press Enter.');
  const verb = editor.kind.replace('skill-bundle-', '');
  return dispatchCommandEditorSubmission(
    `/skills bundle ${verb} ${quoteSlashCommandArg(readField('id'))}`,
    `Opening skill bundle ${verb}`,
    `The workspace handed a confirmed skill bundle ${verb} command to the shell-owned command router.`,
    'safe',
  );
}

export function buildAgentWorkspaceSkillBundleCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceCommandEditorSubmission {
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceSkillBundleCommandEditorKind,
    editor,
    readField,
    SKILL_BUNDLE_COMMAND_SUBMISSION_HANDLERS,
  );
}
