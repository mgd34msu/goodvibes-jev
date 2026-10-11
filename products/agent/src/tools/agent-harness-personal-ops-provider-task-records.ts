import { captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { assertPersonalOpsDataCurrent, capturePersonalOpsData, protectPersonalOpsData } from './agent-harness-personal-ops-source.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { readRecord, readString } from './agent-harness-model-routing-utils.ts';
import { personalOpsRecordCertification } from './agent-harness-personal-ops-certification.ts';
import { safeRecordIdPart } from './agent-harness-personal-ops-records.ts';
import type { PersonalOpsFollowUpRoute, PersonalOpsLiveRecord, PersonalOpsRecordFreshness } from './agent-harness-personal-ops-types.ts';

type ProviderTaskLane = 'tasks' | 'reminders';
type ProviderReadModelSourceKind = Extract<PersonalOpsRecordFreshness['source'], 'daemon-read-model' | 'sdk-read-model'>;

interface ProviderTaskSource {
  readonly path: string;
  readonly source: unknown;
  readonly kind: ProviderReadModelSourceKind;
}

const TASK_READ_KEYS = ['readRoute', 'inspectRoute', 'refreshRoute', 'getTaskRoute'];
const TASK_EFFECT_KEYS = {
  update: ['updateRoute', 'editRoute', 'patchRoute'],
  complete: ['completeRoute', 'doneRoute', 'finishRoute'],
  defer: ['deferRoute', 'snoozeRoute'],
  delete: ['deleteRoute', 'archiveRoute'],
} as const;
const REMINDER_READ_KEYS = ['readRoute', 'inspectRoute', 'refreshRoute', 'getReminderRoute', 'getScheduleRoute'];
const REMINDER_EFFECT_KEYS = {
  edit: ['editRoute', 'updateRoute', 'rescheduleRoute'],
  complete: ['completeRoute', 'doneRoute', 'dismissRoute'],
  snooze: ['snoozeRoute', 'deferRoute'],
  delete: ['deleteRoute', 'cancelRoute'],
} as const;

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return '';
}

function readStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return [...new Set(value.map((entry) => readString(entry)).filter(Boolean))].slice(0, 12);
  const text = readString(value);
  return text ? text.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 12) : [];
}

function readIso(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const text = readString(value);
  if (!text) return '';
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : previewHarnessText(text, 80);
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
  for (const containerKey of ['routes', 'effectRoutes', 'actions']) {
    const routes = readRecord(record[containerKey]);
    for (const key of keys) {
      const route = readRoute(routes[key]);
      if (route) return route;
    }
  }
  return '';
}

function sources(context: CommandContext, lane: ProviderTaskLane): readonly ProviderTaskSource[] {
  const paths = lane === 'tasks' ? [
    { path: 'context.platform.readModels.personalOps.tasks', kind: 'daemon-read-model' as const },
    { path: 'context.platform.readModels.personalOps.taskRecords', kind: 'daemon-read-model' as const },
    { path: 'context.platform.readModels.providerTasks', kind: 'daemon-read-model' as const },
    { path: 'context.platform.readModels.taskProviders.tasks', kind: 'daemon-read-model' as const },
    { path: 'context.platform.personalOps.tasks', kind: 'daemon-read-model' as const },
    { path: 'context.clients.operator.personalOps.tasks', kind: 'sdk-read-model' as const },
  ] : [
    { path: 'context.platform.readModels.personalOps.reminders', kind: 'daemon-read-model' as const },
    { path: 'context.platform.readModels.personalOps.reminderRecords', kind: 'daemon-read-model' as const },
    { path: 'context.platform.readModels.providerReminders', kind: 'daemon-read-model' as const },
    { path: 'context.platform.readModels.reminders', kind: 'daemon-read-model' as const },
    { path: 'context.platform.readModels.schedules.reminders', kind: 'daemon-read-model' as const },
    { path: 'context.platform.personalOps.reminders', kind: 'daemon-read-model' as const },
    { path: 'context.clients.operator.personalOps.reminders', kind: 'sdk-read-model' as const },
  ];
  return paths.map(entry => ({ ...entry, source: modelReadingServicePath(context, entry.path.split('.').slice(1)) }));
}
function readSnapshot(source: unknown, lane: ProviderTaskLane): unknown {
  if (typeof source === 'function') {
    try {
      const result: unknown = source();
      return result instanceof Promise ? undefined : result;
    } catch {
      return undefined;
    }
  }
  const record = readRecord(source);
  const methods = lane === 'tasks'
    ? ['getSnapshot', 'snapshot', 'listTasks', 'getTasks', 'list']
    : ['getSnapshot', 'snapshot', 'listReminders', 'getReminders', 'listSchedules', 'list'];
  for (const methodName of methods) {
    const method = modelReadingServicePath(source, [methodName]);
    if (typeof method !== 'function') continue;
    try {
      const result: unknown = method.call(source);
      return result instanceof Promise ? undefined : result;
    } catch {
      return undefined;
    }
  }
  return source;
}

function recordsFromSnapshot(snapshot: unknown, lane: ProviderTaskLane, depth = 0): readonly unknown[] {
  if (Array.isArray(snapshot)) return snapshot;
  const record = readRecord(snapshot);
  const keys = lane === 'tasks'
    ? ['tasks', 'taskRecords', 'items', 'records', 'entries', 'queue']
    : ['reminders', 'reminderRecords', 'schedules', 'items', 'records', 'entries', 'queue'];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    const valueRecord = readRecord(value);
    if (Object.keys(valueRecord).length > 0) {
      return Object.entries(valueRecord).map(([providerRecordId, entry]) => {
        const entryRecord = readRecord(entry);
        return Object.keys(entryRecord).length > 0 && !firstString(entryRecord, ['id', 'taskId', 'reminderId', 'scheduleId', 'providerRecordId'])
          ? { ...entryRecord, providerRecordId }
          : entry;
      });
    }
  }
  if (depth < 2) {
    for (const key of ['snapshot', 'data', 'current', 'payload', 'result', 'state']) {
      const nested = recordsFromSnapshot(record[key], lane, depth + 1);
      if (nested.length > 0) return nested;
    }
  }
  return firstString(record, lane === 'tasks'
    ? ['id', 'taskId', 'providerRecordId']
    : ['id', 'reminderId', 'scheduleId', 'providerRecordId'])
    ? [record]
    : [];
}

function followUp(id: string, label: string, route: string, policy: string): PersonalOpsFollowUpRoute | null {
  if (!route) return null;
  return {
    id,
    label,
    effect: 'confirmed-effect',
    modelRoute: route,
    requiresConfirmation: true,
    policy,
  };
}

function freshness(source: ProviderTaskSource, readRoute: string, currentAt: string, sampleInput: Readonly<Record<string, unknown>>): PersonalOpsRecordFreshness {
  return {
    status: readRoute ? 'fresh-provider-route-ready' : 'fresh-provider-record-current',
    source: source.kind,
    sourceTool: source.path,
    ...(currentAt ? { lastReviewedAt: currentAt } : {}),
    ...(readRoute ? { refreshRoute: readRoute } : {}),
    ...(Object.keys(sampleInput).length > 0 ? { sampleInput } : {}),
    policy: readRoute
      ? 'The provider published a current task/reminder record plus a bounded read route. Run it only for a user-requested refresh; mutations remain separate confirmed follow-up routes.'
      : 'The provider published current task/reminder state through a daemon or SDK read model. Inspect it as read-only; mutations require explicit published routes.',
  };
}

function normalizeTask(source: ProviderTaskSource, raw: unknown, index: number): PersonalOpsLiveRecord | null {
  const record = readRecord(raw);
  const providerId = firstString(record, ['providerId', 'provider', 'accountId', 'service', 'source']) || 'provider';
  const taskId = firstString(record, ['taskId', 'id', 'uid', 'providerRecordId']) || `${index + 1}`;
  const title = firstString(record, ['title', 'name', 'summary', 'subject']) || `Provider task ${index + 1}`;
  const status = firstString(record, ['status', 'state', 'reviewState']) || 'current';
  const dueAt = readIso(record.dueAt ?? record.due ?? record.deadline ?? record.scheduledAt);
  const updatedAt = readIso(record.currentAt ?? record.syncedAt ?? record.updatedAt ?? record.createdAt);
  const priority = firstString(record, ['priority', 'urgency', 'importance']);
  const list = firstString(record, ['list', 'listId', 'project', 'projectId', 'workspace']);
  const assignee = firstString(record, ['assignee', 'owner', 'assignedTo']);
  const notes = firstString(record, ['snippet', 'preview', 'notes', 'descriptionSummary', 'description']);
  const labels = readStringArray(record.labels ?? record.tags).slice(0, 6);
  const readRoute = routeFromKeys(record, TASK_READ_KEYS);
  const sampleInput: Record<string, unknown> = { taskId };
  const followUpRoutes = [
    followUp('update-provider-task', 'Update task', routeFromKeys(record, TASK_EFFECT_KEYS.update), 'Updating a provider task mutates provider state and requires exact field review plus explicit confirmation.'),
    followUp('complete-provider-task', 'Complete task', routeFromKeys(record, TASK_EFFECT_KEYS.complete), 'Completing a provider task mutates provider state and requires explicit confirmation.'),
    followUp('defer-provider-task', 'Defer task', routeFromKeys(record, TASK_EFFECT_KEYS.defer), 'Deferring or snoozing a provider task changes timing and requires explicit confirmation.'),
    followUp('delete-provider-task', 'Delete or archive task', routeFromKeys(record, TASK_EFFECT_KEYS.delete), 'Deleting or archiving a provider task requires explicit confirmation and an exact provider route.'),
  ].filter((route): route is PersonalOpsFollowUpRoute => route !== null);
  const hasConfirmedEffectRoute = followUpRoutes.some((route) => route.effect === 'confirmed-effect');
  return {
    id: `provider-task:${safeRecordIdPart(source.path)}:${safeRecordIdPart(taskId)}`,
    label: `Fresh task: ${previewHarnessText(title, 96)}`,
    status: previewHarnessText(status, 48),
    summary: [
      `Provider ${previewHarnessText(providerId, 64)} published current task ${previewHarnessText(taskId, 80)} from ${source.path}.`,
      notes ? `Preview ${previewHarnessText(notes, 140)}.` : '',
      list ? `List ${previewHarnessText(list, 64)}.` : '',
      dueAt ? `Due ${dueAt}.` : '',
      priority ? `Priority ${previewHarnessText(priority, 40)}.` : '',
      assignee ? `Owner ${previewHarnessText(assignee, 64)}.` : '',
      labels.length > 0 ? `Labels ${labels.map((label) => previewHarnessText(label, 40)).join(', ')}.` : '',
      updatedAt ? `Updated ${updatedAt}.` : '',
      followUpRoutes.length > 0 ? 'Published provider effects are separated into confirmed follow-up routes.' : 'No provider mutation route is published for this task.',
    ].filter(Boolean).join(' '),
    userRoute: 'Agent Workspace -> Personal Ops -> Review queue',
    modelRoute: readRoute || `personal_ops action:"lane" laneId:"tasks" query:"${safeRecordIdPart(taskId)}" includeParameters:true`,
    tags: ['provider-backed', 'fresh-provider', 'task-record', providerId, status, priority, ...labels].filter(Boolean),
    effect: 'read-only',
    capability: 'task-provider-record',
    confirmationRequired: false,
    sourceTool: source.path,
    certification: personalOpsRecordCertification({
      record,
      sourcePath: source.path,
      durableId: taskId,
      recordKind: 'task',
      hasConfirmedEffectRoute,
    }),
    freshness: freshness(source, readRoute, updatedAt || dueAt, sampleInput),
    followUpRoutes,
    sampleInput,
  };
}

function normalizeReminder(source: ProviderTaskSource, raw: unknown, index: number): PersonalOpsLiveRecord | null {
  const record = readRecord(raw);
  const providerId = firstString(record, ['providerId', 'provider', 'accountId', 'service', 'source']) || 'provider';
  const reminderId = firstString(record, ['reminderId', 'scheduleId', 'id', 'uid', 'providerRecordId']) || `${index + 1}`;
  const title = firstString(record, ['title', 'message', 'name', 'summary', 'subject']) || `Provider reminder ${index + 1}`;
  const status = firstString(record, ['status', 'state', 'reviewState']) || 'current';
  const dueAt = readIso(record.dueAt ?? record.remindAt ?? record.scheduledAt ?? record.nextRunAt ?? record.time);
  const updatedAt = readIso(record.currentAt ?? record.syncedAt ?? record.updatedAt ?? record.createdAt);
  const cadence = firstString(record, ['cadence', 'schedule', 'scheduleValue', 'rrule', 'repeat']);
  const delivery = firstString(record, ['deliveryTarget', 'deliveryTargetId', 'channel', 'target']);
  const notes = firstString(record, ['snippet', 'preview', 'notes', 'descriptionSummary', 'description']);
  const readRoute = routeFromKeys(record, REMINDER_READ_KEYS);
  const sampleInput: Record<string, unknown> = { reminderId };
  const followUpRoutes = [
    followUp('edit-provider-reminder', 'Edit reminder', routeFromKeys(record, REMINDER_EFFECT_KEYS.edit), 'Editing a provider reminder changes schedule or message state and requires exact field review plus explicit confirmation.'),
    followUp('complete-provider-reminder', 'Complete reminder', routeFromKeys(record, REMINDER_EFFECT_KEYS.complete), 'Completing or dismissing a provider reminder mutates provider state and requires explicit confirmation.'),
    followUp('snooze-provider-reminder', 'Snooze reminder', routeFromKeys(record, REMINDER_EFFECT_KEYS.snooze), 'Snoozing a provider reminder changes timing and requires explicit confirmation.'),
    followUp('delete-provider-reminder', 'Delete or cancel reminder', routeFromKeys(record, REMINDER_EFFECT_KEYS.delete), 'Deleting or cancelling a provider reminder requires explicit confirmation and an exact provider route.'),
  ].filter((route): route is PersonalOpsFollowUpRoute => route !== null);
  const hasConfirmedEffectRoute = followUpRoutes.some((route) => route.effect === 'confirmed-effect');
  return {
    id: `provider-reminder:${safeRecordIdPart(source.path)}:${safeRecordIdPart(reminderId)}`,
    label: `Fresh reminder: ${previewHarnessText(title, 96)}`,
    status: previewHarnessText(status, 48),
    summary: [
      `Provider ${previewHarnessText(providerId, 64)} published current reminder ${previewHarnessText(reminderId, 80)} from ${source.path}.`,
      notes ? `Preview ${previewHarnessText(notes, 140)}.` : '',
      dueAt ? `Due ${dueAt}.` : '',
      cadence ? `Cadence ${previewHarnessText(cadence, 64)}.` : '',
      delivery ? `Delivery ${previewHarnessText(delivery, 64)}.` : '',
      updatedAt ? `Updated ${updatedAt}.` : '',
      followUpRoutes.length > 0 ? 'Published provider effects are separated into confirmed follow-up routes.' : 'No provider mutation route is published for this reminder.',
    ].filter(Boolean).join(' '),
    userRoute: 'Agent Workspace -> Personal Ops -> Review queue',
    modelRoute: readRoute || `personal_ops action:"lane" laneId:"reminders" query:"${safeRecordIdPart(reminderId)}" includeParameters:true`,
    tags: ['provider-backed', 'fresh-provider', 'reminder-record', providerId, status, cadence].filter(Boolean),
    effect: 'read-only',
    capability: 'reminder-provider-record',
    confirmationRequired: false,
    sourceTool: source.path,
    certification: personalOpsRecordCertification({
      record,
      sourcePath: source.path,
      durableId: reminderId,
      recordKind: 'reminder',
      hasConfirmedEffectRoute,
    }),
    freshness: freshness(source, readRoute, updatedAt || dueAt, sampleInput),
    followUpRoutes,
    sampleInput,
  };
}

export async function providerBackedTaskRecords(context: CommandContext, options: CatalogRankingOptions = {}): Promise<readonly PersonalOpsLiveRecord[]> {
  return providerBackedRecords(context, 'tasks', options);
}

export async function providerBackedReminderRecords(context: CommandContext, options: CatalogRankingOptions = {}): Promise<readonly PersonalOpsLiveRecord[]> {
  return providerBackedRecords(context, 'reminders', options);
}

async function providerBackedRecords(context: CommandContext, lane: ProviderTaskLane, options: CatalogRankingOptions): Promise<readonly PersonalOpsLiveRecord[]> {
  const records: PersonalOpsLiveRecord[] = [];
  const seen = new Set<string>();
  for (const source of sources(context, lane)) {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    const original = readSnapshot(source.source, lane);
    if (original === undefined || original === null) continue;
    const originalSnapshot = capturePersonalOpsData(original);
    const sourceMethods = source.source !== null && typeof source.source === 'object'
      ? captureCatalogMethods(source.source, ['getSnapshot', 'snapshot', 'list', 'listEvents', 'getEvents', 'listThreads', 'getThreads', 'listMessages', 'getMessages', 'listTasks', 'getTasks', 'listReminders', 'getReminders', 'listSchedules']) : () => {};
    const assertSource = () => {
      options.signal?.throwIfAborted(); sourceMethods();
      if (sources(context, lane).find(entry => entry.path === source.path)?.source !== source.source) throw new ToolInputProjectionError('held');
      assertPersonalOpsDataCurrent(readSnapshot(source.source, lane), originalSnapshot);
    };
    const assertCurrent = () => { options.assertCurrent?.(); assertSource(); };
    const snapshot = await protectPersonalOpsData(original, { signal: options.signal, assertCurrent });
    assertCurrent(); options.retainCurrent?.(assertSource, source.path);
    for (const [index, raw] of recordsFromSnapshot(snapshot, lane).entries()) {
      const record = lane === 'tasks' ? normalizeTask(source, raw, index) : normalizeReminder(source, raw, index);
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
      if (records.length >= 10) return records;
    }
  }
  return records;
}
