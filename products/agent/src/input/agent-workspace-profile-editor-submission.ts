import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceProfileEditorKind } from './agent-workspace-profile-editors.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

type AgentWorkspaceProfileEditorSubmissionResult =
  | {
    readonly kind: 'editor';
    readonly editor: AgentWorkspaceLocalEditor;
    readonly status: string;
    readonly actionResult?: AgentWorkspaceActionResult;
  }
  | {
    readonly kind: 'dispatch';
    readonly command: string;
    readonly status: string;
    readonly actionResult: AgentWorkspaceActionResult;
  };

function isAffirmative(value: string): boolean {
  return /^(y|yes|true)$/i.test(value.trim());
}

export function isAgentWorkspaceProfileEditorSubmissionKind(kind: string): kind is AgentWorkspaceProfileEditorKind {
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

export function buildAgentWorkspaceProfileEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
): AgentWorkspaceProfileEditorSubmissionResult {
  if (editor.kind === 'profile-template-export') {
    if (!isAffirmative(readField('confirm'))) {
      return {
        kind: 'editor',
        editor: { ...editor, message: 'Starter template export not confirmed. Type yes, then press Enter.' },
        status: 'Agent starter template export not confirmed.',
      };
    }
    const command = `/agent-profile template export ${quoteSlashCommandArg(readField('templateId'))} ${quoteSlashCommandArg(readField('path'))} --yes`;
    return {
      kind: 'dispatch',
      command,
      status: 'Opening Agent starter template export.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening Agent starter template export',
        detail: 'The workspace handed a confirmed starter template export command to the shell-owned command router.',
        command,
        safety: 'safe',
      },
    };
  }
  if (editor.kind === 'profile-template-import') {
    if (!isAffirmative(readField('confirm'))) {
      return {
        kind: 'editor',
        editor: { ...editor, message: 'Starter template import not confirmed. Type yes, then press Enter.' },
        status: 'Agent starter template import not confirmed.',
      };
    }
    const command = `/agent-profile template import ${quoteSlashCommandArg(readField('path'))} --yes`;
    return {
      kind: 'dispatch',
      command,
      status: 'Opening Agent starter template import.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening Agent starter template import',
        detail: 'The workspace handed a confirmed starter template import command to the shell-owned command router.',
        command,
        safety: 'safe',
      },
    };
  }
  if (editor.kind === 'profile-template-show') {
    const command = `/agent-profile template show ${quoteSlashCommandArg(readField('id'))}`;
    return {
      kind: 'dispatch',
      command,
      status: 'Opening Agent starter template preview.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening Agent starter template preview',
        detail: 'The workspace handed a read-only starter template preview command to the shell-owned command router.',
        command,
        safety: 'read-only',
      },
    };
  }
  if (editor.kind === 'profile-show') {
    const command = `/agent-profile show ${quoteSlashCommandArg(readField('profile'))}`;
    return {
      kind: 'dispatch',
      command,
      status: 'Opening Agent profile detail.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening Agent profile detail',
        detail: 'The workspace handed a read-only Agent profile inspection command to the shell-owned command router.',
        command,
        safety: 'read-only',
      },
    };
  }
  if (editor.kind === 'profile-template-from-discovered') {
    if (!isAffirmative(readField('confirm'))) {
      return {
        kind: 'editor',
        editor: { ...editor, message: 'Starter-from-discovered creation not confirmed. Type yes, then press Enter.' },
        status: 'Agent starter-from-discovered creation not confirmed.',
      };
    }
    const parts = [
      '/agent-profile',
      'template',
      'from-discovered',
      quoteSlashCommandArg(readField('id')),
    ];
    const name = readField('name');
    const description = readField('description');
    const persona = readField('persona');
    const skills = readField('skills');
    const routines = readField('routines');
    if (name.length > 0) parts.push('--name', quoteSlashCommandArg(name));
    if (description.length > 0) parts.push('--description', quoteSlashCommandArg(description));
    if (persona.length > 0) parts.push('--persona', quoteSlashCommandArg(persona));
    if (skills.length > 0) parts.push('--skills', quoteSlashCommandArg(skills));
    if (routines.length > 0) parts.push('--routines', quoteSlashCommandArg(routines));
    if (isAffirmative(readField('replace'))) parts.push('--replace');
    parts.push('--yes');
    const command = parts.join(' ');
    return {
      kind: 'dispatch',
      command,
      status: 'Opening Agent starter-from-discovered creation.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening Agent starter-from-discovered creation',
        detail: 'The workspace handed a confirmed starter creation command to the shell-owned command router.',
        command,
        safety: 'safe',
      },
    };
  }
  if (editor.kind === 'profile-from-discovered') {
    if (!isAffirmative(readField('confirm'))) {
      return {
        kind: 'editor',
        editor: { ...editor, message: 'Profile-from-discovered creation not confirmed. Type yes, then press Enter.' },
        status: 'Agent profile-from-discovered creation not confirmed.',
      };
    }
    const parts = [
      '/agent-profile',
      'create-from-discovered',
      quoteSlashCommandArg(readField('profile')),
    ];
    const templateId = readField('templateId');
    const name = readField('name');
    const description = readField('description');
    const persona = readField('persona');
    const skills = readField('skills');
    const routines = readField('routines');
    if (templateId.length > 0) parts.push('--template-id', quoteSlashCommandArg(templateId));
    if (name.length > 0) parts.push('--name', quoteSlashCommandArg(name));
    if (description.length > 0) parts.push('--description', quoteSlashCommandArg(description));
    if (persona.length > 0) parts.push('--persona', quoteSlashCommandArg(persona));
    if (skills.length > 0) parts.push('--skills', quoteSlashCommandArg(skills));
    if (routines.length > 0) parts.push('--routines', quoteSlashCommandArg(routines));
    if (isAffirmative(readField('replace'))) parts.push('--replace');
    parts.push('--yes');
    const command = parts.join(' ');
    return {
      kind: 'dispatch',
      command,
      status: 'Opening Agent profile-from-discovered creation.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening Agent profile-from-discovered creation',
        detail: 'The workspace handed a confirmed discovered-behavior profile creation command to the shell-owned command router.',
        command,
        safety: 'safe',
      },
    };
  }
  if (editor.kind === 'profile-default') {
    if (!isAffirmative(readField('confirm'))) {
      return {
        kind: 'editor',
        editor: { ...editor, message: 'Default Agent profile selection not confirmed. Type yes, then press Enter.' },
        status: 'Default Agent profile selection not confirmed.',
      };
    }
    const command = `/agent-profile use ${quoteSlashCommandArg(readField('profile'))} --yes`;
    return {
      kind: 'dispatch',
      command,
      status: 'Opening default Agent profile selection.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening default Agent profile selection',
        detail: 'The workspace handed a confirmed default profile selection command to the shell-owned command router.',
        command,
        safety: 'safe',
      },
    };
  }
  if (editor.kind === 'profile-default-clear') {
    if (!isAffirmative(readField('confirm'))) {
      return {
        kind: 'editor',
        editor: { ...editor, message: 'Default Agent profile clear not confirmed. Type yes, then press Enter.' },
        status: 'Default Agent profile clear not confirmed.',
      };
    }
    const command = '/agent-profile default clear --yes';
    return {
      kind: 'dispatch',
      command,
      status: 'Opening default Agent profile clear.',
      actionResult: {
        kind: 'dispatched',
        title: 'Opening default Agent profile clear',
        detail: 'The workspace handed a confirmed default profile clear command to the shell-owned command router.',
        command,
        safety: 'safe',
      },
    };
  }
  if (!isAffirmative(readField('confirm'))) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Agent profile delete not confirmed. Type yes, then press Enter.' },
      status: 'Agent profile delete not confirmed.',
    };
  }
  const command = `/agent-profile delete ${quoteSlashCommandArg(readField('profile'))} --yes`;
  return {
    kind: 'dispatch',
    command,
    status: 'Opening Agent profile deletion.',
    actionResult: {
      kind: 'dispatched',
      title: 'Opening Agent profile deletion',
      detail: 'The workspace handed a confirmed profile deletion command to the shell-owned command router.',
      command,
      safety: 'safe',
    },
  };
}
