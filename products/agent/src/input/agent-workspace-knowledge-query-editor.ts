import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { quoteSlashCommandArg } from './slash-command-parser.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;
export type AgentKnowledgeQueryMode = 'ask' | 'search';

export type AgentKnowledgeQueryEditorSubmission =
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

export function createAgentKnowledgeQueryEditor(mode: AgentKnowledgeQueryMode): AgentWorkspaceLocalEditor {
  return {
    kind: mode === 'ask' ? 'knowledge-ask' : 'knowledge-search',
    mode: 'create',
    title: mode === 'ask' ? 'Ask Agent Knowledge' : 'Search Agent Knowledge',
    selectedFieldIndex: 0,
    message: mode === 'ask'
      ? 'Ask the isolated Agent Knowledge segment. If it has no answer, it fails closed instead of using another knowledge segment.'
      : 'Search the isolated Agent Knowledge segment. Results come from Agent-owned sources only.',
    fields: [
      {
        id: 'query',
        label: mode === 'ask' ? 'Question' : 'Search query',
        value: '',
        required: true,
        multiline: false,
        hint: 'Plain-language query. Spaces are allowed.',
      },
    ],
  };
}

export function buildAgentKnowledgeQueryEditorSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  commandDispatchAvailable: boolean,
): AgentKnowledgeQueryEditorSubmission {
  if (!commandDispatchAvailable) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Command dispatch is unavailable; cannot query Agent Knowledge from this workspace.' },
      status: 'Command dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Command dispatch unavailable',
        detail: 'The Agent Knowledge query command cannot be opened from this runtime.',
      },
    };
  }
  const mode: AgentKnowledgeQueryMode = editor.kind === 'knowledge-ask' ? 'ask' : 'search';
  const command = `/knowledge ${mode} ${quoteSlashCommandArg(readField('query'))}`;
  return {
    kind: 'dispatch',
    command,
    status: `Opening Agent Knowledge ${mode}.`,
    actionResult: {
      kind: 'dispatched',
      title: `Opening Agent Knowledge ${mode}`,
      detail: 'The workspace handed a read-only Agent Knowledge query to the shell-owned command router.',
      command,
      safety: 'read-only',
    },
  };
}
