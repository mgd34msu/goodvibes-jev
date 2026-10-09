import { rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import type { Ranked } from '@goodvibes-jev/judgment';
import { laneById, liveRecordById, operationSummary, recordOperationSummary, workflowById, workflowExecutionPlan, workflowMissingFields } from './agent-harness-personal-ops-runner.ts';
import type { PersonalOpsConnectorSignal, PersonalOpsConnectorTool, PersonalOpsIntakeCandidate, PersonalOpsLane, PersonalOpsLiveRecord, PersonalOpsWorkflowStatus } from './agent-harness-personal-ops-types.ts';

/** Structural effect/capability scoping precedes canonical semantic ranking. */
export async function selectConnectorTool(
  lane: PersonalOpsLane,
  effect: PersonalOpsConnectorTool['effect'],
  capability: string,
  request: string,
  options: CatalogRankingOptions = {},
): Promise<{ readonly signal: PersonalOpsConnectorSignal; readonly tool: PersonalOpsConnectorTool; readonly judgment: Ranked } | undefined> {
  const candidates = (lane.connectorSignals ?? []).flatMap((signal) => {
    const tools = effect === 'read-only' ? signal.readTools ?? [] : signal.writeTools ?? [];
    return tools.filter((tool) => tool.capability === capability && tool.effect === effect)
      .map((tool) => ({ signal, tool }));
  });
  const ranked = await rankHarnessCatalog(candidates, request, ({ signal, tool }) => ({
    id: `${signal.id}:${tool.qualifiedName ?? tool.name}`,
    description: `${tool.description ?? tool.name}. Capability: ${tool.capability}. Effect: ${tool.effect}. Connector: ${signal.status}.`,
  }), 'agent.personal-ops.connector', options);
  // An uncertain match is not an operation selection. Readiness does not invent relevance.
  const selected = ranked.matches.find(({ judgment }) => judgment.reading.verdict === 'yes');
  return selected ? { ...selected.entry, judgment: selected.judgment } : undefined;
}

const INTAKE_ROUTES = [
  { id: 'inbox-draft-reply', description: 'Read an email conversation and draft a reply locally without sending it.' },
  { id: 'inbox-triage-briefing', description: 'Search and review inbox messages; summarize priorities and suggested next actions.' },
  { id: 'calendar-agenda-briefing', description: 'Read a calendar window and summarize upcoming appointments and meeting preparation.' },
  { id: 'calendar-conflict-scan', description: 'Read a calendar window to inspect availability, overlapping appointments and scheduling conflicts.' },
  { id: 'confirmed-reminder-request', description: 'Prepare one reminder for the user with an explicit title, time, cadence and delivery scope.' },
  { id: 'host-task-review', description: 'Inspect existing connected-host task execution state and running work.' },
  { id: 'visible-work-item', description: 'Create a local visible task or work-plan item to track work.' },
  { id: 'capture-scratchpad-note', description: 'Capture working context in a local scratchpad note, without promoting it to durable memory.' },
  { id: 'routine-review-or-promotion', description: 'Inspect, create or review a reusable routine or checklist before separately confirming a schedule.' },
  { id: 'delivery-channel-review', description: 'Inspect configured communication channels before sending a reviewed message to an explicit recipient.' },
] as const;

export function workflowCandidate(options: {
  readonly lane: PersonalOpsLane;
  readonly workflowId: string;
  readonly id: string;
  readonly label: string;
  readonly confidence: PersonalOpsIntakeCandidate['confidence'];
  readonly why: string;
  readonly operation?: { readonly signal: PersonalOpsConnectorSignal; readonly tool: PersonalOpsConnectorTool; readonly judgment?: Ranked };
  readonly followUpOperation?: { readonly signal: PersonalOpsConnectorSignal; readonly tool: PersonalOpsConnectorTool; readonly judgment?: Ranked };
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
    ...(operation ? { operation: { ...operationSummary(operation, options.operation?.signal, options.includeParameters), judgment: options.operation?.judgment } } : {}),
    ...(options.followUpOperation ? { followUpOperation: { ...operationSummary(options.followUpOperation.tool, options.followUpOperation.signal, options.includeParameters), judgment: options.followUpOperation.judgment } } : {}),
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

export async function buildPersonalOpsIntakeCandidates(
  request: string,
  lanes: readonly PersonalOpsLane[],
  includeParameters: boolean,
  options: CatalogRankingOptions = {},
): Promise<{ readonly candidates: readonly PersonalOpsIntakeCandidate[]; readonly judgments: readonly Ranked[] }> {
  const ranking = await rankHarnessCatalog(INTAKE_ROUTES, request, (route) => route, 'agent.personal-ops.intake', options);
  const selected = new Set(ranking.matches.map(({ entry }) => entry.id));
  const confirmed = new Set(ranking.matches.filter(({ judgment }) => judgment.reading.verdict === 'yes').map(({ entry }) => entry.id));
  const inboxLane = laneById(lanes, 'inbox');
  const calendarLane = laneById(lanes, 'calendar');
  const taskLane = laneById(lanes, 'tasks');
  const reminderLane = laneById(lanes, 'reminders');
  const routineLane = laneById(lanes, 'routines');
  const deliveryLane = laneById(lanes, 'delivery');
  const candidates: PersonalOpsIntakeCandidate[] = [];

  if (selected.has('inbox-draft-reply')) {
    const readTool = confirmed.has('inbox-draft-reply') ? await selectConnectorTool(inboxLane, 'read-only', 'inbox-read', `Read the selected email conversation to draft a reply. User request: ${request}`, options) : undefined;
    const writeTool = confirmed.has('inbox-draft-reply') ? await selectConnectorTool(inboxLane, 'confirmed-effect', 'inbox-write', `Send the reviewed reply only after separate confirmation. User request: ${request}`, options) : undefined;
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

  if (selected.has('inbox-triage-briefing')) {
    const readTool = confirmed.has('inbox-triage-briefing') ? await selectConnectorTool(inboxLane, 'read-only', 'inbox-read', `Search and list email messages for triage. User request: ${request}`, options) : undefined;
    const candidate = workflowCandidate({
      lane: inboxLane,
      workflowId: 'inbox-triage-briefing',
      id: 'inbox-triage-briefing',
      label: 'Triage inbox messages',
      confidence: 'high',
      why: 'The request asks for inbox, email, message, or thread triage.',
      operation: readTool,
      includeParameters,
      readOnlyNext: 'Run only a bounded read/list/search route, then summarize priorities, risks, and suggested next actions in chat.',
      mutationBoundary: 'Reply, send, label, archive, move, and delete actions require a separate explicit confirmation.',
    });
    if (candidate) candidates.push(candidate);
  }

  for (const workflowId of ['calendar-agenda-briefing', 'calendar-conflict-scan'] as const) {
    if (!selected.has(workflowId)) continue;
    const asksConflict = workflowId === 'calendar-conflict-scan';
    const readTool = confirmed.has(workflowId) ? await selectConnectorTool(calendarLane, 'read-only', 'calendar-read', `${asksConflict ? 'Inspect scheduling conflicts and availability' : 'Read upcoming agenda events'}. User request: ${request}`, options) : undefined;
    const writeTool = confirmed.has(workflowId) ? await selectConnectorTool(calendarLane, 'confirmed-effect', 'calendar-write', `Edit the selected calendar event only after separate confirmation. User request: ${request}`, options) : undefined;
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

  if (selected.has('confirmed-reminder-request')) {
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

  for (const routeId of ['host-task-review', 'visible-work-item'] as const) {
    if (!selected.has(routeId)) continue;
    const recordId = routeId === 'host-task-review' ? 'host-tasks-list' : 'workplan-add';
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

  if (selected.has('capture-scratchpad-note')) {
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

  if (selected.has('routine-review-or-promotion')) {
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

  if (selected.has('delivery-channel-review')) {
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

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const ordered = ranking.matches.flatMap(({ entry, judgment }) => {
    const candidate = byId.get(entry.id);
    return candidate ? [{ ...candidate,
      confidence: judgment.reading.verdict === 'yes' ? 'high' as const : 'low' as const,
      why: `Canonical engine.tools.registry-rank reading: ${judgment.reading.verdict}.`,
      judgment,
    }] : [];
  });
  options.signal?.throwIfAborted();
  return { candidates: ordered, judgments: ranking.judgments };
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
