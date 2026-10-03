import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

export interface AgentResearchSourceWorkspaceToolArgs {
  readonly mode: 'add';
  readonly question: string;
  readonly title: string;
  readonly url?: string;
  readonly publisher?: string;
  readonly publishedAt?: string;
  readonly accessedAt?: string;
  readonly summary: string;
  readonly evidence?: string;
  readonly credibility?: string;
  readonly score?: number;
  readonly tags?: readonly string[];
  readonly note?: string;
  readonly confirm: true;
  readonly explicitUserRequest: string;
}

function splitTags(value: string): readonly string[] {
  return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function readOptionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : undefined;
}

function isAffirmative(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'true';
}

export function createAgentResearchSourceEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'research-source',
    mode: 'create',
    title: 'Add Research Source',
    selectedFieldIndex: 0,
    message: 'Capture one source in the project-local research queue. This does not save a report or ingest Agent Knowledge.',
    fields: [
      { id: 'question', label: 'Question', value: '', required: true, multiline: true, hint: 'Research question or topic this source supports.' },
      { id: 'title', label: 'Source title', value: '', required: true, multiline: false, hint: 'Readable source title.' },
      { id: 'url', label: 'URL', value: '', required: false, multiline: false, hint: 'Optional HTTP or HTTPS URL. Secret-like query values are redacted.' },
      { id: 'publisher', label: 'Publisher', value: '', required: false, multiline: false, hint: 'Optional source owner, publication, repo, or docs site.' },
      { id: 'publishedAt', label: 'Published', value: '', required: false, multiline: false, hint: 'Optional source date if known.' },
      { id: 'summary', label: 'Summary', value: '', required: true, multiline: true, hint: 'Short source summary. Ctrl-J inserts a new line.' },
      { id: 'evidence', label: 'Evidence notes', value: '', required: false, multiline: true, hint: 'Useful quoted-or-paraphrased evidence notes within copyright limits.' },
      { id: 'credibility', label: 'Credibility', value: 'unreviewed', required: false, multiline: false, hint: 'unreviewed, low, medium, high, or mixed.' },
      { id: 'score', label: 'Score', value: '', required: false, multiline: false, hint: 'Optional 0-100 usefulness/credibility score.' },
      { id: 'tags', label: 'Tags', value: 'research', required: false, multiline: false, hint: 'Comma-separated source tags.' },
      { id: 'note', label: 'Review note', value: '', required: false, multiline: true, hint: 'Why this source is useful, risky, primary, outdated, or disputed.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to add this source to the local queue.' },
    ],
  };
}

export function buildAgentResearchSourceToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentResearchSourceWorkspaceToolArgs {
  const url = readField('url').trim();
  const publisher = readField('publisher').trim();
  const publishedAt = readField('publishedAt').trim();
  const evidence = readField('evidence').trim();
  const credibility = readField('credibility').trim();
  const score = readOptionalNumber(readField('score'));
  const tags = splitTags(readField('tags'));
  const note = readField('note').trim();
  return {
    mode: 'add',
    question: readField('question').trim(),
    title: readField('title').trim(),
    ...(url ? { url } : {}),
    ...(publisher ? { publisher } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    summary: readField('summary').trim(),
    ...(evidence ? { evidence } : {}),
    ...(credibility ? { credibility } : {}),
    ...(score === undefined ? {} : { score }),
    ...(tags.length > 0 ? { tags } : {}),
    ...(note ? { note } : {}),
    confirm: true,
    explicitUserRequest,
  };
}

export function buildAgentResearchSourcePromptSubmission(
  editor: AgentWorkspaceLocalEditor,
  readField: AgentWorkspaceFieldReader,
  promptDispatchAvailable: boolean,
): {
  readonly kind: 'editor';
  readonly editor: AgentWorkspaceLocalEditor;
  readonly status: string;
  readonly actionResult?: AgentWorkspaceActionResult;
} | {
  readonly kind: 'prompt';
  readonly prompt: string;
  readonly status: string;
  readonly actionResult: AgentWorkspaceActionResult;
} {
  if (!isAffirmative(readField('confirm'))) {
    return {
      kind: 'editor',
      editor: { ...editor, message: 'Type yes to add this source to the local research queue.' },
      status: 'Research source capture not confirmed.',
    };
  }

  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use research action:"add_source" with these fields.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit source capture from the workspace form.',
        safety: 'safe',
      },
    };
  }

  const args = buildAgentResearchSourceToolArgs(
    readField,
    'Add one reviewed or candidate source to the project-local research queue.',
  );
  const prompt = [
    'Add this source to the project-local research source queue.',
    'Use the `research` tool with these arguments:',
    'action: "add_source"',
    `question: ${JSON.stringify(args.question)}`,
    `title: ${JSON.stringify(args.title)}`,
    args.url ? `url: ${JSON.stringify(args.url)}` : 'url: none',
    args.publisher ? `publisher: ${JSON.stringify(args.publisher)}` : 'publisher: none',
    args.publishedAt ? `publishedAt: ${JSON.stringify(args.publishedAt)}` : 'publishedAt: none',
    `summary: ${JSON.stringify(args.summary)}`,
    args.evidence ? `evidence: ${JSON.stringify(args.evidence)}` : 'evidence: none',
    args.credibility ? `credibility: ${JSON.stringify(args.credibility)}` : 'credibility: none',
    args.score === undefined ? 'score: none' : `score: ${JSON.stringify(args.score)}`,
    args.tags ? `tags: ${JSON.stringify(args.tags)}` : 'tags: none',
    args.note ? `note: ${JSON.stringify(args.note)}` : 'note: none',
    'confirm: true',
    `explicitUserRequest: ${JSON.stringify(args.explicitUserRequest)}`,
    'Policy: local source queue only; do not save a report, ingest Knowledge, or send external messages.',
  ].join('\n');

  return {
    kind: 'prompt',
    prompt,
    status: 'Submitting source capture request.',
    actionResult: {
      kind: 'guidance',
      title: 'Research source queue',
      detail: 'Submitted a request to add one source to the local research queue.',
      safety: 'safe',
    },
  };
}
