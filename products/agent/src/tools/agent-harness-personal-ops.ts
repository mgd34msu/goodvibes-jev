import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { LANE_IDS, QUEUE_CAPABILITIES, type AgentHarnessPersonalOpsArgs, type McpToolSchema, type PersonalOpsBriefingStatus, type PersonalOpsLane, type PersonalOpsLaneId, type PersonalOpsLaneResolution, type PersonalOpsLiveRecord, type PersonalOpsReadRunResult, type PersonalOpsStatus, type PersonalOpsWorkflowStatus } from './agent-harness-personal-ops-types.ts';
import { mcpToolCaller, mcpToolRecords, mcpToolSchemas, readLimit, readString, toolsByServer } from './agent-harness-personal-ops-discovery.ts';
import { buildLanes } from './agent-harness-personal-ops-lanes.ts';
import { describeLane, laneStatusRank, searchText } from './agent-harness-personal-ops-records.ts';
import { boundedPersonalOpsResult, executionRouteForRecord, liveRecordSearchText, missingRequiredInputFields, personalOpsReadNextRoutes, personalOpsReadReviewRecords, readInputFields, readRunControlBoolean, readRunControlString, redactedPersonalOpsText, resolveRunRecord, savePersonalOpsReviewArtifact, summarizeRunRecord } from './agent-harness-personal-ops-runner.ts';
import { buildPersonalOpsIntakeCandidates, nextActions } from './agent-harness-personal-ops-intake.ts';

export function personalOpsCatalogStatus(context: CommandContext): Record<string, unknown> {
  const lanes = buildLanes(context);
  const workflows = lanes.flatMap((lane) => lane.workflows ?? []);
  const counts = lanes.reduce<Record<PersonalOpsStatus, number>>((acc, lane) => {
    acc[lane.status] += 1;
    return acc;
  }, { ready: 0, partial: 0, 'needs-setup': 0, gap: 0 });
  return {
    modes: ['personal_ops_briefing', 'personal_ops', 'personal_ops_queue', 'personal_ops_lane', 'personal_ops_intake', 'run_personal_ops_read'],
    lanes: lanes.length,
    ...counts,
    workflows: workflows.length,
    readyWorkflows: workflows.filter((workflow) => workflow.status === 'ready').length,
    attentionWorkflows: workflows.filter((workflow) => workflow.status === 'attention').length,
    setupWorkflows: workflows.filter((workflow) => workflow.status === 'needs-setup').length,
    bestReadyStatus: lanes.reduce((best, lane) => Math.max(best, laneStatusRank(lane.status)), 0),
  };
}

function briefingStatusForLane(lane: PersonalOpsLane): PersonalOpsBriefingStatus {
  if (lane.status === 'ready') return 'ready';
  if (lane.status === 'partial') return 'attention';
  return 'needs-setup';
}

function briefingStatusRank(status: PersonalOpsBriefingStatus): number {
  if (status === 'ready') return 3;
  if (status === 'attention') return 2;
  return 1;
}

function briefingStatusFromSteps(steps: readonly Record<string, unknown>[]): PersonalOpsBriefingStatus {
  const statuses = steps
    .map((step) => typeof step.status === 'string' ? step.status : '')
    .filter((status): status is PersonalOpsBriefingStatus => status === 'ready' || status === 'attention' || status === 'needs-setup');
  if (statuses.length === 0) return 'needs-setup';
  if (statuses.some((status) => status === 'needs-setup')) return statuses.some((status) => status !== 'needs-setup') ? 'attention' : 'needs-setup';
  return statuses.some((status) => status === 'attention') ? 'attention' : 'ready';
}

function recordCount(lane: PersonalOpsLane, predicate: (record: PersonalOpsLiveRecord) => boolean): number {
  return (lane.liveRecords ?? []).filter(predicate).length;
}

function isFreshProviderRecord(record: PersonalOpsLiveRecord): boolean {
  return record.freshness?.status === 'fresh-provider-route-ready'
    || record.freshness?.status === 'fresh-provider-record-current';
}

function workflowCount(lane: PersonalOpsLane, status: PersonalOpsWorkflowStatus): number {
  return (lane.workflows ?? []).filter((workflow) => workflow.status === status).length;
}

function briefingPurpose(lane: PersonalOpsLane): string {
  if (lane.id === 'inbox') return 'Find inbox items that need attention while keeping replies, labels, archive, and sends as separate confirmed effects.';
  if (lane.id === 'calendar') return 'Brief the agenda, conflicts, prep gaps, and reminder opportunities before any event edit or RSVP.';
  if (lane.id === 'tasks') return 'Make ongoing work visible through work plans and connected-host task inspection.';
  if (lane.id === 'reminders') return 'Capture follow-ups as confirmed reminders or schedules with an explicit delivery path.';
  if (lane.id === 'routines') return 'Reuse reviewed routines and only promote schedules when cadence and scope are explicit.';
  if (lane.id === 'delivery') return 'Check whether summaries, reminders, and follow-ups can reach the user through configured channels.';
  return 'Capture useful working context locally without promoting it to durable memory until reviewed.';
}

function briefingNext(lane: PersonalOpsLane): string {
  const freshProviderReads = recordCount(lane, isFreshProviderRecord);
  const refreshableSavedRecords = recordCount(lane, (record) => record.freshness?.status === 'saved-review-refreshable');
  const savedReviewRecords = recordCount(lane, (record) => record.freshness?.source === 'saved-review-artifact' || typeof record.reviewRecordCount === 'number');
  const attentionWorkflows = workflowCount(lane, 'attention');
  if ((lane.id === 'inbox' || lane.id === 'calendar') && freshProviderReads > 0) {
    return 'Inspect one current provider-backed record first; run a bounded refresh/read route only when the returned record exposes one and the user asks for live provider data.';
  }
  if ((lane.id === 'inbox' || lane.id === 'calendar') && refreshableSavedRecords > 0) {
    return 'Recap the saved redacted queue first; refresh a single record only through the returned confirmed read route.';
  }
  if ((lane.id === 'inbox' || lane.id === 'calendar') && savedReviewRecords > 0) {
    return 'Use saved redacted review records for today, then repair a provider connector before promising fresh queue state.';
  }
  if ((lane.id === 'inbox' || lane.id === 'calendar') && attentionWorkflows > 0) {
    return 'Repair connector trust, connection, or schema freshness before reading live personal data.';
  }
  return lane.next;
}

function briefingStepForLane(lane: PersonalOpsLane, includeParameters: boolean): Record<string, unknown> {
  const records = lane.liveRecords ?? [];
  const workflows = lane.workflows ?? [];
  const freshProviderReads = recordCount(lane, isFreshProviderRecord);
  const refreshableSavedRecords = recordCount(lane, (record) => record.freshness?.status === 'saved-review-refreshable');
  const savedReviewRecords = recordCount(lane, (record) => record.freshness?.source === 'saved-review-artifact' || typeof record.reviewRecordCount === 'number');
  const readOnlyRecords = recordCount(lane, (record) => record.effect === 'read-only');
  const confirmedEffectRecords = recordCount(lane, (record) => record.effect === 'confirmed-effect' || record.confirmationRequired === true);
  const laneRoute = `personal_ops action:"lane" laneId:"${lane.id}"`;
  const intakeRoute = `personal_ops action:"intake" query:"${lane.label.toLowerCase()} daily briefing"`;
  const workflowRoutes = workflows
    .map((workflow) => workflow.modelRoute)
    .filter((route, index, routes) => route && routes.indexOf(route) === index)
    .slice(0, includeParameters ? 4 : 2);
  const evidence = [
    ...lane.signals.slice(0, includeParameters ? 8 : 4),
    `${records.length} live/operation record(s)`,
    `${workflowCount(lane, 'ready')} ready workflow(s)`,
    `${workflowCount(lane, 'attention')} attention workflow(s)`,
    `${freshProviderReads} fresh provider read/record route(s)`,
    `${refreshableSavedRecords} refreshable saved review record(s)`,
    `${savedReviewRecords} saved review record(s)`,
  ];
  return {
    id: lane.id,
    label: lane.label,
    status: briefingStatusForLane(lane),
    purpose: briefingPurpose(lane),
    next: previewHarnessText(briefingNext(lane), includeParameters ? 220 : 140),
    modelRoute: laneRoute,
    inspectRoutes: [laneRoute, intakeRoute, ...workflowRoutes].slice(0, includeParameters ? 8 : 4),
    evidence,
    sourceCounts: {
      records: records.length,
      readOnlyRecords,
      confirmedEffectRecords,
      workflows: workflows.length,
      readyWorkflows: workflowCount(lane, 'ready'),
      attentionWorkflows: workflowCount(lane, 'attention'),
      freshProviderReads,
      refreshableSavedRecords,
      savedReviewRecords,
      connectorSignals: lane.connectorSignals?.length ?? 0,
    },
    confirmationBoundary: lane.id === 'inbox' || lane.id === 'calendar'
      ? 'Live provider reads stay bounded and selected; sends, labels, archives, moves, event edits, RSVP, and deletes require a separate confirmed route.'
      : 'Writes, sends, schedules, connected-host controls, and operator effects require an explicit user request and the owning confirmed tool.',
  };
}

function autonomyBriefingStep(): Record<string, unknown> {
  return {
    id: 'autonomy-queue',
    label: 'Autonomy Queue',
    status: 'ready' satisfies PersonalOpsBriefingStatus,
    purpose: 'Review visible ongoing work, owners, status, tails, receipts, and cancel or recovery routes before starting more autonomous work.',
    next: 'Inspect the autonomy queue and resolve running, blocked, or ownerless work before adding new background jobs.',
    modelRoute: 'autonomy action:"queue"',
    inspectRoutes: [
      'autonomy action:"queue"',
      'autonomy action:"intake" query:"daily operations follow-up"',
    ],
    evidence: [
      'Visible autonomy queue has a first-class harness mode',
      'Queue item inspection exposes cancel and recovery routes',
      'New ongoing work should enter through autonomy action:"intake" or a visible schedule/work-plan route',
    ],
    sourceCounts: {
      records: 0,
      workflows: 1,
      readyWorkflows: 1,
      attentionWorkflows: 0,
      freshProviderReads: 0,
      refreshableSavedRecords: 0,
      savedReviewRecords: 0,
      connectorSignals: 0,
    },
    confirmationBoundary: 'Starting, cancelling, retrying, scheduling, or mutating autonomous work remains a separate confirmed route.',
  };
}

export async function personalOpsBriefingSummary(context: CommandContext, args: AgentHarnessPersonalOpsArgs): Promise<Record<string, unknown>> {
  const includeParameters = args.includeParameters === true;
  const request = readString(args.query) || readString(args.target) || 'daily personal operations';
  const tools = await mcpToolRecords(context);
  const lanes = buildLanes(context, {
    toolsByServer: toolsByServer(tools),
    schemasByQualifiedName: includeParameters ? await mcpToolSchemas(context, tools) : new Map<string, McpToolSchema>(),
  });
  const orderedLaneIds: readonly PersonalOpsLaneId[] = ['inbox', 'calendar', 'tasks', 'reminders', 'routines', 'delivery', 'notes'];
  const allSteps = [
    ...orderedLaneIds
      .map((laneId) => lanes.find((lane) => lane.id === laneId))
      .filter((lane): lane is PersonalOpsLane => lane !== undefined)
      .map((lane) => briefingStepForLane(lane, includeParameters)),
    autonomyBriefingStep(),
  ];
  const limit = readLimit(args.limit, includeParameters ? 8 : 6);
  const steps = allSteps.slice(0, limit);
  const status = briefingStatusFromSteps(steps);
  const readiness = steps.reduce<Record<PersonalOpsBriefingStatus, number>>((acc, step) => {
    const stepStatus = typeof step.status === 'string' ? step.status : 'needs-setup';
    if (stepStatus === 'ready' || stepStatus === 'attention' || stepStatus === 'needs-setup') acc[stepStatus] += 1;
    return acc;
  }, { ready: 0, attention: 0, 'needs-setup': 0 });
  const liveRecords = lanes.flatMap((lane) => lane.liveRecords ?? []);
  const workflows = lanes.flatMap((lane) => lane.workflows ?? []);
  const missingContracts = lanes
    .filter((lane) => (lane.id === 'inbox' || lane.id === 'calendar') && lane.status !== 'ready')
    .map((lane) => `${lane.label}: fresh provider-backed queues need a ready connector or daemon record before GoodVibes can promise current live data.`);
  return {
    status,
    title: 'Daily Personal Ops briefing plan',
    request: previewHarnessText(request, includeParameters ? 220 : 120),
    generatedFrom: 'Current Agent-local workspace state, GoodVibes daemon contract metadata, MCP connector posture, saved review queues, and schema-derived Personal Ops records.',
    returned: steps.length,
    total: allSteps.length,
    steps,
    readiness,
    recommendedOrder: steps
      .slice()
      .sort((left, right) => briefingStatusRank((right.status as PersonalOpsBriefingStatus) ?? 'needs-setup') - briefingStatusRank((left.status as PersonalOpsBriefingStatus) ?? 'needs-setup'))
      .map((step) => step.id),
    sourceSummary: {
      lanes: lanes.length,
      liveRecords: liveRecords.length,
      workflows: workflows.length,
      readyWorkflows: workflows.filter((workflow) => workflow.status === 'ready').length,
      attentionWorkflows: workflows.filter((workflow) => workflow.status === 'attention').length,
      freshProviderReads: liveRecords.filter(isFreshProviderRecord).length,
      refreshableSavedRecords: liveRecords.filter((record) => record.freshness?.status === 'saved-review-refreshable').length,
      savedReviewRecords: liveRecords.filter((record) => record.freshness?.source === 'saved-review-artifact' || typeof record.reviewRecordCount === 'number').length,
      connectorSignals: lanes.reduce((sum, lane) => sum + (lane.connectorSignals?.length ?? 0), 0),
    },
    routes: {
      personalOps: 'personal_ops action:"status"',
      intake: 'personal_ops action:"intake" query:"..."',
      laneTemplate: 'personal_ops action:"lane" laneId:"inbox|calendar|notes|tasks|reminders|routines|delivery"',
      liveReadTemplate: 'personal_ops action:"read" laneId:"inbox|calendar" recordId:"..." fields:{...} confirm:true explicitUserRequest:"..."',
      autonomyQueue: 'autonomy action:"queue"',
      workspace: 'workspace action:"actions" categoryId:"personal-ops"',
    },
    nextActions: [
      'Start with ready steps, then resolve attention or setup steps before promising live provider state.',
      'Use saved redacted inbox/calendar review queues for recap when fresh connectors are not ready.',
      'Run exactly one live personal-data read at a time through personal_ops action:"read", then summarize before any follow-up effect.',
      ...nextActions(lanes).slice(0, 3),
    ].slice(0, includeParameters ? 8 : 5),
    missingContracts,
    policy: 'This briefing is read-only. It plans the user-facing daily operations flow across Personal Ops lanes and the autonomy queue; live personal-data reads, sends, edits, schedule creation, connected-host controls, and external delivery remain separate explicit confirmed actions.',
  };
}

export async function personalOpsSummary(context: CommandContext, args: AgentHarnessPersonalOpsArgs): Promise<Record<string, unknown>> {
  const includeParameters = args.includeParameters === true;
  const tools = includeParameters ? await mcpToolRecords(context) : [];
  const schemasByQualifiedName = includeParameters ? await mcpToolSchemas(context, tools) : new Map<string, McpToolSchema>();
  const lanes = buildLanes(context, {
    toolsByServer: toolsByServer(tools),
    schemasByQualifiedName,
  });
  const workflows = lanes.flatMap((lane) => lane.workflows ?? []);
  return {
    lanes: lanes.map((lane) => describeLane(lane, includeParameters)),
    returned: lanes.length,
    total: lanes.length,
    workflowSummary: {
      workflows: workflows.length,
      ready: workflows.filter((workflow) => workflow.status === 'ready').length,
      attention: workflows.filter((workflow) => workflow.status === 'attention').length,
      needsSetup: workflows.filter((workflow) => workflow.status === 'needs-setup').length,
    },
    policy: 'Personal Ops unifies inbox, agenda, notes, tasks, reminders, routines, and delivery. Lanes include live records when Agent owns them, daemon/SDK provider read-model queue records when published, and schema-derived connector operation records when MCP schemas are available. Missing email/calendar connectors, messages, and events are reported as setup/data gaps, not faked.',
    nextActions: nextActions(lanes),
  };
}

function queueRecordType(record: PersonalOpsLiveRecord): string {
  if (record.capability === 'inbox-thread-review') return 'saved-inbox-thread';
  if (record.capability === 'calendar-event-review') return 'saved-calendar-event';
  if (record.capability === 'inbox-review-artifact') return 'saved-inbox-review';
  if (record.capability === 'calendar-review-artifact') return 'saved-calendar-review';
  if (record.freshness?.status === 'fresh-provider-record-current') return 'fresh-provider-record';
  if (record.freshness?.status === 'fresh-provider-route-ready') return 'fresh-provider-read';
  if (record.freshness?.status === 'connector-attention') return 'provider-read-attention';
  return record.capability ?? 'personal-ops-record';
}

function queueStatusRank(record: PersonalOpsLiveRecord): number {
  if (record.freshness?.status === 'saved-review-refreshable') return 100;
  if (record.capability === 'inbox-thread-review' || record.capability === 'calendar-event-review') return 90;
  if (record.freshness?.status === 'fresh-provider-route-ready' || record.freshness?.status === 'fresh-provider-record-current') return 80;
  if (record.capability === 'inbox-review-artifact' || record.capability === 'calendar-review-artifact') return 70;
  if (record.freshness?.status === 'connector-attention') return 50;
  if (record.freshness?.status === 'provider-contract-missing') return 35;
  if (record.freshness?.status === 'source-tool-missing') return 25;
  return 10;
}

function isPersonalOpsQueueRecord(record: PersonalOpsLiveRecord): boolean {
  if (record.freshness?.source === 'saved-review-artifact') return true;
  if (isFreshProviderRecord(record) || record.freshness?.status === 'connector-attention') return true;
  return record.capability ? QUEUE_CAPABILITIES.has(record.capability) : false;
}

function describeQueueItem(lane: PersonalOpsLane, record: PersonalOpsLiveRecord, includeParameters: boolean): Record<string, unknown> {
  const refreshRoute = record.freshness?.refreshRoute;
  const followUpRoutes = (record.followUpRoutes ?? []).slice(0, includeParameters ? 8 : 3);
  return {
    queueItemId: `${lane.id}:${record.id}`,
    laneId: lane.id,
    laneLabel: lane.label,
    type: queueRecordType(record),
    label: record.label,
    status: record.status,
    summary: previewHarnessText(record.summary, includeParameters ? 220 : 120),
    modelRoute: previewHarnessText(record.modelRoute, includeParameters ? 180 : 120),
    inspectRoute: record.modelRoute,
    effect: record.effect ?? 'read-only',
    capability: record.capability,
    confirmationRequired: Boolean(record.confirmationRequired),
    ...(record.freshness ? {
      freshness: {
        status: record.freshness.status,
        source: record.freshness.source,
        ...(record.freshness.sourceTool ? { sourceTool: record.freshness.sourceTool } : {}),
        ...(record.freshness.lastReviewedAt ? { lastReviewedAt: record.freshness.lastReviewedAt } : {}),
        ...(refreshRoute ? { refreshRoute, refreshRequiresConfirmation: true } : {}),
        policy: previewHarnessText(record.freshness.policy, includeParameters ? 220 : 120),
      },
    } : {}),
    routes: {
      lane: `personal_ops action:"lane" laneId:"${lane.id}"`,
      inspect: record.modelRoute,
      ...(refreshRoute ? { refresh: refreshRoute } : {}),
      ...(record.artifactId ? { artifact: `agent_artifacts show artifactId:"${record.artifactId}" includeContent:true` } : {}),
    },
    followUpRoutes,
    ...(includeParameters && record.certification ? { certification: record.certification } : {}),
    ...(includeParameters && record.tags && record.tags.length > 0 ? { tags: record.tags } : {}),
    ...(includeParameters && record.requiredFields ? { requiredFields: record.requiredFields } : {}),
    ...(includeParameters && record.sampleInput ? { sampleInput: record.sampleInput } : {}),
    ...(includeParameters && record.artifactId ? { artifactId: record.artifactId } : {}),
    ...(includeParameters && record.reviewLabels ? { reviewLabels: record.reviewLabels } : {}),
    ...(includeParameters && record.sourceTool ? { sourceTool: record.sourceTool } : {}),
  };
}

function queueSearchText(item: { readonly lane: PersonalOpsLane; readonly record: PersonalOpsLiveRecord }): string {
  return [
    item.lane.id,
    item.lane.label,
    liveRecordSearchText(item.record),
  ].join('\n').toLowerCase();
}

export async function personalOpsQueueSummary(context: CommandContext, args: AgentHarnessPersonalOpsArgs): Promise<Record<string, unknown>> {
  const includeParameters = args.includeParameters === true;
  const query = readString(args.query) || readString(args.target);
  const tools = await mcpToolRecords(context);
  const lanes = buildLanes(context, {
    toolsByServer: toolsByServer(tools),
    schemasByQualifiedName: includeParameters ? await mcpToolSchemas(context, tools) : new Map<string, McpToolSchema>(),
  });
  const queueLanes = lanes.filter((lane) => lane.id === 'inbox' || lane.id === 'calendar');
  const allItems = queueLanes
    .flatMap((lane) => (lane.liveRecords ?? [])
      .filter(isPersonalOpsQueueRecord)
      .map((record) => ({ lane, record })))
    .filter((item) => !query || queueSearchText(item).includes(query.toLowerCase()))
    .sort((left, right) => queueStatusRank(right.record) - queueStatusRank(left.record) || left.lane.id.localeCompare(right.lane.id) || left.record.label.localeCompare(right.record.label));
  const limit = readLimit(args.limit, includeParameters ? 20 : 8);
  const items = allItems.slice(0, limit).map((item) => describeQueueItem(item.lane, item.record, includeParameters));
  const readRecords = allItems.filter((item) => item.record.effect === 'read-only');
  const confirmedFollowUps = allItems.reduce((total, item) => total + (item.record.followUpRoutes ?? []).filter((route) => route.requiresConfirmation).length, 0);
  const freshProviderReads = allItems.filter((item) => isFreshProviderRecord(item.record)).length;
  const refreshableSavedRecords = allItems.filter((item) => item.record.freshness?.status === 'saved-review-refreshable').length;
  const savedReviewRecords = allItems.filter((item) => item.record.freshness?.source === 'saved-review-artifact' || typeof item.record.reviewRecordCount === 'number').length;
  const attentionRecords = allItems.filter((item) => item.record.freshness?.status === 'connector-attention' || item.lane.status === 'gap' || item.lane.status === 'needs-setup').length;
  return {
    status: allItems.length > 0 ? attentionRecords > 0 ? 'attention' : 'ready' : 'empty',
    queue: items,
    returned: items.length,
    total: allItems.length,
    summary: {
      inbox: allItems.filter((item) => item.lane.id === 'inbox').length,
      calendar: allItems.filter((item) => item.lane.id === 'calendar').length,
      readOnlyRecords: readRecords.length,
      freshProviderReads,
      refreshableSavedRecords,
      savedReviewRecords,
      attentionRecords,
      confirmedFollowUps,
    },
    routes: {
      status: 'personal_ops action:"status"',
      briefing: 'personal_ops action:"briefing"',
      intake: 'personal_ops action:"intake" query:"..."',
      inboxLane: 'personal_ops action:"lane" laneId:"inbox"',
      calendarLane: 'personal_ops action:"lane" laneId:"calendar"',
      liveReadTemplate: 'personal_ops action:"read" laneId:"inbox|calendar" recordId:"..." fields:{...} confirm:true explicitUserRequest:"..."',
    },
    nextActions: allItems.length > 0
      ? [
        refreshableSavedRecords > 0 ? 'Refresh one saved queue item only through its returned confirmed read route when the user asks for current provider state.' : '',
        freshProviderReads > 0 ? 'Inspect one current provider-backed queue record at a time; run a refresh route only when the record publishes one and the user asks.' : '',
        'Use saved redacted queue artifacts for recap or local drafts before any external send, label, archive, edit, RSVP, or delete.',
      ].filter(Boolean).slice(0, includeParameters ? 5 : 3)
      : [
        'Run personal_ops action:"intake" for the user request to find a safe connector route.',
        'Set up an inbox or calendar connector before promising fresh queue state.',
      ],
    policy: 'Personal Ops queue is read-only. It aggregates existing saved review artifacts, connector read-route records, and daemon/SDK provider read-model records; it does not execute MCP tools, read live provider data beyond already-published read models, send messages, edit calendar events, create reminders, or mutate artifacts.',
  };
}

export async function personalOpsIntakeSummary(context: CommandContext, args: AgentHarnessPersonalOpsArgs): Promise<Record<string, unknown>> {
  const request = readString(args.query) || readString(args.target);
  if (!request) {
    return {
      status: 'missing_request',
      usage: 'Use personal_ops action:"intake" with query:"<personal operations request>". This action is read-only and returns the safest lane, route, missing fields, and confirmation boundary.',
      examples: [
        'Triage my unread inbox.',
        'Draft a reply to this email thread.',
        'Brief my calendar for today.',
        'Remind me tomorrow at 9am to send the report.',
      ],
      personalOpsRoute: 'personal_ops action:"status"',
    };
  }
  const includeParameters = args.includeParameters === true;
  const tools = await mcpToolRecords(context);
  const lanes = buildLanes(context, {
    toolsByServer: toolsByServer(tools),
    schemasByQualifiedName: await mcpToolSchemas(context, tools),
  });
  const limit = readLimit(args.limit, includeParameters ? 8 : 4);
  const candidates = buildPersonalOpsIntakeCandidates(request, lanes, includeParameters).slice(0, limit);
  const preferred = candidates[0]!;
  return {
    status: 'ready',
    request: previewHarnessText(request, includeParameters ? 220 : 120),
    preferred,
    candidates,
    personalOpsRoute: 'personal_ops action:"status"',
    laneRoute: `personal_ops action:"lane" laneId:"${preferred.laneId}"`,
    policy: 'Personal Ops intake is read-only. It chooses the safest visible lane and route; live personal-data reads must use reviewed connector or daemon routes, and every send, edit, schedule, or external effect still requires explicit confirmation.',
  };
}

export async function runPersonalOpsRead(context: CommandContext, args: AgentHarnessPersonalOpsArgs): Promise<PersonalOpsReadRunResult> {
  const includeParameters = args.includeParameters === true;
  const tools = await mcpToolRecords(context);
  const lanes = buildLanes(context, {
    toolsByServer: toolsByServer(tools),
    schemasByQualifiedName: await mcpToolSchemas(context, tools),
  });
  const resolved = resolveRunRecord(lanes, {
    laneId: readString(args.laneId),
    recordId: readString(args.recordId),
    target: readString(args.target),
    query: readString(args.query),
  });
  if (!resolved) {
    return {
      status: 'missing_lookup',
      usage: 'personal_ops action:"read" requires laneId plus recordId, target, or query for one read-only inbox/calendar connector operation.',
      examples: [
        'personal_ops action:"intake" query:"Triage my unread email." includeParameters:true',
        'personal_ops action:"read" laneId:"inbox" recordId:"mcp:gmail-inbox:gmail.search_messages" fields:{"query":"is:unread newer_than:7d"} confirm:true explicitUserRequest:"Triage my unread inbox."',
      ],
    };
  }
  if (!('lane' in resolved)) return resolved;

  const { lane, record } = resolved;
  const runRoute = executionRouteForRecord(record, lane.id);
  const fields = readInputFields(args.fields, record.sampleInput);
  const recordSummary = summarizeRunRecord(record, lane, includeParameters);

  if (record.status !== 'ready') {
    return {
      status: 'blocked',
      reason: 'connector_not_ready',
      record: recordSummary,
      next: 'Repair connector trust, connection, or schema freshness before reading live personal data.',
      inspectRoutes: [record.modelRoute, `personal_ops action:"lane" laneId:"${lane.id}"`],
      policy: 'Personal Ops never reads personal provider data from attention or setup-needed connectors.',
    };
  }
  if (record.effect !== 'read-only') {
    return {
      status: 'blocked',
      reason: 'not_read_only',
      record: recordSummary,
      next: 'Use the returned confirmed-effect route only after the user reviews the intended provider mutation.',
      policy: 'personal_ops action:"read" refuses send, edit, label, archive, delete, move, create, RSVP, and reschedule operations.',
    };
  }
  if (!record.qualifiedName) {
    return {
      status: 'blocked',
      reason: 'missing_qualified_tool',
      record: recordSummary,
      next: 'Inspect the connector schema or lane operation records until a qualified MCP tool name is available.',
    };
  }
  const missingFields = missingRequiredInputFields(record, fields);
  if (missingFields.length > 0) {
    return {
      status: 'missing_fields',
      record: recordSummary,
      missingFields,
      sampleInput: record.sampleInput ?? {},
      runRoute,
      policy: 'Required fields must be supplied by the user or an explicit intake plan; placeholder sample values are never executed silently.',
    };
  }
  if (!readString(args.explicitUserRequest) || args.confirm !== true) {
    return {
      status: 'needs_confirmation',
      record: recordSummary,
      inputPreview: fields,
      runRoute,
      policy: 'Reading live personal inbox/calendar data requires confirm:true and explicitUserRequest. Write-like provider effects are not supported by this route.',
    };
  }
  const callTool = mcpToolCaller(context);
  if (!callTool) {
    return {
      status: 'unavailable',
      reason: 'mcp_call_tool_unavailable',
      record: recordSummary,
      next: 'Use MCP tool discovery and connector setup until the runtime publishes callTool for this Agent session.',
    };
  }

  try {
    const result = await callTool(record.qualifiedName, fields);
    const reviewRecords = personalOpsReadReviewRecords(lane, record, result, includeParameters);
    const output = boundedPersonalOpsResult(result, includeParameters);
    const saveRequested = readRunControlBoolean(args.fields, ['saveReviewCards', 'saveReview']);
    const savedReviewArtifact = saveRequested
      ? await savePersonalOpsReviewArtifact({
        context,
        lane,
        sourceRecord: record,
        inputFields: fields,
        reviewRecords,
        output,
        title: readRunControlString(args.fields, 'artifactTitle'),
      })
      : null;
    const nextRoutes = personalOpsReadNextRoutes({ lane, runRoute, savedReviewArtifact });
    return {
      status: 'executed',
      record: recordSummary,
      input: fields,
      output,
      reviewSummary: {
        kind: lane.id === 'calendar' ? 'calendar' : 'inbox',
        records: reviewRecords.length,
        source: record.qualifiedName,
      },
      reviewRecords,
      ...(savedReviewArtifact ? { savedReviewArtifact } : {}),
      nextRoutes,
      followUp: [
        'Summarize or draft only in the Agent transcript.',
        'Ask for explicit confirmation before any send, label, archive, delete, calendar edit, RSVP, or reschedule route.',
      ],
      policy: 'This route executed one selected read-only MCP connector tool and returned bounded, redacted output for review.',
    };
  } catch (error) {
    return {
      status: 'failed',
      record: recordSummary,
      input: fields,
      error: previewHarnessText(redactedPersonalOpsText(summarizeError(error)), 320),
      policy: 'Connector failures are reported as reviewable errors; no fallback personal data is fabricated.',
    };
  }
}

export async function describePersonalOpsLane(context: CommandContext, args: AgentHarnessPersonalOpsArgs): Promise<PersonalOpsLaneResolution> {
  const laneId = readString(args.laneId);
  const target = readString(args.target);
  const query = readString(args.query);
  const input = laneId || target || query;
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: `personal_ops action:"lane" requires laneId, target, or query. Lane ids: ${LANE_IDS.join(', ')}.`,
    };
  }
  const normalized = input.toLowerCase();
  const tools = await mcpToolRecords(context);
  const lanes = buildLanes(context, { toolsByServer: toolsByServer(tools), schemasByQualifiedName: await mcpToolSchemas(context, tools) });
  const exact = lanes.find((lane) => lane.id === normalized);
  if (exact) return { status: 'found', lane: describeLane(exact, true) };
  const matches = lanes.filter((lane) => searchText(lane).includes(normalized));
  if (matches.length === 1) return { status: 'found', lane: describeLane(matches[0]!, true) };
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.map((lane) => ({
        laneId: lane.id,
        label: lane.label,
        status: lane.status,
        modelRoute: lane.modelRoute,
      })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown Personal Ops lane ${input}. Lane ids: ${LANE_IDS.join(', ')}.`,
  };
}
