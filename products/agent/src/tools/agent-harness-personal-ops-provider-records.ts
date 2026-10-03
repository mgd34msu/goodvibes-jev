import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { readRecord, readString } from './agent-harness-model-routing-utils.ts';
import { redactedPersonalOpsText } from './agent-harness-personal-ops-runner.ts';
import { personalOpsRecordCertification } from './agent-harness-personal-ops-certification.ts';
import { safeRecordIdPart } from './agent-harness-personal-ops-records.ts';
import type { PersonalOpsFollowUpRoute, PersonalOpsLaneId, PersonalOpsLiveRecord, PersonalOpsRecordFreshness } from './agent-harness-personal-ops-types.ts';

type ProviderBackedLaneId = Extract<PersonalOpsLaneId, 'inbox' | 'calendar'>;
type ProviderReadModelSourceKind = Extract<PersonalOpsRecordFreshness['source'], 'daemon-read-model' | 'sdk-read-model'>;

interface ProviderReadModelSource {
  readonly path: string;
  readonly source: unknown;
  readonly kind: ProviderReadModelSourceKind;
}

const INBOX_ROUTE_KEYS = {
  read: ['readRoute', 'refreshRoute', 'inspectRoute', 'threadRoute', 'messageRoute', 'getThreadRoute'],
  reply: ['replyRoute', 'sendReplyRoute', 'draftReplyRoute'],
  send: ['sendRoute', 'sendMessageRoute'],
  archive: ['archiveRoute'],
  label: ['labelRoute', 'applyLabelRoute'],
} as const;

const CALENDAR_ROUTE_KEYS = {
  read: ['readRoute', 'refreshRoute', 'inspectRoute', 'eventRoute', 'getEventRoute'],
  edit: ['editRoute', 'updateRoute', 'rescheduleRoute'],
  rsvp: ['rsvpRoute', 'respondRoute'],
  delete: ['deleteRoute', 'cancelRoute'],
} as const;

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const direct = readString(record[key]);
    if (direct) return direct;
  }
  return '';
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'unread', 'conflict', 'conflicted'].includes(normalized)) return true;
    if (['false', 'no', '0', 'read', 'clear'].includes(normalized)) return false;
  }
  return null;
}

function readStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => readString(entry)).filter(Boolean))].slice(0, 12);
  }
  const text = readString(value);
  return text ? text.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 12) : [];
}

function readIso(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const text = readString(value);
  if (!text) return '';
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : previewHarnessText(redactedPersonalOpsText(text), 80);
}

function readRoute(value: unknown): string {
  const direct = readString(value);
  if (direct) return direct;
  const record = readRecord(value);
  return firstString(record, ['modelRoute', 'route', 'command', 'action', 'href']);
}

function routeFromKeys(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const route = readRoute(record[key]);
    if (route) return route;
  }
  const routes = readRecord(record.routes);
  for (const key of keys) {
    const route = readRoute(routes[key]);
    if (route) return route;
  }
  const effectRoutes = readRecord(record.effectRoutes);
  for (const key of keys) {
    const route = readRoute(effectRoutes[key]);
    if (route) return route;
  }
  return '';
}

function providerReadModelSources(context: CommandContext, laneId: ProviderBackedLaneId): readonly ProviderReadModelSource[] {
  const platform = context.platform as unknown as Record<string, unknown>;
  const clients = readRecord(context.clients);
  const readModels = readRecord(platform.readModels);
  const personalOps = readRecord(readModels.personalOps);
  const email = readRecord(readModels.email);
  const mail = readRecord(readModels.mail);
  const calendar = readRecord(readModels.calendar);
  const platformPersonalOps = readRecord(platform.personalOps);
  const operator = readRecord(clients.operator);
  const operatorPersonalOps = readRecord(operator.personalOps);
  if (laneId === 'inbox') {
    return [
      { path: 'context.platform.readModels.personalOps.inboxThreads', source: personalOps.inboxThreads, kind: 'daemon-read-model' },
      { path: 'context.platform.readModels.personalOps.emailThreads', source: personalOps.emailThreads, kind: 'daemon-read-model' },
      { path: 'context.platform.readModels.inboxThreads', source: readModels.inboxThreads, kind: 'daemon-read-model' },
      { path: 'context.platform.readModels.emailThreads', source: readModels.emailThreads, kind: 'daemon-read-model' },
      { path: 'context.platform.readModels.email.threads', source: email.threads, kind: 'daemon-read-model' },
      { path: 'context.platform.readModels.email.messages', source: email.messages, kind: 'daemon-read-model' },
      { path: 'context.platform.readModels.mail.threads', source: mail.threads, kind: 'daemon-read-model' },
      { path: 'context.platform.personalOps.inboxThreads', source: platformPersonalOps.inboxThreads, kind: 'daemon-read-model' },
      { path: 'context.clients.operator.personalOps.inboxThreads', source: operatorPersonalOps.inboxThreads, kind: 'sdk-read-model' },
      { path: 'context.clients.operator.personalOps.emailThreads', source: operatorPersonalOps.emailThreads, kind: 'sdk-read-model' },
    ];
  }
  return [
    { path: 'context.platform.readModels.personalOps.calendarEvents', source: personalOps.calendarEvents, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.calendarEvents', source: readModels.calendarEvents, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.calendar.events', source: calendar.events, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.calendar.agenda', source: calendar.agenda, kind: 'daemon-read-model' },
    { path: 'context.platform.personalOps.calendarEvents', source: platformPersonalOps.calendarEvents, kind: 'daemon-read-model' },
    { path: 'context.clients.operator.personalOps.calendarEvents', source: operatorPersonalOps.calendarEvents, kind: 'sdk-read-model' },
  ];
}

function readProviderSnapshot(source: unknown, laneId: ProviderBackedLaneId): unknown {
  if (typeof source === 'function') {
    try {
      const result = (source as () => unknown)();
      return result instanceof Promise ? undefined : result;
    } catch {
      return undefined;
    }
  }
  const record = readRecord(source);
  const methodNames = laneId === 'calendar'
    ? ['getSnapshot', 'snapshot', 'listEvents', 'getEvents', 'list']
    : ['getSnapshot', 'snapshot', 'listThreads', 'getThreads', 'listMessages', 'getMessages', 'list'];
  for (const methodName of methodNames) {
    const method = record[methodName];
    if (typeof method !== 'function') continue;
    try {
      const result = (method as () => unknown).call(source);
      return result instanceof Promise ? undefined : result;
    } catch {
      return undefined;
    }
  }
  return source;
}

function recordsFromSnapshot(snapshot: unknown, laneId: ProviderBackedLaneId, depth = 0): readonly unknown[] {
  if (Array.isArray(snapshot)) return snapshot;
  const record = readRecord(snapshot);
  const keys = laneId === 'calendar'
    ? ['calendarEvents', 'events', 'agenda', 'items', 'records', 'entries', 'queue']
    : ['inboxThreads', 'emailThreads', 'threads', 'messages', 'emails', 'items', 'records', 'entries', 'queue'];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    const valueRecord = readRecord(value);
    if (Object.keys(valueRecord).length > 0) {
      return Object.entries(valueRecord).map(([providerRecordId, entry]) => {
        const entryRecord = readRecord(entry);
        return Object.keys(entryRecord).length > 0 && !firstString(entryRecord, ['id', 'threadId', 'messageId', 'eventId', 'uid'])
          ? { ...entryRecord, providerRecordId }
          : entry;
      });
    }
  }
  if (depth < 2) {
    for (const key of ['snapshot', 'data', 'current', 'payload', 'result', 'state']) {
      const nested = recordsFromSnapshot(record[key], laneId, depth + 1);
      if (nested.length > 0) return nested;
    }
  }
  return firstString(record, laneId === 'calendar'
    ? ['id', 'eventId', 'uid', 'providerRecordId']
    : ['id', 'threadId', 'messageId', 'providerRecordId'])
    ? [record]
    : [];
}

function providerFreshness(options: {
  readonly source: ProviderReadModelSource;
  readonly readRoute: string;
  readonly requiredFields: readonly string[];
  readonly sampleInput: Readonly<Record<string, unknown>>;
  readonly currentAt: string;
}): PersonalOpsRecordFreshness {
  return {
    status: options.readRoute ? 'fresh-provider-route-ready' : 'fresh-provider-record-current',
    source: options.source.kind,
    sourceTool: options.source.path,
    ...(options.currentAt ? { lastReviewedAt: options.currentAt } : {}),
    ...(options.readRoute ? { refreshRoute: options.readRoute } : {}),
    ...(options.requiredFields.length > 0 ? { requiredFields: options.requiredFields } : {}),
    ...(Object.keys(options.sampleInput).length > 0 ? { sampleInput: options.sampleInput } : {}),
    policy: options.readRoute
      ? 'The provider published a current read-model record plus a bounded read or refresh route. Run the route only for a user-requested refresh; provider mutations remain separate confirmed follow-up routes.'
      : 'The provider published current redacted queue state through the daemon or SDK read model. Inspect it as read-only; refreshes and provider mutations require explicit published routes.',
  };
}

function followUp(
  id: string,
  label: string,
  route: string,
  effect: PersonalOpsFollowUpRoute['effect'],
  policy: string,
): PersonalOpsFollowUpRoute | null {
  if (!route) return null;
  return {
    id,
    label,
    effect,
    modelRoute: route,
    requiresConfirmation: effect === 'confirmed-effect',
    policy,
  };
}

function normalizeInboxRecord(source: ProviderReadModelSource, raw: unknown, index: number): PersonalOpsLiveRecord | null {
  const record = readRecord(raw);
  const providerId = firstString(record, ['providerId', 'provider', 'accountId', 'service', 'mailbox']) || 'provider';
  const threadId = firstString(record, ['threadId', 'conversationId', 'messageThreadId', 'id', 'messageId', 'uid', 'providerRecordId']) || `${index + 1}`;
  const subject = firstString(record, ['subject', 'title', 'summary', 'name']) || `Inbox thread ${index + 1}`;
  const status = firstString(record, ['status', 'state', 'reviewState'])
    || (readBoolean(record.needsReply) === true ? 'needs-reply' : readBoolean(record.unread) === true ? 'unread' : 'current');
  const sender = firstString(record, ['from', 'sender', 'author', 'participant']);
  const receivedAt = readIso(record.receivedAt ?? record.updatedAt ?? record.timestamp ?? record.date);
  const labels = readStringArray(record.labels ?? record.tags ?? record.mailboxLabels).slice(0, 6);
  const snippet = firstString(record, ['snippet', 'preview', 'excerpt', 'abstract']);
  const readRoute = routeFromKeys(record, INBOX_ROUTE_KEYS.read);
  const requiredFields = readStringArray(record.requiredFields);
  const sampleInput: Record<string, unknown> = threadId ? { threadId } : {};
  const followUpRoutes = [
    followUp('inspect-provider-thread', 'Inspect current thread record', readRoute || `personal_ops action:"lane" laneId:"inbox" query:"${safeRecordIdPart(threadId)}" includeParameters:true`, 'read-only', 'Inspecting the current provider-backed thread record is read-only and does not send, label, archive, move, or delete provider data.'),
    followUp('reply-provider-thread', 'Reply to thread', routeFromKeys(record, INBOX_ROUTE_KEYS.reply), 'confirmed-effect', 'Replying sends or stages provider data only after the user reviews exact recipients and body and confirms the published route.'),
    followUp('send-provider-message', 'Send provider message', routeFromKeys(record, INBOX_ROUTE_KEYS.send), 'confirmed-effect', 'Sending provider mail requires a separate published send route, exact body review, and explicit confirmation.'),
    followUp('archive-provider-thread', 'Archive thread', routeFromKeys(record, INBOX_ROUTE_KEYS.archive), 'confirmed-effect', 'Archiving mutates provider state and requires an explicit user request plus confirmation.'),
    followUp('label-provider-thread', 'Apply label', routeFromKeys(record, INBOX_ROUTE_KEYS.label), 'confirmed-effect', 'Labels mutate provider state and require an explicit user request plus confirmation.'),
  ].filter((route): route is PersonalOpsFollowUpRoute => route !== null);
  const hasConfirmedEffectRoute = followUpRoutes.some((route) => route.effect === 'confirmed-effect');
  const currentAt = readIso(record.currentAt ?? record.readAt ?? record.syncedAt ?? record.updatedAt ?? record.receivedAt);
  return {
    id: `provider-thread:${safeRecordIdPart(source.path)}:${safeRecordIdPart(threadId)}`,
    label: `Fresh thread: ${previewHarnessText(redactedPersonalOpsText(subject), 96)}`,
    status: previewHarnessText(redactedPersonalOpsText(status), 48),
    summary: [
      `Provider ${previewHarnessText(redactedPersonalOpsText(providerId), 64)} published current inbox thread ${previewHarnessText(redactedPersonalOpsText(threadId), 80)} from ${source.path}.`,
      sender ? `From ${previewHarnessText(redactedPersonalOpsText(sender), 80)}.` : '',
      labels.length > 0 ? `Labels ${labels.map((label) => previewHarnessText(redactedPersonalOpsText(label), 40)).join(', ')}.` : '',
      receivedAt ? `Updated ${receivedAt}.` : '',
      snippet ? `Preview ${previewHarnessText(redactedPersonalOpsText(snippet), 160)}.` : '',
      followUpRoutes.some((route) => route.effect === 'confirmed-effect') ? 'Published provider effects are separated into confirmed follow-up routes.' : 'No provider mutation route is published for this thread.',
    ].filter(Boolean).join(' '),
    userRoute: 'Agent Workspace -> Personal Ops -> Review queue',
    modelRoute: readRoute || `personal_ops action:"lane" laneId:"inbox" query:"${safeRecordIdPart(threadId)}" includeParameters:true`,
    tags: ['provider-backed', 'fresh-provider', 'inbox-thread', providerId, status, ...labels].filter(Boolean),
    effect: 'read-only',
    capability: 'inbox-provider-thread',
    confirmationRequired: false,
    sourceTool: source.path,
    certification: personalOpsRecordCertification({
      record,
      sourcePath: source.path,
      durableId: threadId,
      recordKind: 'inbox thread',
      hasConfirmedEffectRoute,
    }),
    freshness: providerFreshness({ source, readRoute, requiredFields, sampleInput, currentAt }),
    followUpRoutes,
    ...(requiredFields.length > 0 ? { requiredFields } : {}),
    ...(Object.keys(sampleInput).length > 0 ? { sampleInput } : {}),
  };
}

function normalizeCalendarRecord(source: ProviderReadModelSource, raw: unknown, index: number): PersonalOpsLiveRecord | null {
  const record = readRecord(raw);
  const providerId = firstString(record, ['providerId', 'provider', 'accountId', 'service', 'calendarProvider']) || 'provider';
  const eventId = firstString(record, ['eventId', 'uid', 'id', 'providerRecordId']) || `${index + 1}`;
  const calendarId = firstString(record, ['calendarId', 'calendar', 'calendarName']);
  const title = firstString(record, ['title', 'summary', 'subject', 'name']) || `Calendar event ${index + 1}`;
  const start = readIso(record.start ?? record.startAt ?? record.startTime ?? record.when);
  const end = readIso(record.end ?? record.endAt ?? record.endTime);
  const conflictCount = Array.isArray(record.conflicts) ? record.conflicts.length : readBoolean(record.conflict ?? record.hasConflict) === true ? 1 : 0;
  const status = conflictCount > 0
    ? 'conflict'
    : firstString(record, ['status', 'state', 'reviewState']) || 'current';
  const location = firstString(record, ['location', 'room', 'venue']);
  const attendeeCount = Array.isArray(record.attendees) ? record.attendees.length : null;
  const snippet = firstString(record, ['snippet', 'preview', 'notes', 'descriptionSummary']);
  const readRoute = routeFromKeys(record, CALENDAR_ROUTE_KEYS.read);
  const requiredFields = readStringArray(record.requiredFields);
  const sampleInput: Record<string, unknown> = { eventId };
  if (calendarId) sampleInput.calendarId = calendarId;
  const followUpRoutes = [
    followUp('inspect-provider-event', 'Inspect current event record', readRoute || `personal_ops action:"lane" laneId:"calendar" query:"${safeRecordIdPart(eventId)}" includeParameters:true`, 'read-only', 'Inspecting the current provider-backed event record is read-only and does not edit, RSVP, delete, or reschedule provider data.'),
    followUp('edit-provider-event', 'Edit or reschedule event', routeFromKeys(record, CALENDAR_ROUTE_KEYS.edit), 'confirmed-effect', 'Editing or rescheduling a provider event requires exact field review and explicit confirmation.'),
    followUp('rsvp-provider-event', 'RSVP to event', routeFromKeys(record, CALENDAR_ROUTE_KEYS.rsvp), 'confirmed-effect', 'RSVP mutates provider state and requires an explicit user request plus confirmation.'),
    followUp('delete-provider-event', 'Delete or cancel event', routeFromKeys(record, CALENDAR_ROUTE_KEYS.delete), 'confirmed-effect', 'Deleting or cancelling calendar data requires an explicit user request plus confirmation.'),
  ].filter((route): route is PersonalOpsFollowUpRoute => route !== null);
  const hasConfirmedEffectRoute = followUpRoutes.some((route) => route.effect === 'confirmed-effect');
  const currentAt = readIso(record.currentAt ?? record.readAt ?? record.syncedAt ?? record.updatedAt ?? record.start);
  return {
    id: `provider-event:${safeRecordIdPart(source.path)}:${safeRecordIdPart(eventId)}`,
    label: `Fresh event: ${previewHarnessText(redactedPersonalOpsText(title), 96)}`,
    status: previewHarnessText(redactedPersonalOpsText(status), 48),
    summary: [
      `Provider ${previewHarnessText(redactedPersonalOpsText(providerId), 64)} published current calendar event ${previewHarnessText(redactedPersonalOpsText(eventId), 80)} from ${source.path}.`,
      calendarId ? `Calendar ${previewHarnessText(redactedPersonalOpsText(calendarId), 64)}.` : '',
      start || end ? `Window ${[start, end].filter(Boolean).join(' -> ')}.` : '',
      location ? `Location ${previewHarnessText(redactedPersonalOpsText(location), 80)}.` : '',
      attendeeCount !== null ? `${attendeeCount} attendee(s).` : '',
      conflictCount > 0 ? `${conflictCount} conflict signal(s).` : '',
      snippet ? `Preview ${previewHarnessText(redactedPersonalOpsText(snippet), 160)}.` : '',
      followUpRoutes.some((route) => route.effect === 'confirmed-effect') ? 'Published provider effects are separated into confirmed follow-up routes.' : 'No provider mutation route is published for this event.',
    ].filter(Boolean).join(' '),
    userRoute: 'Agent Workspace -> Personal Ops -> Review queue',
    modelRoute: readRoute || `personal_ops action:"lane" laneId:"calendar" query:"${safeRecordIdPart(eventId)}" includeParameters:true`,
    tags: ['provider-backed', 'fresh-provider', 'calendar-event', providerId, status, conflictCount > 0 ? 'conflict' : '', calendarId].filter(Boolean),
    effect: 'read-only',
    capability: 'calendar-provider-event',
    confirmationRequired: false,
    sourceTool: source.path,
    certification: personalOpsRecordCertification({
      record,
      sourcePath: source.path,
      durableId: eventId,
      recordKind: 'calendar event',
      hasConfirmedEffectRoute,
    }),
    freshness: providerFreshness({ source, readRoute, requiredFields, sampleInput, currentAt }),
    followUpRoutes,
    ...(requiredFields.length > 0 ? { requiredFields } : {}),
    ...(Object.keys(sampleInput).length > 0 ? { sampleInput } : {}),
  };
}

export function providerBackedQueueRecords(context: CommandContext, laneId: ProviderBackedLaneId): readonly PersonalOpsLiveRecord[] {
  const records: PersonalOpsLiveRecord[] = [];
  const seen = new Set<string>();
  for (const source of providerReadModelSources(context, laneId)) {
    const snapshot = readProviderSnapshot(source.source, laneId);
    for (const [index, raw] of recordsFromSnapshot(snapshot, laneId).entries()) {
      const record = laneId === 'calendar'
        ? normalizeCalendarRecord(source, raw, index)
        : normalizeInboxRecord(source, raw, index);
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
      if (records.length >= 10) return records;
    }
  }
  return records;
}
