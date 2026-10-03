const SOURCE_LABELS = {
  user: 'User',
  agent: 'Agent',
  imported: 'Imported',
  system: 'Built-in',
  builtin: 'Built-in',
  local: 'Local',
  'agent-memory': 'Agent memory',
} as const satisfies Readonly<Record<string, string>>;

const USER_PROVENANCE_LABELS = new Set<string>([
  'Workspace',
  'Workspace capture',
  'Command',
  'Manual',
  'Main conversation',
]);

const REVIEW_STATE_LABELS = {
  fresh: 'Needs review',
  reviewed: 'Reviewed',
  stale: 'Needs refresh',
  contradicted: 'Contradicted',
} as const satisfies Readonly<Record<string, string>>;

type SourceLabelKey = keyof typeof SOURCE_LABELS;
type ReviewStateLabelKey = keyof typeof REVIEW_STATE_LABELS;

export interface AgentRecordReference {
  readonly kind: string;
  readonly ref: string;
  readonly label?: string;
}

function titleCaseWords(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function formatAgentRecordSource(source: string | undefined): string {
  const normalized = (source ?? '').trim().toLowerCase();
  if (!normalized) return 'Unknown';
  if (normalized in SOURCE_LABELS) return SOURCE_LABELS[normalized as SourceLabelKey];
  return titleCaseWords(source ?? '');
}

export function formatAgentRecordReviewState(reviewState: string | undefined): string {
  const normalized = (reviewState ?? '').trim().toLowerCase();
  if (!normalized) return REVIEW_STATE_LABELS.fresh;
  if (normalized in REVIEW_STATE_LABELS) return REVIEW_STATE_LABELS[normalized as ReviewStateLabelKey];
  return titleCaseWords(reviewState ?? '');
}

export function formatAgentRecordProvenance(provenance: string | undefined): string {
  const raw = (provenance ?? '').trim();
  const normalized = raw.toLowerCase();
  if (!raw) return '';
  if (normalized === 'agent-workspace') return 'Workspace';
  if (normalized === 'agent-workspace-learned-behavior') return 'Workspace capture';
  if (normalized === 'workspace capture') return 'Workspace capture';
  if (normalized === 'slash-command') return 'Command';
  if (normalized === 'agent-memory') return 'Agent memory';
  if (normalized === 'manual') return 'Manual';
  if (normalized === 'main-conversation') return 'Main conversation';
  if (normalized === 'plan-command') return 'Planning command';
  if (normalized === 'agent-media-generation') return 'Media generation';
  if (normalized === 'agent-channel-send') return 'Channel delivery';
  if (normalized === 'project-memory') return 'Project memory';

  const discovered = raw.match(/^discovered:([^:]+):(.+)$/i);
  if (discovered) {
    return `Imported file (${discovered[1]}): ${discovered[2]}`;
  }

  const starter = raw.match(/^goodvibes-agent starter:(.+)$/i);
  if (starter) {
    return `Starter profile: ${starter[1]}`;
  }

  return titleCaseWords(raw);
}

export function formatAgentRecordOrigin(source: string | undefined, provenance: string | undefined): string {
  const sourceLabel = formatAgentRecordSource(source);
  const provenanceLabel = formatAgentRecordProvenance(provenance);
  if (!provenanceLabel || provenanceLabel === sourceLabel) return sourceLabel;
  if (sourceLabel === 'User' && USER_PROVENANCE_LABELS.has(provenanceLabel)) {
    return provenanceLabel;
  }
  if (sourceLabel === 'Imported' && provenanceLabel.startsWith('Imported file')) {
    return provenanceLabel;
  }
  return `${sourceLabel} (${provenanceLabel})`;
}

export function formatAgentRecordReference(reference: AgentRecordReference): string {
  const kind = titleCaseWords(reference.kind);
  const label = reference.label?.trim();
  return `${kind}: ${reference.ref}${label ? ` (${label})` : ''}`;
}

export function formatAgentRecordReferences(references: readonly AgentRecordReference[]): string {
  return references.map(formatAgentRecordReference).join(', ');
}
