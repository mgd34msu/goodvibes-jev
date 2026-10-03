import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import type { CommandContext } from '../input/command-registry.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-snapshot.ts';
import { automationRunLiveRecords, approvalLiveRecords, controlAvailable, firstAvailableControlRoute, researchRunLiveRecords, scheduleLiveRecords, taskLiveRecords, watcherReceiptLiveRecords } from './agent-harness-autonomy-live-records.ts';
import { watcherReadModelLiveRecords } from './agent-harness-autonomy-watcher-read-models.ts';
import type { AgentHarnessAutonomyQueueArgs, AutonomyQueueItem, AutonomyQueueLiveRecord, AutonomyQueueRecordControl, AutonomyQueueRecordOutput, AutonomyQueueResolution, AutonomyQueueStatus, OperatorContractMethod } from './agent-harness-autonomy-queue-types.ts';
export type { AutonomyQueueResolution } from './agent-harness-autonomy-queue-types.ts';
import { previewHarnessText } from './agent-harness-text.ts';

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(parsed)));
}

function operatorContractMethods(): readonly OperatorContractMethod[] {
  const contract = getOperatorContract();
  const methods = Array.isArray(contract.operator?.methods)
    ? contract.operator.methods as OperatorContractMethod[]
    : [];
  return methods.filter((method) => method.id);
}

function methodSearchText(method: OperatorContractMethod): string {
  return [
    method.id,
    method.title,
    method.description,
    method.category,
    method.http?.method,
    method.http?.path,
  ].filter(Boolean).join('\n').toLowerCase();
}

function methodIdsMatching(tokens: readonly string[]): readonly string[] {
  if (tokens.length === 0) return [];
  return operatorContractMethods()
    .filter((method) => {
      const text = methodSearchText(method);
      return tokens.some((token) => text.includes(token));
    })
    .map((method) => method.id)
    .sort((left, right) => left.localeCompare(right));
}

function statusRank(status: AutonomyQueueStatus): number {
  if (status === 'attention') return 5;
  if (status === 'active') return 4;
  if (status === 'needs-setup') return 3;
  if (status === 'ready') return 2;
  return 1;
}

function itemSearchText(item: AutonomyQueueItem): string {
  return [
    item.id,
    item.label,
    item.status,
    item.owner,
    item.kind,
    item.current,
    item.next,
    item.inspectRoute,
    item.modelRoute,
    item.cancelRoute ?? '',
    item.createRoute ?? '',
    item.batchCreateRoute ?? '',
    item.methodIds?.join('\n') ?? '',
    item.liveRecords?.flatMap((record) => [
      record.id,
      record.label,
      record.status,
      record.phase ?? '',
      record.summary,
      record.inspectRoute,
      record.cancelRoute ?? '',
      record.checkpointRoute ?? '',
      record.pauseRoute ?? '',
      record.resumeRoute ?? '',
      record.nextSteps?.join('\n') ?? '',
      record.sourceIds?.join('\n') ?? '',
      record.logTail?.join('\n') ?? '',
      record.output ? [
        record.output.status,
        record.output.route,
        record.output.source,
        record.output.preview ?? '',
        record.output.policy,
      ].join('\n') : '',
      record.diagnostics?.join('\n') ?? '',
      record.controls?.map((control) => [
        control.id,
        control.label,
        control.state,
        control.effect,
        control.modelRoute ?? '',
        control.reason ?? '',
      ].join(' ')).join('\n') ?? '',
    ]).join('\n') ?? '',
  ].join('\n').toLowerCase();
}

function describeControl(control: AutonomyQueueRecordControl): Record<string, unknown> {
  return {
    id: control.id,
    label: control.label,
    state: control.state,
    effect: control.effect,
    confirmationRequired: control.confirmationRequired,
    ...(control.modelRoute ? { modelRoute: control.modelRoute } : {}),
    ...(control.reason ? { reason: previewHarnessText(control.reason, 120) } : {}),
  };
}

function describeOutput(output: AutonomyQueueRecordOutput, includeParameters: boolean): Record<string, unknown> {
  return {
    status: output.status,
    route: output.route,
    source: output.source,
    ...(output.preview ? { preview: previewHarnessText(output.preview, includeParameters ? 220 : 96) } : {}),
    policy: previewHarnessText(output.policy, includeParameters ? 180 : 96),
  };
}

function describeLiveRecord(record: AutonomyQueueLiveRecord, includeParameters: boolean): Record<string, unknown> {
  const availableControls = record.controls
    ?.filter((control) => control.state === 'available')
    .map((control) => control.id);
  return {
    id: record.id,
    label: record.label,
    status: record.status,
    ...(record.phase ? { phase: record.phase } : {}),
    ...(typeof record.progress === 'number' ? { progress: record.progress } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    summary: previewHarnessText(record.summary, includeParameters ? 180 : 96),
    inspectRoute: record.inspectRoute,
    ...(record.cancelRoute ? { cancelRoute: record.cancelRoute } : {}),
    ...(record.checkpointRoute ? { checkpointRoute: record.checkpointRoute } : {}),
    ...(record.pauseRoute ? { pauseRoute: record.pauseRoute } : {}),
    ...(record.resumeRoute ? { resumeRoute: record.resumeRoute } : {}),
    ...(record.nextSteps && record.nextSteps.length > 0 ? { nextSteps: record.nextSteps.slice(0, includeParameters ? 8 : 3) } : {}),
    ...(record.sourceIds && record.sourceIds.length > 0 ? { sourceIds: record.sourceIds.slice(0, includeParameters ? 12 : 4) } : {}),
    ...(record.logTail && record.logTail.length > 0 ? { logTail: record.logTail.slice(-(includeParameters ? 5 : 2)) } : {}),
    ...(record.output ? { output: describeOutput(record.output, includeParameters) } : {}),
    ...(record.diagnostics && record.diagnostics.length > 0 ? { diagnostics: record.diagnostics.slice(0, includeParameters ? 10 : 3).map((line) => previewHarnessText(line, includeParameters ? 160 : 96)) } : {}),
    ...(availableControls && availableControls.length > 0 ? { availableControls: availableControls.slice(0, includeParameters ? 8 : 4) } : {}),
    ...(includeParameters && record.controls && record.controls.length > 0 ? { controls: record.controls.map(describeControl) } : {}),
  };
}

function describeItem(item: AutonomyQueueItem, includeParameters: boolean, lookup?: Record<string, unknown>): Record<string, unknown> {
  return {
    queueItemId: item.id,
    label: item.label,
    status: item.status,
    owner: item.owner,
    kind: item.kind,
    visible: item.visible,
    cancellable: item.cancellable,
    count: item.count,
    current: previewHarnessText(item.current, includeParameters ? 180 : 96),
    next: previewHarnessText(item.next, includeParameters ? 180 : 96),
    modelRoute: item.modelRoute,
    inspectRoute: item.inspectRoute,
    ...(item.cancelRoute ? { cancelRoute: item.cancelRoute } : {}),
    ...(item.createRoute ? { createRoute: item.createRoute } : {}),
    ...(item.batchCreateRoute ? { batchCreateRoute: item.batchCreateRoute } : {}),
    ...(item.liveRecords && item.liveRecords.length > 0 ? { liveRecords: item.liveRecords.slice(0, includeParameters ? 8 : 3).map((record) => describeLiveRecord(record, includeParameters)) } : {}),
    ...(lookup ? { lookup } : {}),
    ...(includeParameters ? {
      routes: {
        inspect: item.inspectRoute,
        model: item.modelRoute,
        cancel: item.cancelRoute ?? null,
        create: item.createRoute ?? null,
        batchCreate: item.batchCreateRoute ?? null,
      },
      methodIds: item.methodIds ?? [],
      policy: 'Queue rows are read-only. Create, run, pause, resume, cancel, approve, deny, send, and schedule effects stay on their owning confirmed route.',
    } : {}),
  };
}

function buildQueueItems(context: CommandContext): readonly AutonomyQueueItem[] {
  const snapshot = buildAgentWorkspaceRuntimeSnapshot(context);
  const approvalMethods = methodIdsMatching(['approval']);
  const automationMethods = methodIdsMatching(['automation']);
  const scheduleMethods = methodIdsMatching(['schedule', 'reminder']);
  const taskMethods = methodIdsMatching(['task', 'work-plan', 'workplan']);
  const readyChannels = snapshot.channels.filter((channel) => channel.ready).length;
  const configuredTargets = snapshot.channels.filter((channel) => channel.defaultTarget === 'configured').length;
  const researchRuns = researchRunLiveRecords(snapshot);
  const taskRecords = taskLiveRecords(context);
  const approvalRecords = approvalLiveRecords(context);
  const automationReadModelRecords = automationRunLiveRecords(context);
  const watcherReadModelRecords = watcherReadModelLiveRecords(context);
  const watcherReceiptRecords = watcherReceiptLiveRecords(context);
  const automationRecords = [...automationReadModelRecords, ...watcherReadModelRecords, ...watcherReceiptRecords];
  const scheduleRecords = scheduleLiveRecords(context);
  const latestResearchRun = researchRuns[0];
  const taskCancelRoute = firstAvailableControlRoute(taskRecords, 'cancel');
  const taskStatus: AutonomyQueueStatus = taskRecords.some((record) => record.status === 'blocked' || record.status === 'failed')
    ? 'attention'
    : taskRecords.some((record) => record.status === 'running' || record.status === 'queued')
      ? 'active'
      : taskMethods.length > 0
        ? 'ready'
        : 'needs-setup';
  const approvalStatus: AutonomyQueueStatus = approvalRecords.some((record) => record.status === 'pending' || record.status === 'claimed')
    ? 'attention'
    : approvalMethods.length > 0
      ? 'ready'
      : 'needs-setup';
  const automationStatus: AutonomyQueueStatus = automationRecords.some((record) => record.status === 'failed' || record.status === 'blocked')
    ? 'attention'
    : automationReadModelRecords.some((record) => record.status === 'queued' || record.status === 'running')
      || watcherReadModelRecords.some((record) => record.status === 'queued' || record.status === 'running')
      ? 'active'
      : automationMethods.length > 0 || watcherReadModelRecords.length > 0 || watcherReceiptRecords.length > 0
        ? 'ready'
        : 'needs-setup';
  const scheduleStatus: AutonomyQueueStatus = scheduleRecords.some((record) => record.status === 'error')
    ? 'attention'
    : scheduleRecords.some((record) => record.status === 'enabled')
      ? 'active'
      : scheduleMethods.length > 0
        ? 'ready'
        : 'needs-setup';
  const scheduleReadyRoutines = snapshot.localRoutines.filter((routine) => (
    routine.enabled === true
    && routine.reviewState === 'reviewed'
    && (routine.missingRequirementCount ?? 0) === 0
  )).length;
  const routineReceiptStatus: AutonomyQueueStatus = snapshot.failedRoutineScheduleReceiptCount > 0
    ? 'attention'
    : snapshot.successfulRoutineScheduleReceiptCount > 0
      ? 'active'
      : scheduleReadyRoutines > 0
        ? 'ready'
        : 'needs-setup';

  const items: AutonomyQueueItem[] = [
    {
      id: 'visible-work-plan',
      label: 'Visible work plan',
      status: 'ready',
      owner: 'agent',
      kind: 'work-plan',
      visible: true,
      cancellable: true,
      count: taskMethods.length,
      current: `Work-plan actions are available in the Agent workspace; ${taskMethods.length} task/work-plan daemon method(s) are discoverable.`,
      next: 'Track ongoing user work here first, then update status to active, blocked, done, failed, or cancelled from the confirmed form.',
      inspectRoute: 'workspace action:"action" actionId:"workplan-show"',
      modelRoute: 'agent_work_plan',
      cancelRoute: 'workspace action:"run" actionId:"workplan-status" confirm:true explicitUserRequest:"..."',
      createRoute: 'workspace action:"run" actionId:"workplan-add" confirm:true explicitUserRequest:"..."',
      methodIds: taskMethods,
    },
    {
      id: 'research-runs',
      label: 'Research runs',
      status: snapshot.researchRunBlockedCount > 0
        ? 'attention'
        : snapshot.researchRunRunningCount > 0
          ? 'active'
          : snapshot.researchRunPausedCount > 0 || snapshot.researchRunPlannedCount > 0
            ? 'ready'
            : 'needs-setup',
      owner: 'agent',
      kind: 'research-run',
      visible: true,
      cancellable: snapshot.researchRunRunningCount + snapshot.researchRunPausedCount + snapshot.researchRunPlannedCount + snapshot.researchRunBlockedCount > 0,
      count: snapshot.researchRunCount,
      current: [
        `${snapshot.researchRunCount} run(s), ${snapshot.researchRunRunningCount} running, ${snapshot.researchRunPausedCount} paused, ${snapshot.researchRunBlockedCount} blocked, ${snapshot.researchRunPlannedCount} planned.`,
        latestResearchRun ? `Latest visible run: ${latestResearchRun.label} (${latestResearchRun.status}${typeof latestResearchRun.progress === 'number' ? ` ${latestResearchRun.progress}%` : ''}).` : '',
      ].filter(Boolean).join(' '),
      next: snapshot.researchRunBlockedCount > 0
        ? 'Inspect blocked research runs, then checkpoint, resume, cancel, or complete one exact run.'
        : snapshot.researchRunRunningCount > 0
          ? 'Checkpoint progress, source ids, and next steps before switching tasks or saving a report.'
          : 'Create a visible research run when the user wants resumable deep research.',
      inspectRoute: 'research action:"runs"',
      modelRoute: 'research action:"runs"',
      cancelRoute: 'research action:"cancel" id="..." note="..." confirm:true explicitUserRequest="..."',
      createRoute: 'research action:"create_run" title:"..." question:"..." confirm:true explicitUserRequest:"..."',
      liveRecords: researchRuns,
    },
    {
      id: 'connected-host-tasks',
      label: 'Connected-host tasks',
      status: taskStatus,
      owner: 'connected-host',
      kind: 'host-task',
      visible: true,
      cancellable: taskRecords.some((record) => controlAvailable(record, 'cancel')),
      count: taskRecords.length > 0 ? taskRecords.length : taskMethods.length,
      current: taskRecords.length > 0
        ? `${taskRecords.length} live connected-host task record(s); active cancellable tasks expose exact confirmed daemon controls. ${taskMethods.length} task-like daemon method(s) are discoverable.`
        : `${taskMethods.length} task-like daemon method(s) are present; Agent exposes read-only host task inspection.`,
      next: taskRecords.some((record) => record.status === 'blocked' || record.status === 'failed')
        ? 'Inspect failed or blocked host tasks, then use the exact retry control when useful or update Agent workplan state from the visible work-plan route.'
        : taskCancelRoute
          ? 'Inspect active host tasks; cancel only the exact host task id through its confirmed daemon control when the user authorizes it.'
          : taskRecords.some((record) => record.status === 'running' || record.status === 'queued')
            ? 'Inspect active host tasks before changing any work plan, delegation, or automation state.'
          : taskMethods.length > 0
            ? 'Inspect host tasks before changing any work plan or automation state.'
        : 'Update the connected GoodVibes host or connector set until task inspection methods are present.',
      inspectRoute: 'workspace action:"action" actionId:"tasks-list"',
      modelRoute: 'host action:"methods" query:"task"',
      ...(taskCancelRoute ? { cancelRoute: taskCancelRoute } : {}),
      methodIds: taskMethods,
      liveRecords: taskRecords,
    },
    {
      id: 'pending-approvals',
      label: 'Pending approvals',
      status: approvalStatus,
      owner: 'connected-host',
      kind: 'approval',
      visible: true,
      cancellable: true,
      count: approvalRecords.length > 0 ? approvalRecords.length : approvalMethods.length,
      current: approvalRecords.length > 0
        ? `${approvalRecords.length} recent approval record(s); pending or claimed approvals require explicit user-visible decisions.`
        : `${approvalMethods.length} approval daemon method(s) are present; approval decisions remain explicit and reviewable.`,
      next: approvalRecords.some((record) => record.status === 'pending' || record.status === 'claimed')
        ? 'Review pending approval records, risk, and args; approve, deny, or cancel exactly one id only when the user asks.'
        : 'Review the matrix, then approve, deny, or cancel one exact approval id only when the user asks.',
      inspectRoute: 'workspace action:"action" actionId:"approvals"',
      modelRoute: 'host action:"methods" query:"approval"',
      cancelRoute: 'workspace action:"run" actionId:"approval-cancel" confirm:true explicitUserRequest:"..."',
      methodIds: approvalMethods,
      liveRecords: approvalRecords,
    },
    {
      id: 'automation-runs',
      label: 'Automation runs',
      status: automationStatus,
      owner: 'connected-host',
      kind: 'automation-run',
      visible: true,
      cancellable: true,
      count: automationRecords.length > 0 ? automationRecords.length : automationMethods.length,
      current: automationRecords.length > 0
        ? `${automationReadModelRecords.length} recent automation run record(s), ${watcherReadModelRecords.length} live watcher run/source record(s), ${watcherReceiptRecords.length} durable watcher/run receipt(s); active, failed, and retryable live runs expose exact control routes while receipt records stay read-only.`
        : `${automationMethods.length} automation daemon method(s) are present; run, pause, resume, cancel, and retry actions are confirmed forms.`,
      next: automationRecords.some((record) => record.status === 'failed')
        ? 'Inspect failed automation runs, then retry or leave them alone only through exact confirmed run routes.'
        : automationReadModelRecords.some((record) => record.status === 'queued' || record.status === 'running')
          ? 'Inspect active automation runs and cancel only the exact run id the user authorizes.'
          : watcherReadModelRecords.some((record) => record.status === 'queued' || record.status === 'running')
            ? 'Inspect live watcher/source records and use exact published watcher controls only for the run id the user authorizes.'
            : watcherReadModelRecords.length > 0
              ? 'Review live watcher/source read models and durable receipts; mutate only through exact confirmed routes published by the host.'
              : watcherReceiptRecords.length > 0
                ? 'Review durable watcher/run receipts, then wait for live SDK/daemon run records before controlling any run.'
                : 'Inspect automation posture first. Use exact run/job ids for confirmed run control.',
      inspectRoute: 'host action:"methods" query:"automation"',
      modelRoute: 'workspace action:"actions" categoryId:"automation"',
      cancelRoute: 'workspace action:"run" actionId:"automation-run-cancel" confirm:true explicitUserRequest:"..."',
      methodIds: automationMethods,
      liveRecords: automationRecords,
    },
    {
      id: 'autonomous-schedule-requests',
      label: 'Autonomous schedule requests',
      status: scheduleMethods.length > 0 ? 'ready' : 'needs-setup',
      owner: 'agent-and-connected-host',
      kind: 'schedule',
      visible: true,
      cancellable: false,
      count: scheduleMethods.length,
      current: `${scheduleMethods.length} schedule/reminder daemon method(s); autonomous schedules require explicit task, cadence, success criteria, and user request provenance.`,
      next: scheduleMethods.length > 0
        ? 'Create one visible autonomous schedule only after the user gives exact timing and success criteria.'
        : 'Update the connected GoodVibes host until automation.schedules.create is available.',
      inspectRoute: 'autonomy action:"intake" query:"..."',
      modelRoute: 'schedule action:"create"',
      createRoute: 'schedule action:"create" task:"..." successCriteria:"..." scheduleKind:"..." scheduleValue:"..." confirm:true explicitUserRequest:"..."',
      methodIds: scheduleMethods,
    },
    {
      id: 'connected-schedules',
      label: 'Connected schedules',
      status: scheduleStatus,
      owner: 'connected-host',
      kind: 'schedule',
      visible: true,
      cancellable: true,
      count: scheduleRecords.length > 0 ? scheduleRecords.length : scheduleMethods.length,
      current: scheduleRecords.length > 0
        ? `${scheduleRecords.length} live connected schedule record(s); edit, run-now, enable, disable, and delete remain explicit confirmed actions.`
        : `${scheduleMethods.length} schedule/reminder daemon method(s) are present; schedule inspection, edit, and lifecycle controls are visible.`,
      next: scheduleRecords.some((record) => record.status === 'error')
        ? 'Inspect schedule errors before running, enabling, disabling, deleting, or creating more schedules.'
        : scheduleRecords.length > 0
          ? 'Review live schedules or reconcile routine receipts before controlling one exact schedule id.'
          : 'List schedules or reconcile routine receipts before controlling one schedule by id.',
      inspectRoute: 'workspace action:"action" actionId:"schedule-list"',
      modelRoute: 'schedule action:"list|edit|run|pause|resume|delete"',
      cancelRoute: 'schedule action:"pause" scheduleId:"..." confirm:true explicitUserRequest:"..."',
      createRoute: 'schedule action:"create" task:"..." successCriteria:"..." scheduleKind:"..." scheduleValue:"..." confirm:true explicitUserRequest:"..."',
      methodIds: scheduleMethods,
      liveRecords: scheduleRecords,
    },
    {
      id: 'reminder-requests',
      label: 'Reminder requests',
      status: scheduleMethods.length > 0 ? readyChannels > 0 || configuredTargets > 0 ? 'ready' : 'needs-setup' : 'needs-setup',
      owner: 'agent-and-connected-host',
      kind: 'reminder',
      visible: true,
      cancellable: false,
      count: configuredTargets,
      current: `${configuredTargets} configured delivery target(s), ${readyChannels} ready channel(s), ${scheduleMethods.length} schedule/reminder method(s).`,
      next: readyChannels > 0 || configuredTargets > 0
        ? 'Create one reminder only after the user gives real timing and delivery scope.'
        : 'Configure at least one delivery target before relying on reminder delivery.',
      inspectRoute: 'personal_ops action:"lane" laneId:"reminders"',
      modelRoute: 'schedule action:"remind"',
      createRoute: 'schedule action:"remind" message:"..." scheduleKind:"..." scheduleValue:"..." confirm:true explicitUserRequest:"..."',
      methodIds: scheduleMethods,
    },
    {
      id: 'routine-schedule-promotions',
      label: 'Routine schedule promotions',
      status: routineReceiptStatus,
      owner: 'agent-and-connected-host',
      kind: 'routine-schedule',
      visible: true,
      cancellable: false,
      count: snapshot.routineScheduleReceiptCount,
      current: `${snapshot.routineScheduleReceiptCount} receipt(s), ${snapshot.successfulRoutineScheduleReceiptCount} created, ${snapshot.failedRoutineScheduleReceiptCount} failed, ${scheduleReadyRoutines} schedule-ready routine(s).`,
      next: snapshot.failedRoutineScheduleReceiptCount > 0
        ? 'Reconcile failed receipts before creating more routine schedules.'
        : scheduleReadyRoutines > 0
          ? 'Promote one reviewed routine only when the user asks for recurrence.'
          : 'Create, enable, and review a routine before schedule promotion.',
      inspectRoute: 'workspace action:"action" actionId:"schedule-receipts"',
      modelRoute: 'workspace action:"actions" categoryId:"routines"',
      createRoute: 'workspace action:"run" actionId:"schedule-promote-routine" confirm:true explicitUserRequest:"..."',
      methodIds: scheduleMethods,
    },
    {
      id: 'delegated-subagents',
      label: 'Delegated subagents',
      status: 'ready',
      owner: 'agent',
      kind: 'delegated-agent',
      visible: true,
      cancellable: true,
      count: 0,
      current: 'Subagent and delegation routes are visible and cancellable; ordinary chat remains serial by default.',
      next: 'Use visible delegation only when isolation, parallelism, remote execution, or an explicit build/fix/review handoff helps the user.',
      inspectRoute: 'agent_harness mode:"agent_orchestration"',
      modelRoute: 'agent_harness mode:"agent_orchestration"',
      cancelRoute: 'agent { mode: "cancel", agentId: "..." }',
      createRoute: 'agent { mode: "spawn", task: "..." }',
      batchCreateRoute: 'agent { mode: "batch-spawn", tasks: [...] }',
    },
    {
      id: 'delivery-followups',
      label: 'Delivery follow-ups',
      status: readyChannels > 0 ? 'ready' : 'needs-setup',
      owner: 'agent-and-connected-host',
      kind: 'delivery',
      visible: true,
      cancellable: false,
      count: readyChannels,
      current: `${readyChannels}/${snapshot.channels.length} channel(s) ready; ${configuredTargets} configured default target(s).`,
      next: readyChannels > 0
        ? 'Use confirmed notification or channel send tools only after the user asks for delivery.'
        : 'Pair or configure a delivery channel before promising proactive follow-up.',
      inspectRoute: 'channels action:"status"',
      modelRoute: 'channels action:"status"',
      createRoute: 'workspace action:"run" actionId:"personal-ops-channels" confirm:true explicitUserRequest:"..."',
    },
  ];
  return items.sort((left, right) => statusRank(right.status) - statusRank(left.status) || left.label.localeCompare(right.label));
}

function nextActions(items: readonly AutonomyQueueItem[]): readonly string[] {
  return items
    .filter((item) => item.status === 'attention' || item.status === 'needs-setup' || item.status === 'active')
    .map((item) => `${item.label}: ${item.next}`)
    .slice(0, 5);
}

export function autonomyQueueCatalogStatus(context: CommandContext): Record<string, unknown> {
  const items = buildQueueItems(context);
  const counts = items.reduce<Record<AutonomyQueueStatus, number>>((acc, item) => {
    acc[item.status] += 1;
    return acc;
  }, { ready: 0, active: 0, 'needs-setup': 0, attention: 0, blocked: 0 });
  return {
    modes: ['autonomy_queue', 'autonomy_queue_item'],
    items: items.length,
    cancellable: items.filter((item) => item.cancellable).length,
    ...counts,
    readOnly: true,
  };
}

export function autonomyQueueSummary(context: CommandContext, args: AgentHarnessAutonomyQueueArgs): Record<string, unknown> {
  const includeParameters = args.includeParameters === true;
  const query = readString(args.query).toLowerCase();
  const limit = readLimit(args.limit, 100);
  const all = buildQueueItems(context);
  const filtered = all.filter((item) => !query || itemSearchText(item).includes(query));
  return {
    summary: {
      items: all.length,
      visible: all.filter((item) => item.visible).length,
      cancellable: all.filter((item) => item.cancellable).length,
      attention: all.filter((item) => item.status === 'attention').length,
      needsSetup: all.filter((item) => item.status === 'needs-setup').length,
      active: all.filter((item) => item.status === 'active').length,
      ready: all.filter((item) => item.status === 'ready').length,
    },
    queue: filtered.slice(0, limit).map((item) => describeItem(item, includeParameters)),
    returned: Math.min(filtered.length, limit),
    total: all.length,
    nextActions: nextActions(all),
    policy: 'Visible autonomy queue is read-only. Autonomous work must have a visible owner, status/progress route, inspect route, and cancellation or recovery route when the owning surface supports one.',
  };
}

export function describeAutonomyQueueItem(context: CommandContext, args: AgentHarnessAutonomyQueueArgs): AutonomyQueueResolution {
  const queueItemId = readString(args.queueItemId);
  const target = readString(args.target);
  const query = readString(args.query);
  const input = queueItemId || target || query;
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: 'autonomy action:"item" requires queueItemId, target, or query. Use action:"queue" to inspect queue item ids.',
    };
  }
  const normalized = input.toLowerCase();
  const items = buildQueueItems(context);
  const exact = items.find((item) => item.id === input);
  if (exact) return { status: 'found', item: describeItem(exact, true, { source: queueItemId ? 'queueItemId' : target ? 'target' : 'query', input, resolvedBy: 'id' }) };
  const insensitive = items.find((item) => item.id.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', item: describeItem(insensitive, true, { source: queueItemId ? 'queueItemId' : target ? 'target' : 'query', input, resolvedBy: 'case-insensitive-id' }) };
  const matches = items.filter((item) => itemSearchText(item).includes(normalized));
  if (matches.length === 1) return { status: 'found', item: describeItem(matches[0]!, true, { source: queueItemId ? 'queueItemId' : target ? 'target' : 'query', input, resolvedBy: 'search' }) };
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.slice(0, 8).map((item) => ({
        queueItemId: item.id,
        label: item.label,
        status: item.status,
        modelRoute: item.modelRoute,
      })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown autonomy queue item ${input}. Use autonomy action:"queue" to inspect queue item ids.`,
  };
}
