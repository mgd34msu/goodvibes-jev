import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { isAffirmative, splitList } from './agent-workspace-editors.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

export type AgentKnowledgeUrlEditorSubmission =
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

export function buildAgentKnowledgeUrlEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  commandDispatchAvailable: boolean,
): AgentKnowledgeUrlEditorSubmission {
  const url = readField('url');
  const confirm = readField('confirm');
  if (!isAffirmative(confirm)) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Type yes to confirm Agent Knowledge URL ingest.' },
      status: 'Agent Knowledge ingest not confirmed.',
    };
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Agent Knowledge URL ingest requires an http(s) URL.');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: 'editor',
      editor: { ...editor, message: detail },
      status: detail,
      actionResult: {
        kind: 'error',
        title: 'Agent Knowledge ingest URL invalid',
        detail,
      },
    };
  }

  if (!commandDispatchAvailable) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Command dispatch is unavailable; cannot run Agent Knowledge ingest from this workspace.' },
      status: 'Command dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Command dispatch unavailable',
        detail: 'The Agent Knowledge ingest command cannot be opened from this runtime.',
      },
    };
  }

  const folder = readField('folder');
  const tags = splitList(readField('tags'));
  const parts = ['/knowledge', 'ingest-url', quoteSlashCommandArg(url)];
  if (tags.length > 0) parts.push('--tags', quoteSlashCommandArg(tags.join(',')));
  if (folder.length > 0) parts.push('--folder', quoteSlashCommandArg(folder));
  parts.push('--yes');
  const command = parts.join(' ');

  return {
    kind: 'dispatch',
    command,
    status: 'Opening Agent Knowledge URL ingest.',
    actionResult: {
      kind: 'dispatched',
      title: 'Opening Agent Knowledge URL ingest',
      detail: 'The workspace handed a confirmed Agent Knowledge URL ingest command to the shell-owned command router.',
      command,
      safety: 'safe',
    },
  };
}
