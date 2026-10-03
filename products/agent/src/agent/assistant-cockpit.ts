import type { AgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-types.ts';

export type AssistantCockpitLaneState = 'ready' | 'attention' | 'setup';
export type AssistantCockpitStatus = 'ready' | 'ready-with-optional-setup' | 'attention';

export interface AssistantCockpitLane {
  readonly id:
    | 'setup'
    | 'chat-and-model'
    | 'work-and-files'
    | 'personal-ops'
    | 'research-and-docs'
    | 'background-work'
    | 'safety-and-recovery';
  readonly label: string;
  readonly state: AssistantCockpitLaneState;
  readonly summary: string;
  readonly nextAction: string;
  readonly routes: readonly string[];
}

export interface AssistantCockpit {
  readonly status: AssistantCockpitStatus;
  readonly primaryNextAction: string;
  readonly lanes: readonly AssistantCockpitLane[];
  readonly boundaryPolicy: string;
}

export interface AssistantCockpitMetrics {
  readonly setupBlockers: number;
  readonly setupSmokeResult?: string;
  readonly setupSmokeTrend?: string;
  readonly modelStatus: string;
  readonly executionRoutes: number;
  readonly personalGaps: number;
  readonly runningWork: number;
  readonly researchRuns: number;
  readonly documentLanes: number;
  readonly documentGaps: number;
  readonly securityFindings: number;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readString(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? String(record[key]) : '';
}

function readNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return readRecord(record[key]);
}

function lane(options: AssistantCockpitLane): AssistantCockpitLane {
  return options;
}

function setupLaneSummary(metrics: AssistantCockpitMetrics): string {
  const base = metrics.setupBlockers > 0
    ? `${metrics.setupBlockers} setup blocker(s) before autonomous work.`
    : 'First-run setup has no blocking assistant issue.';
  const latest = metrics.setupSmokeResult ? ` Last smoke ${metrics.setupSmokeResult}.` : '';
  const trend = metrics.setupSmokeTrend && metrics.setupSmokeTrend !== 'none'
    ? ` Trend ${metrics.setupSmokeTrend}.`
    : '';
  return `${base}${latest}${trend}`;
}

function setupLaneNextAction(metrics: AssistantCockpitMetrics): string {
  if (metrics.setupSmokeTrend === 'regressing') return 'Review recent smoke history, fix new blockers, then rerun setup smoke.';
  if (metrics.setupSmokeResult === 'blocked') return 'Review the saved smoke artifact, resolve blockers, then rerun setup smoke.';
  if (metrics.setupSmokeResult === 'ready-for-user-run') return 'Complete remaining user-run smoke checks, then start the user task.';
  if (metrics.setupBlockers === 0 && !metrics.setupSmokeResult) return 'Run setup smoke before trusting ongoing autonomous work.';
  return 'Use setup posture for the next visible setup step.';
}

export function buildAssistantCockpitFromMetrics(metrics: AssistantCockpitMetrics): AssistantCockpit {
  const status: AssistantCockpitStatus = metrics.setupBlockers > 0 || metrics.modelStatus === 'degraded'
    ? 'attention'
    : metrics.personalGaps > 0
      ? 'ready-with-optional-setup'
      : 'ready';
  const primaryNextAction = metrics.setupBlockers > 0
    ? 'Finish first-run setup blockers before trusting autonomous work.'
    : metrics.modelStatus === 'degraded'
      ? 'Review provider and model routing before starting a new assistant task.'
      : metrics.runningWork > 0
        ? 'Review visible background work before starting another long-running task.'
        : 'Start with the user task; route details are available only when needed.';

  return {
    status,
    primaryNextAction,
    lanes: [
      lane({
        id: 'setup',
        label: 'Get the assistant working',
        state: metrics.setupBlockers > 0 ? 'attention' : 'ready',
        summary: setupLaneSummary(metrics),
        nextAction: setupLaneNextAction(metrics),
        routes: [
          'setup action:"status"',
          'setup action:"item"',
          'setup action:"checkpoint"',
          'setup action:"save_checkpoint"',
          'setup action:"clear_checkpoint"',
          'setup action:"token"',
          'setup action:"smoke"',
        ],
      }),
      lane({
        id: 'chat-and-model',
        label: 'Talk and choose models',
        state: metrics.modelStatus === 'degraded' ? 'attention' : 'ready',
        summary: metrics.modelStatus === 'degraded' ? 'Model/provider API is degraded; routing still has diagnostics.' : 'Model route posture is available.',
        nextAction: 'Inspect routing only when model choice, cost, privacy, or local setup matters.',
        routes: ['models action:"status"', 'models action:"providers"', 'models action:"local"'],
      }),
      lane({
        id: 'work-and-files',
        label: 'Work in this project',
        state: metrics.executionRoutes > 0 ? 'ready' : 'setup',
        summary: metrics.executionRoutes > 0 ? 'Local read/edit/exec and recovery posture is inspectable.' : 'Execution posture needs tool availability review.',
        nextAction: 'Use local work routes first; delegate only for isolation, remote work, or explicit review.',
        routes: ['context action:"files"', 'agent_harness mode:"execution_posture"', 'agent_harness mode:"file_recovery"'],
      }),
      lane({
        id: 'personal-ops',
        label: 'Handle personal operations',
        state: metrics.personalGaps > 0 ? 'attention' : 'ready',
        summary: metrics.personalGaps > 0 ? `${metrics.personalGaps} personal-ops lane(s) need setup.` : 'Personal Ops lanes are available or safely identified.',
        nextAction: 'Use Personal Ops lanes and queue for inbox, calendar, notes, tasks, and delivery readiness.',
        routes: ['personal_ops action:"briefing"', 'personal_ops action:"queue"', 'personal_ops action:"intake" query:"..."', 'personal_ops action:"lane" laneId:"..."'],
      }),
      lane({
        id: 'research-and-docs',
        label: 'Research and write',
        state: metrics.documentGaps > 0 ? 'attention' : 'ready',
        summary: `${metrics.researchRuns} research run(s); ${metrics.documentLanes} document lane(s).`,
        nextAction: 'Start with the research briefing, then use source queues, reports, documents, artifacts, and blind compare as one writing path.',
        routes: ['research action:"briefing"', 'research action:"plan"', 'research action:"search"', 'research action:"runner"', 'research action:"reports"', 'agent_harness mode:"document_ops"'],
      }),
      lane({
        id: 'background-work',
        label: 'Supervise background work',
        state: metrics.runningWork > 0 ? 'attention' : 'ready',
        summary: metrics.runningWork > 0 ? `${metrics.runningWork} running item(s) need visible supervision.` : 'No running background work reported by the summary.',
        nextAction: 'Inspect the autonomy queue, visible agents, and tracked local processes before starting, pausing, resuming, or canceling ongoing work.',
        routes: ['agent_harness mode:"autonomy_queue"', 'agent_harness mode:"agent_orchestration"', 'agent_harness mode:"background_processes"', 'agent_harness mode:"autonomy_intake"'],
      }),
      lane({
        id: 'safety-and-recovery',
        label: 'Stay safe and recover',
        state: metrics.securityFindings > 0 ? 'attention' : 'ready',
        summary: metrics.securityFindings > 0 ? `${metrics.securityFindings} safety finding(s) need review.` : 'Security and recovery posture is inspectable.',
        nextAction: 'Use security, support bundle, execution history, and file recovery routes when risk or rollback matters.',
        routes: ['agent_harness mode:"security_posture"', 'agent_harness mode:"support_bundles"', 'agent_harness mode:"execution_history"'],
      }),
    ],
    boundaryPolicy: 'Primary UX is one assistant. Host, daemon, provider, MCP, and delegation details are diagnostics and confirmation boundaries, not first questions for the user.',
  };
}

export function buildAssistantCockpitFromSummaries(input: {
  readonly setupPosture: unknown;
  readonly projectContext?: unknown;
  readonly agentOrchestration?: unknown;
  readonly modelRouting: unknown;
  readonly executionPosture: unknown;
  readonly backgroundProcesses?: unknown;
  readonly personalOps: unknown;
  readonly autonomyQueue: unknown;
  readonly researchRuns: unknown;
  readonly documentOps: unknown;
  readonly securityPosture: unknown;
}): AssistantCockpit {
  const setup = readRecord(input.setupPosture);
  const model = readRecord(input.modelRouting);
  const execution = readRecord(input.executionPosture);
  const agentOrchestration = readRecord(input.agentOrchestration);
  const backgroundProcesses = readRecord(input.backgroundProcesses);
  const personal = readRecord(input.personalOps);
  const autonomy = readRecord(input.autonomyQueue);
  const research = readRecord(input.researchRuns);
  const documents = readRecord(input.documentOps);
  const security = readRecord(input.securityPosture);
  const setupSmokeEvidence = readNestedRecord(setup, 'setupSmokeEvidence');
  const setupSmokeHistory = readNestedRecord(setup, 'setupSmokeHistory');
  return buildAssistantCockpitFromMetrics({
    setupBlockers: readNumber(setup, 'autonomyBlockers') || readNumber(setup, 'blockedPlanItems'),
    setupSmokeResult: readString(setupSmokeEvidence, 'result') || undefined,
    setupSmokeTrend: readString(setupSmokeHistory, 'trend') || undefined,
    modelStatus: readString(model, 'status'),
    executionRoutes: readNumber(execution, 'routes'),
    personalGaps: readNumber(personal, 'gap'),
    runningWork: readNumber(autonomy, 'running') || readNumber(agentOrchestration, 'running') || readNumber(research, 'running') || readNumber(backgroundProcesses, 'running'),
    researchRuns: readNumber(research, 'runs'),
    documentLanes: readNumber(documents, 'lanes'),
    documentGaps: readNumber(documents, 'gap'),
    securityFindings: readNumber(security, 'findings'),
  });
}

export function buildAssistantCockpitFromWorkspaceSnapshot(snapshot: AgentWorkspaceRuntimeSnapshot): AssistantCockpit {
  const setupBlockers = snapshot.setupChecklist.filter((item) => item.status === 'blocked').length;
  const modelStatus = snapshot.provider === 'unknown' || snapshot.model === 'unknown' ? 'degraded' : 'ready';
  const readyChannels = snapshot.channels.filter((channel) => channel.ready).length;
  const enabledChannels = snapshot.channels.filter((channel) => channel.enabled).length;
  const scheduleReadyRoutines = snapshot.localRoutines.filter((routine) => (
    routine.enabled === true
    && routine.reviewState === 'reviewed'
    && (routine.missingRequirementCount ?? 0) === 0
  )).length;
  const personalGaps = [
    enabledChannels > 0 && readyChannels === 0,
    snapshot.localRoutineCount > 0 && scheduleReadyRoutines === 0,
  ].filter(Boolean).length;
  const runningWork = snapshot.researchRunRunningCount + snapshot.researchRunBlockedCount;
  const securityFindings = [
    snapshot.permissionMode === 'allow-all',
    snapshot.rawPromptTelemetry,
    snapshot.browserToolExposureEnabled,
    snapshot.mcpQuarantinedServerCount > 0,
    snapshot.mcpAllowAllServerCount > 0,
    snapshot.failedRoutineScheduleReceiptCount > 0,
  ].filter(Boolean).length;

  return buildAssistantCockpitFromMetrics({
    setupBlockers,
    setupSmokeResult: undefined,
    setupSmokeTrend: undefined,
    modelStatus,
    executionRoutes: 1,
    personalGaps,
    runningWork,
    researchRuns: snapshot.researchRunCount,
    documentLanes: 7,
    documentGaps: 0,
    securityFindings,
  });
}
