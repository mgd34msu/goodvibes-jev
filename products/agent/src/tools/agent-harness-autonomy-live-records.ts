import type { CommandContext } from '../input/command-registry.ts';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { buildAgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-snapshot.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import type { UiAutomationSnapshot, UiTasksSnapshot } from '../runtime/ui-read-models.ts';
import type { AutonomyQueueLiveRecord, AutonomyQueueRecordControl, AutonomyQueueRecordOutput, SnapshotReader } from './agent-harness-autonomy-queue-types.ts';
function readSnapshot<TSnapshot>(readModel: SnapshotReader<TSnapshot> | undefined): TSnapshot | null {
  if (!readModel) return null;
  try {
    return readModel.getSnapshot();
  } catch {
    return null;
  }
}

function formatEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function formatTimeFragment(label: string, value: number | undefined): string {
  const formatted = formatEpochMs(value);
  return formatted ? `${label} ${formatted}` : '';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const SENSITIVE_TEXT_PATTERNS: readonly [RegExp, string][] = [
  [/("?\b(?:api[-_]?key|apikey|token|secret|password|passwd|credential|authorization)\b"?\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"<redacted>"'],
  [/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1=<redacted>'],
  [/(\b(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1<redacted>'],
  [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>'],
  [/(\s--(?:token|password|secret|api-key|api_key)\s+)("[^"]*"|'[^']*'|[^\s]+)/gi, '$1<redacted>'],
];

const WATCHER_RECEIPT_PURPOSES = new Set([
  'watcher-receipt',
  'watcher-run-receipt',
  'automation-watcher-receipt',
  'automation-run-history-receipt',
  'durable-run-history-receipt',
  'agent-watcher-receipt',
  'agent-watcher-run-receipt',
  'connected-host-watcher-receipt',
  'connected-host-watcher-run-receipt',
  'connected-host-automation-run-history-receipt',
  'provider-source-record-receipt',
]);

function redactHarnessOutputText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function compactUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return redactHarnessOutputText(value.replace(/\s+/g, ' ').trim());
  if (typeof value === 'number' || typeof value === 'boolean') return redactHarnessOutputText(String(value));
  try {
    return redactHarnessOutputText(JSON.stringify(value).replace(/\s+/g, ' ').trim());
  } catch {
    return '';
  }
}

function artifactMetadata(artifact: ArtifactDescriptor): Readonly<Record<string, unknown>> {
  return artifact.metadata && typeof artifact.metadata === 'object'
    ? artifact.metadata as Readonly<Record<string, unknown>>
    : {};
}

function artifactMetadataString(artifact: ArtifactDescriptor, key: string): string {
  return readString(artifactMetadata(artifact)[key]);
}

function artifactMetadataBoolean(artifact: ArtifactDescriptor, key: string): boolean | null {
  const value = artifactMetadata(artifact)[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function artifactTimestamp(artifact: ArtifactDescriptor): number {
  const explicit = artifactMetadataString(artifact, 'createdAt')
    || artifactMetadataString(artifact, 'recordedAt')
    || artifactMetadataString(artifact, 'completedAt')
    || artifactMetadataString(artifact, 'timestamp');
  if (explicit) {
    const parsed = Date.parse(explicit);
    if (Number.isFinite(parsed)) return parsed;
  }
  return typeof artifact.createdAt === 'number' && Number.isFinite(artifact.createdAt) ? artifact.createdAt : 0;
}

function normalizedReceiptStatus(artifact: ArtifactDescriptor): string {
  const raw = (artifactMetadataString(artifact, 'status')
    || artifactMetadataString(artifact, 'outcome')
    || artifactMetadataString(artifact, 'result')).toLowerCase();
  if (!raw) return 'unknown';
  if (['ok', 'ready', 'success', 'succeeded', 'complete', 'completed', 'delivered', 'captured', 'recorded'].includes(raw)) return 'succeeded';
  if (['queued', 'scheduled', 'running', 'pending', 'in-progress', 'in_progress'].includes(raw)) return raw.replace('_', '-');
  if (['blocked', 'needs-review', 'needs_setup', 'needs-setup'].includes(raw)) return 'blocked';
  if (['fail', 'failed', 'error', 'errored'].includes(raw)) return 'failed';
  return raw;
}

function watcherReceiptArtifacts(context: CommandContext): readonly ArtifactDescriptor[] {
  const store = context.platform.artifactStore;
  if (!store?.list) return [];
  try {
    return store.list(100)
      .filter((artifact) => WATCHER_RECEIPT_PURPOSES.has(artifactMetadataString(artifact, 'purpose')))
      .sort((left, right) => artifactTimestamp(right) - artifactTimestamp(left))
      .slice(0, 20);
  } catch {
    return [];
  }
}

function formatIntervalMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return `${value}ms`;
  const units: ReadonlyArray<readonly [number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  for (const [size, suffix] of units) {
    if (value >= size && value % size === 0) return `${value / size}${suffix}`;
  }
  return `${value}ms`;
}

function summarizeSchedule(schedule: UiAutomationSnapshot['jobs'][number]['schedule']): string {
  if (schedule.kind === 'cron') {
    return [
      `cron ${schedule.expression}`,
      schedule.timezone ? `timezone ${schedule.timezone}` : '',
      schedule.staggerMs !== undefined ? `stagger ${schedule.staggerMs}ms` : '',
    ].filter(Boolean).join(', ');
  }
  if (schedule.kind === 'every') return `every ${formatIntervalMs(schedule.intervalMs)}`;
  return `at ${formatEpochMs(schedule.at) ?? schedule.at}`;
}

function quoteRouteValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function operatorMethodRoute(methodId: string, input: Record<string, string>): string {
  const payload = JSON.stringify(input);
  return `agent_operator_method methodId:"${quoteRouteValue(methodId)}" input:${payload} confirm:true explicitUserRequest:"..."`;
}

function availableControl(
  id: string,
  label: string,
  effect: AutonomyQueueRecordControl['effect'],
  modelRoute: string,
): AutonomyQueueRecordControl {
  return {
    id,
    label,
    state: 'available',
    effect,
    confirmationRequired: effect === 'confirmed-effect',
    modelRoute,
  };
}

function unavailableControl(id: string, label: string, reason: string): AutonomyQueueRecordControl {
  return {
    id,
    label,
    state: 'unavailable',
    effect: 'confirmed-effect',
    confirmationRequired: true,
    reason,
  };
}

export function controlAvailable(record: AutonomyQueueLiveRecord, id: string): boolean {
  return record.controls?.some((control) => control.id === id && control.state === 'available') === true;
}

function availableControlRoute(record: AutonomyQueueLiveRecord, id: string): string | undefined {
  return record.controls?.find((control) => control.id === id && control.state === 'available')?.modelRoute;
}

export function firstAvailableControlRoute(records: readonly AutonomyQueueLiveRecord[], id: string): string | undefined {
  for (const record of records) {
    const route = availableControlRoute(record, id);
    if (route) return route;
  }
  return undefined;
}

function taskOutputDescriptor(task: UiTasksSnapshot['tasks'][number]): AutonomyQueueRecordOutput {
  const route = `/tasks output ${task.id}`;
  const resultPreview = task.result !== undefined ? compactUnknown(task.result) : '';
  if (resultPreview.length > 0) {
    return {
      status: 'preview',
      route,
      source: 'runtime-task-result',
      preview: previewHarnessText(resultPreview, 240),
      policy: 'Bounded preview from the connected-host task read model; secret-looking text is redacted. Use the route for the full host-owned output view when available.',
    };
  }
  const errorPreview = task.error ? compactUnknown(task.error) : '';
  if (errorPreview.length > 0) {
    return {
      status: 'preview',
      route,
      source: 'runtime-task-error',
      preview: previewHarnessText(errorPreview, 240),
      policy: 'Bounded error preview from the connected-host task read model; secret-looking text is redacted. Use the route for the full host-owned output view when available.',
    };
  }
  return {
    status: 'route-only',
    route,
    source: 'not-published',
    policy: 'The connected host has not published task result/error text in the task read model. Use the route for host-owned output if that host exposes it.',
  };
}

function taskDiagnostics(task: UiTasksSnapshot['tasks'][number]): readonly string[] {
  const retry = task.retryPolicy
    ? `retry attempt ${task.retryPolicy.currentAttempt}/${task.retryPolicy.maxAttempts} backoff ${task.retryPolicy.backoff} delay ${task.retryPolicy.delayMs}ms categories ${task.retryPolicy.retryOn.join(',')}`
    : '';
  return [
    retry,
    task.retryAt ? `retry eligible ${formatEpochMs(task.retryAt)}` : '',
    task.exitCode !== undefined ? `exit code ${task.exitCode}` : '',
    task.parentTaskId ? `parent ${task.parentTaskId}` : '',
    task.childTaskIds.length > 0 ? `children ${task.childTaskIds.join(',')}` : '',
    task.correlationId ? `correlation ${task.correlationId}` : '',
    task.turnId ? `turn ${task.turnId}` : '',
    task.error ? `error ${compactUnknown(task.error)}` : '',
    task.result !== undefined ? `result ${compactUnknown(task.result)}` : '',
    `output route /tasks output ${task.id}`,
  ].filter((value): value is string => value.length > 0);
}

function automationRunDiagnostics(run: UiAutomationSnapshot['runs'][number]): readonly string[] {
  const telemetry = run.telemetry;
  const usage = telemetry?.usage;
  const usageSummary = usage
    ? [
      `telemetry usage input ${usage.inputTokens}`,
      `output ${usage.outputTokens}`,
      `cache-read ${usage.cacheReadTokens}`,
      `cache-write ${usage.cacheWriteTokens}`,
      usage.reasoningTokens !== undefined ? `reasoning ${usage.reasoningTokens}` : '',
    ].filter(Boolean).join(' ')
    : '';
  const callSummary = telemetry
    ? [
      telemetry.llmCallCount !== undefined ? `llm ${telemetry.llmCallCount}` : '',
      telemetry.toolCallCount !== undefined ? `tool ${telemetry.toolCallCount}` : '',
      telemetry.turnCount !== undefined ? `turns ${telemetry.turnCount}` : '',
      telemetry.reasoningSummaryPresent !== undefined ? `reasoning-summary ${telemetry.reasoningSummaryPresent ? 'yes' : 'no'}` : '',
    ].filter(Boolean).join(' ')
    : '';
  const route = run.route
    ? [
      `route ${run.route.id}`,
      run.route.surfaceKind,
      run.route.kind,
      run.route.title,
    ].filter(Boolean).join(' ')
    : '';
  const deliveries = (run.deliveryAttempts ?? []).slice(-3).map((delivery) => [
    `delivery ${delivery.id}`,
    delivery.status,
    delivery.responseId ? `response ${delivery.responseId}` : '',
    delivery.endedAt ? `ended ${formatEpochMs(delivery.endedAt)}` : '',
  ].filter(Boolean).join(' '));
  return [
    run.continuationMode ? `continuation ${run.continuationMode}` : '',
    run.executionIntent ? `intent ${compactUnknown(run.executionIntent)}` : '',
    telemetry?.source ? `telemetry source ${telemetry.source}` : '',
    telemetry?.modelId ? `telemetry model ${telemetry.modelId}` : '',
    telemetry?.providerId ? `telemetry provider ${telemetry.providerId}` : '',
    usageSummary,
    callSummary ? `telemetry calls ${callSummary}` : '',
    route,
    ...deliveries,
    run.result !== undefined ? `result ${compactUnknown(run.result)}` : '',
    run.cancelledReason ? `cancelled ${run.cancelledReason}` : '',
  ].filter((value): value is string => value.length > 0);
}

function scheduleEditRoute(job: UiAutomationSnapshot['jobs'][number]): string {
  const schedule = job.schedule;
  const value = schedule.kind === 'cron'
    ? schedule.expression
    : schedule.kind === 'every'
      ? formatIntervalMs(schedule.intervalMs)
      : formatEpochMs(schedule.at) ?? String(schedule.at);
  const timezone = schedule.kind === 'cron' && schedule.timezone
    ? ` timezone:"${quoteRouteValue(schedule.timezone)}"`
    : '';
  return `schedule action:"edit" scheduleId:"${quoteRouteValue(job.id)}" scheduleKind:"${schedule.kind}" scheduleValue:"${quoteRouteValue(value)}"${timezone} confirm:true explicitUserRequest:"..."`;
}

function taskStatusRank(status: UiTasksSnapshot['tasks'][number]['status']): number {
  if (status === 'running') return 0;
  if (status === 'queued') return 1;
  if (status === 'blocked') return 2;
  if (status === 'failed') return 3;
  if (status === 'completed') return 4;
  return 5;
}

export function taskLiveRecords(context: CommandContext): readonly AutonomyQueueLiveRecord[] {
  const snapshot = readSnapshot(context.platform.readModels?.tasks);
  const tasks = [...(snapshot?.tasks ?? [])].sort((left, right) => {
    const rankDelta = taskStatusRank(left.status) - taskStatusRank(right.status);
    if (rankDelta !== 0) return rankDelta;
    const leftTime = left.endedAt ?? left.startedAt ?? left.queuedAt;
    const rightTime = right.endedAt ?? right.startedAt ?? right.queuedAt;
    return rightTime - leftTime || left.title.localeCompare(right.title);
  });
  return tasks.slice(0, 20).map((task) => {
    const active = task.status === 'queued' || task.status === 'running' || task.status === 'blocked';
    const canCancel = task.cancellable && active;
    const canRetry = task.status === 'failed' || task.status === 'cancelled';
    const cancelRoute = operatorMethodRoute('tasks.cancel', { taskId: task.id });
    const retryRoute = operatorMethodRoute('tasks.retry', { taskId: task.id });
    const retry = task.retryPolicy
      ? `attempt ${task.retryPolicy.currentAttempt}/${task.retryPolicy.maxAttempts}`
      : '';
    const summary = [
      `${task.status} ${task.kind}`,
      `owner ${task.owner}`,
      task.cancellable ? 'host-cancellable' : 'not cancellable',
      formatTimeFragment('queued', task.queuedAt),
      formatTimeFragment('started', task.startedAt),
      formatTimeFragment('ended', task.endedAt),
      retry,
      task.retryAt ? `retry ${formatEpochMs(task.retryAt)}` : '',
      task.error ? `error ${compactUnknown(task.error)}` : '',
      task.result !== undefined ? `result ${compactUnknown(task.result)}` : compactUnknown(task.description),
    ].filter(Boolean).join(' | ');
    const output = taskOutputDescriptor(task);
    return {
      id: task.id,
      label: task.title,
      status: task.status,
      phase: task.kind,
      updatedAt: formatEpochMs(task.endedAt ?? task.startedAt ?? task.queuedAt),
      summary,
      inspectRoute: `/tasks show ${task.id}`,
      ...(canCancel ? { cancelRoute } : {}),
      nextSteps: [
        `/tasks show ${task.id}`,
        `/tasks output ${task.id}`,
        ...(canCancel ? [cancelRoute] : []),
        ...(canRetry ? [retryRoute] : []),
        'Use /workplan for Agent-owned visible task changes; host task mutation requires exact confirmed daemon methods.',
      ],
      sourceIds: [
        task.parentTaskId,
        ...task.childTaskIds,
        task.correlationId,
        task.turnId,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0),
      ...(task.error ? { logTail: [compactUnknown(task.error)] } : {}),
      output,
      diagnostics: taskDiagnostics(task),
      controls: [
        availableControl('inspect', 'Inspect task', 'read-only', `/tasks show ${task.id}`),
        availableControl('output', 'Show output', 'read-only', `/tasks output ${task.id}`),
        canCancel
          ? availableControl('cancel', 'Cancel task', 'confirmed-effect', cancelRoute)
          : unavailableControl('cancel', 'Cancel task', task.cancellable ? `Task is ${task.status}; cancel is only useful before terminal completion.` : 'Task owner did not mark this task cancellable.'),
        canRetry
          ? availableControl('retry', 'Retry task', 'confirmed-effect', retryRoute)
          : unavailableControl('retry', 'Retry task', `Task is ${task.status}; retry is only offered for failed or cancelled tasks.`),
      ],
    };
  });
}

export function approvalLiveRecords(context: CommandContext): readonly AutonomyQueueLiveRecord[] {
  const snapshot = readSnapshot(context.platform.readModels?.controlPlane);
  const statusRank = new Map([
    ['pending', 0],
    ['claimed', 1],
    ['denied', 2],
    ['cancelled', 3],
    ['expired', 4],
    ['approved', 5],
  ]);
  return [...(snapshot?.approvals ?? [])]
    .sort((left, right) => {
      const rankDelta = (statusRank.get(left.status) ?? 99) - (statusRank.get(right.status) ?? 99);
      if (rankDelta !== 0) return rankDelta;
      return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
    })
    .slice(0, 20)
    .map((approval) => {
      const active = approval.status === 'pending' || approval.status === 'claimed';
      const label = `${approval.request.tool}: ${approval.request.analysis.summary}`;
      const approveRoute = `agent_operator_action action:"approvals.approve" approvalId:"${approval.id}" confirm:true explicitUserRequest:"..."`;
      const denyRoute = `agent_operator_action action:"approvals.deny" approvalId:"${approval.id}" confirm:true explicitUserRequest:"..."`;
      const cancelRoute = `agent_operator_action action:"approvals.cancel" approvalId:"${approval.id}" confirm:true explicitUserRequest:"..."`;
      return {
        id: approval.id,
        label,
        status: approval.status,
        phase: approval.request.analysis.riskLevel,
        updatedAt: formatEpochMs(approval.updatedAt),
        summary: [
          `${approval.request.category}/${approval.request.analysis.riskLevel}`,
          approval.request.analysis.classification,
          `call ${approval.callId}`,
          approval.sessionId ? `session ${approval.sessionId}` : '',
          approval.routeId ? `route ${approval.routeId}` : '',
          approval.claimedBy ? `claimed by ${approval.claimedBy}` : '',
          approval.resolvedBy ? `resolved by ${approval.resolvedBy}` : '',
          compactUnknown(approval.request.args),
        ].filter(Boolean).join(' | '),
        inspectRoute: '/approval matrix',
        ...(active ? {
          cancelRoute,
        } : {}),
        nextSteps: active ? [
          approveRoute,
          denyRoute,
          cancelRoute,
        ] : [`/approval matrix`],
        sourceIds: [
          approval.callId,
          approval.sessionId,
          approval.routeId,
          ...approval.audit.map((entry) => entry.id),
        ].filter((value): value is string => typeof value === 'string' && value.length > 0),
        logTail: approval.audit.slice(-3).map((entry) => [
          entry.action,
          entry.actor,
          formatEpochMs(entry.createdAt),
          entry.note,
        ].filter(Boolean).join(' ')),
        controls: [
          availableControl('inspect', 'Inspect approval matrix', 'read-only', '/approval matrix'),
          active
            ? availableControl('approve', 'Approve approval', 'confirmed-effect', approveRoute)
            : unavailableControl('approve', 'Approve approval', `Approval is ${approval.status}; only pending or claimed approvals can be approved.`),
          active
            ? availableControl('deny', 'Deny approval', 'confirmed-effect', denyRoute)
            : unavailableControl('deny', 'Deny approval', `Approval is ${approval.status}; only pending or claimed approvals can be denied.`),
          active
            ? availableControl('cancel', 'Cancel approval', 'confirmed-effect', cancelRoute)
            : unavailableControl('cancel', 'Cancel approval', `Approval is ${approval.status}; only pending or claimed approvals can be cancelled.`),
        ],
      };
    });
}

export function automationRunLiveRecords(context: CommandContext): readonly AutonomyQueueLiveRecord[] {
  const snapshot = readSnapshot(context.platform.readModels?.automation);
  return [...(snapshot?.runs ?? [])]
    .sort((left, right) => {
      const activeDelta = Number(right.status === 'queued' || right.status === 'running') - Number(left.status === 'queued' || left.status === 'running');
      if (activeDelta !== 0) return activeDelta;
      return right.queuedAt - left.queuedAt || left.id.localeCompare(right.id);
    })
    .slice(0, 20)
    .map((run) => {
      const active = run.status === 'queued' || run.status === 'running';
      const failed = run.status === 'failed';
      const cancelRoute = `agent_operator_action action:"automation.runs.cancel" runId:"${run.id}" confirm:true explicitUserRequest:"..."`;
      const retryRoute = `agent_operator_action action:"automation.runs.retry" runId:"${run.id}" confirm:true explicitUserRequest:"..."`;
      const timing = [
        formatTimeFragment('queued', run.queuedAt),
        formatTimeFragment('started', run.startedAt),
        formatTimeFragment('ended', run.endedAt),
        run.durationMs !== undefined ? `duration ${run.durationMs}ms` : '',
      ].filter(Boolean).join(', ');
      return {
        id: run.id,
        label: `${run.jobId} -> ${run.target.kind}`,
        status: run.status,
        phase: run.scheduleKind ?? run.triggeredBy.kind,
        updatedAt: formatEpochMs(run.updatedAt),
        summary: [
          `job ${run.jobId}`,
          `target ${run.target.kind}`,
          `attempt ${run.attempt}`,
          run.agentId ? `agent ${run.agentId}` : '',
          run.sessionId ? `session ${run.sessionId}` : '',
          run.routeId ? `route ${run.routeId}` : '',
          run.modelId ? `model ${run.modelId}` : '',
          run.providerId ? `provider ${run.providerId}` : '',
          timing,
          run.error ? `error ${run.error}` : '',
          run.result !== undefined ? `result ${compactUnknown(run.result)}` : '',
        ].filter(Boolean).join(' | '),
        inspectRoute: 'workspace action:"action" actionId:"schedule-list"',
        ...(active ? {
          cancelRoute,
        } : {}),
        nextSteps: [
          ...(active ? [cancelRoute] : []),
          ...(failed ? [retryRoute] : []),
          `workspace action:"action" actionId:"schedule-list"`,
        ],
        sourceIds: [
          run.jobId,
          run.agentId,
          run.sessionId,
          run.routeId,
          run.triggeredBy.id,
          ...run.deliveryIds,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0),
        logTail: [
          run.error,
          run.cancelledReason,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0),
        diagnostics: automationRunDiagnostics(run),
        controls: [
          availableControl('inspect', 'Inspect schedule list', 'read-only', 'workspace action:"action" actionId:"schedule-list"'),
          active
            ? availableControl('cancel', 'Cancel automation run', 'confirmed-effect', cancelRoute)
            : unavailableControl('cancel', 'Cancel automation run', `Run is ${run.status}; cancel is only offered for queued or running runs.`),
          failed
            ? availableControl('retry', 'Retry automation run', 'confirmed-effect', retryRoute)
            : unavailableControl('retry', 'Retry automation run', `Run is ${run.status}; retry is only offered for failed runs.`),
        ],
      };
    });
}

export function watcherReceiptLiveRecords(context: CommandContext): readonly AutonomyQueueLiveRecord[] {
  return watcherReceiptArtifacts(context).map((artifact) => {
    const purpose = artifactMetadataString(artifact, 'purpose');
    const operation = artifactMetadataString(artifact, 'operation')
      || artifactMetadataString(artifact, 'action')
      || artifactMetadataString(artifact, 'event')
      || 'watcher-run';
    const status = normalizedReceiptStatus(artifact);
    const watcherId = artifactMetadataString(artifact, 'watcherId')
      || artifactMetadataString(artifact, 'sourceId')
      || artifactMetadataString(artifact, 'providerSourceId');
    const runId = artifactMetadataString(artifact, 'runId')
      || artifactMetadataString(artifact, 'jobRunId')
      || artifactMetadataString(artifact, 'automationRunId');
    const provider = artifactMetadataString(artifact, 'providerId')
      || artifactMetadataString(artifact, 'provider')
      || artifactMetadataString(artifact, 'sourceProvider');
    const trigger = artifactMetadataString(artifact, 'trigger')
      || artifactMetadataString(artifact, 'triggerKind')
      || artifactMetadataString(artifact, 'eventKind');
    const correlationId = artifactMetadataString(artifact, 'correlationId')
      || artifactMetadataString(artifact, 'turnId')
      || artifactMetadataString(artifact, 'sessionId');
    const redaction = artifactMetadataString(artifact, 'redaction')
      || artifactMetadataString(artifact, 'redactionPolicy')
      || 'metadata-only';
    const failureReason = artifactMetadataString(artifact, 'failureReason')
      || artifactMetadataString(artifact, 'error');
    const sourceTool = artifactMetadataString(artifact, 'sourceTool')
      || artifactMetadataString(artifact, 'qualifiedName');
    const payloadRedacted = artifactMetadataBoolean(artifact, 'payloadRedacted');
    const artifactRoute = `agent_artifacts show artifactId:"${artifact.id}" includeContent:false`;
    const queueRoute = 'autonomy action:"item" queueItemId:"automation-runs" includeParameters:true';
    return {
      id: `watcher-receipt:${artifact.id}`,
      label: `Watcher receipt: ${operation.replace(/[-_]+/g, ' ')}`,
      status,
      phase: trigger || operation,
      updatedAt: formatEpochMs(artifactTimestamp(artifact)),
      summary: [
        `Durable watcher/run receipt ${artifact.id} reports ${operation} ${status}.`,
        `Redaction ${redaction}.`,
        payloadRedacted === true ? 'Payload redacted.' : payloadRedacted === false ? 'Payload redaction not asserted.' : '',
        provider ? `Provider ${provider}.` : '',
        watcherId ? `Watcher ${compactUnknown(watcherId)}.` : '',
        runId ? `Run ${compactUnknown(runId)}.` : '',
        trigger ? `Trigger ${compactUnknown(trigger)}.` : '',
        failureReason ? `Failure ${compactUnknown(failureReason)}.` : '',
        sourceTool ? `Source ${sourceTool}.` : '',
      ].filter(Boolean).join(' '),
      inspectRoute: artifactRoute,
      nextSteps: [
        artifactRoute,
        queueRoute,
      ],
      sourceIds: [
        watcherId,
        runId,
        provider,
        trigger,
        correlationId,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0),
      diagnostics: [
        `purpose ${purpose}`,
        `receipt artifact ${artifact.id}`,
        `redaction ${redaction}`,
        failureReason ? `failure ${compactUnknown(failureReason)}` : '',
      ].filter((value): value is string => value.length > 0),
      ...(failureReason ? { logTail: [compactUnknown(failureReason)] } : {}),
      controls: [
        availableControl('inspect', 'Inspect watcher receipt', 'read-only', artifactRoute),
        availableControl('queue', 'Inspect automation queue', 'read-only', queueRoute),
      ],
    };
  });
}

export function scheduleLiveRecords(context: CommandContext): readonly AutonomyQueueLiveRecord[] {
  const snapshot = readSnapshot(context.platform.readModels?.automation);
  return [...(snapshot?.jobs ?? [])]
    .sort((left, right) => {
      const errorDelta = Number(right.status === 'error') - Number(left.status === 'error');
      if (errorDelta !== 0) return errorDelta;
      return (right.nextRunAt ?? 0) - (left.nextRunAt ?? 0) || left.name.localeCompare(right.name);
    })
    .slice(0, 20)
    .map((job) => {
      const enabled = job.enabled && job.status === 'enabled';
      const paused = job.status === 'paused' || !job.enabled;
      const toggleRoute = enabled
        ? `schedule action:"pause" scheduleId:"${job.id}" confirm:true explicitUserRequest:"..."`
        : `schedule action:"resume" scheduleId:"${job.id}" confirm:true explicitUserRequest:"..."`;
      const runRoute = `schedule action:"run" scheduleId:"${job.id}" confirm:true explicitUserRequest:"..."`;
      const editRoute = scheduleEditRoute(job);
      const deleteRoute = `schedule action:"delete" scheduleId:"${job.id}" confirm:true explicitUserRequest:"..."`;
      return {
        id: job.id,
        label: job.name,
        status: job.status,
        phase: job.schedule.kind,
        updatedAt: formatEpochMs(job.updatedAt),
        summary: [
          enabled ? 'enabled' : paused ? 'paused' : job.status,
          summarizeSchedule(job.schedule),
          `runs ${job.runCount}`,
          `success ${job.successCount}`,
          `failed ${job.failureCount}`,
          formatTimeFragment('next', job.nextRunAt),
          formatTimeFragment('last', job.lastRunAt),
          job.lastRunId ? `last run ${job.lastRunId}` : '',
          job.description ?? '',
          job.pausedReason ? `paused ${job.pausedReason}` : '',
        ].filter(Boolean).join(' | '),
        inspectRoute: '/schedule list',
        ...(enabled ? { cancelRoute: toggleRoute } : {}),
        ...(enabled ? { pauseRoute: toggleRoute } : { resumeRoute: toggleRoute }),
        nextSteps: [
          runRoute,
          editRoute,
          toggleRoute,
          deleteRoute,
          `workspace action:"action" actionId:"schedule-list"`,
        ],
        sourceIds: [
          job.source.id,
          job.lastRunId,
          ...job.labels,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0),
        ...(job.pausedReason || job.status === 'error' ? {
          logTail: [job.pausedReason ?? `Schedule status ${job.status}`],
        } : {}),
        controls: [
          availableControl('inspect', 'Inspect schedules', 'read-only', '/schedule list'),
          availableControl('run', 'Run schedule now', 'confirmed-effect', runRoute),
          availableControl('edit', 'Edit schedule', 'confirmed-effect', editRoute),
          availableControl(enabled ? 'pause' : 'resume', enabled ? 'Pause schedule' : 'Resume schedule', 'confirmed-effect', toggleRoute),
          availableControl(enabled ? 'disable' : 'enable', enabled ? 'Disable schedule' : 'Enable schedule', 'confirmed-effect', toggleRoute),
          availableControl('delete', 'Delete schedule', 'confirmed-effect', deleteRoute),
        ],
      };
    });
}

export function researchRunLiveRecords(snapshot: ReturnType<typeof buildAgentWorkspaceRuntimeSnapshot>): readonly AutonomyQueueLiveRecord[] {
  return snapshot.researchRuns.map((run) => {
    const terminal = run.status === 'cancelled' || run.status === 'completed' || run.status === 'failed';
    const canPause = run.status === 'running' || run.status === 'blocked';
    const canResume = run.status === 'paused' || run.status === 'planned' || run.status === 'blocked';
    const inspectRoute = `research action:"run" runId="${run.id}"`;
    const cancelRoute = `research action:"cancel" id="${run.id}" note="..." confirm:true explicitUserRequest:"..."`;
    const checkpointRoute = `research action:"checkpoint" id="${run.id}" note="..." progress:${run.progress} confirm:true explicitUserRequest:"..."`;
    const pauseRoute = `research action:"pause" id="${run.id}" note="..." confirm:true explicitUserRequest:"..."`;
    const resumeRoute = `research action:"resume" id="${run.id}" note="..." confirm:true explicitUserRequest:"..."`;
    const availableNextRoutes = [
      checkpointRoute,
      ...(canPause ? [pauseRoute] : []),
      ...(canResume ? [resumeRoute] : []),
      cancelRoute,
    ];
    return {
      id: run.id,
      label: run.title,
      status: run.status,
      phase: run.phase,
      progress: run.progress,
      updatedAt: run.updatedAt,
      summary: [
        `${run.status}/${run.phase} ${run.progress}%`,
        `${run.checkpointCount} checkpoint(s)`,
        `${run.sourceIds.length} source(s)`,
        run.reportArtifactId ? `report ${run.reportArtifactId}` : '',
        run.note ?? '',
      ].filter(Boolean).join(' | '),
      inspectRoute,
      ...(terminal ? {} : {
        cancelRoute,
        checkpointRoute,
        ...(canPause ? { pauseRoute } : {}),
        ...(canResume ? { resumeRoute } : {}),
      }),
      nextSteps: terminal ? run.nextSteps : [...run.nextSteps, ...availableNextRoutes],
      sourceIds: run.sourceIds,
      logTail: run.logTail,
      controls: [
        availableControl('inspect', 'Inspect research run', 'read-only', inspectRoute),
        terminal
          ? unavailableControl('checkpoint', 'Checkpoint research run', `Research run is ${run.status}; checkpoint is only offered before terminal completion.`)
          : availableControl('checkpoint', 'Checkpoint research run', 'confirmed-effect', checkpointRoute),
        canPause
          ? availableControl('pause', 'Pause research run', 'confirmed-effect', pauseRoute)
          : unavailableControl('pause', 'Pause research run', terminal ? `Research run is ${run.status}; pause is only offered before terminal completion.` : `Research run is ${run.status}; pause is offered for running or blocked runs.`),
        canResume
          ? availableControl('resume', 'Resume research run', 'confirmed-effect', resumeRoute)
          : unavailableControl('resume', 'Resume research run', terminal ? `Research run is ${run.status}; resume is only offered before terminal completion.` : `Research run is ${run.status}; resume is offered for planned, paused, or blocked runs.`),
        terminal
          ? unavailableControl('cancel', 'Cancel research run', `Research run is ${run.status}; cancel is only offered before terminal completion.`)
          : availableControl('cancel', 'Cancel research run', 'confirmed-effect', cancelRoute),
      ],
    };
  });
}
