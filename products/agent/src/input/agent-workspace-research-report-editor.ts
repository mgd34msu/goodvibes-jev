import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

const SECRETISH = /token|secret|password|authorization|credential|api[-_]?key/i;

export interface AgentResearchReportWorkspaceToolArgs {
  readonly title: string;
  readonly question: string;
  readonly summary?: string;
  readonly reportMarkdown?: string;
  readonly sources: readonly {
    readonly title: string;
    readonly url?: string;
    readonly credibility?: string;
    readonly note?: string;
  }[];
  readonly findings?: readonly string[];
  readonly gaps?: readonly string[];
  readonly recommendations?: readonly string[];
  readonly methodology?: string;
  readonly confidence?: string;
  readonly requireCitationCoverage?: boolean;
  readonly visualReport?: boolean;
  readonly tags?: readonly string[];
  readonly confirm: true;
  readonly explicitUserRequest: string;
}

function splitList(value: string): readonly string[] {
  return value
    .split(/\n/)
    .map((entry) => entry.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

function splitTags(value: string): readonly string[] {
  return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function isAffirmative(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'true';
}

function sanitizeSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRETISH.test(key)) url.searchParams.set(key, '<redacted>');
    }
    return url.toString();
  } catch {
    return value.replace(/([?&\s](?:token|secret|password|authorization|credential|api[-_]?key)=)[^\s&]+/gi, '$1<redacted>');
  }
}

function parseSources(value: string): AgentResearchReportWorkspaceToolArgs['sources'] {
  return splitList(value).map((line) => {
    const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
    const urlIndex = parts.findIndex((part) => /^https?:\/\//i.test(part));
    const url = urlIndex >= 0 ? parts[urlIndex] : '';
    const detailStart = urlIndex >= 0 ? urlIndex + 1 : 1;
    const nonUrlParts = parts.filter((_, index) => index !== urlIndex);
    const title = urlIndex === 0 ? (nonUrlParts.length > 1 ? nonUrlParts[0] : url) : (parts[0] ?? url ?? line);
    const noteParts = parts.slice(detailStart + 1);
    return {
      title: title || line,
      ...(url ? { url: sanitizeSourceUrl(url) } : {}),
      ...(parts[detailStart] ? { credibility: parts[detailStart] } : {}),
      ...(noteParts.length > 0 ? { note: noteParts.join(' | ') } : {}),
    };
  });
}

export function createAgentResearchReportEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'research-report',
    mode: 'create',
    title: 'Save Research Report',
    selectedFieldIndex: 0,
    message: 'Save a reviewed source-grounded report artifact with citation coverage and a visual report packet. Sources are required; this does not ingest knowledge.',
    fields: [
      { id: 'title', label: 'Title', value: '', required: true, multiline: false, hint: 'Short report title.' },
      { id: 'question', label: 'Question', value: '', required: true, multiline: true, hint: 'The research question this report answers.' },
      { id: 'summary', label: 'Summary', value: '', required: false, multiline: true, hint: 'Optional executive summary.' },
      { id: 'reportMarkdown', label: 'Report markdown', value: '', required: false, multiline: true, hint: 'Full reviewed report body. Use [S1], [S2], etc. for citations when possible.' },
      { id: 'sources', label: 'Sources', value: '', required: true, multiline: true, hint: 'One per line: title | https://source | high/medium/low | note.' },
      { id: 'findings', label: 'Findings', value: '', required: false, multiline: true, hint: 'Optional one finding per line.' },
      { id: 'gaps', label: 'Gaps', value: '', required: false, multiline: true, hint: 'Optional caveats or unresolved questions, one per line.' },
      { id: 'recommendations', label: 'Recommendations', value: '', required: false, multiline: true, hint: 'Optional next actions, one per line.' },
      { id: 'methodology', label: 'Method', value: '', required: false, multiline: true, hint: 'How sources were found, filtered, and judged.' },
      { id: 'confidence', label: 'Confidence', value: 'medium', required: false, multiline: false, hint: 'Overall confidence such as high, medium, low, or mixed.' },
      { id: 'visualReport', label: 'Visual packet', value: 'yes', required: false, multiline: false, hint: 'Type yes to add at-a-glance, evidence matrix, findings board, dated sources, and handoff checklist sections.' },
      { id: 'requireCitationCoverage', label: 'Require citations', value: '', required: false, multiline: false, hint: 'Type yes to require every listed source to be cited as [S1], [S2], etc. in the report body.' },
      { id: 'tags', label: 'Tags', value: 'research', required: false, multiline: false, hint: 'Comma-separated optional artifact tags.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to save this report as an artifact.' },
    ],
  };
}

export function buildAgentResearchReportToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): AgentResearchReportWorkspaceToolArgs {
  const summary = readField('summary').trim();
  const reportMarkdown = readField('reportMarkdown').trim();
  const findings = splitList(readField('findings'));
  const gaps = splitList(readField('gaps'));
  const recommendations = splitList(readField('recommendations'));
  const methodology = readField('methodology').trim();
  const confidence = readField('confidence').trim();
  const visualReport = isAffirmative(readField('visualReport'));
  const requireCitationCoverage = isAffirmative(readField('requireCitationCoverage'));
  const tags = splitTags(readField('tags'));
  return {
    title: readField('title').trim(),
    question: readField('question').trim(),
    ...(summary ? { summary } : {}),
    ...(reportMarkdown ? { reportMarkdown } : {}),
    sources: parseSources(readField('sources')),
    ...(findings.length > 0 ? { findings } : {}),
    ...(gaps.length > 0 ? { gaps } : {}),
    ...(recommendations.length > 0 ? { recommendations } : {}),
    ...(methodology ? { methodology } : {}),
    ...(confidence ? { confidence } : {}),
    ...(visualReport ? { visualReport } : {}),
    ...(requireCitationCoverage ? { requireCitationCoverage } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    confirm: true,
    explicitUserRequest,
  };
}

export function buildAgentResearchReportPromptSubmission(
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
      editor: { ...editor, message: 'Type yes to confirm saving this sourced report as an artifact.' },
      status: 'Research report save not confirmed.',
    };
  }

  if (!promptDispatchAvailable) {
    return {
      kind: 'editor',
      editor: {
        ...editor,
        message: 'Prompt dispatch is unavailable in this runtime. Use agent_harness mode:"run_workspace_action" with this editor schema.',
      },
      status: 'Prompt dispatch unavailable.',
      actionResult: {
        kind: 'error',
        title: 'Prompt dispatch unavailable',
        detail: 'This runtime cannot submit research report saving from the workspace form.',
        safety: 'safe',
      },
    };
  }

  const args = buildAgentResearchReportToolArgs(
    readField,
    'Save a reviewed source-grounded research report as an Agent artifact.',
  );
  const prompt = [
    'Save this reviewed source-grounded research report as an Agent artifact.',
    'Use the `research` tool with these arguments:',
    'action: "report"',
    `title: ${JSON.stringify(args.title)}`,
    `question: ${JSON.stringify(args.question)}`,
    args.summary ? `summary: ${JSON.stringify(args.summary)}` : 'summary: none',
    args.reportMarkdown ? `reportMarkdown: ${JSON.stringify(args.reportMarkdown)}` : 'reportMarkdown: none',
    `sources: ${JSON.stringify(args.sources)}`,
    args.findings ? `findings: ${JSON.stringify(args.findings)}` : 'findings: none',
    args.gaps ? `gaps: ${JSON.stringify(args.gaps)}` : 'gaps: none',
    args.recommendations ? `recommendations: ${JSON.stringify(args.recommendations)}` : 'recommendations: none',
    args.methodology ? `methodology: ${JSON.stringify(args.methodology)}` : 'methodology: none',
    args.confidence ? `confidence: ${JSON.stringify(args.confidence)}` : 'confidence: none',
    args.visualReport ? 'visualReport: true' : 'visualReport: false',
    args.requireCitationCoverage ? 'requireCitationCoverage: true' : 'requireCitationCoverage: false',
    args.tags ? `tags: ${JSON.stringify(args.tags)}` : 'tags: none',
    'confirm: true',
    `explicitUserRequest: ${JSON.stringify(args.explicitUserRequest)}`,
    'Policy: save a sourced report artifact with optional visual packet only; do not ingest knowledge or send external messages.',
  ].join('\n');

  return {
    kind: 'prompt',
    prompt,
    status: 'Submitting research report artifact request.',
    actionResult: {
      kind: 'guidance',
      title: 'Research report artifact',
      detail: 'Submitted a confirmed request to save a reviewed source-grounded report artifact with visual packet.',
      safety: 'safe',
    },
  };
}
