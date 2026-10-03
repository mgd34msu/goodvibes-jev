import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { CommandContext } from '../input/command-registry.ts';
import {
  AgentResearchRunRegistry,
  researchRunLogTail,
  type AgentResearchRunRecord,
  type AgentResearchRunStatus,
} from '../agent/research-run-registry.ts';
import {
  AgentResearchSourceRegistry,
  researchSourceReportLine,
  type AgentResearchSourceRecord,
} from '../agent/research-source-registry.ts';
import { browserControlPosture } from './agent-harness-browser-control.ts';
import { isCertifiedResearchLiveRecord, researchLiveReadModelSnapshot } from './agent-harness-research-live-read-models.ts';
import { previewHarnessText } from './agent-harness-text.ts';

interface AgentHarnessResearchBriefingArgs {
  readonly query?: unknown;
  readonly target?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface ResearchBriefingItem {
  readonly id: string;
  readonly kind: 'run' | 'source' | 'report' | 'workflow' | 'browser';
  readonly priority: number;
  readonly label: string;
  readonly status: string;
  readonly summary: string;
  readonly next: string;
  readonly routes: Record<string, string>;
  readonly confirmationBoundary: string;
  readonly relatedIds?: readonly string[];
  readonly detail?: Record<string, unknown>;
}

type ArtifactListStore = {
  readonly list?: (limit?: number) => readonly ArtifactDescriptor[];
};

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(50, Math.trunc(parsed)));
}

function routeString(value: string): string {
  return JSON.stringify(value);
}

function fallbackTitle(question: string): string {
  const normalized = question.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Deep research run';
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69).trimEnd()}...`;
}

function runPriority(status: AgentResearchRunStatus, progress: number): number {
  if (status === 'blocked') return 98;
  if (status === 'running') return 94 + Math.min(4, Math.round(progress / 25));
  if (status === 'paused') return 88;
  if (status === 'planned') return 82;
  if (status === 'failed') return 70;
  if (status === 'completed') return 58;
  return 30;
}

function isMutableRun(status: AgentResearchRunStatus): boolean {
  return status !== 'cancelled' && status !== 'completed' && status !== 'failed';
}

function runSearchText(run: AgentResearchRunRecord): string {
  return [
    run.id,
    run.title,
    run.question,
    run.goal,
    run.status,
    run.phase,
    run.note ?? '',
    run.error ?? '',
    run.reportArtifactId ?? '',
    ...run.plan,
    ...run.nextSteps,
    ...run.sourceIds,
  ].join('\n').toLowerCase();
}

function sourceSearchText(source: AgentResearchSourceRecord): string {
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
    ...source.tags,
  ].join('\n').toLowerCase();
}

function artifactSearchText(artifact: ArtifactDescriptor): string {
  return [
    artifact.id,
    artifact.kind,
    artifact.mimeType,
    artifact.filename ?? '',
    artifact.sourceUri ?? '',
    JSON.stringify(artifact.metadata ?? {}),
  ].join('\n').toLowerCase();
}

function reportArtifacts(context: CommandContext, query: string): readonly ArtifactDescriptor[] {
  const store = context.platform?.artifactStore as ArtifactListStore | undefined;
  const artifacts = store?.list?.(100) ?? [];
  const normalized = query.toLowerCase();
  return artifacts.filter((artifact) => {
    const metadata = artifact.metadata ?? {};
    const purpose = typeof metadata.purpose === 'string' ? metadata.purpose : '';
    const source = typeof metadata.source === 'string' ? metadata.source : '';
    const sourceKind = typeof metadata.sourceKind === 'string' ? metadata.sourceKind : '';
    const isResearchReport = [purpose, source, sourceKind].some((value) => value.toLowerCase().includes('agent-research-report'));
    return isResearchReport && (!normalized || artifactSearchText(artifact).includes(normalized));
  });
}

function matchingSources(
  sources: readonly AgentResearchSourceRecord[],
  runs: readonly AgentResearchRunRecord[],
  query: string,
): readonly AgentResearchSourceRecord[] {
  const normalized = query.toLowerCase();
  const sourceIds = new Set(runs.flatMap((run) => run.sourceIds).map((id) => id.toLowerCase()));
  return sources.filter((source) => (
    !normalized
    || sourceIds.has(source.id.toLowerCase())
    || sourceSearchText(source).includes(normalized)
    || runs.some((run) => run.question.toLowerCase() === source.question.toLowerCase())
  ));
}

function runItem(run: AgentResearchRunRecord, includeParameters: boolean): ResearchBriefingItem {
  const mutable = isMutableRun(run.status);
  const routes: Record<string, string> = {
    inspect: `research action:"run" runId:${routeString(run.id)}`,
    workflow: `research action:"plan" runId:${routeString(run.id)}`,
    search: `research action:"search" runId:${routeString(run.id)} maxResults:5`,
    sources: `research action:"sources" query:${routeString(run.question)}`,
    report: `research action:"report" question:${routeString(run.question)} sources:[...] visualReport:true requireCitationCoverage:true confirm:true explicitUserRequest:"..."`,
  };
  if (mutable) {
    routes.checkpoint = `research action:"checkpoint" id:${routeString(run.id)} phase:"reading" progress:${Math.max(run.progress, 25)} note:"..." sourceIds:["..."] confirm:true explicitUserRequest:"..."`;
    routes.cancel = `research action:"cancel" id:${routeString(run.id)} note:"..." confirm:true explicitUserRequest:"..."`;
  }
  if (run.status === 'paused' || run.status === 'planned' || run.status === 'blocked') {
    routes.resume = `research action:"resume" id:${routeString(run.id)} confirm:true explicitUserRequest:"..."`;
  }
  if (run.reportArtifactId) {
    routes.reportArtifact = `research action:"report_artifact" artifactId:${routeString(run.reportArtifactId)}`;
    routes.promoteKnowledge = `agent_knowledge_ingest sourceKind:"artifact" artifactId:${routeString(run.reportArtifactId)} confirm:true explicitUserRequest:"..."`;
  }
  const next = run.status === 'completed'
    ? 'Review the saved report artifact, then promote it to Agent Knowledge only if the user wants durable knowledge.'
    : run.status === 'blocked'
      ? 'Resolve the blocker, checkpoint the decision, or cancel with a clear note.'
      : run.status === 'paused'
        ? 'Resume only when the user wants the research to continue.'
        : run.status === 'planned'
          ? 'Start or checkpoint this visible run before collecting more sources.'
          : 'Checkpoint progress, source ids, and next steps before switching tasks or saving a report.';
  return {
    id: `run:${run.id}`,
    kind: 'run',
    priority: runPriority(run.status, run.progress),
    label: run.title,
    status: run.status,
    summary: previewHarnessText(run.question, includeParameters ? 220 : 120),
    next,
    routes,
    confirmationBoundary: mutable ? 'Run state changes require confirm:true and explicitUserRequest; this briefing is read-only.' : 'Terminal run inspection is read-only; replacement runs require explicit confirmation.',
    relatedIds: run.sourceIds,
    ...(includeParameters ? {
      detail: {
        runId: run.id,
        phase: run.phase,
        progress: run.progress,
        goal: run.goal,
        plan: run.plan,
        nextSteps: run.nextSteps,
        sourceIds: run.sourceIds,
        logTail: researchRunLogTail(run, 5),
        reportArtifactId: run.reportArtifactId ?? null,
      },
    } : {}),
  };
}

function sourcePriority(source: AgentResearchSourceRecord): number {
  if (source.status === 'candidate') return 90;
  if (source.status === 'reviewed') return 84 + Math.min(10, Math.round(source.score / 10));
  if (source.status === 'used') return 54;
  return 24;
}

function sourceItem(source: AgentResearchSourceRecord, includeParameters: boolean): ResearchBriefingItem {
  const routes: Record<string, string> = {
    inspect: `research action:"source" sourceId:${routeString(source.id)}`,
    sources: `research action:"sources" query:${routeString(source.question)}`,
  };
  if (source.status === 'candidate' || source.status === 'rejected') {
    routes.review = `research action:"review_source" id:${routeString(source.id)} credibility:"high|medium|mixed|low" score:80 note:"..." confirm:true explicitUserRequest:"..."`;
  }
  if (source.status !== 'rejected') {
    routes.reject = `research action:"reject_source" id:${routeString(source.id)} note:"..." confirm:true explicitUserRequest:"..."`;
  }
  if (source.status === 'reviewed' || source.status === 'used') {
    routes.bundle = `research action:"bundle" query:${routeString(source.question)} includeReportLines:true`;
    routes.report = `research action:"report" question:${routeString(source.question)} sources:[...] visualReport:true requireCitationCoverage:true confirm:true explicitUserRequest:"..."`;
    routes.ingest = 'agent_knowledge_ingest sourceKind:"url" url:"..." confirm:true explicitUserRequest:"..."';
  }
  return {
    id: `source:${source.id}`,
    kind: 'source',
    priority: sourcePriority(source),
    label: source.title,
    status: source.status,
    summary: previewHarnessText(source.summary, includeParameters ? 220 : 120),
    next: source.status === 'candidate'
      ? 'Review credibility, score, and citation value before using this source.'
      : source.status === 'reviewed'
        ? 'Bundle reviewed sources and save a citation-covered report artifact.'
        : source.status === 'used'
          ? 'Inspect the report that used this source before ingesting durable knowledge.'
          : 'Leave rejected unless the user provides new evidence.',
    routes,
    confirmationBoundary: 'Source review, rejection, report save, and Knowledge ingest are separate confirmed effects.',
    relatedIds: [source.id],
    ...(includeParameters ? {
      detail: {
        sourceId: source.id,
        credibility: source.credibility,
        score: source.score,
        publisher: source.publisher ?? null,
        url: source.url ?? null,
        reportLine: researchSourceReportLine(source),
        evidence: source.evidence ?? null,
      },
    } : {}),
  };
}

function reportItem(artifact: ArtifactDescriptor, includeParameters: boolean): ResearchBriefingItem {
  const routes = {
    inspect: `research action:"report_artifact" artifactId:${routeString(artifact.id)}`,
    export: `agent_artifacts mode:"export" artifactId:${routeString(artifact.id)} destinationPath:"exports/${artifact.filename ?? `${artifact.id}.md`}" confirm:true explicitUserRequest:"..."`,
    archive: `agent_artifacts mode:"archive" artifactIds:[${routeString(artifact.id)}] destinationPath:"exports/research-report.zip" confirm:true explicitUserRequest:"..."`,
    promoteKnowledge: `agent_knowledge_ingest sourceKind:"artifact" artifactId:${routeString(artifact.id)} confirm:true explicitUserRequest:"..."`,
  };
  return {
    id: `report:${artifact.id}`,
    kind: 'report',
    priority: 76,
    label: artifact.filename ?? artifact.id,
    status: 'saved-report',
    summary: previewHarnessText(`Saved research report artifact ${artifact.id}.`, includeParameters ? 220 : 120),
    next: 'Inspect the report, then export, archive, share, or promote to Agent Knowledge only after review.',
    routes,
    confirmationBoundary: 'Report inspection is read-only; export, archive, share, and Knowledge ingest stay confirmed.',
    relatedIds: [artifact.id],
    ...(includeParameters ? {
      detail: {
        artifactId: artifact.id,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        createdAt: artifact.createdAt,
        metadata: artifact.metadata,
      },
    } : {}),
  };
}

function workflowItem(query: string, includeParameters: boolean): ResearchBriefingItem {
  const question = query || 'Research question goes here';
  const title = fallbackTitle(question);
  return {
    id: 'workflow:new-run',
    kind: 'workflow',
    priority: query ? 80 : 34,
    label: query ? `Start visible research: ${title}` : 'Start visible research',
    status: query ? 'needs-visible-run' : 'waiting-for-question',
    summary: query
      ? previewHarnessText(question, includeParameters ? 220 : 120)
      : 'Provide a research question before creating run state or collecting sources.',
    next: query
      ? 'Create a visible run, collect bounded public sources, review them, then save a sourced visual report.'
      : 'Ask the user for the research question, success criteria, and any source constraints.',
    routes: {
      plan: `research action:"plan" query:${routeString(question)}`,
      createRun: `research action:"create_run" title:${routeString(title)} question:${routeString(question)} plan:["Search bounded public web sources","Capture candidate sources","Review credibility","Save sourced report"] confirm:true explicitUserRequest:"..."`,
      search: `research action:"search" query:${routeString(question)} maxResults:5`,
      sources: `research action:"sources" query:${routeString(question)}`,
    },
    confirmationBoundary: 'Creating run state and source queue writes are separate confirmed actions; this briefing does not search or write.',
  };
}

function browserItem(context: CommandContext, includeParameters: boolean): ResearchBriefingItem {
  const browser = browserControlPosture(context);
  const liveResearch = researchLiveReadModelSnapshot(context);
  const certifiedRunnerRecords = liveResearch.browserRunnerRecords.filter(isCertifiedResearchLiveRecord);
  const certifiedVisualReports = liveResearch.visualReportRecords.filter(isCertifiedResearchLiveRecord);
  const hasCertifiedRunner = certifiedRunnerRecords.length > 0;
  return {
    id: 'browser:research-runner',
    kind: 'browser',
    priority: hasCertifiedRunner ? 86 : browser.configured ? 60 : 28,
    label: 'Browser-backed research runner',
    status: hasCertifiedRunner ? 'certified-live-runner' : browser.configured ? 'ready-with-confirmation' : 'setup-needed',
    summary: hasCertifiedRunner
      ? 'The SDK/daemon published certified live browser-backed research runner evidence.'
      : browser.configured
      ? 'Browser or desktop control is configured; use it only when public web/fetch is insufficient.'
      : 'Browser-backed research needs setup before live browser execution should be promised.',
    next: hasCertifiedRunner
      ? 'Inspect certified run, source receipt, and visual-render evidence before saving reports or promoting Knowledge.'
      : browser.configured
      ? 'Use browser-backed research only after the user confirms authenticated or interactive scope.'
      : 'Use bounded public search now, or inspect browser setup if live browser state is required.',
    routes: {
      runner: 'research action:"runner"',
      setup: browser.setupRoute,
      recommended: certifiedRunnerRecords[0]?.modelRoute ?? browser.recommendedRoute,
      fallback: browser.fallbackRoutes[0] ?? 'research action:"search"',
      ...(certifiedVisualReports[0] ? { visualReport: certifiedVisualReports[0].modelRoute } : {}),
    },
    confirmationBoundary: 'This briefing never opens the browser; browser handoff stays on confirmed computer/browser routes.',
    ...(includeParameters ? {
      detail: {
        configured: browser.configured || hasCertifiedRunner,
        needsReview: browser.needsReview,
        fallbackRoutes: browser.fallbackRoutes,
        liveRunnerRecords: liveResearch.browserRunnerRecords.slice(0, 8),
        liveVisualReportRecords: liveResearch.visualReportRecords.slice(0, 8),
      },
    } : {}),
  };
}

export function researchBriefingCatalogStatus(context: CommandContext): Record<string, unknown> {
  const shellPaths = context.workspace?.shellPaths;
  const runs = shellPaths ? AgentResearchRunRegistry.fromShellPaths(shellPaths).snapshot() : null;
  const sources = shellPaths ? AgentResearchSourceRegistry.fromShellPaths(shellPaths).snapshot() : null;
  const reports = reportArtifacts(context, '');
  const liveResearch = researchLiveReadModelSnapshot(context);
  return {
    modes: ['research_briefing'],
    status: shellPaths ? 'ready' : 'unavailable',
    activeRuns: (runs?.planned.length ?? 0) + (runs?.running.length ?? 0) + (runs?.paused.length ?? 0) + (runs?.blocked.length ?? 0),
    candidateSources: sources?.candidates.length ?? 0,
    reviewedSources: sources?.reviewed.length ?? 0,
    savedReports: reports.length,
    liveBrowserRuns: liveResearch.browserRunnerRecords.length,
    liveVisualReports: liveResearch.visualReportRecords.length,
    readOnly: true,
  };
}

export function researchBriefingSummary(context: CommandContext, args: AgentHarnessResearchBriefingArgs): Record<string, unknown> {
  const includeParameters = args.includeParameters === true;
  const query = readString(args.query) || readString(args.target);
  const shellPaths = context.workspace?.shellPaths;
  const runs = shellPaths ? AgentResearchRunRegistry.fromShellPaths(shellPaths).list() : [];
  const sources = shellPaths ? AgentResearchSourceRegistry.fromShellPaths(shellPaths).list() : [];
  const normalized = query.toLowerCase();
  const matchedRuns = runs.filter((run) => !normalized || runSearchText(run).includes(normalized));
  const matchedSources = matchingSources(sources, matchedRuns, query);
  const reports = reportArtifacts(context, query);
  const liveResearch = researchLiveReadModelSnapshot(context);
  const certifiedRunnerRecords = liveResearch.browserRunnerRecords.filter(isCertifiedResearchLiveRecord);
  const activeRuns = matchedRuns.filter((run) => isMutableRun(run.status));
  const candidateSources = matchedSources.filter((source) => source.status === 'candidate');
  const reviewedSources = matchedSources.filter((source) => source.status === 'reviewed');
  const items = [
    ...activeRuns.map((run) => runItem(run, includeParameters)),
    ...matchedRuns.filter((run) => !isMutableRun(run.status) && run.reportArtifactId).map((run) => runItem(run, includeParameters)),
    ...candidateSources.map((source) => sourceItem(source, includeParameters)),
    ...reviewedSources.map((source) => sourceItem(source, includeParameters)),
    ...reports.map((artifact) => reportItem(artifact, includeParameters)),
    ...(query && matchedRuns.length === 0 ? [workflowItem(query, includeParameters)] : []),
    browserItem(context, includeParameters),
  ]
    .sort((left, right) => right.priority - left.priority || left.label.localeCompare(right.label));
  const limit = readLimit(args.limit, includeParameters ? 20 : 8);
  const status = !shellPaths
    ? 'unavailable'
    : candidateSources.length > 0
      ? 'needs-source-review'
      : reviewedSources.length > 0
        ? 'ready-to-report'
        : activeRuns.length > 0
          ? 'active'
          : reports.length > 0
            ? 'report-ready'
            : query
              ? 'needs-visible-run'
              : 'empty';
  return {
    status,
    query: query || null,
    summary: {
      runs: matchedRuns.length,
      activeRuns: activeRuns.length,
      candidateSources: candidateSources.length,
      reviewedSources: reviewedSources.length,
      savedReports: reports.length,
      browserReady: browserControlPosture(context).configured || certifiedRunnerRecords.length > 0,
      liveBrowserRuns: liveResearch.browserRunnerRecords.length,
      liveVisualReports: liveResearch.visualReportRecords.length,
    },
    queue: items.slice(0, limit),
    returned: Math.min(items.length, limit),
    total: items.length,
    routes: {
      plan: query ? `research action:"plan" query:${routeString(query)}` : 'research action:"plan" query:"..."',
      search: query ? `research action:"search" query:${routeString(query)} maxResults:5` : 'research action:"search" query:"..." maxResults:5',
      runner: 'research action:"runner"',
      runs: 'research action:"runs"',
      sources: query ? `research action:"sources" query:${routeString(query)}` : 'research action:"sources"',
      reports: query ? `research action:"reports" query:${routeString(query)}` : 'research action:"reports"',
      saveReport: query ? `research action:"report" question:${routeString(query)} sources:[...] visualReport:true requireCitationCoverage:true confirm:true explicitUserRequest:"..."` : 'research action:"report" question:"..." sources:[...] visualReport:true requireCitationCoverage:true confirm:true explicitUserRequest:"..."',
    },
    nextActions: items
      .filter((item) => item.kind !== 'browser')
      .slice(0, includeParameters ? 6 : 4)
      .map((item) => `${item.label}: ${item.next}`),
    policy: 'Research briefing is read-only. It does not search the web, open a browser, create run state, save sources, write reports, ingest Knowledge, export artifacts, archive artifacts, or send messages; each returned effect route requires its own confirmation boundary.',
  };
}
