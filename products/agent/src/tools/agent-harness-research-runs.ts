import type { CommandContext } from '../input/command-registry.ts';
import {
  AgentResearchRunRegistry,
  researchRunLogTail,
  researchRunReportLine,
  type AgentResearchRunRecord,
  type AgentResearchRunStatus,
} from '../agent/research-run-registry.ts';
import { browserControlPosture } from './agent-harness-browser-control.ts';
import { isCertifiedResearchLiveRecord, researchLiveReadModelSnapshot } from './agent-harness-research-live-read-models.ts';
import { previewHarnessText } from './agent-harness-text.ts';

interface AgentHarnessResearchRunArgs {
  readonly runId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

interface ResearchRunItem {
  readonly run: AgentResearchRunRecord;
  readonly priority: number;
  readonly next: string;
  readonly modelRoute: string;
  readonly inspectRoute: string;
  readonly checkpointRoute?: string;
  readonly pauseRoute?: string;
  readonly resumeRoute?: string;
  readonly cancelRoute?: string;
  readonly completeRoute?: string;
  readonly reportRoute?: string;
}

export type ResearchRunResolution =
  | { readonly status: 'found'; readonly run: Record<string, unknown> }
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

function statusPriority(status: AgentResearchRunStatus): number {
  if (status === 'running') return 96;
  if (status === 'blocked') return 90;
  if (status === 'paused') return 82;
  if (status === 'planned') return 76;
  if (status === 'failed') return 64;
  if (status === 'cancelled') return 30;
  return 42;
}

function isMutable(status: AgentResearchRunStatus): boolean {
  return status !== 'cancelled' && status !== 'completed' && status !== 'failed';
}

function nextForRun(run: AgentResearchRunRecord): string {
  if (run.status === 'planned') return 'Start the run or add an initial checkpoint before doing more research.';
  if (run.status === 'running') return 'Checkpoint source ids, progress, and next steps before switching tasks or saving a report.';
  if (run.status === 'paused') return 'Resume only when the user wants this research to continue.';
  if (run.status === 'blocked') return 'Resolve the blocker or cancel with a clear note.';
  if (run.status === 'failed') return 'Inspect the failure note, then create a new run or recover manually.';
  if (run.status === 'completed') return 'Inspect the saved report artifact or explicitly promote reviewed artifacts to Agent Knowledge.';
  return 'Leave cancelled unless the user asks to create a replacement run.';
}

function buildRunItem(run: AgentResearchRunRecord): ResearchRunItem {
  const mutable = isMutable(run.status);
  const checkpointRoute = mutable
    ? `research action:"checkpoint" id="${run.id}" confirm:true explicitUserRequest="..."`
    : '';
  const pauseRoute = run.status === 'running' || run.status === 'blocked'
    ? `research action:"pause" id="${run.id}" confirm:true explicitUserRequest="..."`
    : '';
  const resumeRoute = run.status === 'paused' || run.status === 'planned' || run.status === 'blocked'
    ? `research action:"resume" id="${run.id}" confirm:true explicitUserRequest="..."`
    : '';
  const cancelRoute = mutable
    ? `research action:"cancel" id="${run.id}" note="..." confirm:true explicitUserRequest="..."`
    : '';
  const completeRoute = mutable
    ? `research action:"complete" id="${run.id}" reportArtifactId="..." confirm:true explicitUserRequest="..."`
    : '';
  return {
    run,
    priority: statusPriority(run.status) + Math.min(20, Math.round(run.progress / 5)),
    next: nextForRun(run),
    modelRoute: 'research action:"run"',
    inspectRoute: `research action:"run" runId="${run.id}"`,
    ...(checkpointRoute ? { checkpointRoute } : {}),
    ...(pauseRoute ? { pauseRoute } : {}),
    ...(resumeRoute ? { resumeRoute } : {}),
    ...(cancelRoute ? { cancelRoute } : {}),
    ...(completeRoute ? { completeRoute } : {}),
    reportRoute: 'research action:"report" confirm:true explicitUserRequest:"..."',
  };
}

function runSearchText(item: ResearchRunItem): string {
  const run = item.run;
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
    researchRunLogTail(run, 5).join('\n'),
    run.plan.join('\n'),
    run.nextSteps.join('\n'),
    run.sourceIds.join('\n'),
    item.inspectRoute,
    item.checkpointRoute ?? '',
    item.pauseRoute ?? '',
    item.resumeRoute ?? '',
    item.cancelRoute ?? '',
    item.completeRoute ?? '',
  ].join('\n').toLowerCase();
}

function runItems(context: CommandContext): readonly ResearchRunItem[] {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return [];
  return AgentResearchRunRegistry.fromShellPaths(shellPaths)
    .list()
    .map(buildRunItem)
    .sort((left, right) => right.priority - left.priority || right.run.updatedAt.localeCompare(left.run.updatedAt));
}

function describeRunItem(item: ResearchRunItem, includeParameters: boolean, lookup?: Record<string, unknown>): Record<string, unknown> {
  const run = item.run;
  return {
    runId: run.id,
    title: run.title,
    question: previewHarnessText(run.question, includeParameters ? 180 : 96),
    goal: previewHarnessText(run.goal, includeParameters ? 180 : 96),
    status: run.status,
    phase: run.phase,
    progress: run.progress,
    priority: item.priority,
    sources: run.sourceIds.length,
    checkpoints: run.checkpoints.length,
    logTail: researchRunLogTail(run, includeParameters ? 5 : 3),
    ...(run.reportArtifactId ? { reportArtifactId: run.reportArtifactId } : {}),
    next: previewHarnessText(item.next, includeParameters ? 180 : 96),
    modelRoute: item.modelRoute,
    inspectRoute: item.inspectRoute,
    ...(item.checkpointRoute ? { checkpointRoute: item.checkpointRoute } : {}),
    ...(item.pauseRoute ? { pauseRoute: item.pauseRoute } : {}),
    ...(item.resumeRoute ? { resumeRoute: item.resumeRoute } : {}),
    ...(item.cancelRoute ? { cancelRoute: item.cancelRoute } : {}),
    ...(item.completeRoute ? { completeRoute: item.completeRoute } : {}),
    ...(item.reportRoute ? { reportRoute: item.reportRoute } : {}),
    runLine: researchRunReportLine(run),
    ...(lookup ? { lookup } : {}),
    ...(includeParameters ? {
      plan: run.plan,
      nextSteps: run.nextSteps,
      sourceIds: run.sourceIds,
      note: run.note ?? null,
      error: run.error ?? null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt ?? null,
      pausedAt: run.pausedAt ?? null,
      cancelledAt: run.cancelledAt ?? null,
      completedAt: run.completedAt ?? null,
      failedAt: run.failedAt ?? null,
      checkpoints: run.checkpoints.slice(-10),
      policy: 'Research run rows are local visible state only. Web research, source review, report saves, Knowledge ingest, and external sends stay on explicit separate routes.',
    } : {}),
  };
}

function researchRunnerPosture(context: CommandContext, includeParameters: boolean): Record<string, unknown> {
  const browser = browserControlPosture(context);
  const liveResearch = researchLiveReadModelSnapshot(context);
  const certifiedRunnerRecords = liveResearch.browserRunnerRecords.filter(isCertifiedResearchLiveRecord);
  const certifiedVisualReports = liveResearch.visualReportRecords.filter(isCertifiedResearchLiveRecord);
  return {
    browserBackedResearch: {
      status: certifiedRunnerRecords.length > 0 ? 'certified-live-runner' : browser.status,
      configured: browser.configured || certifiedRunnerRecords.length > 0,
      needsReview: browser.needsReview,
      recommendedRoute: certifiedRunnerRecords[0]?.modelRoute ?? browser.recommendedRoute,
      setupRoute: browser.setupRoute,
      fallbackRoutes: browser.fallbackRoutes,
      liveRecords: liveResearch.browserRunnerRecords.slice(0, includeParameters ? 8 : 3),
      certifiedLiveRecords: certifiedRunnerRecords.slice(0, includeParameters ? 8 : 3),
      workflows: browser.workflows.map((workflow) => ({
        id: workflow.id,
        label: workflow.label,
        status: workflow.status,
        next: previewHarnessText(workflow.next, includeParameters ? 180 : 96),
        inspectRoute: workflow.inspectRoute,
        safety: previewHarnessText(workflow.safety, includeParameters ? 180 : 96),
      })),
    },
    visualReportRendering: {
      status: certifiedVisualReports.length > 0 ? 'certified-live-renderer' : 'artifact-packet-only',
      liveRecords: liveResearch.visualReportRecords.slice(0, includeParameters ? 8 : 3),
      certifiedLiveRecords: certifiedVisualReports.slice(0, includeParameters ? 8 : 3),
      route: certifiedVisualReports[0]?.modelRoute ?? 'research action:"reports"',
    },
    sourceQueueRoute: 'research action:"sources"',
    sourceReviewRoute: 'research action:"review_source" confirm:true explicitUserRequest:"..."',
    reportRoute: 'research action:"report" confirm:true explicitUserRequest:"..."',
    knowledgePromotionRoute: 'agent_knowledge_ingest sourceKind:"artifact" artifactId:"..." confirm:true explicitUserRequest:"..."',
    policy: 'Use browser-backed research only when browser/desktop control is ready or reviewed. Public web research can use web/fetch routes; report saving and Knowledge promotion remain separate confirmed effects.',
  };
}

function nextActions(items: readonly ResearchRunItem[]): readonly string[] {
  return items
    .filter((item) => item.run.status === 'planned' || item.run.status === 'running' || item.run.status === 'paused' || item.run.status === 'blocked')
    .slice(0, 5)
    .map((item) => `${item.run.title}: ${item.next}`);
}

export function researchRunsCatalogStatus(context: CommandContext): Record<string, unknown> {
  const items = runItems(context);
  return {
    modes: ['research_runs', 'research_run'],
    runs: items.length,
    planned: items.filter((item) => item.run.status === 'planned').length,
    running: items.filter((item) => item.run.status === 'running').length,
    paused: items.filter((item) => item.run.status === 'paused').length,
    blocked: items.filter((item) => item.run.status === 'blocked').length,
    terminal: items.filter((item) => !isMutable(item.run.status)).length,
    cancellable: items.filter((item) => isMutable(item.run.status)).length,
    readOnly: true,
  };
}

export function researchRunsSummary(context: CommandContext, args: AgentHarnessResearchRunArgs): Record<string, unknown> {
  const includeParameters = args.includeParameters === true;
  const query = readString(args.query).toLowerCase();
  const limit = readLimit(args.limit, 100);
  const items = runItems(context);
  const filtered = items.filter((item) => !query || runSearchText(item).includes(query));
  return {
    summary: {
      runs: items.length,
      planned: items.filter((item) => item.run.status === 'planned').length,
      running: items.filter((item) => item.run.status === 'running').length,
      paused: items.filter((item) => item.run.status === 'paused').length,
      blocked: items.filter((item) => item.run.status === 'blocked').length,
      terminal: items.filter((item) => !isMutable(item.run.status)).length,
      cancellable: items.filter((item) => isMutable(item.run.status)).length,
    },
    runs: filtered.slice(0, limit).map((item) => describeRunItem(item, includeParameters)),
    runnerPosture: researchRunnerPosture(context, includeParameters),
    returned: Math.min(filtered.length, limit),
    total: items.length,
    nextActions: nextActions(items),
    policy: 'Research runs are read-only in the harness. Run-state writes use confirmed research lifecycle actions; sources, reports, Knowledge, and delivery stay on separate explicit routes.',
  };
}

export function describeResearchRun(context: CommandContext, args: AgentHarnessResearchRunArgs): ResearchRunResolution {
  const runId = readString(args.runId);
  const target = readString(args.target);
  const query = readString(args.query);
  const input = runId || target || query;
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: 'research_run requires runId, target, or query. Use research action:"runs" to inspect run ids.',
    };
  }
  const normalized = input.toLowerCase();
  const items = runItems(context);
  const exact = items.find((item) => item.run.id === input);
  if (exact) return { status: 'found', run: describeRunItem(exact, true, { source: runId ? 'runId' : target ? 'target' : 'query', input, resolvedBy: 'id' }) };
  const insensitive = items.find((item) => item.run.id.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', run: describeRunItem(insensitive, true, { source: runId ? 'runId' : target ? 'target' : 'query', input, resolvedBy: 'case-insensitive-id' }) };
  const matches = items.filter((item) => runSearchText(item).includes(normalized));
  if (matches.length === 1) return { status: 'found', run: describeRunItem(matches[0]!, true, { source: runId ? 'runId' : target ? 'target' : 'query', input, resolvedBy: 'search' }) };
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.slice(0, 8).map((item) => ({
        runId: item.run.id,
        title: item.run.title,
        status: item.run.status,
        phase: item.run.phase,
        progress: item.run.progress,
        modelRoute: item.modelRoute,
      })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown research run ${input}. Use research action:"runs" to inspect run ids.`,
  };
}
