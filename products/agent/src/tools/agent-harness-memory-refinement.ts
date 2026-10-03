import type {
  KnowledgeRefinementTaskRecord,
  KnowledgeSemanticSelfImproveResult,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

interface AgentHarnessMemoryRefinementArgs {
  readonly query?: unknown;
  readonly target?: unknown;
  readonly knowledgeSpaceId?: unknown;
  readonly sourceIds?: unknown;
  readonly gapIds?: unknown;
  readonly limit?: unknown;
  readonly maxRunMs?: unknown;
  readonly timeoutMs?: unknown;
  readonly force?: unknown;
  readonly includeParameters?: unknown;
}

interface KnowledgeRefinementService {
  listRefinementTasks?: (
    limit?: number,
    input?: {
      readonly spaceId?: string;
      readonly state?: string;
      readonly subjectKind?: string;
      readonly subjectId?: string;
      readonly gapId?: string;
    },
  ) => readonly KnowledgeRefinementTaskRecord[];
  getRefinementTask?: (id: string) => KnowledgeRefinementTaskRecord | null;
  runRefinement?: (input?: {
    readonly knowledgeSpaceId?: string;
    readonly sourceIds?: readonly string[];
    readonly gapIds?: readonly string[];
    readonly limit?: number;
    readonly maxRunMs?: number;
    readonly force?: boolean;
  }) => Promise<KnowledgeSemanticSelfImproveResult>;
  listJobs?: () => readonly {
    readonly id: string;
    readonly kind: string;
    readonly title: string;
    readonly description: string;
    readonly defaultMode: string;
  }[];
  listJobRuns?: (limit?: number, jobId?: string) => readonly {
    readonly id: string;
    readonly jobId: string;
    readonly status: string;
    readonly mode: string;
    readonly requestedAt: number;
    readonly completedAt?: number;
    readonly error?: string;
  }[];
}

const ACTIVE_STATES = new Set(['detected', 'queued', 'searching', 'evaluating', 'extracting', 'applying', 'verified']);
const ATTENTION_STATES = new Set(['blocked', 'needs_review', 'failed']);

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
  const text = readString(value);
  if (!text) return [];
  return text.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function readLimit(value: unknown, fallback: number, max = 100): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

function readRunBudgetMs(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return undefined;
  return Math.max(5_000, Math.min(60_000, Math.trunc(parsed)));
}

function knowledgeService(context: CommandContext): KnowledgeRefinementService | null {
  const service = context.extensions?.agentKnowledgeService;
  return service && typeof service === 'object' ? service as KnowledgeRefinementService : null;
}

function iso(value: number | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function routeValue(value: string): string {
  return JSON.stringify(value);
}

function taskSearchText(task: KnowledgeRefinementTaskRecord): string {
  return [
    task.id,
    task.spaceId,
    task.state,
    task.priority,
    task.trigger,
    task.subjectTitle ?? '',
    task.subjectId ?? '',
    task.subjectType ?? '',
    task.gapId ?? '',
    task.issueId ?? '',
    task.blockedReason ?? '',
    readString(task.metadata.gapTitle),
    readString(task.metadata.gapKind),
  ].join('\n').toLowerCase();
}

function compactTask(task: KnowledgeRefinementTaskRecord, includeParameters: boolean): Record<string, unknown> {
  const latestTrace = task.trace.at(-1);
  const accepted = task.acceptedSourceIds ?? [];
  const ingested = task.ingestedSourceIds ?? [];
  return {
    taskId: task.id,
    spaceId: task.spaceId,
    state: task.state,
    priority: task.priority,
    trigger: task.trigger,
    ...(task.subjectTitle ? { subject: previewHarnessText(task.subjectTitle, includeParameters ? 140 : 80) } : {}),
    ...(task.subjectId ? { subjectId: task.subjectId } : {}),
    ...(task.gapId ? { gapId: task.gapId } : {}),
    attemptCount: task.attemptCount,
    ...(task.blockedReason ? { blockedReason: previewHarnessText(task.blockedReason, includeParameters ? 180 : 96) } : {}),
    acceptedSourceCount: accepted.length,
    ingestedSourceCount: ingested.length,
    promotedFactCount: task.promotedFactCount ?? 0,
    updatedAt: iso(task.updatedAt),
    inspectRoute: `memory action:"refinement" query:${routeValue(task.id)} includeParameters:true`,
    rerunRoute: task.gapId
      ? `memory action:"run_refinement" gapIds:[${routeValue(task.gapId)}] confirm:true explicitUserRequest:"..."`
      : `memory action:"run_refinement" knowledgeSpaceId:${routeValue(task.spaceId)} limit:1 confirm:true explicitUserRequest:"..."`,
    ...(latestTrace ? {
      latestTrace: {
        at: iso(latestTrace.at),
        state: latestTrace.state,
        message: previewHarnessText(latestTrace.message, includeParameters ? 180 : 96),
      },
    } : {}),
    ...(includeParameters ? {
      budget: task.budget,
      acceptedSourceIds: accepted,
      ingestedSourceIds: ingested,
      rejectedSourceUrls: task.rejectedSourceUrls ?? [],
      sourceAssessments: (task.sourceAssessments ?? []).slice(0, 5).map((entry) => ({
        url: previewHarnessText(entry.url, 120),
        accepted: entry.accepted,
        confidence: entry.confidence,
        reasons: entry.reasons.slice(0, 3),
      })),
    } : {}),
  };
}

function taskCounts(tasks: readonly KnowledgeRefinementTaskRecord[]): Record<string, number> {
  const counts: Record<string, number> = {
    total: tasks.length,
    active: tasks.filter((task) => ACTIVE_STATES.has(task.state)).length,
    attention: tasks.filter((task) => ATTENTION_STATES.has(task.state)).length,
    closed: tasks.filter((task) => task.state === 'closed').length,
    suppressed: tasks.filter((task) => task.state === 'suppressed').length,
    cancelled: tasks.filter((task) => task.state === 'cancelled').length,
  };
  for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
  return counts;
}

function semanticJob(service: KnowledgeRefinementService): ReturnType<NonNullable<KnowledgeRefinementService['listJobs']>>[number] | null {
  return service.listJobs?.().find((job) => job.kind === 'semantic-self-improvement' || job.id === 'knowledge-semantic-self-improvement') ?? null;
}

export function memoryRefinementCatalogStatus(context: CommandContext): Record<string, unknown> {
  const service = knowledgeService(context);
  const tasks = service?.listRefinementTasks?.(1_000) ?? [];
  const counts = taskCounts(tasks);
  return {
    modes: ['memory_refinement', 'run_memory_refinement'],
    status: !service?.listRefinementTasks && !service?.runRefinement
      ? 'unavailable'
      : counts.attention > 0
        ? 'attention'
        : counts.active > 0
          ? 'active'
          : counts.total > 0
            ? 'ready'
            : 'empty',
    serviceAvailable: Boolean(service),
    taskCounts: counts,
    semanticJobPublished: Boolean(service ? semanticJob(service) : null),
    readOnlyRoute: 'memory action:"refinement"',
    confirmedRunRoute: 'memory action:"run_refinement" confirm:true explicitUserRequest:"..."',
  };
}

export function memoryRefinementSummary(context: CommandContext, args: AgentHarnessMemoryRefinementArgs): Record<string, unknown> {
  const includeParameters = args.includeParameters === true;
  const service = knowledgeService(context);
  if (!service?.listRefinementTasks && !service?.runRefinement) {
    return {
      status: 'unavailable',
      summary: 'Agent Knowledge semantic refinement is not available in this runtime.',
      requiredService: 'extensions.agentKnowledgeService.listRefinementTasks and runRefinement',
      routes: {
        knowledgeStatus: 'agent_knowledge action:"status"',
        memoryCurator: 'memory action:"curator" includeParameters:true',
      },
      policy: 'No refinement mutation is attempted from posture inspection.',
    };
  }

  const query = (readString(args.query) || readString(args.target)).toLowerCase();
  const limit = readLimit(args.limit, 25, 100);
  const spaceId = readString(args.knowledgeSpaceId);
  const allTasks = service.listRefinementTasks?.(1_000, spaceId ? { spaceId } : undefined) ?? [];
  const filtered = allTasks.filter((task) => !query || taskSearchText(task).includes(query));
  const counts = taskCounts(allTasks);
  const job = semanticJob(service);
  const latestRun = job ? service.listJobRuns?.(1, job.id)?.[0] : null;

  return {
    status: counts.attention > 0 ? 'attention' : counts.active > 0 ? 'active' : counts.total > 0 ? 'ready' : 'empty',
    userOutcome: 'Semantic self-improvement is a supervised Agent Knowledge refinement lane: gaps and repair tasks stay inspectable before any source search, ingest, or prompt expansion.',
    taskCounts: counts,
    tasks: filtered.slice(0, limit).map((task) => compactTask(task, includeParameters)),
    returned: Math.min(filtered.length, limit),
    total: filtered.length,
    semanticSelfImprovementJob: job ? {
      id: job.id,
      title: job.title,
      defaultMode: job.defaultMode,
      description: previewHarnessText(job.description, includeParameters ? 180 : 96),
      runRoute: 'memory action:"run_refinement" confirm:true explicitUserRequest:"..."',
      ...(latestRun ? {
        latestRun: {
          id: latestRun.id,
          status: latestRun.status,
          mode: latestRun.mode,
          requestedAt: iso(latestRun.requestedAt),
          completedAt: iso(latestRun.completedAt),
          ...(latestRun.error ? { error: previewHarnessText(latestRun.error, 120) } : {}),
        },
      } : {}),
    } : {
      status: 'not-published',
      description: 'KnowledgeService.runRefinement is available, but the scheduled semantic-self-improvement job is not listed.',
    },
    routes: {
      inspect: 'memory action:"refinement" includeParameters:true',
      inspectTask: 'memory action:"refinement" query:"<taskId>" includeParameters:true',
      runManual: 'memory action:"run_refinement" limit:12 confirm:true explicitUserRequest:"..."',
      runScopedSpace: 'memory action:"run_refinement" knowledgeSpaceId:"<spaceId>" limit:12 confirm:true explicitUserRequest:"..."',
      runScopedGaps: 'memory action:"run_refinement" gapIds:["<gapId>"] confirm:true explicitUserRequest:"..."',
      knowledgeStatus: 'agent_knowledge action:"status"',
      memoryCurator: 'memory action:"curator" includeParameters:true',
    },
    nextActions: [
      counts.attention > 0 ? 'Inspect blocked or failed refinement tasks before running a broader semantic self-improvement pass.' : '',
      counts.active > 0 ? 'Let active refinement tasks finish or inspect their trace before starting another broad run.' : '',
      counts.total === 0 ? 'Run a small confirmed manual refinement after useful Agent Knowledge sources exist.' : '',
      'Keep reviewed Agent-local memory as the active prompt path until refined Knowledge evidence is inspected and promoted through existing confirmed routes.',
    ].filter(Boolean),
    policy: 'Read-only refinement inspection never searches, ingests, writes prompt memory, or mutates Knowledge. Manual refinement runs require confirm:true and explicitUserRequest.',
  };
}

export async function runMemoryRefinement(context: CommandContext, args: AgentHarnessMemoryRefinementArgs): Promise<Record<string, unknown>> {
  const service = knowledgeService(context);
  if (!service?.runRefinement) {
    return {
      status: 'unavailable',
      error: 'Agent Knowledge semantic refinement runner is not available in this runtime.',
      inspectRoute: 'memory action:"refinement" includeParameters:true',
    };
  }
  const sourceIds = readStringArray(args.sourceIds);
  const gapIds = readStringArray(args.gapIds);
  const knowledgeSpaceId = readString(args.knowledgeSpaceId);
  const limit = readLimit(args.limit, 12, 24);
  const maxRunMs = readRunBudgetMs(args.maxRunMs) ?? readRunBudgetMs(args.timeoutMs);
  const run = await service.runRefinement({
    ...(knowledgeSpaceId ? { knowledgeSpaceId } : {}),
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
    ...(gapIds.length > 0 ? { gapIds } : {}),
    limit,
    ...(maxRunMs ? { maxRunMs } : {}),
    ...(args.force === true ? { force: true } : {}),
  });
  return {
    status: run.errors.length > 0 || run.blockedGaps > 0 ? 'completed-with-attention' : 'completed',
    result: {
      scannedGaps: run.scannedGaps,
      candidateGaps: run.candidateGaps ?? 0,
      processedGaps: run.processedGaps ?? 0,
      createdGaps: run.createdGaps,
      repairableGaps: run.repairableGaps,
      suppressedGaps: run.suppressedGaps,
      skippedGaps: run.skippedGaps,
      searched: run.searched,
      ingestedSources: run.ingestedSources,
      linkedRepairs: run.linkedRepairs,
      blockedGaps: run.blockedGaps,
      closedGaps: run.closedGaps,
      queuedTasks: run.queuedTasks,
      requestedLimit: run.requestedLimit ?? limit,
      effectiveLimit: run.effectiveLimit ?? 0,
      truncated: Boolean(run.truncated),
      budgetExhausted: Boolean(run.budgetExhausted),
      taskIds: run.taskIds,
      acceptedSourceIds: run.acceptedSourceIds ?? [],
      ingestedSourceIds: run.ingestedSourceIds,
      promotedFactCount: run.promotedFactCount ?? 0,
      ...(run.nextRepairAttemptAt ? { nextRepairAttemptAt: iso(run.nextRepairAttemptAt) } : {}),
      errors: run.errors.map((entry) => ({
        gapId: entry.gapId,
        error: previewHarnessText(entry.error, 160),
      })),
    },
    scope: {
      ...(knowledgeSpaceId ? { knowledgeSpaceId } : {}),
      ...(sourceIds.length > 0 ? { sourceIds } : {}),
      ...(gapIds.length > 0 ? { gapIds } : {}),
      limit,
      ...(maxRunMs ? { maxRunMs } : {}),
      force: args.force === true,
    },
    nextRoutes: {
      refinement: 'memory action:"refinement" includeParameters:true',
      curator: 'memory action:"curator" includeParameters:true',
      tasks: run.taskIds.map((taskId) => `memory action:"refinement" query:${routeValue(taskId)} includeParameters:true`).slice(0, 8),
      knowledgeStatus: 'agent_knowledge action:"status"',
    },
    policy: 'Confirmed semantic refinement updates only Agent Knowledge semantic gaps/refinement tasks and source-backed repair evidence through KnowledgeService.runRefinement. It does not write Agent-local prompt memory, external memory providers, channel messages, or reports.',
  };
}
