import type { CommandContext } from '../input/command-registry.ts';
import {
  AgentResearchSourceRegistry,
  researchSourceReportLine,
  type AgentResearchSourceRecord,
  type AgentResearchSourceStatus,
} from '../agent/research-source-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

interface AgentHarnessResearchQueueArgs {
  readonly sourceId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface ResearchQueueItem {
  readonly source: AgentResearchSourceRecord;
  readonly priority: number;
  readonly next: string;
  readonly modelRoute: string;
  readonly inspectRoute: string;
  readonly bundleRoute?: string;
  readonly reviewRoute?: string;
  readonly rejectRoute?: string;
  readonly reportRoute?: string;
  readonly ingestRoute?: string;
}

export type ResearchSourceResolution =
  | { readonly status: 'found'; readonly source: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(parsed)));
}

function routeString(value: string): string {
  return JSON.stringify(value);
}

function statusPriority(status: AgentResearchSourceStatus): number {
  if (status === 'candidate') return 86;
  if (status === 'reviewed') return 72;
  if (status === 'used') return 42;
  return 20;
}

function nextForSource(source: AgentResearchSourceRecord): string {
  if (source.status === 'candidate') return 'Review credibility, score, and notes before citing or ingesting this source.';
  if (source.status === 'reviewed') return 'Use this source in a report, attach it to a document, or explicitly ingest it into Agent Knowledge if it should become durable.';
  if (source.status === 'used') return 'Inspect the saved report or promote the report artifact into Agent Knowledge only after review.';
  return 'Leave rejected unless new evidence changes the source assessment.';
}

function buildQueueItem(source: AgentResearchSourceRecord): ResearchQueueItem {
  const reviewRoute = source.status === 'candidate' || source.status === 'rejected'
    ? `research action:"review_source" id="${source.id}" confirm:true explicitUserRequest="..."`
    : '';
  const rejectRoute = source.status !== 'rejected'
    ? `research action:"reject_source" id="${source.id}" confirm:true explicitUserRequest="..."`
    : '';
  const reportRoute = source.status === 'reviewed' || source.status === 'used'
    ? 'research action:"report" confirm:true explicitUserRequest:"..."'
    : '';
  const bundleRoute = source.status === 'reviewed' || source.status === 'used'
    ? `research action:"bundle" query:${routeString(source.id)} limit:10`
    : '';
  const ingestRoute = source.status === 'reviewed' || source.status === 'used'
    ? 'agent_knowledge_ingest sourceKind="url" confirm=true explicitUserRequest="..."'
    : '';
  return {
    source,
    priority: Math.max(statusPriority(source.status), source.score),
    next: nextForSource(source),
    modelRoute: 'research action:"source"',
    inspectRoute: `research action:"source" sourceId="${source.id}"`,
    ...(bundleRoute ? { bundleRoute } : {}),
    ...(reviewRoute ? { reviewRoute } : {}),
    ...(rejectRoute ? { rejectRoute } : {}),
    ...(reportRoute ? { reportRoute } : {}),
    ...(ingestRoute ? { ingestRoute } : {}),
  };
}

function sourceSearchText(item: ResearchQueueItem): string {
  const source = item.source;
  return [
    source.id,
    source.question,
    source.title,
    source.url ?? '',
    source.publisher ?? '',
    source.summary,
    source.evidence ?? '',
    source.credibility,
    source.status,
    source.note ?? '',
    source.tags.join('\n'),
    item.inspectRoute,
    item.bundleRoute ?? '',
    item.reviewRoute ?? '',
    item.reportRoute ?? '',
    item.ingestRoute ?? '',
  ].join('\n').toLowerCase();
}

function queueItems(context: CommandContext): readonly ResearchQueueItem[] {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return [];
  return AgentResearchSourceRegistry.fromShellPaths(shellPaths)
    .list()
    .map(buildQueueItem)
    .sort((left, right) => right.priority - left.priority || right.source.updatedAt.localeCompare(left.source.updatedAt));
}

function describeSourceItem(item: ResearchQueueItem, includeParameters: boolean, lookup?: Record<string, unknown>): Record<string, unknown> {
  const source = item.source;
  return {
    sourceId: source.id,
    title: source.title,
    question: previewHarnessText(source.question, includeParameters ? 180 : 96),
    status: source.status,
    credibility: source.credibility,
    score: source.score,
    priority: item.priority,
    summary: previewHarnessText(source.summary, includeParameters ? 220 : 96),
    ...(source.url ? { url: source.url } : {}),
    ...(source.publisher ? { publisher: source.publisher } : {}),
    tags: source.tags,
    next: previewHarnessText(item.next, includeParameters ? 180 : 96),
    modelRoute: item.modelRoute,
    inspectRoute: item.inspectRoute,
    ...(item.bundleRoute ? { bundleRoute: item.bundleRoute } : {}),
    ...(item.reviewRoute ? { reviewRoute: item.reviewRoute } : {}),
    ...(item.rejectRoute ? { rejectRoute: item.rejectRoute } : {}),
    ...(item.reportRoute ? { reportRoute: item.reportRoute } : {}),
    ...(item.ingestRoute ? { ingestRoute: item.ingestRoute } : {}),
    reportSourceLine: researchSourceReportLine(source),
    ...(lookup ? { lookup } : {}),
    ...(includeParameters ? {
      evidence: source.evidence ?? null,
      note: source.note ?? null,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      reviewedAt: source.reviewedAt ?? null,
      rejectedAt: source.rejectedAt ?? null,
      usedAt: source.usedAt ?? null,
      policy: 'Research queue rows are local project state only. Report save, Knowledge ingest, external sends, and deletion stay on explicit separate routes.',
    } : {}),
  };
}

function nextActions(items: readonly ResearchQueueItem[]): readonly string[] {
  return items
    .filter((item) => item.source.status === 'candidate' || item.source.status === 'reviewed')
    .slice(0, 5)
    .map((item) => `${item.source.title}: ${item.next}`);
}

export function researchQueueCatalogStatus(context: CommandContext): Record<string, unknown> {
  const items = queueItems(context);
  return {
    modes: ['research_queue', 'research_source'],
    sources: items.length,
    candidates: items.filter((item) => item.source.status === 'candidate').length,
    reviewed: items.filter((item) => item.source.status === 'reviewed').length,
    rejected: items.filter((item) => item.source.status === 'rejected').length,
    used: items.filter((item) => item.source.status === 'used').length,
    readOnly: true,
  };
}

export function researchQueueSummary(context: CommandContext, args: AgentHarnessResearchQueueArgs): Record<string, unknown> {
  const includeParameters = args.includeParameters === true;
  const query = readString(args.query).toLowerCase();
  const limit = readLimit(args.limit, 100);
  const items = queueItems(context);
  const filtered = items.filter((item) => !query || sourceSearchText(item).includes(query));
  const bundleItems = filtered.filter((item) => item.source.status === 'reviewed' || item.source.status === 'used');
  return {
    summary: {
      sources: items.length,
      candidates: items.filter((item) => item.source.status === 'candidate').length,
      reviewed: items.filter((item) => item.source.status === 'reviewed').length,
      rejected: items.filter((item) => item.source.status === 'rejected').length,
      used: items.filter((item) => item.source.status === 'used').length,
    },
    sources: filtered.slice(0, limit).map((item) => describeSourceItem(item, includeParameters)),
    bundle: {
      sources: bundleItems.length,
      route: query
        ? `research action:"bundle" query:${routeString(query)} limit:${Math.min(limit, 20)}`
        : `research action:"bundle" limit:${Math.min(limit, 20)}`,
      reportRoute: 'research action:"report" requireCitationCoverage:true confirm:true explicitUserRequest:"..."',
      next: 'Use bundle route to assemble reviewed/used sources into citation-ready report input before saving a report artifact.',
    },
    returned: Math.min(filtered.length, limit),
    total: items.length,
    nextActions: nextActions(items),
    policy: 'Research queue is read-only in the harness. Source capture/review writes use confirmed research source actions; report artifacts and Knowledge ingest remain explicit separate steps.',
  };
}

export function describeResearchSource(context: CommandContext, args: AgentHarnessResearchQueueArgs): ResearchSourceResolution {
  const sourceId = readString(args.sourceId);
  const target = readString(args.target);
  const query = readString(args.query);
  const input = sourceId || target || query;
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: 'research_source requires sourceId, target, or query. Use research action:"sources" to inspect source ids.',
    };
  }
  const normalized = input.toLowerCase();
  const items = queueItems(context);
  const exact = items.find((item) => item.source.id === input);
  if (exact) return { status: 'found', source: describeSourceItem(exact, true, { source: sourceId ? 'sourceId' : target ? 'target' : 'query', input, resolvedBy: 'id' }) };
  const insensitive = items.find((item) => item.source.id.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', source: describeSourceItem(insensitive, true, { source: sourceId ? 'sourceId' : target ? 'target' : 'query', input, resolvedBy: 'case-insensitive-id' }) };
  const matches = items.filter((item) => sourceSearchText(item).includes(normalized));
  if (matches.length === 1) return { status: 'found', source: describeSourceItem(matches[0]!, true, { source: sourceId ? 'sourceId' : target ? 'target' : 'query', input, resolvedBy: 'search' }) };
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.slice(0, 8).map((item) => ({
        sourceId: item.source.id,
        title: item.source.title,
        status: item.source.status,
        credibility: item.source.credibility,
        score: item.source.score,
        modelRoute: item.modelRoute,
      })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown research source ${input}. Use research action:"sources" to inspect source ids.`,
  };
}
