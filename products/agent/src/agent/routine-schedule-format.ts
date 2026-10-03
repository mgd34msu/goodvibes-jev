import {
  ROUTINE_SCHEDULE_LIST_METHOD,
  ROUTINE_SCHEDULE_METHOD,
  type RoutineScheduleCorrelationResult,
  type RoutineSchedulePromotionFailure,
  type RoutineSchedulePromotionPreview,
  type RoutineSchedulePromotionSuccess,
  type RoutineScheduleReceipt,
  type RoutineScheduleReceiptSnapshot,
} from './routine-schedule-promotion.ts';
import { scheduleConfirmationRouteLines, scheduleNextRouteLines, scheduleRouteArg } from './schedule-next-routes.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function formatDeliveryTargetKind(target: { readonly kind?: string; readonly surfaceKind?: string }): string {
  if (target.kind === 'surface') return `channel${target.surfaceKind ? `/${target.surfaceKind}` : ''}`;
  return `${target.kind ?? 'unknown'}${target.surfaceKind ? `/${target.surfaceKind}` : ''}`;
}

function formatDeliveryTarget(target: {
  readonly kind?: string;
  readonly surfaceKind?: string;
  readonly routeId?: string;
  readonly address?: string;
  readonly label?: string;
}): string {
  const details = [
    target.routeId ? `route=${target.routeId}` : '',
    target.address ? `address=${target.address}` : '',
    target.label ? `label=${target.label}` : '',
  ].filter(Boolean);
  return `${formatDeliveryTargetKind(target)}${details.length > 0 ? ` ${details.join(' ')}` : ''}`;
}

function formatRoutineScheduleFailureKind(kind: string): string {
  if (kind === 'auth_required') return 'authorization required';
  if (kind === 'connected_host_unavailable') return 'connected host unavailable';
  if (kind === 'connected_host_incompatible') return 'connected host incompatible';
  if (kind === 'connected_host_route_unavailable') return 'connected host route unavailable';
  if (kind === 'connected_host_error') return 'connected host error';
  return kind.replace(/[_-]+/g, ' ');
}

function routineScheduleSelector(preview: RoutineSchedulePromotionPreview): { readonly flag: string; readonly value: string } {
  if (preview.payload.kind === 'cron') return { flag: '--cron', value: String(preview.payload.cron ?? '') };
  if (preview.payload.kind === 'every') return { flag: '--every', value: String(preview.payload.every ?? '') };
  return { flag: '--at', value: String(preview.payload.at ?? '') };
}

function routineScheduleConfirmCommand(preview: RoutineSchedulePromotionPreview): string {
  const selector = routineScheduleSelector(preview);
  const args = [
    '/schedule promote-routine',
    scheduleRouteArg(preview.routineId),
    selector.flag,
    scheduleRouteArg(selector.value),
  ];
  if (typeof preview.payload.timezone === 'string' && preview.payload.timezone) {
    args.push('--timezone', scheduleRouteArg(preview.payload.timezone));
  }
  args.push('--yes');
  return args.join(' ');
}

export function formatRoutineSchedulePreview(preview: RoutineSchedulePromotionPreview): string {
  const schedule = preview.payload.kind === 'cron'
    ? `${preview.payload.cron}${preview.payload.timezone ? ` [${preview.payload.timezone}]` : ''}`
    : preview.payload.kind === 'every'
      ? String(preview.payload.every)
      : String(preview.payload.at);
  const delivery = preview.payload.delivery;
  const deliveryTargetCount = delivery?.targets.length ?? 0;
  return [
    'GoodVibes schedule preview for Agent routine',
    `  routine ${preview.routineName} (${preview.routineId})`,
    `  route ${preview.method} ${preview.route}`,
    `  name ${String(preview.payload.name ?? '(connected-host default)')}`,
    `  schedule ${preview.payload.kind} ${schedule}`,
    `  enabled ${preview.payload.enabled === false ? 'no' : 'yes'}`,
    `  delivery: ${delivery?.mode ?? 'none'}${deliveryTargetCount > 0 ? ` (${deliveryTargetCount} target${deliveryTargetCount === 1 ? '' : 's'})` : ''}`,
    '  target connected GoodVibes host/main conversation route',
    '  policy isolated Agent Knowledge only; no default knowledge/non-Agent fallback; no delegated review unless explicitly requested',
    ...scheduleConfirmationRouteLines({
      workspace: 'workspace action:"run" actionId:"schedule-promote-routine" confirm:true explicitUserRequest:"..."',
      cli: routineScheduleConfirmCommand(preview),
    }),
  ].join('\n');
}

export function formatRoutineScheduleSuccess(result: RoutineSchedulePromotionSuccess): string {
  const record: Record<string, unknown> = isRecord(result.schedule) ? result.schedule : {};
  const id = readString(record, 'id') ?? '(unknown)';
  const status = readString(record, 'status') ?? (record.enabled === false ? 'paused' : 'enabled');
  return [
    'Created GoodVibes schedule for Agent routine',
    `  routine ${result.routineName} (${result.routineId})`,
    `  schedule ${id}`,
    `  status ${status}`,
    `  route ${result.kind} ${result.route}`,
    ...scheduleNextRouteLines(id),
  ].join('\n');
}

export function formatRoutineScheduleReceipts(snapshot: RoutineScheduleReceiptSnapshot, limit = 10): string {
  const receipts = snapshot.receipts.slice(0, Math.max(1, limit));
  if (snapshot.receipts.length === 0) {
    return [
      'Agent routine schedule receipts',
      `  store ${snapshot.path}`,
      '  No routine schedule promotions have been recorded yet.',
      '  Create one with /schedule promote-routine <routine-id> --cron <expr> --yes.',
    ].join('\n');
  }
  return [
    `Agent routine schedule receipts (${snapshot.receipts.length})`,
    `  store ${snapshot.path}`,
    ...receipts.map((receipt) => {
      const schedule = receipt.scheduleId ? ` schedule=${receipt.scheduleId}` : '';
      const failure = receipt.status === 'failed' && receipt.failureKind ? ` failure ${formatRoutineScheduleFailureKind(receipt.failureKind)}` : '';
      return `  ${receipt.id}  ${receipt.status}  ${receipt.scheduleKind} ${receipt.scheduleValue}  routine ${receipt.routineId}${schedule}${failure}`;
    }),
    snapshot.receipts.length > receipts.length ? `  ...${snapshot.receipts.length - receipts.length} more` : '',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function formatRoutineScheduleReceipt(receipt: RoutineScheduleReceipt): string {
  return [
    `Agent routine schedule receipt ${receipt.id}`,
    `  created ${receipt.createdAt}`,
    `  status ${receipt.status}`,
    `  routine ${receipt.routineName} (${receipt.routineId})`,
    `  route ${receipt.method} ${receipt.route}`,
    `  connected host: ${receipt.connectedHostBaseUrl}`,
    `  schedule ${receipt.scheduleName}${receipt.scheduleId ? ` (${receipt.scheduleId})` : ''}`,
    receipt.scheduleStatus ? `  schedule status ${receipt.scheduleStatus}` : '',
    `  cadence: ${receipt.scheduleKind} ${receipt.scheduleValue}${receipt.timezone ? ` [${receipt.timezone}]` : ''}`,
    `  enabled ${receipt.enabled ? 'yes' : 'no'}`,
    receipt.provider ? `  provider ${receipt.provider}` : '',
    receipt.model ? `  model ${receipt.model}` : '',
    `  target ${formatDeliveryTargetKind(receipt.target)}`,
    receipt.deliveryMode ? `  delivery: ${receipt.deliveryMode}` : '',
    ...(receipt.deliveryTargets ?? []).map((target) => `  delivery target: ${formatDeliveryTarget(target)}`),
    receipt.failureKind ? `  failure: ${receipt.failureKind}` : '',
    receipt.failureError ? `  error: ${receipt.failureError}` : '',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function formatRoutineScheduleCorrelation(result: RoutineScheduleCorrelationResult, limit = 10): string {
  if (!result.ok) {
    return [
      `GoodVibes schedule reconciliation error ${formatRoutineScheduleFailureKind(result.kind)}`,
      `  ${result.error}`,
      result.baseUrl ? `  connected host ${result.baseUrl}` : null,
      `  route ${ROUTINE_SCHEDULE_LIST_METHOD} ${result.route}`,
      result.kind === 'auth_required'
        ? '  next pair/authenticate with the connected GoodVibes host, then retry.'
        : null,
      result.kind === 'connected_host_unavailable'
        ? '  next make the connected GoodVibes host available outside Agent, then retry.'
        : null,
      result.kind === 'connected_host_incompatible' || result.kind === 'connected_host_route_unavailable'
        ? '  next update the connected GoodVibes host so public automation.schedules.list is available.'
        : null,
    ].filter((line): line is string => Boolean(line)).join('\n');
  }
  const correlations = result.correlations.slice(0, Math.max(1, limit));
  if (result.receiptCount === 0) {
    return [
      'Agent routine schedule reconciliation',
      `  connected host: ${result.baseUrl}`,
      `  route: ${result.kind} ${result.route}`,
      `  live schedules: ${result.scheduleCount}`,
      '  No local routine promotion receipts exist yet.',
      '  Create one with /schedule promote-routine <routine-id> --cron <expr> --yes.',
    ].join('\n');
  }
  const matched = result.correlations.filter((entry) => entry.liveStatus === 'matched').length;
  const missing = result.correlations.filter((entry) => entry.liveStatus === 'missing').length;
  const failed = result.correlations.filter((entry) => entry.liveStatus === 'failed-receipt').length;
  return [
    'Agent routine schedule reconciliation',
    `  connected host: ${result.baseUrl}`,
    `  route: ${result.kind} ${result.route}`,
    `  receipts: ${result.receiptCount}; live schedules: ${result.scheduleCount}; matched: ${matched}; missing: ${missing}; failed receipts: ${failed}`,
    ...correlations.map((entry) => {
      const receipt = entry.receipt;
      const schedule = entry.schedule;
      const live = schedule
        ? ` live=${schedule.id}; status ${schedule.status ?? (schedule.enabled === false ? 'paused' : 'enabled')}`
        : '';
      const runs = schedule && schedule.runCount !== undefined
        ? ` runs ${schedule.runCount}/${schedule.successCount ?? 0}/${schedule.failureCount ?? 0}`
        : '';
      const next = schedule?.nextRunAt ? ` next ${new Date(schedule.nextRunAt).toISOString()}` : '';
      return `  ${receipt.id}  ${entry.liveStatus}  reason ${entry.matchReason}  routine ${receipt.routineId}  receipt schedule ${receipt.scheduleId ?? '(none)'}${live}${runs}${next}`;
    }),
    result.correlations.length > correlations.length ? `  ...${result.correlations.length - correlations.length} more` : '',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function formatRoutineScheduleFailure(failure: RoutineSchedulePromotionFailure): string {
  return [
    `GoodVibes schedule error ${formatRoutineScheduleFailureKind(failure.kind)}`,
    `  ${failure.error}`,
    failure.baseUrl ? `  connected host ${failure.baseUrl}` : null,
    `  route ${ROUTINE_SCHEDULE_METHOD} ${failure.route}`,
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
