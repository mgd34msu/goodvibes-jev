import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

interface AgentHarnessAutonomyIntakeArgs {
  readonly query?: unknown;
  readonly target?: unknown;
  readonly includeParameters?: unknown;
}

interface ScheduleDetection {
  readonly kind?: 'at' | 'every' | 'cron';
  readonly value?: string;
  readonly missing: readonly string[];
  readonly notes: readonly string[];
}

interface AutonomyRouteCandidate {
  readonly id: string;
  readonly label: string;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly why: string;
  readonly modelRoute: string;
  readonly inspectRoute: string;
  readonly requiresConfirmation: boolean;
  readonly missingFields?: readonly string[];
  readonly userQuestion?: string;
  readonly setupRoutes?: readonly string[];
  readonly triggerWorkflowId?: string;
  readonly policy?: string;
}

type WatcherEvidenceContractStatus = 'contract-needed' | 'ready';
type WatcherEvidenceCheckStatus = 'published-route' | 'missing';

interface WatcherEvidenceContractRoute {
  readonly id: string;
  readonly label: string;
  readonly modelRoute: string;
  readonly effect: 'read-only' | 'confirmed';
  readonly why: string;
}

interface WatcherEvidenceContractCheck {
  readonly id: string;
  readonly label: string;
  readonly status: WatcherEvidenceCheckStatus;
  readonly requiredFor: string;
  readonly owner: 'goodvibes-sdk-or-daemon';
  readonly inspectRoute: string;
}

interface WatcherEvidenceReceiptContract {
  readonly status: 'missing';
  readonly appliesTo: readonly string[];
  readonly requiredFields: readonly string[];
  readonly nextWhenPublished: string;
}

interface WatcherProviderSourceContract {
  readonly status: 'missing';
  readonly supportedSourceKinds: readonly string[];
  readonly requiredFields: readonly string[];
  readonly policy: string;
}

interface WatcherEvidenceContract {
  readonly status: WatcherEvidenceContractStatus;
  readonly userOutcome: string;
  readonly currentState: string;
  readonly owner: 'goodvibes-sdk-or-daemon';
  readonly nextRoutes: readonly WatcherEvidenceContractRoute[];
  readonly contractChecklist: readonly WatcherEvidenceContractCheck[];
  readonly receiptContract: WatcherEvidenceReceiptContract;
  readonly providerSourceContract: WatcherProviderSourceContract;
  readonly policy: string;
}

type TriggerWorkflowStatus = 'ready' | 'attention' | 'setup-needed' | 'not-published';

interface TriggerWorkflow {
  readonly id: string;
  readonly label: string;
  readonly status: TriggerWorkflowStatus;
  readonly userOutcome: string;
  readonly summary: string;
  readonly nextStep: string;
  readonly capabilities: readonly string[];
  readonly requiredFields: readonly string[];
  readonly modelRoute: string;
  readonly inspectRoute: string;
  readonly setupRoutes: readonly string[];
  readonly evidence: Record<string, unknown>;
  readonly outcome?: {
    readonly target: string;
    readonly successCriteria: readonly string[];
    readonly evidenceFields: readonly string[];
    readonly verificationRoute: string;
  };
  readonly evidenceContract?: WatcherEvidenceContract;
  readonly policy: string;
}

const WATCHER_EVIDENCE_RECEIPT_FIELDS = [
  'receiptId',
  'watcherId',
  'runId',
  'sourceId',
  'sourceKind',
  'sourceScope',
  'operation',
  'status',
  'createdAt',
  'startedAt',
  'completedAt',
  'redaction',
  'lastCheckpoint',
  'lastError',
  'nextRoute',
  'recoveryRoute',
] as const;

const WATCHER_PROVIDER_SOURCE_FIELDS = [
  'sourceId',
  'sourceKind',
  'providerId',
  'providerKind',
  'scope',
  'filter',
  'enabled',
  'lastSeenAt',
  'lastCheckpoint',
  'lastError',
  'redaction',
  'permissionSummary',
  'nextRoute',
] as const;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasAny(text: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

function operatorMethodIds(): ReadonlySet<string> {
  const methods = getOperatorContract().operator?.methods;
  if (!Array.isArray(methods)) return new Set();
  return new Set(methods.map((method) => (
    method && typeof method === 'object' && 'id' in method && typeof method.id === 'string'
      ? method.id
      : ''
  )).filter(Boolean));
}

function triggerWorkflowSummary(workflows: readonly TriggerWorkflow[]): Record<string, unknown> {
  const watcherContract = workflows.find((workflow) => workflow.evidenceContract)?.evidenceContract;
  return {
    total: workflows.length,
    ready: workflows.filter((workflow) => workflow.status === 'ready').length,
    attention: workflows.filter((workflow) => workflow.status === 'attention').length,
    setupNeeded: workflows.filter((workflow) => workflow.status === 'setup-needed').length,
    notPublished: workflows.filter((workflow) => workflow.status === 'not-published').length,
    watcherEvidenceContractStatus: watcherContract?.status ?? null,
    watcherEvidenceMissing: watcherContract?.contractChecklist
      .filter((check) => check.status === 'missing')
      .map((check) => check.id) ?? [],
    primaryNextStep: workflows.find((workflow) => workflow.status !== 'ready')?.nextStep
      ?? 'Trigger routes are published; require explicit source, scope, task, success criteria, and confirmation before creating anything.',
  };
}

function describeTriggerWorkflow(workflow: TriggerWorkflow, includeParameters: boolean): Record<string, unknown> {
  if (includeParameters) return { ...workflow };
  return {
    workflowId: workflow.id,
    label: workflow.label,
    status: workflow.status,
    summary: previewHarnessText(workflow.summary),
    modelRoute: workflow.modelRoute,
  };
}

function watcherEvidenceContract(methodIds: ReadonlySet<string>): WatcherEvidenceContract {
  const watcherCreatePublished = methodIds.has('watchers.create');
  const watcherListPublished = methodIds.has('watchers.list');
  const watcherRunPublished = methodIds.has('watchers.run');
  const watcherStartStopPublished = methodIds.has('watchers.start') && methodIds.has('watchers.stop');
  return {
    status: 'contract-needed',
    userOutcome: 'Show durable watcher run history and provider-source records in the autonomy queue without hiding trigger ownership.',
    currentState: watcherListPublished
      ? 'Watcher create/list routes are published, but durable run-history and provider-source records are not published as Agent-readable records yet.'
      : 'Watcher visibility, run-history, and provider-source records are not fully published by the current connected-host contract.',
    owner: 'goodvibes-sdk-or-daemon',
    nextRoutes: [
      {
        id: 'inspect-watcher-methods',
        label: 'Inspect watcher methods',
        modelRoute: 'host action:"methods" query:"watchers"',
        effect: 'read-only',
        why: 'Shows which watcher setup and run-control routes the connected host publishes.',
      },
      {
        id: 'inspect-watcher-list',
        label: 'Inspect watcher list contract',
        modelRoute: 'host action:"method" methodId:"watchers.list"',
        effect: 'read-only',
        why: 'Checks the source-owned watcher visibility route before Agent claims durable trigger state.',
      },
      {
        id: 'inspect-autonomy-queue',
        label: 'Inspect autonomy queue',
        modelRoute: 'autonomy action:"queue"',
        effect: 'read-only',
        why: 'Shows the current Agent-visible runs, schedules, tasks, approvals, and watcher-adjacent records.',
      },
      {
        id: 'inspect-personal-ops-source',
        label: 'Inspect Personal Ops source readiness',
        modelRoute: 'personal_ops action:"lane" laneId:"inbox"',
        effect: 'read-only',
        why: 'Checks email/Gmail connector readiness before any provider-backed watcher source is used.',
      },
    ],
    contractChecklist: [
      {
        id: 'watcher-create-route',
        label: 'Watcher creation route',
        status: watcherCreatePublished ? 'published-route' : 'missing',
        requiredFor: 'Create a visible source-scoped watcher after explicit user confirmation.',
        owner: 'goodvibes-sdk-or-daemon',
        inspectRoute: 'host action:"method" methodId:"watchers.create"',
      },
      {
        id: 'watcher-list-route',
        label: 'Watcher visibility route',
        status: watcherListPublished ? 'published-route' : 'missing',
        requiredFor: 'Verify a watcher remains visible, scoped, and enabled after creation or control changes.',
        owner: 'goodvibes-sdk-or-daemon',
        inspectRoute: 'host action:"method" methodId:"watchers.list"',
      },
      {
        id: 'watcher-run-control-routes',
        label: 'Watcher run/control routes',
        status: watcherRunPublished && watcherStartStopPublished ? 'published-route' : 'missing',
        requiredFor: 'Expose explicit run, start, stop, and retry controls without guessing lifecycle state.',
        owner: 'goodvibes-sdk-or-daemon',
        inspectRoute: 'host action:"methods" query:"watchers.run watchers.start watchers.stop"',
      },
      {
        id: 'durable-run-history-records',
        label: 'Durable watcher run history records',
        status: 'missing',
        requiredFor: 'Show past watcher runs, checkpoints, errors, and next recovery routes in the autonomy queue.',
        owner: 'goodvibes-sdk-or-daemon',
        inspectRoute: 'autonomy action:"queue"',
      },
      {
        id: 'provider-source-records',
        label: 'Provider-source records',
        status: 'missing',
        requiredFor: 'Show source-scoped Gmail/email/webhook/file records without polling or exposing raw provider payloads.',
        owner: 'goodvibes-sdk-or-daemon',
        inspectRoute: 'personal_ops action:"lane" laneId:"inbox"',
      },
      {
        id: 'redacted-event-payloads',
        label: 'Redacted event payload descriptors',
        status: 'missing',
        requiredFor: 'Show what triggered a watcher without leaking raw provider payloads, tokens, or personal message bodies.',
        owner: 'goodvibes-sdk-or-daemon',
        inspectRoute: 'autonomy action:"queue"',
      },
      {
        id: 'queue-correlation-records',
        label: 'Queue correlation records',
        status: 'missing',
        requiredFor: 'Link watcher source events, watcher runs, task records, recovery routes, and user-visible queue cards.',
        owner: 'goodvibes-sdk-or-daemon',
        inspectRoute: 'autonomy action:"queue"',
      },
    ],
    receiptContract: {
      status: 'missing',
      appliesTo: [
        'watchers.create',
        'watchers.patch',
        'watchers.run',
        'watchers.start',
        'watchers.stop',
        'watchers.delete',
        'watcher-run-history',
        'provider-source-record',
      ],
      requiredFields: WATCHER_EVIDENCE_RECEIPT_FIELDS,
      nextWhenPublished: 'autonomy action:"queue" and autonomy action:"item" should expose watcher run/source receipts with exact recovery and replay routes.',
    },
    providerSourceContract: {
      status: 'missing',
      supportedSourceKinds: ['webhook', 'github-webhook', 'file-watcher', 'gmail', 'email', 'calendar'],
      requiredFields: WATCHER_PROVIDER_SOURCE_FIELDS,
      policy: 'Provider-source records must be scoped, permission-aware, redacted, and source-owned; Agent only consumes published records and never polls personal providers silently.',
    },
    policy: 'This contract is read-only guidance. Watcher creation/control remains on confirmed connected-host operator routes; durable run/source storage remains owned by the SDK/daemon.',
  };
}

function compactWatcherEvidenceContract(contract: WatcherEvidenceContract): Record<string, unknown> {
  return {
    status: contract.status,
    userOutcome: contract.userOutcome,
    owner: contract.owner,
    missing: contract.contractChecklist.filter((check) => check.status === 'missing').map((check) => check.id),
    publishedRoutes: contract.contractChecklist.filter((check) => check.status === 'published-route').map((check) => check.id),
    requiredReceiptFields: contract.receiptContract.requiredFields,
    providerSourceKinds: contract.providerSourceContract.supportedSourceKinds,
    inspectRoute: 'host action:"methods" query:"watchers"',
  };
}

function watcherTriggerOutcome(): TriggerWorkflow['outcome'] {
  return {
    target: 'created-visible-watcher',
    successCriteria: [
      'The confirmed watchers.create receipt includes id, label, kind, state, source, and metadata.',
      'The receipt has no lastError.',
      'A follow-up watchers.list read shows the watcher remains visible before assuming the trigger is active.',
    ],
    evidenceFields: ['id', 'kind', 'label', 'state', 'source.kind', 'source.enabled', 'sourceStatus', 'lastCheckpoint', 'lastError'],
    verificationRoute: 'agent_operator_method methodId:"watchers.list"',
  };
}

function normalizeInterval(amount: string, rawUnit: string): string {
  const unit = rawUnit.toLowerCase();
  if (unit === 'ms') return `${amount}ms`;
  if (unit === 's' || unit.startsWith('sec')) return `${amount}s`;
  if (unit === 'm' || unit === 'min' || unit.startsWith('minute')) return `${amount}m`;
  if (unit === 'h' || unit === 'hr' || unit.startsWith('hour')) return `${amount}h`;
  return `${amount}d`;
}

function detectSchedule(request: string): ScheduleDetection {
  const lower = request.toLowerCase();
  const iso = request.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?\b/);
  if (iso) return { kind: 'at', value: iso[0], missing: [], notes: ['Detected exact ISO timestamp.'] };

  const interval = lower.match(/\bevery\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|min|minutes?|h|hr|hours?|d|days?)\b/);
  if (interval?.[1] && interval[2]) {
    return {
      kind: 'every',
      value: normalizeInterval(interval[1], interval[2]),
      missing: [],
      notes: ['Detected exact recurring interval.'],
    };
  }

  const compactEvery = lower.match(/\bevery\s+(\d+(?:\.\d+)?(?:ms|s|m|h|d))\b/);
  if (compactEvery?.[1]) {
    return { kind: 'every', value: compactEvery[1], missing: [], notes: ['Detected exact recurring interval.'] };
  }

  const cron = request.match(/\bcron[:\s]+(\S+\s+\S+\s+\S+\s+\S+\s+\S+(?:\s+\S+)?)/i);
  if (cron?.[1]) return { kind: 'cron', value: cron[1].trim(), missing: [], notes: ['Detected cron expression.'] };

  if (hasAny(lower, ['daily', 'every day', 'each day'])) {
    return {
      kind: 'cron',
      missing: ['scheduleValue', 'timezone'],
      notes: ['Daily intent detected; ask for an exact time/timezone or cron expression before creating anything.'],
    };
  }
  if (hasAny(lower, ['weekly', 'every week', 'each week'])) {
    return {
      kind: 'cron',
      missing: ['scheduleValue', 'timezone'],
      notes: ['Weekly intent detected; ask for day, time, and timezone or a cron expression before creating anything.'],
    };
  }
  if (hasAny(lower, ['monthly', 'every month', 'each month'])) {
    return {
      kind: 'cron',
      missing: ['scheduleValue', 'timezone'],
      notes: ['Monthly intent detected; ask for day, time, and timezone or a cron expression before creating anything.'],
    };
  }
  if (hasAny(lower, ['schedule', 'scheduled', 'recurring', 'repeat', 'remind', 'reminder', 'follow up', 'follow-up'])) {
    return {
      missing: ['scheduleKind', 'scheduleValue'],
      notes: ['Scheduling intent detected; ask for exact ISO time, interval, or cron expression.'],
    };
  }
  return { missing: [], notes: [] };
}

function asksForEventTrigger(lower: string): boolean {
  return hasAny(lower, [
    'event trigger',
    'event-trigger',
    'incoming webhook',
    'webhook trigger',
    'triggered by webhook',
    'when a webhook',
    'when webhook',
    'on webhook',
    'file watcher',
    'watcher trigger',
    'when gmail',
    'new gmail',
    'when email arrives',
    'new email arrives',
    'github webhook',
  ]);
}

function buildTriggerWorkflows(request: string, schedule: ScheduleDetection): readonly TriggerWorkflow[] {
  const methodIds = operatorMethodIds();
  const schedulesCreatePublished = methodIds.has('automation.schedules.create');
  const schedulesListPublished = methodIds.has('automation.schedules.list');
  const watcherCreatePublished = methodIds.has('watchers.create');
  const watcherListPublished = methodIds.has('watchers.list');
  const watcherRunPublished = methodIds.has('watchers.run');
  const watcherStartStopPublished = methodIds.has('watchers.start') && methodIds.has('watchers.stop');
  const controlEventsPublished = methodIds.has('control.events.stream') || methodIds.has('control.events.catalog');
  const watcherContract = watcherEvidenceContract(methodIds);
  const scheduleMissing = schedule.missing.length > 0 ? schedule.missing : schedule.kind ? [] : ['scheduleKind', 'scheduleValue'];
  const scheduleReady = schedulesCreatePublished && schedule.kind !== undefined && scheduleMissing.length === 0;
  const watcherReady = watcherCreatePublished && watcherListPublished;
  const shortRequest = previewHarnessText(request || 'requested autonomous work', 96).replace(/"/g, "'");

  return [
    {
      id: 'time-based-wakeup-schedule',
      label: 'Time-based wakeup or schedule',
      status: scheduleReady ? 'ready' : schedulesCreatePublished ? 'attention' : 'setup-needed',
      userOutcome: 'Run autonomous work on an exact at/every/cron cadence without making the user understand scheduler internals.',
      summary: scheduleReady
        ? 'The request includes an exact cadence and the connected host publishes automation.schedules.create.'
        : schedulesCreatePublished
          ? 'The schedule route is published, but this request still needs an exact cadence before creation.'
          : 'The connected host does not publish automation.schedules.create in the current SDK contract.',
      nextStep: scheduleReady
        ? 'Create through schedule action:"create" with confirm:true and explicit success criteria.'
        : 'Ask for the exact ISO time, every interval, or cron expression before offering schedule creation.',
      capabilities: ['cron', 'at', 'every', 'wakeups', 'scheduled autonomous work'],
      requiredFields: ['task', 'successCriteria', ...scheduleMissing],
      modelRoute: `schedule action:"create" task:"${shortRequest}" successCriteria:"..." scheduleKind:"${schedule.kind ?? 'at|every|cron'}" scheduleValue:"${schedule.value ?? '...'}" confirm:true explicitUserRequest:"..."`,
      inspectRoute: 'autonomy action:"item" queueItemId:"connected-schedules"',
      setupRoutes: [
        'host action:"method" methodId:"automation.schedules.create"',
        'autonomy action:"item" queueItemId:"connected-schedules"',
      ],
      evidence: {
        schedulesCreatePublished,
        schedulesListPublished,
        detectedScheduleKind: schedule.kind ?? null,
        detectedScheduleValue: schedule.value ?? null,
        missingFields: scheduleMissing,
      },
      policy: 'Schedule creation is a confirmed connected-host mutation; vague recurring intent stays a question, not an inferred background job.',
    },
    {
      id: 'incoming-webhook-or-watcher',
      label: 'Incoming webhook or watcher trigger',
      status: watcherReady ? 'ready' : watcherCreatePublished ? 'attention' : 'setup-needed',
      userOutcome: 'Start visible work from a trusted incoming webhook, file/source watcher, or explicit event source.',
      summary: watcherReady
        ? 'The SDK operator contract publishes watcher create/list routes for trusted event-trigger setup.'
        : watcherCreatePublished
          ? 'Watcher creation is published, but watcher listing/readiness posture is incomplete.'
          : 'Watcher creation is not published by the current connected-host contract.',
      nextStep: watcherReady
        ? 'Inspect watchers.create, then create only after the user provides source scope, run target, success criteria, and confirmation.'
        : 'Use operator method discovery and do not claim incoming trigger setup until watcher routes are published.',
      capabilities: ['incoming webhook', 'watcher', 'event trigger', 'source trigger', 'github webhook'],
      requiredFields: ['trusted trigger source', 'source scope', 'task or run target', 'success criteria', 'confirmation'],
      modelRoute: 'agent_operator_method methodId:"watchers.create" confirm:true explicitUserRequest:"..."',
      inspectRoute: 'host action:"method" methodId:"watchers.create"',
      setupRoutes: [
        'host action:"methods" query:"watchers"',
        'host action:"method" methodId:"watchers.list"',
        'autonomy action:"queue"',
      ],
      evidence: {
        watcherCreatePublished,
        watcherListPublished,
        watcherRunPublished,
        watcherStartStopPublished,
      },
      outcome: watcherTriggerOutcome(),
      evidenceContract: watcherContract,
      policy: 'Incoming triggers are admin connected-host mutations. They require a trusted source boundary, explicit run scope, and user confirmation before creation.',
    },
    {
      id: 'gmail-or-email-trigger',
      label: 'Gmail or email-triggered workflow',
      status: watcherReady ? 'attention' : 'setup-needed',
      userOutcome: 'React to inbox changes only through a configured connector and a permission-scoped watcher/source boundary.',
      summary: watcherReady
        ? 'Watcher routes exist, but email/Gmail automation still needs a configured Personal Ops connector and reviewed source scope.'
        : 'Email-triggered work needs watcher routes plus a configured inbox connector before Agent can offer it.',
      nextStep: 'Inspect Personal Ops inbox connector readiness before creating any watcher for email-triggered work.',
      capabilities: ['gmail trigger', 'email trigger', 'inbox watcher', 'connector event'],
      requiredFields: ['configured inbox connector', 'trusted mailbox/query scope', 'task to run', 'success criteria', 'confirmation'],
      modelRoute: 'personal_ops action:"lane" laneId:"inbox"',
      inspectRoute: 'personal_ops action:"lane" laneId:"inbox"',
      setupRoutes: [
        'personal_ops action:"status" query:"inbox gmail email"',
        'host action:"method" methodId:"watchers.create"',
      ],
      evidence: {
        watcherCreatePublished,
        watcherListPublished,
        personalOpsRoutePublished: true,
      },
      evidenceContract: watcherContract,
      policy: 'Agent does not poll or read mail silently. Email-triggered work needs connector setup, scoped query/source details, and confirmation.',
    },
    {
      id: 'control-plane-event-stream',
      label: 'Control-plane event stream',
      status: controlEventsPublished ? 'ready' : 'not-published',
      userOutcome: 'Use daemon control-plane events for status-aware supervision without inventing hidden background work.',
      summary: controlEventsPublished
        ? 'The operator contract publishes control event catalog or stream routes for read-only supervision.'
        : 'Control-plane event stream routes are not published in the current SDK contract.',
      nextStep: controlEventsPublished
        ? 'Use read-only control event routes for supervision, then route mutations through exact confirmed operator methods.'
        : 'Keep supervision on autonomy action:"queue" until control event stream routes are published.',
      capabilities: ['control events', 'event stream', 'always-on gateway supervision'],
      requiredFields: ['event scope', 'supervision route'],
      modelRoute: 'host action:"methods" query:"control events stream"',
      inspectRoute: 'host action:"methods" query:"control events"',
      setupRoutes: [
        'autonomy action:"queue"',
        'host action:"methods" query:"control events"',
      ],
      evidence: {
        controlEventsPublished,
      },
      policy: 'Read-only event streams can inform supervision; they do not authorize new effects without the owning confirmed route.',
    },
  ];
}

function reminderRoute(request: string, schedule: ScheduleDetection): string {
  const message = previewHarnessText(request, 72).replace(/"/g, "'");
  const kind = schedule.kind ?? 'at|every|cron';
  const value = schedule.value ?? '...';
  return `schedule action:"remind" message:"${message}" scheduleKind:"${kind}" scheduleValue:"${value}" confirm:true explicitUserRequest:"..."`;
}

function autonomyScheduleRoute(request: string, schedule: ScheduleDetection): string {
  const task = previewHarnessText(request, 96).replace(/"/g, "'");
  const kind = schedule.kind ?? 'at|every|cron';
  const value = schedule.value ?? '...';
  return `schedule action:"create" task:"${task}" successCriteria:"..." scheduleKind:"${kind}" scheduleValue:"${value}" confirm:true explicitUserRequest:"..."`;
}

function buildCandidates(request: string): readonly AutonomyRouteCandidate[] {
  const lower = request.toLowerCase();
  const schedule = detectSchedule(request);
  const candidates: AutonomyRouteCandidate[] = [];
  const scheduled = schedule.missing.length > 0 || schedule.kind !== undefined;
  const asksForReminder = hasAny(lower, ['remind', 'reminder', 'follow up', 'follow-up', 'ping me', 'notify me']);
  const asksForRoutine = hasAny(lower, ['routine', 'checklist', 'recurring task', 'daily review', 'weekly review']);
  const asksForResearch = hasAny(lower, ['research', 'investigate', 'market map', 'source', 'report']);
  const asksForAutonomousSchedule = scheduled && !asksForReminder && hasAny(lower, [
    'audit',
    'brief',
    'briefing',
    'check',
    'daily report',
    'weekly report',
    'digest',
    'monitor',
    'research',
    'review',
    'run',
    'scan',
    'summarize',
    'triage',
  ]);
  const asksForDelegation = hasAny(lower, ['build', 'fix', 'implement', 'refactor', 'code', 'test']) && hasAny(lower, ['background', 'subagent', 'delegate', 'parallel']);
  const asksForApproval = hasAny(lower, ['approval', 'approve', 'deny']);
  const asksForAutomationControl = hasAny(lower, ['cancel', 'retry', 'pause', 'resume', 'run now'])
    && hasAny(lower, ['automation', 'schedule', 'job', 'run']);
  const asksForTrigger = asksForEventTrigger(lower);
  // Email and calendar are built in now, the google tool serves them once an
  // account is connected. This used to classify them as unsupported outright.
  const asksForMailOrCalendar = hasAny(lower, ['email', 'calendar', 'gmail', 'imap', 'caldav']);

  if (asksForAutomationControl) {
    candidates.push({
      id: 'automation-control',
      label: 'Control an existing automation or schedule',
      confidence: 'high',
      why: 'The request is about run, cancel, retry, pause, resume, or run-now control for an existing job/run/schedule.',
      modelRoute: 'autonomy action:"item" queueItemId:"automation-runs"',
      inspectRoute: 'autonomy action:"queue"',
      requiresConfirmation: true,
      missingFields: ['exact jobId, runId, or scheduleId from the queue record'],
      userQuestion: 'Which exact job, run, or schedule id should be controlled?',
    });
  }

  if (asksForApproval) {
    candidates.push({
      id: 'approval-decision',
      label: 'Review or decide a pending approval',
      confidence: 'high',
      why: 'The request mentions approval review or decision.',
      modelRoute: 'autonomy action:"item" queueItemId:"pending-approvals"',
      inspectRoute: 'workspace action:"action" actionId:"approvals"',
      requiresConfirmation: true,
      missingFields: ['exact approvalId', 'approve, deny, or cancel decision'],
      userQuestion: 'Which approval id and decision should be applied?',
    });
  }

  if (asksForTrigger) {
    candidates.push({
      id: 'visible-event-trigger-intake',
      label: 'Create or review a visible webhook or event-trigger watcher',
      confidence: 'high',
      why: 'The request asks for work to start from an external event, webhook, watcher, Gmail, or inbound message instead of a time-based schedule.',
      modelRoute: 'agent_operator_method methodId:"watchers.create" confirm:true explicitUserRequest:"..."',
      inspectRoute: 'host action:"method" methodId:"watchers.create"',
      requiresConfirmation: true,
      missingFields: [
        'trusted trigger source and scope',
        'task to run',
        'success criteria',
      ],
      userQuestion: 'Which trusted event source should be allowed to trigger this work, and what should count as a successful run?',
      setupRoutes: [
        'host action:"methods" query:"watchers"',
        'autonomy action:"queue"',
      ],
      triggerWorkflowId: 'incoming-webhook-or-watcher',
      policy: 'Watcher creation is an admin connected-host mutation and must stay source-scoped, visible, and confirmed.',
    });
  }

  if (asksForReminder || (scheduled && !asksForRoutine && !asksForResearch)) {
    candidates.push({
      id: 'one-reminder-or-simple-recurring-reminder',
      label: 'Create one confirmed reminder schedule',
      confidence: asksForReminder ? 'high' : 'medium',
      why: 'The request looks like a reminder, follow-up, notification, or simple scheduled message.',
      modelRoute: reminderRoute(request, schedule),
      inspectRoute: 'autonomy action:"item" queueItemId:"reminder-requests"',
      requiresConfirmation: true,
      missingFields: schedule.missing.length > 0 ? schedule.missing : undefined,
      userQuestion: schedule.missing.length > 0 ? 'What exact ISO time, interval, or cron expression should GoodVibes use?' : undefined,
    });
  }

  if (asksForAutonomousSchedule && !asksForRoutine) {
    const missingFields = [
      ...schedule.missing,
      'successCriteria',
    ];
    candidates.push({
      id: 'confirmed-autonomous-schedule',
      label: 'Create one confirmed autonomous Agent schedule',
      confidence: asksForResearch ? 'high' : 'medium',
      why: 'The request asks for recurring Agent work, not just a reminder notification.',
      modelRoute: autonomyScheduleRoute(request, schedule),
      inspectRoute: 'autonomy action:"item" queueItemId:"autonomous-schedule-requests"',
      requiresConfirmation: true,
      missingFields: missingFields.length > 0 ? missingFields : undefined,
      userQuestion: schedule.missing.length > 0
        ? 'What exact cadence and success criteria should this scheduled Agent work use?'
        : 'What should count as a successful scheduled run?',
    });
  }

  if (asksForRoutine) {
    candidates.push({
      id: 'reviewed-routine-schedule',
      label: 'Promote a reviewed Agent routine to a connected schedule',
      confidence: asksForRoutine ? 'high' : 'medium',
      why: 'The request sounds like recurring agent work rather than a simple reminder.',
      modelRoute: 'workspace action:"actions" categoryId:"routines" query:"promote routine"',
      inspectRoute: 'autonomy action:"item" queueItemId:"routine-schedule-promotions"',
      requiresConfirmation: true,
      missingFields: ['routineId', ...schedule.missing],
      userQuestion: 'Which reviewed routine should run, and what exact cadence should it use?',
    });
  }

  if (asksForResearch && !scheduled) {
    candidates.push({
      id: 'visible-research-run',
      label: 'Start a visible research run',
      confidence: 'high',
      why: 'The request is research/report oriented and needs a visible ledger before long-running work.',
      modelRoute: 'research action:"create_run" title:"..." question:"..." confirm:true explicitUserRequest:"..."',
      inspectRoute: 'research action:"runs"',
      requiresConfirmation: true,
      missingFields: ['research question', 'success criteria'],
      userQuestion: 'What exact research question and deliverable should be tracked?',
    });
  }

  if (asksForDelegation) {
    candidates.push({
      id: 'visible-delegation',
      label: 'Delegate isolated build/fix/review work',
      confidence: 'medium',
      why: 'The request asks for implementation work in the background, parallel, or delegated path.',
      modelRoute: 'delegation action:"status"',
      inspectRoute: 'autonomy action:"item" queueItemId:"delegated-subagents"',
      requiresConfirmation: true,
      missingFields: ['task scope', 'repo/worktree target', 'review expectation'],
      userQuestion: 'What exact implementation scope should be delegated, and what result should come back?',
    });
  }

  if (asksForMailOrCalendar) {
    candidates.push({
      id: 'connect-google-account',
      label: 'Use the built-in Gmail and Calendar connector',
      confidence: 'medium',
      why: 'The request depends on mail or calendar, which this build serves natively through the google tool once an account is connected.',
      modelRoute: 'google action:"status"',
      inspectRoute: 'google action:"status"',
      requiresConfirmation: false,
      missingFields: ['a connected Google account'],
      userQuestion: 'Connect a Google account with /google connect, or take up credentials already on this machine with /google adopt, which would you like?',
    });
  }

  if (candidates.length === 0) {
    candidates.push({
      id: 'inspect-visible-autonomy-first',
      label: 'Inspect visible autonomy queue before acting',
      confidence: 'low',
      why: 'The request does not clearly map to a safe autonomous work route yet.',
      modelRoute: 'autonomy action:"queue"',
      inspectRoute: 'autonomy action:"queue"',
      requiresConfirmation: false,
      missingFields: ['goal', 'owner', 'timing', 'success criteria'],
      userQuestion: 'What should run, when should it run, and how should success be reported?',
    });
  }

  return candidates;
}

export function autonomyIntakeSummary(_context: CommandContext, args: AgentHarnessAutonomyIntakeArgs): Record<string, unknown> {
  const request = readString(args.query) || readString(args.target);
  const watcherContract = watcherEvidenceContract(operatorMethodIds());
  if (!request) {
    const workflows = buildTriggerWorkflows('', { missing: [], notes: [] });
    return {
      status: 'missing_request',
      usage: 'Use autonomy action:"intake" with query:"<ongoing work request>". This action is read-only and returns the safest confirmed route.',
      examples: [
        'Remind me every 2h to check the deploy.',
        'Run the weekly operator report as a reviewed routine.',
        'Cancel the running automation job.',
      ],
      queueRoute: 'autonomy action:"queue"',
      triggerWorkflowSummary: triggerWorkflowSummary(workflows),
      watcherEvidenceContract: compactWatcherEvidenceContract(watcherContract),
    };
  }
  const schedule = detectSchedule(request);
  const candidates = buildCandidates(request);
  const preferred = candidates[0]!;
  const workflows = buildTriggerWorkflows(request, schedule);
  return {
    status: 'ready',
    request: previewHarnessText(request, args.includeParameters === true ? 220 : 120),
    preferred,
    candidates: candidates.slice(0, args.includeParameters === true ? 8 : 4),
    triggerWorkflowSummary: triggerWorkflowSummary(workflows),
    triggerWorkflows: workflows.map((workflow) => describeTriggerWorkflow(workflow, args.includeParameters === true)),
    watcherEvidenceContract: args.includeParameters === true ? watcherContract : compactWatcherEvidenceContract(watcherContract),
    queueRoute: 'autonomy action:"queue"',
    policy: 'Autonomy intake is read-only. It selects visible routes and missing fields; creation, approval, run control, delegation, and delivery still require the returned confirmed route plus explicit user request.',
  };
}
