import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { PERSONAL_OPS_READ_CONTROL_FIELDS, type PersonalOpsConnectorSignal, type PersonalOpsConnectorTool, type PersonalOpsExecutionStep, type PersonalOpsIntakeCandidate, type PersonalOpsLane, type PersonalOpsLaneId, type PersonalOpsLiveRecord, type PersonalOpsReadRunResult, type PersonalOpsRoutePacket, type PersonalOpsWorkflow, type PersonalOpsWorkflowStatus } from './agent-harness-personal-ops-types.ts';

export function laneById(lanes: readonly PersonalOpsLane[], laneId: PersonalOpsLaneId): PersonalOpsLane {
  return lanes.find((lane) => lane.id === laneId)!;
}

export function workflowById(lane: PersonalOpsLane, workflowId: string): PersonalOpsWorkflow | null {
  return lane.workflows?.find((workflow) => workflow.id === workflowId) ?? null;
}

export function liveRecordById(lane: PersonalOpsLane, recordId: string): PersonalOpsLiveRecord | null {
  return lane.liveRecords?.find((record) => record.id === recordId) ?? null;
}

export function liveRecordSearchText(record: PersonalOpsLiveRecord): string {
  return [
    record.id,
    record.label,
    record.status,
    record.summary,
    record.modelRoute,
    record.qualifiedName ?? '',
    record.capability ?? '',
    record.artifactId ?? '',
    record.reviewLabels?.join('\n') ?? '',
    record.sourceTool ?? '',
    record.followUpRoutes?.map((route) => `${route.id} ${route.label} ${route.effect} ${route.modelRoute} ${route.policy}`).join('\n') ?? '',
    record.tags?.join('\n') ?? '',
  ].join('\n').toLowerCase();
}

export function workflowMissingFields(lane: PersonalOpsLane, workflow: PersonalOpsWorkflow, operation?: PersonalOpsConnectorTool): readonly string[] | undefined {
  if (workflow.status === 'needs-setup') return [`configured ${lane.id === 'inbox' ? 'email' : lane.id} connector or daemon method`];
  if (workflow.status === 'attention') return ['connector trust/schema freshness'];
  if (operation?.requiredFields && operation.requiredFields.length > 0) return operation.requiredFields;
  return undefined;
}

export function operationSummary(
  tool: PersonalOpsConnectorTool | undefined,
  signal: PersonalOpsConnectorSignal | undefined,
  includeParameters: boolean,
): Record<string, unknown> | undefined {
  if (!tool) return undefined;
  return {
    name: tool.name,
    effect: tool.effect,
    capability: tool.capability,
    ...(tool.qualifiedName ? { qualifiedName: tool.qualifiedName } : {}),
    ...(signal ? { connectorId: signal.id, connectorStatus: signal.status } : {}),
    ...(tool.schemaRoute ? { schemaRoute: tool.schemaRoute } : {}),
    ...(includeParameters && tool.requiredFields ? { requiredFields: tool.requiredFields } : {}),
    ...(includeParameters && tool.optionalFields ? { optionalFields: tool.optionalFields.slice(0, 12) } : {}),
    ...(includeParameters && tool.sampleInput ? { sampleInput: tool.sampleInput } : {}),
    ...(tool.effect === 'confirmed-effect' ? { confirmationRequired: true } : { confirmationRequired: false }),
  };
}

export function toolModelRoute(tool: PersonalOpsConnectorTool | undefined): string {
  if (!tool) return 'personal_ops action:"status"';
  return tool.schemaRoute ?? `agent_harness mode:"mcp_servers" query:"${tool.qualifiedName ?? tool.name}"`;
}

export function connectorStep(options: {
  readonly id: string;
  readonly label: string;
  readonly routeKind: PersonalOpsExecutionStep['routeKind'];
  readonly status: PersonalOpsWorkflowStatus;
  readonly tool: PersonalOpsConnectorTool;
  readonly signal?: PersonalOpsConnectorSignal;
  readonly includeParameters: boolean;
  readonly policy: string;
}): PersonalOpsExecutionStep {
  return {
    id: options.id,
    label: options.label,
    routeKind: options.routeKind,
    effect: options.tool.effect,
    requiresConfirmation: options.tool.effect === 'confirmed-effect',
    modelRoute: toolModelRoute(options.tool),
    status: options.status,
    policy: options.policy,
    ...(options.signal ? { connectorId: options.signal.id, connectorStatus: options.signal.status } : {}),
    ...(options.tool.qualifiedName ? { qualifiedName: options.tool.qualifiedName } : {}),
    ...(options.tool.schemaRoute ? { schemaRoute: options.tool.schemaRoute } : {}),
    ...(options.includeParameters && options.tool.requiredFields ? { requiredFields: options.tool.requiredFields } : {}),
    ...(options.includeParameters && options.tool.sampleInput ? { sampleInput: options.tool.sampleInput } : {}),
  };
}

export function workflowExecutionPlan(options: {
  readonly lane: PersonalOpsLane;
  readonly workflow: PersonalOpsWorkflow;
  readonly operation?: { readonly signal: PersonalOpsConnectorSignal; readonly tool: PersonalOpsConnectorTool };
  readonly followUpOperation?: { readonly signal: PersonalOpsConnectorSignal; readonly tool: PersonalOpsConnectorTool };
  readonly includeParameters: boolean;
  readonly readOnlyNext: string;
  readonly mutationBoundary: string;
}): readonly PersonalOpsExecutionStep[] {
  if (options.workflow.status === 'needs-setup') {
    return [{
      id: 'setup-connector',
      label: `Set up a ${options.lane.id === 'inbox' ? 'mail' : options.lane.id} connector`,
      routeKind: 'setup',
      effect: 'setup',
      requiresConfirmation: false,
      modelRoute: options.workflow.modelRoute,
      status: 'needs-setup',
      policy: 'Do not read personal data or create effects until a connector or daemon method is configured and reviewed.',
    }];
  }
  if (options.workflow.status === 'attention') {
    return [{
      id: 'repair-connector-readiness',
      label: 'Repair connector trust or schema freshness',
      routeKind: 'setup',
      effect: 'setup',
      requiresConfirmation: false,
      modelRoute: options.operation?.signal.modelRoute ?? options.workflow.modelRoute,
      status: 'attention',
      policy: 'Review connector trust, connection, and schema freshness before using live personal data.',
    }];
  }

  const steps: PersonalOpsExecutionStep[] = [];
  if (options.operation) {
    steps.push(connectorStep({
      id: 'read-live-context',
      label: options.readOnlyNext,
      routeKind: 'connector-read',
      status: options.workflow.status,
      tool: options.operation.tool,
      signal: options.operation.signal,
      includeParameters: options.includeParameters,
      policy: 'Run only the selected bounded read route, then summarize or draft in the Agent transcript without mutating the provider.',
    }));
  } else {
    steps.push({
      id: 'inspect-read-route',
      label: 'Inspect the exact read route before using live personal data.',
      routeKind: 'setup',
      effect: 'setup',
      requiresConfirmation: false,
      modelRoute: options.workflow.modelRoute,
      status: options.workflow.status,
      policy: 'No concrete connector tool is selected yet; inspect the lane before using personal data.',
    });
  }

  steps.push({
    id: 'compose-local-result',
    label: options.lane.id === 'calendar' ? 'Summarize agenda or conflict findings locally.' : 'Summarize or draft locally without sending.',
    routeKind: 'local-compose',
    effect: 'local-only',
    requiresConfirmation: false,
    modelRoute: 'main Agent response',
    status: options.workflow.status,
    policy: 'Local composition does not send, edit, archive, label, or write provider records.',
  });

  if (options.followUpOperation) {
    steps.push(connectorStep({
      id: 'confirmed-follow-up-effect',
      label: options.mutationBoundary,
      routeKind: 'connector-confirmed-effect',
      status: options.workflow.status,
      tool: options.followUpOperation.tool,
      signal: options.followUpOperation.signal,
      includeParameters: options.includeParameters,
      policy: 'Only run this follow-up after the user reviews the draft/change and explicitly confirms the exact provider effect.',
    }));
  }
  return steps;
}

export function recordOperationSummary(record: PersonalOpsLiveRecord | null, includeParameters: boolean): Record<string, unknown> | undefined {
  if (!record) return undefined;
  return {
    id: record.id,
    label: record.label,
    status: record.status,
    modelRoute: record.modelRoute,
    effect: record.effect ?? 'read-only',
    capability: record.capability,
    ...(includeParameters && record.requiredFields ? { requiredFields: record.requiredFields } : {}),
    ...(includeParameters && record.optionalFields ? { optionalFields: record.optionalFields.slice(0, 12) } : {}),
    ...(includeParameters && record.sampleInput ? { sampleInput: record.sampleInput } : {}),
    confirmationRequired: record.confirmationRequired === true,
  };
}

export function redactedPersonalOpsText(value: string): string {
  return value
    .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1=<redacted>')
    .replace(/(\b(?:api[-_]?key|token|secret|password|passwd|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1<redacted>')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '<redacted-token>');
}

export function stringifyForPreview(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function boundedPersonalOpsResult(value: unknown, includeParameters: boolean): Record<string, unknown> {
  const text = redactedPersonalOpsText(stringifyForPreview(value));
  const max = includeParameters ? 6000 : 1600;
  return {
    format: typeof value,
    characters: text.length,
    truncated: text.length > max,
    preview: text.length <= max ? text : `${text.slice(0, max).trimEnd()}...`,
    redaction: 'Secret-looking tokens, API keys, credentials, passwords, and bearer values are redacted before model display.',
  };
}

export function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function lowerKeyEntries(record: Record<string, unknown>): readonly [string, unknown][] {
  return Object.entries(record).map(([key, value]) => [key.toLowerCase(), value] as [string, unknown]);
}

export function stringField(record: Record<string, unknown>, names: readonly string[]): string {
  const lowered = lowerKeyEntries(record);
  for (const name of names) {
    const exact = lowered.find(([key]) => key === name);
    const value = exact?.[1];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  for (const name of names) {
    const fuzzy = lowered.find(([key]) => key.includes(name));
    const value = fuzzy?.[1];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

export function candidateResultItems(value: unknown, depth = 0): readonly unknown[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) return value;
  const object = recordObject(value);
  if (!object) return [];
  for (const key of ['messages', 'threads', 'emails', 'mail', 'events', 'items', 'results', 'data']) {
    const entry = object[key];
    if (Array.isArray(entry)) return entry;
    const nested = candidateResultItems(entry, depth + 1);
    if (nested.length > 0) return nested;
  }
  for (const key of ['structuredContent', 'structured_content', 'result', 'payload', 'output']) {
    const nested = candidateResultItems(object[key], depth + 1);
    if (nested.length > 0) return nested;
  }
  return [];
}

export function reviewCardFromObject(
  lane: PersonalOpsLane,
  sourceRecord: PersonalOpsLiveRecord,
  item: Record<string, unknown>,
  index: number,
  includeParameters: boolean,
): Record<string, unknown> {
  const calendar = lane.id === 'calendar';
  const id = stringField(item, calendar ? ['id', 'eventid', 'uid'] : ['id', 'messageid', 'threadid', 'emailid']) || `${sourceRecord.id}:item-${index + 1}`;
  const subject = stringField(item, calendar
    ? ['summary', 'title', 'subject', 'name']
    : ['subject', 'title', 'summary']);
  const actor = stringField(item, calendar
    ? ['calendar', 'organizer', 'attendee', 'location']
    : ['from', 'sender', 'author']);
  const time = stringField(item, calendar
    ? ['start', 'starttime', 'time', 'when', 'date']
    : ['date', 'receivedat', 'timestamp', 'time']);
  const body = stringField(item, calendar
    ? ['description', 'notes', 'body', 'snippet']
    : ['snippet', 'preview', 'body', 'text', 'content']);
  const label = subject || actor || `${calendar ? 'Calendar event' : 'Inbox item'} ${index + 1}`;
  const summaryParts = [
    actor ? `${calendar ? 'source' : 'from'} ${actor}` : '',
    time ? `time ${time}` : '',
    body,
  ].filter(Boolean);
  const summary = redactedPersonalOpsText(summaryParts.join('; ') || stringifyForPreview(item));
  return {
    id,
    kind: calendar ? 'calendar-event' : 'inbox-message',
    label: previewHarnessText(redactedPersonalOpsText(label), includeParameters ? 160 : 96),
    summary: previewHarnessText(summary, includeParameters ? 420 : 180),
    sourceRecordId: sourceRecord.id,
    sourceTool: sourceRecord.qualifiedName,
    confidence: 'normalized',
    followUpBoundary: calendar
      ? 'Calendar create, edit, delete, RSVP, and reschedule actions require a separate confirmed route.'
      : 'Reply, send, label, archive, move, and delete actions require a separate confirmed route.',
    ...(includeParameters ? { rawKeys: Object.keys(item).slice(0, 16) } : {}),
  };
}

export function personalOpsReadReviewRecords(
  lane: PersonalOpsLane,
  sourceRecord: PersonalOpsLiveRecord,
  result: unknown,
  includeParameters: boolean,
): readonly Record<string, unknown>[] {
  const items = candidateResultItems(result);
  const objectCards = items
    .map((item, index) => {
      const object = recordObject(item);
      if (!object) return null;
      return reviewCardFromObject(lane, sourceRecord, object, index, includeParameters);
    })
    .filter((item): item is Record<string, unknown> => item !== null)
    .slice(0, 8);
  if (objectCards.length > 0) return objectCards;
  const preview = boundedPersonalOpsResult(result, includeParameters).preview;
  return [{
    id: `${sourceRecord.id}:raw-preview`,
    kind: lane.id === 'calendar' ? 'calendar-read-preview' : 'inbox-read-preview',
    label: `${lane.label} read output preview`,
    summary: previewHarnessText(String(preview), includeParameters ? 420 : 180),
    sourceRecordId: sourceRecord.id,
    sourceTool: sourceRecord.qualifiedName,
    confidence: 'raw-preview',
    followUpBoundary: 'Use this preview to summarize locally; any provider mutation requires a separate confirmed route.',
  }];
}

export function reviewRecordFieldValues(records: readonly Record<string, unknown>[], names: readonly string[], limit: number): readonly string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const value = previewHarnessText(redactedPersonalOpsText(stringField(record, names)), 120);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

export async function savePersonalOpsReviewArtifact(options: {
  readonly context: CommandContext;
  readonly lane: PersonalOpsLane;
  readonly sourceRecord: PersonalOpsLiveRecord;
  readonly inputFields: Readonly<Record<string, unknown>>;
  readonly reviewRecords: readonly Record<string, unknown>[];
  readonly output: Record<string, unknown>;
  readonly title?: string;
}): Promise<Record<string, unknown>> {
  const store = options.context.platform.artifactStore;
  if (!store?.create) {
    return {
      status: 'unavailable',
      reason: 'artifact_store_unavailable',
      policy: 'Review-card persistence requires the Agent artifact store; raw connector output was not written.',
    };
  }
  const createdAt = new Date().toISOString();
  const safeTitle = previewHarnessText(options.title || `${options.lane.label} review cards`, 96)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'personal-ops-review';
  const reviewLabels = reviewRecordFieldValues(options.reviewRecords, ['label', 'subject', 'title', 'summary'], 5);
  const reviewKinds = reviewRecordFieldValues(options.reviewRecords, ['kind'], 5);
  const reviewRecordIds = reviewRecordFieldValues(options.reviewRecords, ['id'], 8);
  const payload = {
    version: 1,
    createdAt,
    laneId: options.lane.id,
    sourceRecordId: options.sourceRecord.id,
    sourceTool: options.sourceRecord.qualifiedName,
    reviewRecords: options.reviewRecords,
    outputPreview: options.output.preview,
    outputTruncated: options.output.truncated,
    inputFieldKeys: Object.keys(options.inputFields).sort((left, right) => left.localeCompare(right)),
    policy: 'Saved Personal Ops review-card artifacts contain redacted review cards and bounded previews only; full raw connector output and full input values are not stored.',
  };
  const descriptor = await store.create({
    kind: 'data',
    mimeType: 'application/json',
    filename: `${safeTitle}-${Date.now()}.json`,
    text: `${redactedPersonalOpsText(JSON.stringify(payload, null, 2))}\n`,
    acquisitionMode: 'inline-data',
    fetchMode: 'not-applicable',
    metadata: {
      purpose: 'personal-ops-review-cards',
      laneId: options.lane.id,
      sourceRecordId: options.sourceRecord.id,
      sourceTool: options.sourceRecord.qualifiedName ?? '',
      reviewRecordCount: options.reviewRecords.length,
      reviewLabels,
      reviewKinds,
      reviewRecordIds,
      fullRawConnectorOutputStored: false,
    },
  });
  return {
    status: 'saved',
    artifactId: descriptor.id,
    filename: descriptor.filename ?? null,
    mimeType: descriptor.mimeType,
    sizeBytes: descriptor.sizeBytes,
    modelRoute: `agent_artifacts show artifactId:"${descriptor.id}"`,
    policy: 'Artifact contains redacted review cards for later user review; provider mutations still require separate confirmation.',
  };
}

export function fieldInputValue(value: string, sample: unknown): unknown {
  if (typeof sample === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (typeof sample === 'boolean') return /^(1|true|yes|y)$/i.test(value.trim());
  if (Array.isArray(sample)) return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return value;
}

export function readInputFields(value: unknown, sampleInput?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const fields: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PERSONAL_OPS_READ_CONTROL_FIELDS.has(key)) continue;
    if (entry === undefined || entry === null) continue;
    const text = typeof entry === 'string' ? entry.trim() : String(entry).trim();
    if (!text) continue;
    fields[key] = fieldInputValue(text, sampleInput?.[key]);
  }
  return fields;
}

export function readRunControlString(fields: unknown, key: string): string {
  const object = recordObject(fields);
  const value = object?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function readRunControlBoolean(fields: unknown, keys: readonly string[]): boolean {
  const object = recordObject(fields);
  if (!object) return false;
  return keys.some((key) => {
    const value = object[key];
    if (value === true) return true;
    if (typeof value !== 'string') return false;
    return /^(1|true|yes|y|on)$/i.test(value.trim());
  });
}

export function missingRequiredInputFields(record: PersonalOpsLiveRecord, fields: Readonly<Record<string, unknown>>): readonly string[] {
  return (record.requiredFields ?? []).filter((field) => !(field in fields) || fields[field] === '');
}

function personalOpsReadRunRoute(laneId: PersonalOpsLaneId, recordId: string): string {
  return `personal_ops action:"read" laneId:"${laneId}" recordId:"${recordId}" fields:{...} confirm:true explicitUserRequest:"..."`;
}

export function executionRouteForRecord(record: PersonalOpsLiveRecord, laneId: PersonalOpsLaneId): string {
  return personalOpsReadRunRoute(laneId, record.id);
}

export function personalOpsRoutePacket(options: {
  readonly id: string;
  readonly label: string;
  readonly effect: PersonalOpsRoutePacket['effect'];
  readonly modelRoute: string;
  readonly requiresConfirmation: boolean;
  readonly policy: string;
}): PersonalOpsRoutePacket {
  return {
    id: options.id,
    label: options.label,
    effect: options.effect,
    modelRoute: options.modelRoute,
    requiresConfirmation: options.requiresConfirmation,
    policy: options.policy,
  };
}

export function savedReviewArtifactId(savedReviewArtifact: Record<string, unknown> | null): string {
  const value = savedReviewArtifact?.artifactId;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function personalOpsReadNextRoutes(options: {
  readonly lane: PersonalOpsLane;
  readonly runRoute: string;
  readonly savedReviewArtifact: Record<string, unknown> | null;
}): Record<string, PersonalOpsRoutePacket> {
  const artifactId = savedReviewArtifactId(options.savedReviewArtifact);
  const artifactRoute = artifactId ? `agent_artifacts show artifactId:"${artifactId}" includeContent:true` : '';
  const localReviewRoute = artifactRoute || 'main Agent response';
  const routes: Record<string, PersonalOpsRoutePacket> = {
    lane: personalOpsRoutePacket({
      id: 'inspect-personal-ops-lane',
      label: `Inspect ${options.lane.label} lane`,
      effect: 'read-only',
      modelRoute: `personal_ops action:"lane" laneId:"${options.lane.id}" includeParameters:true`,
      requiresConfirmation: false,
      policy: 'Reopen the lane to inspect available records, connector readiness, and workflow cards before the next personal-data action.',
    }),
    queue: personalOpsRoutePacket({
      id: 'inspect-personal-ops-queue',
      label: `Inspect ${options.lane.label} review queue`,
      effect: 'read-only',
      modelRoute: `personal_ops action:"queue" query:"${options.lane.id}" includeParameters:true`,
      requiresConfirmation: false,
      policy: 'The queue is read-only; it lists saved review artifacts, fresh read routes, and follow-up boundaries without executing connectors.',
    }),
    refresh: personalOpsRoutePacket({
      id: 'refresh-live-provider-read',
      label: 'Refresh this provider read',
      effect: 'read-only',
      modelRoute: options.runRoute,
      requiresConfirmation: true,
      policy: 'Refreshing reads current provider data only after the user supplies current fields and confirms the bounded read; prior input values are not stored.',
    }),
  };
  if (artifactRoute) {
    routes.artifact = personalOpsRoutePacket({
      id: 'reopen-saved-review-artifact',
      label: 'Reopen saved review cards',
      effect: 'read-only',
      modelRoute: artifactRoute,
      requiresConfirmation: false,
      policy: 'Saved artifacts contain redacted review cards and bounded previews only; inspect them before local drafting, reminders, or any separate confirmed effect.',
    });
    routes.savedQueue = personalOpsRoutePacket({
      id: 'find-saved-review-queue-records',
      label: 'Find saved review queue records',
      effect: 'read-only',
      modelRoute: `personal_ops action:"queue" query:"${artifactId}" includeParameters:true`,
      requiresConfirmation: false,
      policy: 'Filter the read-only queue to the newly saved artifact so the next action starts from durable redacted cards instead of raw provider output.',
    });
  }
  if (options.lane.id === 'calendar') {
    routes.localReminderDraft = personalOpsRoutePacket({
      id: 'draft-local-reminder-from-review',
      label: 'Draft reminder locally from review cards',
      effect: 'local-only',
      modelRoute: localReviewRoute,
      requiresConfirmation: false,
      policy: 'Draft timing and message text in the Agent transcript first; creating a reminder is a separate confirmed schedule route.',
    });
    routes.createReminderBoundary = personalOpsRoutePacket({
      id: 'create-reminder-confirmed-boundary',
      label: 'Create reminder after review',
      effect: 'confirmed-effect',
      modelRoute: 'schedule action:"remind" message:"..." at:"..." confirm:true explicitUserRequest:"..."',
      requiresConfirmation: true,
      policy: 'Create one reminder only after the user reviews exact message text and timing.',
    });
    routes.calendarEditBoundary = personalOpsRoutePacket({
      id: 'inspect-calendar-edit-boundary',
      label: 'Inspect calendar edit route',
      effect: 'confirmed-effect',
      modelRoute: 'personal_ops action:"intake" query:"edit saved calendar event" includeParameters:true',
      requiresConfirmation: true,
      policy: 'Calendar edits, RSVP, reschedule, and deletes require a separate inspected connector route and explicit confirmation.',
    });
  } else {
    routes.localDraft = personalOpsRoutePacket({
      id: 'draft-local-reply-from-review',
      label: 'Draft reply locally from review cards',
      effect: 'local-only',
      modelRoute: localReviewRoute,
      requiresConfirmation: false,
      policy: 'Drafting stays local in the Agent transcript and does not send, label, archive, move, or delete provider records.',
    });
    routes.sendBoundary = personalOpsRoutePacket({
      id: 'inspect-send-boundary',
      label: 'Inspect send route after review',
      effect: 'confirmed-effect',
      modelRoute: 'personal_ops action:"intake" query:"send reviewed reply from saved inbox review" includeParameters:true',
      requiresConfirmation: true,
      policy: 'Sending requires a write-like inbox connector route plus explicit confirmation of exact recipients and body.',
    });
  }
  return routes;
}

export function summarizeRunRecord(record: PersonalOpsLiveRecord, lane: PersonalOpsLane, includeParameters: boolean): Record<string, unknown> {
  return {
    laneId: lane.id,
    recordId: record.id,
    label: record.label,
    status: record.status,
    effect: record.effect ?? 'read-only',
    capability: record.capability,
    modelRoute: record.modelRoute,
    ...(record.qualifiedName ? { qualifiedName: record.qualifiedName } : {}),
    ...(includeParameters && record.requiredFields ? { requiredFields: record.requiredFields } : {}),
    ...(includeParameters && record.optionalFields ? { optionalFields: record.optionalFields.slice(0, 12) } : {}),
    ...(includeParameters && record.sampleInput ? { sampleInput: record.sampleInput } : {}),
  };
}

export function resolveRunRecord(
  lanes: readonly PersonalOpsLane[],
  options: { readonly laneId: string; readonly recordId: string; readonly target: string; readonly query: string },
): { readonly lane: PersonalOpsLane; readonly record: PersonalOpsLiveRecord } | null | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] } {
  const scopedLanes = options.laneId ? lanes.filter((lane) => lane.id === options.laneId) : lanes;
  const lookup = options.recordId || options.target || options.query;
  if (!lookup) return null;
  const normalized = lookup.toLowerCase();
  const exact = scopedLanes.flatMap((lane) => (lane.liveRecords ?? [])
    .filter((record) => record.id === lookup || record.qualifiedName === lookup)
    .map((record) => ({ lane, record })));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup,
      candidates: exact.map(({ lane, record }) => summarizeRunRecord(record, lane, false)),
    };
  }
  const matches = scopedLanes.flatMap((lane) => (lane.liveRecords ?? [])
    .filter((record) => liveRecordSearchText(record).includes(normalized))
    .map((record) => ({ lane, record })));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup,
      candidates: matches.slice(0, 8).map(({ lane, record }) => summarizeRunRecord(record, lane, false)),
    };
  }
  return null;
}
