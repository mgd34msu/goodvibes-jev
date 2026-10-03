import type { AgentWorkspaceEditorKind, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { buildAgentWorkspaceOwnerProfileEditorSubmission, isAgentWorkspaceOwnerProfileSubmissionKind } from './agent-workspace-owner-profile-editor-submission.ts';
import { buildAgentWorkspaceAccessCommandEditorSubmission, isAgentWorkspaceAccessCommandSubmissionKind } from './agent-workspace-access-command-editor-submission.ts';
import { buildAgentWorkspaceChannelCommandEditorSubmission, isAgentWorkspaceChannelCommandSubmissionKind } from './agent-workspace-channel-command-editor-submission.ts';
import { buildAgentWorkspaceDelegationEditorSubmission, isAgentWorkspaceDelegationEditorKind } from './agent-workspace-delegation-editor-submission.ts';
import { buildAgentWorkspaceKnowledgeCommandEditorSubmission, isAgentWorkspaceKnowledgeCommandSubmissionKind } from './agent-workspace-knowledge-command-editor-submission.ts';
import { buildAgentWorkspaceLibraryCommandEditorSubmission, isAgentWorkspaceLibraryCommandSubmissionKind } from './agent-workspace-library-command-editor-submission.ts';
import { buildAgentWorkspaceMemoryCommandEditorSubmission, isAgentWorkspaceMemoryCommandSubmissionKind } from './agent-workspace-memory-command-editor-submission.ts';
import { buildAgentWorkspaceMediaCommandEditorSubmission, isAgentWorkspaceMediaCommandSubmissionKind } from './agent-workspace-media-command-editor-submission.ts';
import { buildAgentWorkspaceMcpCommandEditorSubmission, isAgentWorkspaceMcpCommandSubmissionKind } from './agent-workspace-mcp-command-editor-submission.ts';
import { buildAgentWorkspaceNotifyEditorSubmission, isAgentWorkspaceNotifyEditorKind } from './agent-workspace-notify-editor-submission.ts';
import { buildAgentWorkspaceOperationsCommandEditorSubmission, isAgentWorkspaceOperationsCommandSubmissionKind } from './agent-workspace-operations-command-editor-submission.ts';
import { buildAgentWorkspaceProviderCommandEditorSubmission, isAgentWorkspaceProviderCommandSubmissionKind } from './agent-workspace-provider-command-editor-submission.ts';
import { buildAgentWorkspaceSecretEditorSubmission, isAgentWorkspaceSecretEditorKind } from './agent-workspace-secret-editor-submission.ts';
import { buildAgentWorkspaceSessionCommandEditorSubmission, isAgentWorkspaceSessionCommandSubmissionKind } from './agent-workspace-session-command-editor-submission.ts';
import { buildAgentWorkspaceSkillBundleCommandEditorSubmission, isAgentWorkspaceSkillBundleCommandSubmissionKind } from './agent-workspace-skill-bundle-command-editor-submission.ts';
import { buildAgentWorkspaceTaskCommandEditorSubmission, isAgentWorkspaceTaskCommandSubmissionKind } from './agent-workspace-task-command-editor-submission.ts';
import { buildAgentWorkspaceWorkPlanEditorSubmission, isAgentWorkspaceWorkPlanEditorKind } from './agent-workspace-workplan-editor-submission.ts';
import { buildAgentWorkspaceProfileEditorSubmission, isAgentWorkspaceProfileEditorSubmissionKind } from './agent-workspace-profile-editor-submission.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';
import type { AgentWorkspaceCommandEditorSubmission, AgentWorkspaceCommandSubmissionHandler, AgentWorkspaceFieldReader } from './agent-workspace-command-editor-engine.ts';
import { buildCommandEditorSubmissionFromTable, dispatchCommandEditorSubmission, editorMessageSubmission, isAffirmative } from './agent-workspace-command-editor-engine.ts';

export type AgentWorkspaceBasicCommandEditorSubmission = AgentWorkspaceCommandEditorSubmission;

/** The kinds this module builds a submission for itself (the rest delegate to sibling submission modules). */
type AgentWorkspaceBasicOwnCommandEditorKind = Extract<
  AgentWorkspaceEditorKind,
  'knowledge-file' | 'knowledge-urls' | 'knowledge-bookmarks' | 'knowledge-browser-history' | 'knowledge-connector-ingest' | 'knowledge-reindex' | 'tts-prompt' | 'image-input' | 'skill-bundle' | 'skill-discovery-import'
  | 'support-bundle-export' | 'support-bundle-inspect' | 'support-bundle-import'
  | 'subscription-inspect' | 'subscription-login-start' | 'subscription-login-finish' | 'subscription-logout'
  | 'model-pin' | 'model-unpin'
  | 'persona-discovery-import'
  | 'routine-discovery-import'
  | 'skill-standard-import'
  | 'skill-standard-export'
>;

function unconfirmed(editor: AgentWorkspaceLocalEditor, message: string, status: string): AgentWorkspaceCommandEditorSubmission {
  return editorMessageSubmission(editor, message, status);
}

/**
 * The submission data table for the kinds this module builds itself (delegate-task and
 * workplan/notify/secret/profile kinds keep dispatching to their own sibling submission
 * modules below, unchanged). Split out of the single ~570-line
 * `buildAgentWorkspaceBasicCommandEditorSubmission` if-chain, mirroring the
 * construction-side split in agent-workspace-basic-command-editors.ts.
 */
const BASIC_OWN_COMMAND_SUBMISSION_HANDLERS: Readonly<Record<AgentWorkspaceBasicOwnCommandEditorKind, AgentWorkspaceCommandSubmissionHandler>> = {
  'knowledge-bookmarks': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Bookmark import not confirmed. Type yes, then press Enter.', 'Agent Knowledge bookmark import not confirmed.');
    }
    return dispatchCommandEditorSubmission(
      `/knowledge import-bookmarks ${quoteSlashCommandArg(readField('path'))} --yes`,
      'Opening Agent Knowledge bookmark import',
      'The workspace handed a confirmed bookmark import command to the shell-owned command router.',
      'safe',
    );
  },
  'knowledge-file': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'File ingest not confirmed. Type yes, then press Enter.', 'Agent Knowledge file ingest not confirmed.');
    }
    const parts = ['/knowledge', 'ingest-file', quoteSlashCommandArg(readField('path'))];
    const title = readField('title');
    const tags = readField('tags');
    const folder = readField('folder');
    if (title.length > 0) parts.push('--title', quoteSlashCommandArg(title));
    if (tags.length > 0) parts.push('--tags', quoteSlashCommandArg(tags));
    if (folder.length > 0) parts.push('--folder', quoteSlashCommandArg(folder));
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening Agent Knowledge file ingest',
      'The workspace handed a confirmed file ingest command to the shell-owned command router.',
      'safe',
    );
  },
  'knowledge-urls': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'URL list import not confirmed. Type yes, then press Enter.', 'Agent Knowledge URL list import not confirmed.');
    }
    const parts = ['/knowledge', 'import-urls', quoteSlashCommandArg(readField('path'))];
    if (isAffirmative(readField('allowPrivateHosts'))) parts.push('--allow-private-hosts');
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening Agent Knowledge URL list import',
      'The workspace handed a confirmed URL list import command to the shell-owned command router.',
      'safe',
    );
  },
  'knowledge-browser-history': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Browser history import not confirmed. Type yes, then press Enter.', 'Agent Knowledge browser history import not confirmed.');
    }
    const parts = ['/knowledge', 'import-browser-history'];
    const browsers = readField('browsers');
    const sources = readField('sources');
    const limit = readField('limit');
    const sinceDays = readField('sinceDays');
    if (browsers.length > 0) parts.push('--browsers', quoteSlashCommandArg(browsers));
    if (sources.length > 0) parts.push('--sources', quoteSlashCommandArg(sources));
    if (limit.length > 0) parts.push('--limit', quoteSlashCommandArg(limit));
    if (sinceDays.length > 0) parts.push('--since-days', quoteSlashCommandArg(sinceDays));
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening Agent Knowledge browser history import',
      'The workspace handed a confirmed browser-history import command to the shell-owned command router.',
      'safe',
    );
  },
  'knowledge-connector-ingest': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Connector ingest not confirmed. Type yes, then press Enter.', 'Agent Knowledge connector ingest not confirmed.');
    }
    const connectorId = readField('connectorId');
    const input = readField('input');
    const path = readField('path');
    const content = readField('content');
    const parts = ['/knowledge', 'ingest-connector', quoteSlashCommandArg(connectorId)];
    if (input.length > 0) parts.push('--input', quoteSlashCommandArg(input));
    if (path.length > 0) parts.push('--path', quoteSlashCommandArg(path));
    if (content.length > 0) parts.push('--content', quoteSlashCommandArg(content));
    if (isAffirmative(readField('allowPrivateHosts'))) parts.push('--allow-private-hosts');
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening Agent Knowledge connector ingest',
      'The workspace handed a confirmed connector ingest command to the shell-owned command router.',
      'safe',
    );
  },
  'knowledge-reindex': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Agent Knowledge reindex not confirmed. Type yes, then press Enter.', 'Agent Knowledge reindex not confirmed.');
    }
    return dispatchCommandEditorSubmission(
      '/knowledge reindex --yes',
      'Opening Agent Knowledge reindex',
      'The workspace handed a confirmed reindex command to the shell-owned command router.',
      'safe',
    );
  },
  'tts-prompt': (_editor, readField) => dispatchCommandEditorSubmission(
    `/tts ${quoteSlashCommandArg(readField('prompt'))}`,
    'Opening spoken assistant prompt',
    'The workspace handed a spoken prompt to the shell-owned command router.',
    'safe',
  ),
  'image-input': (_editor, readField) => {
    const prompt = readField('prompt');
    const command = prompt.length > 0
      ? `/image ${quoteSlashCommandArg(readField('path'))} ${quoteSlashCommandArg(prompt)}`
      : `/image ${quoteSlashCommandArg(readField('path'))}`;
    return dispatchCommandEditorSubmission(
      command,
      'Opening image input',
      'The workspace handed an image attachment command to the shell-owned command router.',
      'safe',
    );
  },
  'model-pin': (editor, readField) => modelPinUnpin(editor, readField),
  'model-unpin': (editor, readField) => modelPinUnpin(editor, readField),
  'support-bundle-export': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Agent support bundle export not confirmed. Type yes, then press Enter.', 'Agent support bundle export not confirmed.');
    }
    return dispatchCommandEditorSubmission(
      `/bundle export ${quoteSlashCommandArg(readField('path'))} --yes`,
      'Opening Agent support bundle export',
      'The workspace handed a confirmed support bundle export command to the shell-owned command router.',
      'safe',
    );
  },
  'support-bundle-inspect': (_editor, readField) => dispatchCommandEditorSubmission(
    `/bundle inspect ${quoteSlashCommandArg(readField('path'))}`,
    'Opening Agent support bundle inspection',
    'The workspace handed a support bundle inspect command to the shell-owned command router.',
    'read-only',
  ),
  'support-bundle-import': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Agent support bundle import not confirmed. Type yes, then press Enter.', 'Agent support bundle import not confirmed.');
    }
    return dispatchCommandEditorSubmission(
      `/bundle import ${quoteSlashCommandArg(readField('path'))} --yes`,
      'Opening Agent support bundle import',
      'The workspace handed a confirmed support bundle import command to the shell-owned command router.',
      'safe',
    );
  },
  'subscription-inspect': (_editor, readField) => dispatchCommandEditorSubmission(
    `/subscription inspect ${quoteSlashCommandArg(readField('provider'))}`,
    'Opening provider subscription inspection',
    'The workspace handed a read-only provider subscription inspection command to the shell-owned command router.',
    'read-only',
  ),
  'subscription-login-start': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Provider subscription login start not confirmed. Type yes, then press Enter.', 'Provider subscription login start not confirmed.');
    }
    const parts = [
      '/subscription',
      'login',
      quoteSlashCommandArg(readField('provider')),
      'start',
    ];
    if (!isAffirmative(readField('openBrowser'))) parts.push('--no-browser');
    parts.push('--manual');
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening provider subscription login start',
      'The workspace handed a confirmed subscription-login start command to the shell-owned command router.',
      'safe',
    );
  },
  'subscription-login-finish': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Provider subscription login finish not confirmed. Type yes, then press Enter.', 'Provider subscription login finish not confirmed.');
    }
    return dispatchCommandEditorSubmission(
      `/subscription login ${quoteSlashCommandArg(readField('provider'))} finish ${quoteSlashCommandArg(readField('code'))} --yes`,
      'Opening provider subscription login finish',
      'The workspace handed a confirmed subscription-login finish command to the shell-owned command router.',
      'safe',
    );
  },
  'subscription-logout': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Provider subscription logout not confirmed. Type yes, then press Enter.', 'Provider subscription logout not confirmed.');
    }
    return dispatchCommandEditorSubmission(
      `/subscription logout ${quoteSlashCommandArg(readField('provider'))} --yes`,
      'Opening provider subscription logout',
      'The workspace handed a confirmed provider subscription logout command to the shell-owned command router.',
      'safe',
    );
  },
  'skill-discovery-import': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Discovered skill import not confirmed. Type yes, then press Enter.', 'Agent skill import not confirmed.');
    }
    const parts = ['/skills', 'import-discovered', quoteSlashCommandArg(readField('name'))];
    if (isAffirmative(readField('enabled'))) parts.push('--enabled');
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening discovered skill import',
      'The workspace handed a confirmed local skill import command to the shell-owned command router.',
      'safe',
    );
  },
  'persona-discovery-import': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Discovered persona import not confirmed. Type yes, then press Enter.', 'Agent persona import not confirmed.');
    }
    const parts = ['/personas', 'import-discovered', quoteSlashCommandArg(readField('name'))];
    if (isAffirmative(readField('use'))) parts.push('--use');
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening discovered persona import',
      'The workspace handed a confirmed local persona import command to the shell-owned command router.',
      'safe',
    );
  },
  'skill-standard-import': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Shared skill import not confirmed. Type yes, then press Enter.', 'Shared skill import not confirmed.');
    }
    const parts = ['/skills', 'import-standard', quoteSlashCommandArg(readField('path')), '--yes'];
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening shared skill import',
      'The workspace handed a confirmed shared skill import command to the shell-owned command router.',
      'safe',
    );
  },
  'skill-standard-export': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Skill export not confirmed. Type yes, then press Enter.', 'Skill export not confirmed.');
    }
    const parts = ['/skills', 'export-standard', quoteSlashCommandArg(readField('id')), quoteSlashCommandArg(readField('dest')), '--yes'];
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening skill export',
      'The workspace handed a confirmed skill export command to the shell-owned command router.',
      'safe',
    );
  },
  'routine-discovery-import': (editor, readField) => {
    if (!isAffirmative(readField('confirm'))) {
      return unconfirmed(editor, 'Discovered routine import not confirmed. Type yes, then press Enter.', 'Agent routine import not confirmed.');
    }
    const parts = ['/routines', 'import-discovered', quoteSlashCommandArg(readField('name'))];
    if (isAffirmative(readField('enabled'))) parts.push('--enabled');
    parts.push('--yes');
    return dispatchCommandEditorSubmission(
      parts.join(' '),
      'Opening discovered routine import',
      'The workspace handed a confirmed local routine import command to the shell-owned command router.',
      'safe',
    );
  },
  'skill-bundle': (_editor, readField) => skillBundleCreate(_editor, readField),
};

function modelPinUnpin(editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  const pinning = editor.kind === 'model-pin';
  const command = `/${pinning ? 'pin' : 'unpin'} ${quoteSlashCommandArg(readField('model'))}`;
  return dispatchCommandEditorSubmission(
    command,
    pinning ? 'Opening model pin action' : 'Opening model unpin action',
    'The workspace handed model favorites maintenance to the shell-owned command router.',
    'safe',
  );
}

function skillBundleCreate(_editor: AgentWorkspaceLocalEditor, readField: AgentWorkspaceFieldReader): AgentWorkspaceCommandEditorSubmission {
  const commandParts = [
    '/skills bundle create',
    '--name',
    quoteSlashCommandArg(readField('name')),
    '--description',
    quoteSlashCommandArg(readField('description')),
    '--skills',
    quoteSlashCommandArg(readField('skills')),
  ];
  if (isAffirmative(readField('enabled'))) commandParts.push('--enabled');
  return dispatchCommandEditorSubmission(
    commandParts.join(' '),
    'Opening skill bundle creation',
    'The workspace handed a concrete local skill bundle command to the shell-owned command router.',
    'safe',
  );
}

export function buildAgentWorkspaceBasicCommandEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  commandDispatchAvailable: boolean,
): AgentWorkspaceCommandEditorSubmission {
  if (!commandDispatchAvailable) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Command dispatch is unavailable; this action cannot run from this workspace.' },
      status: 'Command dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Command dispatch unavailable',
        detail: 'The Agent workspace cannot hand this action to the shell-owned command router.',
      },
    };
  }
  if (isAgentWorkspaceAccessCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceAccessCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceChannelCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceChannelCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceKnowledgeCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceKnowledgeCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceLibraryCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceLibraryCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceMemoryCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceMemoryCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceMediaCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceMediaCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceOwnerProfileSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceOwnerProfileEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceProviderCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceProviderCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceSessionCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceSessionCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceSkillBundleCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceSkillBundleCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceTaskCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceTaskCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceMcpCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceMcpCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceOperationsCommandSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceOperationsCommandEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceNotifyEditorKind(editor.kind)) return buildAgentWorkspaceNotifyEditorSubmission(editor, readField);
  if (isAgentWorkspaceSecretEditorKind(editor.kind)) {
    return buildAgentWorkspaceSecretEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceProfileEditorSubmissionKind(editor.kind)) {
    return buildAgentWorkspaceProfileEditorSubmission(editor, readField);
  }
  if (isAgentWorkspaceDelegationEditorKind(editor.kind)) return buildAgentWorkspaceDelegationEditorSubmission(editor, readField);
  if (isAgentWorkspaceWorkPlanEditorKind(editor.kind)) return buildAgentWorkspaceWorkPlanEditorSubmission(editor, readField);
  return buildCommandEditorSubmissionFromTable(
    editor.kind as AgentWorkspaceBasicOwnCommandEditorKind,
    editor,
    readField,
    BASIC_OWN_COMMAND_SUBMISSION_HANDLERS,
  );
}
