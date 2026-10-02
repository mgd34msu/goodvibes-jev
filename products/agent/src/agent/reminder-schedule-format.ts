import {
  REMINDER_SCHEDULE_METHOD,
  type ReminderScheduleFailure,
  type ReminderSchedulePreview,
  type ReminderScheduleSuccess,
} from './reminder-schedule.ts';
import { scheduleConfirmationRouteLines, scheduleNextRouteLines, scheduleRouteArg } from './schedule-next-routes.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function scheduleValue(preview: ReminderSchedulePreview): string {
  if (preview.payload.kind === 'cron') {
    return `${preview.payload.cron}${preview.payload.timezone ? ` [${preview.payload.timezone}]` : ''}`;
  }
  if (preview.payload.kind === 'every') return String(preview.payload.every);
  return String(preview.payload.at);
}

function createReminderRouteArgs(preview: ReminderSchedulePreview): string {
  const args = [
    `scheduleKind:${scheduleRouteArg(String(preview.payload.kind ?? ''))}`,
    `scheduleValue:${scheduleRouteArg(scheduleValue(preview))}`,
  ];
  if (typeof preview.payload.timezone === 'string' && preview.payload.timezone) {
    args.push(`timezone:${scheduleRouteArg(preview.payload.timezone)}`);
  }
  return args.join(' ');
}

function formatReminderScheduleFailureKind(kind: string): string {
  if (kind === 'auth_required') return 'authorization required';
  if (kind === 'connected_host_unavailable') return 'connected host unavailable';
  if (kind === 'connected_host_incompatible') return 'connected host incompatible';
  if (kind === 'connected_host_route_unavailable') return 'connected host route unavailable';
  if (kind === 'connected_host_error') return 'connected host error';
  return kind.replace(/[_-]+/g, ' ');
}

export function formatReminderSchedulePreview(preview: ReminderSchedulePreview): string {
  const delivery = preview.payload.delivery;
  const deliveryTargetCount = delivery?.targets.length ?? 0;
  return [
    'GoodVibes schedule preview for Agent reminder',
    `  route ${preview.method} ${preview.route}`,
    `  name ${String(preview.payload.name ?? '(service default)')}`,
    `  reminder ${preview.message}`,
    `  schedule ${preview.payload.kind} ${scheduleValue(preview)}`,
    `  enabled ${preview.payload.enabled === false ? 'no' : 'yes'}`,
    `  delivery ${delivery?.mode ?? 'none'}${deliveryTargetCount > 0 ? ` (${deliveryTargetCount} target${deliveryTargetCount === 1 ? '' : 's'})` : ''}`,
    '  target connected GoodVibes host/main conversation route',
    '  policy reminder delivery only; isolated Agent Knowledge only; no default knowledge/non-Agent fallback',
    ...scheduleConfirmationRouteLines({
      model: `schedule action:"remind" message:${scheduleRouteArg(preview.message)} ${createReminderRouteArgs(preview)} confirm:true explicitUserRequest:"..."`,
    }),
  ].join('\n');
}

export function formatReminderScheduleSuccess(result: ReminderScheduleSuccess): string {
  const record: Record<string, unknown> = isRecord(result.schedule) ? result.schedule : {};
  const id = readString(record, 'id') ?? '(unknown)';
  const status = readString(record, 'status') ?? (record.enabled === false ? 'paused' : 'enabled');
  return [
    'Created GoodVibes schedule for Agent reminder',
    `  schedule ${id}`,
    `  status ${status}`,
    `  route ${result.kind} ${result.route}`,
    `  reminder ${result.message}`,
    ...scheduleNextRouteLines(id),
  ].join('\n');
}

export function formatReminderScheduleFailure(failure: ReminderScheduleFailure): string {
  return [
    `GoodVibes reminder schedule error ${formatReminderScheduleFailureKind(failure.kind)}`,
    `  ${failure.error}`,
    failure.baseUrl ? `  connected host ${failure.baseUrl}` : null,
    `  route ${REMINDER_SCHEDULE_METHOD} ${failure.route}`,
    failure.kind === 'auth_required'
      ? '  next pair/authenticate with the connected GoodVibes host, then retry with --yes.'
      : null,
    failure.kind === 'connected_host_unavailable'
      ? '  next make the connected GoodVibes host available outside Agent, then retry.'
      : null,
    failure.kind === 'connected_host_incompatible' || failure.kind === 'connected_host_route_unavailable'
      ? '  next update the connected GoodVibes host so public automation.schedules.create is available.'
      : null,
  ].filter((line): line is string => Boolean(line)).join('\n');
}
