import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;
export type AgentWorkspaceWebResearchMode = 'research' | 'fetch';

export type AgentWorkspaceWebResearchSubmission =
  | {
    readonly kind: 'editor';
    readonly editor: AgentWorkspaceLocalEditor;
    readonly status: string;
    readonly actionResult?: AgentWorkspaceActionResult;
  }
  | {
    readonly kind: 'prompt';
    readonly prompt: string;
    readonly status: string;
    readonly actionResult: AgentWorkspaceActionResult;
  };

export function createAgentWorkspaceWebResearchEditor(mode: AgentWorkspaceWebResearchMode): AgentWorkspaceLocalEditor {
  if (mode === 'fetch') {
    return {
      kind: 'web-fetch',
      mode: 'create',
      title: 'Fetch or Inspect URL',
      selectedFieldIndex: 0,
      message: 'Submit a normal Agent conversation turn that inspects one URL with connected read-only web tools. This does not ingest the URL into Agent Knowledge unless you explicitly ask for that.',
      fields: [
        { id: 'url', label: 'URL', value: '', required: true, multiline: false, hint: 'https://example.com/page' },
        { id: 'goal', label: 'Question or goal', value: '', required: false, multiline: true, hint: 'What should Agent extract, compare, summarize, or verify? Ctrl-J inserts a new line.' },
      ],
    };
  }
  return {
    kind: 'web-research',
    mode: 'create',
    title: 'Web Research Request',
    selectedFieldIndex: 0,
    message: 'Submit a normal Agent conversation turn that searches or reads the web through connected read-only tools. Agent should answer in the main conversation and remember only durable facts that belong in Agent memory.',
    fields: [
      { id: 'query', label: 'Research request', value: '', required: true, multiline: true, hint: 'Ask for the outcome you want, not just keywords. Ctrl-J inserts a new line.' },
      { id: 'scope', label: 'Source or freshness hints', value: '', required: false, multiline: false, hint: 'Optional filters such as official docs only, last 30 days, primary sources, or compare products.' },
    ],
  };
}

export function buildAgentWorkspaceWebResearchSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): AgentWorkspaceWebResearchSubmission {
  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Main-conversation submission is unavailable; cannot send this request from the workspace.' },
      status: 'Main-conversation submission unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Conversation submission unavailable',
        detail: 'The Agent workspace cannot hand this request back to the main conversation route.',
      },
    };
  }

  if (editor.kind === 'web-fetch') {
    const url = readField('url');
    const goal = readField('goal');
    const prompt = [
      `Use connected read-only web tools to inspect this URL: ${url}`,
      goal.length > 0 ? `Goal: ${goal}` : 'Goal: summarize the useful facts, source title, and any caveats.',
      'Do not ingest this into Agent Knowledge unless I explicitly ask you to.',
    ].join('\n');
    return {
      kind: 'prompt',
      prompt,
      status: 'Submitting URL inspection to the main conversation.',
      actionResult: {
        kind: 'dispatched',
        title: 'Submitting URL inspection',
        detail: 'The workspace closed and handed a read-only URL inspection request to the normal Agent conversation.',
        safety: 'read-only',
      },
    };
  }

  const query = readField('query');
  const scope = readField('scope');
  const prompt = [
    `Use connected read-only web tools to research this request: ${query}`,
    scope.length > 0 ? `Source and freshness guidance: ${scope}` : 'Prefer current, primary, or official sources when they are available.',
    'Answer in the main conversation. Do not ingest sources into Agent Knowledge unless I explicitly ask you to.',
  ].join('\n');
  return {
    kind: 'prompt',
    prompt,
    status: 'Submitting web research to the main conversation.',
    actionResult: {
      kind: 'dispatched',
      title: 'Submitting web research',
      detail: 'The workspace closed and handed a read-only web research request to the normal Agent conversation.',
      safety: 'read-only',
    },
  };
}
