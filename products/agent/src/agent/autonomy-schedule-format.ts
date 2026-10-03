import {
  AUTONOMY_SCHEDULE_METHOD,
  type AutonomyScheduleFailure,
  type AutonomySchedulePreview,
  type AutonomyScheduleSuccess,
} from './autonomy-schedule.ts';
import { scheduleConfirmationRouteLines, scheduleNextRouteLines, scheduleRouteArg } from './schedule-next-routes.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function scheduleValue(preview: AutonomySchedulePreview): string {
  if (preview.payload.kind === 'cron') {
    return `${preview.payload.cron}${preview.payload.timezone ? ` [${preview.payload.timezone}]` : ''}`;
  }
  if (preview.payload.kind === 'every') return String(preview.payload.every);
  return String(preview.payload.at);
}

function createScheduleRouteArgs(preview: AutonomySchedulePreview): string {
  const args = [
    `scheduleKind:${scheduleRouteArg(String(preview.payload.kind ?? ''))}`,
    `scheduleValue:${scheduleRouteArg(scheduleValue(preview))}`,
  ];
  if (typeof preview.payload.timezone === 'string' && preview.payload.timezone) {
    args.push(`timezone:${scheduleRouteArg(preview.payload.timezone)}`);
  }
  return args.join(' ');
}

function formatAutonomyScheduleFailureKind(kind: string): string {
  if (kind === 'auth_required') return 'authorization required';
  if (kind === 'connected_host_unavailable') return 'connected host unavailable';
  if (kind === 'connected_host_incompatible') return 'connected host incompatible';
  if (kind === 'connected_host_route_unavailable') return 'connected host route unavailable';
  if (kind === 'connected_host_error') return 'connected host error';
  return kind.replace(/[_-]+/g, ' ');
}

export function formatAutonomySchedulePreview(preview: AutonomySchedulePreview): string {
  const delivery = preview.payload.delivery;
  const deliveryTargetCount = delivery?.targets.length ?? 0;
  return [
    'GoodVibes schedule preview for autonomous Agent work',
    `  route ${preview.method} ${preview.route}`,
    `  name ${String(preview.payload.name ?? '(service default)')}`,
    `  task ${preview.task}`,
    `  success ${preview.successCriteria}`,
    `  schedule ${preview.payload.kind} ${scheduleValue(preview)}`,
    `  enabled ${preview.payload.enabled === false ? 'no' : 'yes'}`,
    `  delivery ${delivery?.mode ?? 'none'}${deliveryTargetCount > 0 ? ` (${deliveryTargetCount} target${deliveryTargetCount === 1 ? '' : 's'})` : ''}`,
    '  target connected GoodVibes host/main conversation route',
    '  policy visible scheduled automation; isolated Agent Knowledge only; no default knowledge/non-Agent fallback; approvals required for risky effects',
    ...scheduleConfirmationRouteLines({
      model: `schedule action:"create" task:${scheduleRouteArg(preview.task)} successCriteria:${scheduleRouteArg(preview.successCriteria)} ${createScheduleRouteArgs(preview)} confirm:true explicitUserRequest:"..."`,
    }),
  ].join('\n');
}

export function formatAutonomyScheduleSuccess(result: AutonomyScheduleSuccess): string {
  const record: Record<string, unknown> = isRecord(result.schedule) ? result.schedule : {};
  const id = readString(record, 'id') ?? '(unknown)';
  const status = readString(record, 'status') ?? (record.enabled === false ? 'paused' : 'enabled');
  return [
    'Created GoodVibes schedule for autonomous Agent work',
    `  schedule ${id}`,
    `  status ${status}`,
    `  route ${result.kind} ${result.route}`,
    `  task ${result.task}`,
    ...scheduleNextRouteLines(id),
  ].join('\n');
}

export function formatAutonomyScheduleFailure(failure: AutonomyScheduleFailure): string {
  return [
    `GoodVibes autonomous schedule error ${formatAutonomyScheduleFailureKind(failure.kind)}`,
    `  ${failure.error}`,
    failure.baseUrl ? `  connected host ${failure.baseUrl}` : null,
    `  route ${AUTONOMY_SCHEDULE_METHOD} ${failure.route}`,
    failure.kind === 'auth_required'
      ? '  next pair/authenticate with the connected GoodVibes host, then retry with confirm:true.'
      : null,
    failure.kind === 'connected_host_unavailable'
      ? '  next make the connected GoodVibes host available outside Agent, then retry.'
      : null,
    failure.kind === 'connected_host_incompatible' || failure.kind === 'connected_host_route_unavailable'
      ? '  next update the connected GoodVibes host so public automation.schedules.create is available.'
      : null,
  ].filter((line): line is string => Boolean(line)).join('\n');
}
