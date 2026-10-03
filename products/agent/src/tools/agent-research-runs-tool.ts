import type { ShellPathService } from '@/runtime/index.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import {
  AgentResearchRunRegistry,
  researchRunLogTail,
  researchRunReportLine,
  type AgentResearchRunCreateInput,
  type AgentResearchRunPhase,
  type AgentResearchRunRecord,
  type AgentResearchRunStatus,
} from '../agent/research-run-registry.ts';

export interface AgentResearchRunsToolArgs {
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly query?: unknown;
  readonly status?: unknown;
  readonly title?: unknown;
  readonly question?: unknown;
  readonly goal?: unknown;
  readonly plan?: unknown;
  readonly phase?: unknown;
  readonly progress?: unknown;
  readonly note?: unknown;
  readonly nextSteps?: unknown;
  readonly sourceIds?: unknown;
  readonly reportArtifactId?: unknown;
  readonly error?: unknown;
  readonly includeCheckpoints?: unknown;
  readonly includeLogTail?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

type AgentResearchRunsMode =
  | 'list'
  | 'search'
  | 'show'
  | 'create'
  | 'start'
  | 'checkpoint'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'complete'
  | 'fail'
  | 'delete';

const MODES: readonly AgentResearchRunsMode[] = [
  'list',
  'search',
  'show',
  'create',
  'start',
  'checkpoint',
  'pause',
  'resume',
  'cancel',
  'complete',
  'fail',
  'delete',
];
const STATUS_VALUES: readonly AgentResearchRunStatus[] = ['planned', 'running', 'paused', 'blocked', 'cancelled', 'completed', 'failed'];
const PHASE_VALUES: readonly AgentResearchRunPhase[] = ['planning', 'searching', 'reading', 'synthesizing', 'reviewing', 'reporting'];

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readMode(value: unknown): AgentResearchRunsMode {
  return typeof value === 'string' && MODES.includes(value as AgentResearchRunsMode) ? value as AgentResearchRunsMode : 'list';
}

function readStatus(value: unknown): AgentResearchRunStatus | undefined {
  return typeof value === 'string' && STATUS_VALUES.includes(value as AgentResearchRunStatus) ? value as AgentResearchRunStatus : undefined;
}

function readMutableStatus(value: unknown): AgentResearchRunStatus | undefined {
  const status = readStatus(value);
  if (status === 'planned' || status === 'running' || status === 'paused' || status === 'blocked') return status;
  return undefined;
}

function readPhase(value: unknown): AgentResearchRunPhase | undefined {
  return typeof value === 'string' && PHASE_VALUES.includes(value as AgentResearchRunPhase) ? value as AgentResearchRunPhase : undefined;
}

function readProgress(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(100, Math.round(value)));
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : undefined;
}

function readStringList(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return value.split(/[\n,]/).map((entry) => entry.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function output(text: string): { readonly success: true; readonly output: string } {
  return { success: true, output: text };
}

function failure(error: string): { readonly success: false; readonly error: string } {
  return { success: false, error };
}

function requireId(args: AgentResearchRunsToolArgs): string {
  const id = readString(args.id);
  if (!id) throw new Error('id is required.');
  return id;
}

function requireConfirmedWrite(args: AgentResearchRunsToolArgs, action: string): string {
  const explicitUserRequest = readString(args.explicitUserRequest);
  if (!explicitUserRequest) throw new Error(`${action} requires explicitUserRequest with the user's exact request or a short faithful summary.`);
  if (args.confirm !== true) throw new Error(`${action} requires confirm:true after an explicit user request.`);
  return explicitUserRequest;
}

function runOneLine(run: AgentResearchRunRecord): string {
  const artifact = run.reportArtifactId ? ` artifact ${run.reportArtifactId}` : '';
  return `${run.id}  ${run.status}  ${run.phase}  ${run.progress}%  sources ${run.sourceIds.length}${artifact}  ${run.title}`;
}

function formatRunList(
  title: string,
  runs: readonly AgentResearchRunRecord[],
  includeCheckpoints: boolean,
): string {
  if (runs.length === 0) return `${title}\nNo Agent research runs matched.`;
  const lines = [
    title,
    ...runs.map(runOneLine),
  ];
  if (includeCheckpoints) {
    const checkpointLines = runs
      .filter((run) => run.checkpoints.length > 0)
      .flatMap((run) => run.checkpoints.slice(-2).map((checkpoint) => `  ${run.id}/${checkpoint.id} ${checkpoint.status}/${checkpoint.phase} ${checkpoint.progress}% ${checkpoint.note}`));
    if (checkpointLines.length > 0) lines.push('', 'Recent checkpoints', ...checkpointLines);
  }
  return lines.join('\n');
}

function formatRunListWithLogTail(
  title: string,
  runs: readonly AgentResearchRunRecord[],
  includeCheckpoints: boolean,
  includeLogTail: boolean,
): string {
  const base = formatRunList(title, runs, includeCheckpoints);
  if (!includeLogTail || runs.length === 0) return base;
  const logTail = runs.flatMap((run) => researchRunLogTail(run, 3).map((line) => `  ${run.id} ${line}`));
  return logTail.length > 0 ? [base, '', 'Recent run log tail', ...logTail].join('\n') : base;
}

function logTailSection(run: AgentResearchRunRecord): readonly string[] {
  const logTail = researchRunLogTail(run, 5);
  return [
    'Log tail',
    ...(logTail.length > 0 ? logTail.map((line) => `- ${line}`) : ['(none)']),
    '',
  ];
}

function routeString(value: string): string {
  return JSON.stringify(value);
}

function runNextRouteLines(run: AgentResearchRunRecord): readonly string[] {
  const lines = [
    `  inspect research action:"run" runId:${routeString(run.id)}`,
    `  briefing research action:"briefing" target:${routeString(run.id)}`,
    `  workflow research action:"plan" runId:${routeString(run.id)}`,
  ];
  if (run.status === 'planned') {
    lines.push(
      `  start research action:"start_run" id:${routeString(run.id)} confirm:true explicitUserRequest:"..."`,
      `  search research action:"search" runId:${routeString(run.id)} maxResults:5`,
      `  checkpoint research action:"checkpoint" id:${routeString(run.id)} phase:"searching" progress:10 note:"Started source collection." confirm:true explicitUserRequest:"..."`,
    );
  } else if (run.status === 'running') {
    lines.push(
      `  search research action:"search" runId:${routeString(run.id)} maxResults:5`,
      `  sources research action:"sources" query:${routeString(run.question)} includeReportLines:true`,
      `  checkpoint research action:"checkpoint" id:${routeString(run.id)} phase:"reading" progress:${Math.max(run.progress, 25)} note:"Captured and reviewed source candidates." sourceIds:["..."] confirm:true explicitUserRequest:"..."`,
      `  bundle research action:"bundle" query:${routeString(run.question)} includeReportLines:true`,
      `  report research action:"report" question:${routeString(run.question)} sources:[...] visualReport:true requireCitationCoverage:true confirm:true explicitUserRequest:"..."`,
      `  pause research action:"pause" id:${routeString(run.id)} confirm:true explicitUserRequest:"..."`,
      `  cancel research action:"cancel" id:${routeString(run.id)} note:"..." confirm:true explicitUserRequest:"..."`,
      `  complete research action:"complete" id:${routeString(run.id)} reportArtifactId:"..." confirm:true explicitUserRequest:"..."`,
    );
  } else if (run.status === 'paused' || run.status === 'blocked') {
    lines.push(
      `  resume research action:"resume" id:${routeString(run.id)} confirm:true explicitUserRequest:"..."`,
      `  checkpoint research action:"checkpoint" id:${routeString(run.id)} status:"running" phase:${routeString(run.phase)} progress:${run.progress} note:"Resumed with updated next steps." confirm:true explicitUserRequest:"..."`,
      `  cancel research action:"cancel" id:${routeString(run.id)} note:"..." confirm:true explicitUserRequest:"..."`,
    );
  } else if (run.status === 'completed') {
    lines.push(
      `  reports research action:"reports" query:${routeString(run.title)} includeContent:false`,
      ...(run.reportArtifactId ? [
        `  reportArtifact research action:"report_artifact" artifactId:${routeString(run.reportArtifactId)}`,
        `  promoteKnowledge agent_knowledge_ingest sourceKind:"artifact" artifactId:${routeString(run.reportArtifactId)} confirm:true explicitUserRequest:"..."`,
      ] : [
        `  attachReport research action:"complete" id:${routeString(run.id)} reportArtifactId:"..." confirm:true explicitUserRequest:"..."`,
      ]),
    );
  } else {
    lines.push(
      `  list research action:"runs" status:${routeString(run.status)}`,
      `  followup research action:"create_run" question:${routeString(run.question)} plan:["Follow up on the stopped research run."] confirm:true explicitUserRequest:"..."`,
    );
  }
  return lines;
}

function deletedRunRouteLines(run: AgentResearchRunRecord): readonly string[] {
  return [
    `  list research action:"runs"`,
    `  recreate research action:"create_run" title:${routeString(run.title)} question:${routeString(run.question)} plan:["Follow up on the stopped research run."] confirm:true explicitUserRequest:"..."`,
  ];
}

function formatRunDetail(run: AgentResearchRunRecord): string {
  const lines = [
    `Research run ${run.id}`,
    `title ${run.title}`,
    `question ${run.question}`,
    `goal ${run.goal}`,
    `status ${run.status}`,
    `phase ${run.phase}`,
    `progress ${run.progress}%`,
    `sources ${run.sourceIds.join(', ') || '(none)'}`,
    ...(run.reportArtifactId ? [`reportArtifact ${run.reportArtifactId}`] : []),
    `created ${run.createdAt}`,
    `updated ${run.updatedAt}`,
    ...(run.startedAt ? [`started ${run.startedAt}`] : []),
    ...(run.pausedAt ? [`paused ${run.pausedAt}`] : []),
    ...(run.cancelledAt ? [`cancelled ${run.cancelledAt}`] : []),
    ...(run.completedAt ? [`completed ${run.completedAt}`] : []),
    ...(run.failedAt ? [`failed ${run.failedAt}`] : []),
    '',
    'Plan',
    ...(run.plan.length > 0 ? run.plan.map((step) => `- ${step}`) : ['(none)']),
    '',
    'Next steps',
    ...(run.nextSteps.length > 0 ? run.nextSteps.map((step) => `- ${step}`) : ['(none)']),
    '',
    ...(run.note ? ['Note', run.note, ''] : []),
    ...(run.error ? ['Error', run.error, ''] : []),
    'Run line',
    researchRunReportLine(run),
    '',
    'Checkpoints',
    ...(run.checkpoints.length > 0
      ? run.checkpoints.map((checkpoint) => `- ${checkpoint.id} ${checkpoint.at} ${checkpoint.status}/${checkpoint.phase} ${checkpoint.progress}% ${checkpoint.note}`)
      : ['(none)']),
    '',
    ...logTailSection(run),
    'Routes',
    `checkpoint research action:"checkpoint" id:"${run.id}" confirm:true explicitUserRequest:"..."`,
    `pause research action:"pause" id:"${run.id}" confirm:true explicitUserRequest:"..."`,
    `resume research action:"resume" id:"${run.id}" confirm:true explicitUserRequest:"..."`,
    `cancel research action:"cancel" id:"${run.id}" note:"..." confirm:true explicitUserRequest:"..."`,
    `complete research action:"complete" id:"${run.id}" reportArtifactId:"..." confirm:true explicitUserRequest:"..."`,
    'report research action:"report" confirm:true explicitUserRequest:"..."',
    '',
    'Next routes',
    ...runNextRouteLines(run),
    '',
    'Policy: research run records are local visible state only; web research, report artifacts, Knowledge ingest, and external sends stay on separate explicit routes.',
  ];
  return lines.join('\n');
}

function formatMutationResult(action: string, run: AgentResearchRunRecord): string {
  const nextRoutes = action.startsWith('Deleted') ? deletedRunRouteLines(run) : runNextRouteLines(run);
  return [
    action,
    `  id ${run.id}`,
    `  status ${run.status}`,
    `  phase ${run.phase}`,
    `  progress ${run.progress}%`,
    `  sources ${run.sourceIds.length}`,
    `  title ${run.title}`,
    `  runLine ${researchRunReportLine(run)}`,
    '  nextRoutes',
    ...nextRoutes,
    '  policy local visible run state only; no web search, Knowledge ingest, artifact save, or external message was sent',
  ].join('\n');
}

function createInput(args: AgentResearchRunsToolArgs, explicitUserRequest: string): AgentResearchRunCreateInput {
  const goal = readString(args.goal);
  const note = readString(args.note);
  return {
    title: readString(args.title),
    question: readString(args.question),
    ...(goal ? { goal } : {}),
    plan: readStringList(args.plan),
    nextSteps: readStringList(args.nextSteps),
    sourceIds: readStringList(args.sourceIds),
    ...(note ? { note } : {}),
    provenance: explicitUserRequest,
  };
}

function createAgentResearchRunsTool(shellPaths?: Pick<ShellPathService, 'resolveProjectPath'>): Tool {
  return {
    definition: {
      name: 'agent_research_runs',
      description: 'Track visible local deep-research run state and checkpoints.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: MODES, description: 'Research run operation.' },
          id: { type: 'string', description: 'Research run id or title for show/control/delete.' },
          query: { type: 'string', description: 'Search text for search/list filtering.' },
          status: { type: 'string', enum: STATUS_VALUES, description: 'Optional status filter for list, or non-terminal checkpoint status.' },
          title: { type: 'string', description: 'Short research run title.' },
          question: { type: 'string', description: 'Research question.' },
          goal: { type: 'string', description: 'User-visible outcome for the run.' },
          plan: { type: 'array', items: { type: 'string' }, description: 'Research plan steps.' },
          phase: { type: 'string', enum: PHASE_VALUES, description: 'Current run phase.' },
          progress: { type: 'number', description: '0-100 run progress.' },
          note: { type: 'string', description: 'Checkpoint, pause, cancel, completion, or general note.' },
          nextSteps: { type: 'array', items: { type: 'string' }, description: 'Next visible research steps.' },
          sourceIds: { type: 'array', items: { type: 'string' }, description: 'Project-local research source ids attached to this run.' },
          reportArtifactId: { type: 'string', description: 'Saved report artifact id when completing the run.' },
          error: { type: 'string', description: 'Failure note for fail mode.' },
          includeCheckpoints: { type: 'boolean', description: 'Include recent checkpoint lines in list/search output.' },
          includeLogTail: { type: 'boolean', description: 'Include recent run log tail in list/search output.' },
          confirm: { type: 'boolean', description: 'Required true for local run-state writes.' },
          explicitUserRequest: { type: 'string', description: 'User request authorizing local research run writes.' },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>) => {
      if (!shellPaths) return failure('Research run ledger is unavailable because this runtime did not provide shell paths.');
      const registry = AgentResearchRunRegistry.fromShellPaths(shellPaths);
      const args = rawArgs as AgentResearchRunsToolArgs;
      const mode = readMode(args.mode);
      try {
        if (mode === 'list') {
          const status = readStatus(args.status);
          const runs = registry.list(status);
          return output(formatRunListWithLogTail(
            status ? `Agent research runs (${status})` : 'Agent research runs',
            runs,
            args.includeCheckpoints === true,
            args.includeLogTail === true,
          ));
        }
        if (mode === 'search') {
          const query = readString(args.query);
          return output(formatRunListWithLogTail(`Agent research run search ${query || '(all)'}`, registry.search(query), args.includeCheckpoints === true, args.includeLogTail === true));
        }
        if (mode === 'show') {
          const run = registry.get(requireId(args));
          return run ? output(formatRunDetail(run)) : failure(`Unknown research run ${readString(args.id)}`);
        }
        if (mode === 'create') {
          const explicitUserRequest = requireConfirmedWrite(args, 'Research run creation');
          return output(formatMutationResult('Created Agent research run', registry.create(createInput(args, explicitUserRequest))));
        }
        if (mode === 'start') {
          requireConfirmedWrite(args, 'Research run start');
          return output(formatMutationResult('Started Agent research run', registry.start(requireId(args), readString(args.note))));
        }
        if (mode === 'checkpoint') {
          requireConfirmedWrite(args, 'Research run checkpoint');
          const phase = readPhase(args.phase);
          const status = readMutableStatus(args.status);
          const progress = readProgress(args.progress);
          const note = readString(args.note);
          return output(formatMutationResult('Checkpointed Agent research run', registry.checkpoint(requireId(args), {
            ...(phase ? { phase } : {}),
            ...(status ? { status } : {}),
            ...(progress === undefined ? {} : { progress }),
            note,
            nextSteps: readStringList(args.nextSteps),
            sourceIds: readStringList(args.sourceIds),
          })));
        }
        if (mode === 'pause') {
          requireConfirmedWrite(args, 'Research run pause');
          return output(formatMutationResult('Paused Agent research run', registry.pause(requireId(args), readString(args.note))));
        }
        if (mode === 'resume') {
          requireConfirmedWrite(args, 'Research run resume');
          return output(formatMutationResult('Resumed Agent research run', registry.resume(requireId(args), readString(args.note))));
        }
        if (mode === 'cancel') {
          requireConfirmedWrite(args, 'Research run cancel');
          return output(formatMutationResult('Cancelled Agent research run', registry.cancel(requireId(args), readString(args.note))));
        }
        if (mode === 'complete') {
          requireConfirmedWrite(args, 'Research run completion');
          return output(formatMutationResult('Completed Agent research run', registry.complete(requireId(args), {
            note: readString(args.note),
            reportArtifactId: readString(args.reportArtifactId),
            sourceIds: readStringList(args.sourceIds),
          })));
        }
        if (mode === 'fail') {
          requireConfirmedWrite(args, 'Research run failure');
          return output(formatMutationResult('Failed Agent research run', registry.fail(requireId(args), readString(args.error) || readString(args.note))));
        }
        requireConfirmedWrite(args, 'Research run deletion');
        return output(formatMutationResult('Deleted Agent research run', registry.delete(requireId(args))));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export { createAgentResearchRunsTool };

export function registerAgentResearchRunsTool(
  registry: ToolRegistry,
  shellPaths?: Pick<ShellPathService, 'resolveProjectPath'>,
): void {
  registry.register(createAgentResearchRunsTool(shellPaths));
}
