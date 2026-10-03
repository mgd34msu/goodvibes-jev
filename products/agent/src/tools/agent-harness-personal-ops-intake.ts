import { previewHarnessText } from './agent-harness-text.ts';
import { hasAny } from './agent-harness-personal-ops-discovery.ts';
import { laneById, liveRecordById, operationSummary, recordOperationSummary, workflowById, workflowExecutionPlan, workflowMissingFields } from './agent-harness-personal-ops-runner.ts';
import type { PersonalOpsConnectorSignal, PersonalOpsConnectorTool, PersonalOpsIntakeCandidate, PersonalOpsLane, PersonalOpsLiveRecord, PersonalOpsWorkflowStatus } from './agent-harness-personal-ops-types.ts';

export function toolPreferenceScore(tool: PersonalOpsConnectorTool, preferredTokens: readonly string[]): number {
  const text = [tool.name, tool.description ?? '', tool.capability].join('\n').toLowerCase();
  const preferred = preferredTokens.findIndex((token) => text.includes(token));
  const preferredScore = preferred >= 0 ? 1_000 - preferred * 50 : 0;
  const schemaScore = tool.schemaRoute ? 100 : 0;
  const requiredFieldPenalty = (tool.requiredFields?.length ?? 0) * 5;
  return preferredScore + schemaScore - requiredFieldPenalty;
}

export function selectConnectorTool(
  lane: PersonalOpsLane,
  effect: PersonalOpsConnectorTool['effect'],
  capability: string,
  preferredTokens: readonly string[],
): { readonly signal: PersonalOpsConnectorSignal; readonly tool: PersonalOpsConnectorTool } | undefined {
  const candidates = (lane.connectorSignals ?? []).flatMap((signal) => {
    const tools = effect === 'read-only' ? signal.readTools ?? [] : signal.writeTools ?? [];
    return tools
      .filter((tool) => tool.capability === capability)
      .map((tool) => ({ signal, tool }));
  });
  return candidates
    .sort((left, right) => {
      const statusDelta = (right.signal.status === 'ready' ? 1 : 0) - (left.signal.status === 'ready' ? 1 : 0);
      if (statusDelta !== 0) return statusDelta;
      return toolPreferenceScore(right.tool, preferredTokens) - toolPreferenceScore(left.tool, preferredTokens)
        || left.tool.name.localeCompare(right.tool.name);
    })[0];
}

export function workflowCandidate(options: {
  readonly lane: PersonalOpsLane;
  readonly workflowId: string;
  readonly id: string;
  readonly label: string;
  readonly confidence: PersonalOpsIntakeCandidate['confidence'];
  readonly why: string;
  readonly operation?: { readonly signal: PersonalOpsConnectorSignal; readonly tool: PersonalOpsConnectorTool };
  readonly followUpOperation?: { readonly signal: PersonalOpsConnectorSignal; readonly tool: PersonalOpsConnectorTool };
  readonly includeParameters: boolean;
  readonly readOnlyNext: string;
  readonly mutationBoundary: string;
}): PersonalOpsIntakeCandidate | null {
  const workflow = workflowById(options.lane, options.workflowId);
  if (!workflow) return null;
  const operation = options.operation?.tool;
  const modelRoute = operation?.schemaRoute ?? workflow.modelRoute;
  const inspectRoutes = [
    ...(operation?.schemaRoute ? [operation.schemaRoute] : []),
    ...workflow.inspectRoutes,
  ];
  const missingFields = workflowMissingFields(options.lane, workflow, operation);
  const nextSteps = workflow.status === 'ready'
    ? [
      `Inspect ${operation?.schemaRoute ? 'the selected connector schema' : 'the exact route'} before using live personal data.`,
      options.readOnlyNext,
      options.mutationBoundary,
    ]
    : workflow.status === 'attention'
      ? [
        'Repair connector trust, connection, or schema freshness before using live personal data.',
        'Re-run this intake request after the connector reports ready.',
      ]
      : [
        `Set up a ${options.lane.id === 'inbox' ? 'mail' : options.lane.id} connector or daemon method first.`,
        'Re-run this intake request after setup so the route can bind to a concrete tool.',
      ];
  return {
    id: options.id,
    label: options.label,
    laneId: options.lane.id,
    workflowId: workflow.id,
    status: workflow.status,
    confidence: options.confidence,
    why: options.why,
    modelRoute,
    inspectRoutes: [...new Set(inspectRoutes)],
    requiresConfirmation: false,
    safetyBoundary: workflow.runBoundary,
    nextSteps,
    ...(operation ? { operation: operationSummary(operation, options.operation?.signal, options.includeParameters) } : {}),
    ...(options.followUpOperation ? { followUpOperation: operationSummary(options.followUpOperation.tool, options.followUpOperation.signal, options.includeParameters) } : {}),
    executionPlan: workflowExecutionPlan({
      lane: options.lane,
      workflow,
      operation: options.operation,
      followUpOperation: options.followUpOperation,
      includeParameters: options.includeParameters,
      readOnlyNext: options.readOnlyNext,
      mutationBoundary: options.mutationBoundary,
    }),
    ...(operation?.requiredFields && operation.requiredFields.length > 0 ? { requiredFields: operation.requiredFields } : {}),
    ...(missingFields && missingFields.length > 0 ? { missingFields } : {}),
    ...(workflow.status === 'needs-setup' ? { userQuestion: `Which ${options.lane.id === 'inbox' ? 'email' : options.lane.id} connector should GoodVibes use?` } : {}),
  };
}

export function recordStatusAsWorkflowStatus(status: string): PersonalOpsWorkflowStatus {
  if (status === 'ready') return 'ready';
  if (status === 'needs-setup') return 'needs-setup';
  return 'attention';
}

export function recordCandidate(options: {
  readonly lane: PersonalOpsLane;
  readonly recordId: string;
  readonly id: string;
  readonly label: string;
  readonly confidence: PersonalOpsIntakeCandidate['confidence'];
  readonly why: string;
  readonly includeParameters: boolean;
  readonly requiresConfirmation: boolean;
  readonly missingFields?: readonly string[];
  readonly userQuestion?: string;
  readonly nextSteps: readonly string[];
  readonly safetyBoundary: string;
}): PersonalOpsIntakeCandidate | null {
  const record = liveRecordById(options.lane, options.recordId);
  if (!record) return null;
  return {
    id: options.id,
    label: options.label,
    laneId: options.lane.id,
    status: recordStatusAsWorkflowStatus(record.status),
    confidence: options.confidence,
    why: options.why,
    modelRoute: record.modelRoute,
    inspectRoutes: [record.modelRoute, `personal_ops action:"lane" laneId:"${options.lane.id}"`],
    requiresConfirmation: options.requiresConfirmation,
    safetyBoundary: options.safetyBoundary,
    nextSteps: options.nextSteps,
    operation: recordOperationSummary(record, options.includeParameters),
    ...(record.requiredFields && record.requiredFields.length > 0 ? { requiredFields: record.requiredFields } : {}),
    ...(options.missingFields && options.missingFields.length > 0 ? { missingFields: options.missingFields } : {}),
    ...(options.userQuestion ? { userQuestion: options.userQuestion } : {}),
  };
}

export function setupCandidate(lane: PersonalOpsLane, request: string): PersonalOpsIntakeCandidate {
  return {
    id: 'personal-ops-map-first',
    label: 'Map Personal Ops readiness first',
    laneId: lane.id,
    status: lane.status === 'gap' || lane.status === 'needs-setup' ? 'needs-setup' : lane.status === 'ready' ? 'ready' : 'attention',
    confidence: 'low',
    why: `The request "${previewHarnessText(request, 80)}" does not clearly name one personal operation, so the safest next step is a readiness map.`,
    modelRoute: 'personal_ops action:"status"',
    inspectRoutes: ['personal_ops action:"status"'],
    requiresConfirmation: false,
    safetyBoundary: 'Readiness inspection is read-only; personal-data reads and all sends or mutations remain on their owning routes.',
    nextSteps: [
      'Inspect Personal Ops readiness.',
      'Choose one lane: inbox, calendar, notes, tasks, reminders, routines, or delivery.',
      'Re-run personal_ops action:"intake" with the specific user request.',
    ],
    missingFields: ['specific personal operation goal'],
    userQuestion: 'Should this be inbox, calendar, notes, tasks, reminders, routines, or delivery work?',
  };
}

export function candidatePriority(candidate: PersonalOpsIntakeCandidate): number {
  const confidence = candidate.confidence === 'high' ? 300 : candidate.confidence === 'medium' ? 200 : 100;
  const readiness = candidate.status === 'ready' ? 30 : candidate.status === 'attention' ? 15 : 0;
  return confidence + readiness;
}

export function buildPersonalOpsIntakeCandidates(
  request: string,
  lanes: readonly PersonalOpsLane[],
  includeParameters: boolean,
): readonly PersonalOpsIntakeCandidate[] {
  const lower = request.toLowerCase();
  const inboxLane = laneById(lanes, 'inbox');
  const calendarLane = laneById(lanes, 'calendar');
  const taskLane = laneById(lanes, 'tasks');
  const reminderLane = laneById(lanes, 'reminders');
  const routineLane = laneById(lanes, 'routines');
  const deliveryLane = laneById(lanes, 'delivery');
  const candidates: PersonalOpsIntakeCandidate[] = [];

  const asksInbox = hasAny(lower, ['inbox', 'email', 'mail', 'gmail', 'imap', 'message', 'thread']);
  const asksReply = hasAny(lower, ['draft', 'reply', 'respond', 'compose']);
  const asksCalendar = hasAny(lower, ['calendar', 'agenda', 'caldav', 'event', 'meeting', 'availability', 'freebusy', 'free busy']);
  const asksConflict = hasAny(lower, ['conflict', 'overlap', 'double-book', 'double booked', 'availability', 'freebusy', 'free busy']);
  const asksReminder = hasAny(lower, ['remind', 'reminder', 'follow up', 'follow-up', 'ping me', 'notify me']);
  const asksTask = hasAny(lower, ['task', 'todo', 'to-do', 'work item', 'work plan', 'host task']);
  const asksNote = hasAny(lower, ['note', 'scratchpad', 'capture', 'jot down']);
  const asksRoutine = hasAny(lower, ['routine', 'checklist', 'repeatable']);
  const asksDelivery = !asksReminder && hasAny(lower, ['deliver', 'send', 'channel', 'slack', 'discord', 'telegram', 'sms', 'notification']);

  if (asksInbox && asksReply) {
    const readTool = selectConnectorTool(inboxLane, 'read-only', 'inbox-read', ['get_thread', 'thread', 'read', 'message', 'fetch', 'get']);
    const writeTool = selectConnectorTool(inboxLane, 'confirmed-effect', 'inbox-write', ['send_reply', 'reply', 'draft', 'compose', 'send']);
    const candidate = workflowCandidate({
      lane: inboxLane,
      workflowId: 'inbox-draft-reply',
      id: 'inbox-draft-reply',
      label: 'Draft an inbox reply without sending',
      confidence: 'high',
      why: 'The request mentions drafting or replying to inbox content.',
      operation: readTool,
      followUpOperation: writeTool,
      includeParameters,
      readOnlyNext: 'Read the selected thread through the reviewed connector, then draft the reply in chat.',
      mutationBoundary: 'Sending, labeling, archiving, moving, or deleting remains a separate confirmed connector action.',
    });
    if (candidate) candidates.push(candidate);
  }

  if (asksInbox) {
    const readTool = selectConnectorTool(inboxLane, 'read-only', 'inbox-read', ['search', 'list', 'unread', 'query', 'find', 'messages', 'inbox']);
    const candidate = workflowCandidate({
      lane: inboxLane,
      workflowId: 'inbox-triage-briefing',
      id: 'inbox-triage-briefing',
      label: 'Triage inbox messages',
      confidence: asksReply ? 'medium' : 'high',
      why: 'The request asks for inbox, email, message, or thread triage.',
      operation: readTool,
      includeParameters,
      readOnlyNext: 'Run only a bounded read/list/search route, then summarize priorities, risks, and suggested next actions in chat.',
      mutationBoundary: 'Reply, send, label, archive, move, and delete actions require a separate explicit confirmation.',
    });
    if (candidate) candidates.push(candidate);
  }

  if (asksCalendar) {
    const workflowId = asksConflict ? 'calendar-conflict-scan' : 'calendar-agenda-briefing';
    const readTool = selectConnectorTool(calendarLane, 'read-only', 'calendar-read', asksConflict
      ? ['freebusy', 'availability', 'list', 'events', 'upcoming']
      : ['list', 'upcoming', 'agenda', 'events', 'search']);
    const writeTool = selectConnectorTool(calendarLane, 'confirmed-effect', 'calendar-write', ['create', 'update', 'reschedule', 'edit', 'delete']);
    const candidate = workflowCandidate({
      lane: calendarLane,
      workflowId,
      id: workflowId,
      label: asksConflict ? 'Scan calendar conflicts' : 'Brief calendar agenda',
      confidence: 'high',
      why: asksConflict ? 'The request asks about conflicts, overlap, or availability.' : 'The request asks for agenda, event, meeting, or calendar context.',
      operation: readTool,
      followUpOperation: writeTool,
      includeParameters,
      readOnlyNext: asksConflict
        ? 'Read a bounded calendar window and report overlaps, prep gaps, and reminder suggestions.'
        : 'Read a bounded calendar window and summarize agenda context, prep items, and risks.',
      mutationBoundary: 'Creating, editing, deleting, RSVP, or rescheduling events requires a separate explicit confirmation.',
    });
    if (candidate) candidates.push(candidate);
  }

  if (asksReminder) {
    const candidate = recordCandidate({
      lane: reminderLane,
      recordId: 'reminder-create',
      id: 'confirmed-reminder-request',
      label: 'Create one confirmed reminder',
      confidence: 'high',
      why: 'The request asks GoodVibes to remind, notify, ping, or follow up with the user.',
      includeParameters,
      requiresConfirmation: true,
      missingFields: ['title', 'scheduleKind', 'scheduleValue', 'explicitUserRequest'],
      userQuestion: 'What exact reminder title and time should GoodVibes use?',
      safetyBoundary: 'Reminder creation requires confirm:true and explicitUserRequest; vague follow-up ideas stay as notes or work-plan items.',
      nextSteps: [
        'Collect the reminder title, exact timing, timezone/cadence, and delivery scope.',
        'Inspect delivery channel readiness when the reminder must reach the user outside the terminal.',
        'Create exactly one reminder through the confirmed route.',
      ],
    });
    if (candidate) candidates.push(candidate);
  }

  if (asksTask) {
    const recordId = hasAny(lower, ['host task', 'running task', 'task status', 'inspect task']) ? 'host-tasks-list' : 'workplan-add';
    const candidate = recordCandidate({
      lane: taskLane,
      recordId,
      id: recordId === 'host-tasks-list' ? 'host-task-review' : 'visible-work-item',
      label: recordId === 'host-tasks-list' ? 'Review connected-host tasks' : 'Create a visible work item',
      confidence: 'high',
      why: recordId === 'host-tasks-list'
        ? 'The request asks about host task state.'
        : 'The request asks for task or work-plan tracking.',
      includeParameters,
      requiresConfirmation: false,
      missingFields: recordId === 'workplan-add' ? ['title'] : undefined,
      userQuestion: recordId === 'workplan-add' ? 'What short title should this visible work item use?' : undefined,
      safetyBoundary: 'Agent-owned work-plan edits stay local and visible; connected-host task controls require exact ids and confirmation.',
      nextSteps: recordId === 'host-tasks-list'
        ? ['List host tasks.', 'Inspect one exact host task id before considering retry or cancel.', 'Use confirmed host controls only when the user asks.']
        : ['Create a concise visible work-plan item.', 'Keep status changes visible as the work proceeds.', 'Use host tasks only when execution needs connected-host ownership.'],
    });
    if (candidate) candidates.push(candidate);
  }

  if (asksNote) {
    const candidate: PersonalOpsIntakeCandidate = {
      id: 'capture-scratchpad-note',
      label: 'Capture a scratchpad note',
      laneId: 'notes' as const,
      status: 'ready' as const,
      confidence: 'medium' as const,
      why: 'The request asks to capture or note working context.',
      modelRoute: 'agent_local_registry domain:"notes" action:"create"',
      inspectRoutes: ['personal_ops action:"lane" laneId:"notes"'],
      requiresConfirmation: false,
      safetyBoundary: 'Notes are Agent-local scratchpad records; promotion to memory or Knowledge stays separate and reviewed.',
      nextSteps: ['Create a scratchpad note with a short title and body.', 'Review or promote the note only when it proves useful.'],
      requiredFields: ['title', 'body'],
      missingFields: ['title', 'body'],
      userQuestion: 'What should the note say?',
    };
    candidates.push(candidate);
  }

  if (asksRoutine) {
    candidates.push({
      id: 'routine-review-or-promotion',
      label: 'Review routines before reuse',
      laneId: 'routines',
      status: routineLane.status === 'ready' ? 'ready' : routineLane.status === 'needs-setup' ? 'needs-setup' : 'attention',
      confidence: 'medium',
      why: 'The request asks about a routine, checklist, or repeatable workflow.',
      modelRoute: 'personal_ops action:"lane" laneId:"routines"',
      inspectRoutes: [
        'personal_ops action:"lane" laneId:"routines"',
        'workspace action:"actions" categoryId:"routines"',
      ],
      requiresConfirmation: true,
      safetyBoundary: 'Routine creation/review is Agent-local; schedule promotion requires explicit cadence and confirmation.',
      nextSteps: [
        'Inspect routine readiness and setup gaps.',
        'Create or review the routine locally.',
        'Promote to a connected schedule only after the user confirms cadence and delivery expectations.',
      ],
      missingFields: ['routineId or routine goal'],
      userQuestion: 'Which routine or repeatable workflow should GoodVibes use?',
    });
  }

  if (asksDelivery) {
    candidates.push({
      id: 'delivery-channel-review',
      label: 'Review delivery channels before sending',
      laneId: 'delivery',
      status: deliveryLane.status === 'ready' ? 'ready' : deliveryLane.status === 'needs-setup' ? 'needs-setup' : 'attention',
      confidence: 'medium',
      why: 'The request asks to deliver, send, notify, or use a communication channel.',
      modelRoute: 'channels action:"status"',
      inspectRoutes: [
        'personal_ops action:"lane" laneId:"delivery"',
        'channels action:"triage"',
        'channels action:"deliveries"',
      ],
      requiresConfirmation: true,
      safetyBoundary: 'External sends require an explicit target, reviewed message, and confirmed channel send route.',
      nextSteps: [
        'Inspect channel readiness and recent delivery receipts.',
        'Choose one configured target and message.',
        'Send only through agent_channel_send or the confirmed workspace send flow.',
      ],
      missingFields: ['channel target', 'reviewed message', 'explicitUserRequest'],
      userQuestion: 'Which configured channel target and reviewed message should GoodVibes send?',
    });
  }

  if (candidates.length === 0) candidates.push(setupCandidate(laneById(lanes, 'tasks'), request));
  return candidates
    .sort((left, right) => candidatePriority(right) - candidatePriority(left) || left.id.localeCompare(right.id));
}

export function nextActions(lanes: readonly PersonalOpsLane[]): readonly string[] {
  const urgent = lanes
    .filter((lane) => lane.status === 'gap' || lane.status === 'needs-setup')
    .map((lane) => `${lane.label}: ${lane.next}`);
  const partial = lanes
    .filter((lane) => lane.status === 'partial')
    .map((lane) => `${lane.label}: ${lane.next}`);
  return [...urgent, ...partial].slice(0, 5);
}
