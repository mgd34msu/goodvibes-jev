import { existsSync, readFileSync, renameSync } from 'node:fs';
import { writeStoreFile } from '@/utils/store-file.ts';
import { createBrowserGoodVibesSdk } from '@goodvibes-jev/engine/sdk/browser';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';
import { formatEveryInterval } from '@goodvibes-jev/engine/sdk/platform/automation';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { isRoutineScheduleDeliverySurfaceKind } from './routine-schedule-args.ts';
import {
  ROUTINE_SCHEDULE_LIST_METHOD,
  ROUTINE_SCHEDULE_METHOD,
  ROUTINE_SCHEDULE_ROUTE,
  type AgentConnectedHostConnection,
  type RoutineScheduleCorrelation,
  type RoutineScheduleCorrelationFailure,
  type RoutineScheduleCorrelationResult,
  type RoutineScheduleCorrelationSuccess,
  type RoutineScheduleDeliveryKind,
  type RoutineScheduleKind,
  type RoutineScheduleLiveRecord,
  type RoutineSchedulePromotionPreview,
  type RoutineSchedulePromotionResult,
  type RoutineScheduleReceipt,
  type RoutineScheduleReceiptDeliveryTarget,
  type RoutineScheduleReceiptSnapshot,
} from './routine-schedule-promotion.ts';

type ScheduleCreateInput = RoutineSchedulePromotionPreview['payload'];
type ScheduleDeliveryInput = NonNullable<ScheduleCreateInput['delivery']>;
type ScheduleListOutput = OperatorMethodOutput<'automation.schedules.list'>;

interface RoutineScheduleReceiptStoreFile {
  readonly version: 1;
  readonly receipts: readonly RoutineScheduleReceipt[];
}

const RECEIPT_STORE_VERSION = 1;

/**
 * Count cap on stored routine-schedule receipts. These are low volume, one per
 * promotion attempt, which is a deliberate user action rather than a per-turn
 * event, so 200 is many months of normal use while still bounding the file to a
 * few hundred KB. Applied together with the age TTL: a receipt must survive BOTH.
 */
const ROUTINE_SCHEDULE_RECEIPT_LIMIT = 200;
/**
 * Age TTL on stored routine-schedule receipts. A receipt records a promotion
 * attempt against the connected host; after a quarter the live schedule (or its
 * absence) is the authority and the local record is history nobody consults.
 * 90 days is longer than the prompt-receipt TTL because these are rare, small,
 * and describe lasting host state rather than one turn.
 */
const ROUTINE_SCHEDULE_RECEIPT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Grace window before a receipt whose schedule the host does not list may be
 * reaped. A schedule created seconds ago can legitimately be absent from a list
 * response that raced it; five minutes is far longer than that window and far
 * shorter than the TTL, so a genuinely orphaned receipt still retires promptly.
 */
const ROUTINE_SCHEDULE_RECEIPT_REAP_GRACE_MS = 5 * 60 * 1000;

/** What a store read/prune had to recover from or reclaim, the disclosure record. */
export interface RoutineScheduleReceiptMaintenance {
  readonly path: string;
  /** How the last read had to degrade, if at all. */
  readonly recovered: 'none' | 'unreadable' | 'empty-file' | 'quarantined' | 'quarantine-failed';
  /** Receipts dropped because they aged past the TTL. */
  readonly expired: number;
  /** Receipts dropped because they fell outside the count cap. */
  readonly overflow: number;
  readonly kept: number;
}

/** What a reconcile-time reap removed, the disclosure record. */
export interface RoutineScheduleReceiptReaping {
  /** False when the connected host was not authoritative (unreachable/auth/route failure): nothing is ever reaped then. */
  readonly authoritative: boolean;
  readonly reaped: number;
  /** Receipts the host did not list but that are too young to reap yet. */
  readonly withinGrace: number;
}

interface ReceiptPruneOutcome {
  readonly kept: readonly RoutineScheduleReceipt[];
  readonly expired: number;
  readonly overflow: number;
}

/**
 * Apply BOTH bounds: the age TTL first, then the count cap over what is left.
 * Receipts are ordered oldest-first so the tail is the newest set. A receipt with
 * an unparseable createdAt is kept, a bad timestamp must never read as "old".
 */
function pruneReceipts(
  receipts: readonly RoutineScheduleReceipt[],
  now: number,
  limit: number,
  maxAgeMs: number,
): ReceiptPruneOutcome {
  const ordered = [...receipts].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const fresh = ordered.filter((receipt) => {
    const created = Date.parse(receipt.createdAt);
    return !Number.isFinite(created) || now - created <= maxAgeMs;
  });
  const kept = fresh.slice(-Math.max(1, limit));
  return { kept, expired: ordered.length - fresh.length, overflow: fresh.length - kept.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function redactedDeliveryAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  try {
    const url = new URL(address);
    return `${url.protocol}//${url.host}/...`;
  } catch {
    return '[redacted]';
  }
}

function redactedDeliveryTargets(delivery: ScheduleDeliveryInput | undefined): readonly RoutineScheduleReceiptDeliveryTarget[] | undefined {
  if (!delivery) return undefined;
  return delivery.targets.map((target) => ({
    kind: target.kind as RoutineScheduleDeliveryKind,
    surfaceKind: typeof target.surfaceKind === 'string' && isRoutineScheduleDeliverySurfaceKind(target.surfaceKind) ? target.surfaceKind : undefined,
    address: redactedDeliveryAddress(typeof target.address === 'string' ? target.address : undefined),
    routeId: typeof target.routeId === 'string' ? target.routeId : undefined,
    label: typeof target.label === 'string' ? target.label : undefined,
  }));
}

function normalizeFailureKind(value: unknown): RoutineScheduleReceipt['failureKind'] {
  if (value === 'confirmation_required' || value === 'auth_required' || value === 'connected_host_incompatible') return value;
  if (value === 'connected_host_unavailable' || value === 'connected_host_route_unavailable' || value === 'connected_host_error') return value;
  if (value === 'daemon_unavailable') return 'connected_host_unavailable';
  if (value === 'daemon_route_unavailable') return 'connected_host_route_unavailable';
  if (value === 'daemon_error') return 'connected_host_error';
  return undefined;
}

function readReceipt(value: unknown): RoutineScheduleReceipt | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id')?.trim();
  const createdAt = readString(value, 'createdAt')?.trim();
  const routineId = readString(value, 'routineId')?.trim();
  const routineName = readString(value, 'routineName')?.trim();
  const status = value.status === 'created' || value.status === 'failed' ? value.status : null;
  const scheduleKind = value.scheduleKind === 'cron' || value.scheduleKind === 'every' || value.scheduleKind === 'at'
    ? value.scheduleKind
    : null;
  const scheduleValue = readString(value, 'scheduleValue')?.trim();
  const target = isRecord(value.target) ? value.target : {};
  const deliveryTargets = Array.isArray(value.deliveryTargets)
    ? value.deliveryTargets.map((target): RoutineScheduleReceiptDeliveryTarget | null => {
      if (!isRecord(target)) return null;
      const kind = target.kind === 'webhook' || target.kind === 'surface' || target.kind === 'integration' || target.kind === 'link'
        ? target.kind
        : null;
      if (!kind) return null;
      const surfaceKind = readString(target, 'surfaceKind') ?? undefined;
      return {
        kind,
        surfaceKind: surfaceKind && isRoutineScheduleDeliverySurfaceKind(surfaceKind) ? surfaceKind : undefined,
        address: readString(target, 'address') ?? undefined,
        routeId: readString(target, 'routeId') ?? undefined,
        label: readString(target, 'label') ?? undefined,
      };
    }).filter((target): target is RoutineScheduleReceiptDeliveryTarget => target !== null)
    : undefined;
  if (!id || !createdAt || !routineId || !routineName || !status || !scheduleKind || !scheduleValue) return null;
  return {
    id,
    createdAt,
    routineId,
    routineName,
    route: ROUTINE_SCHEDULE_ROUTE,
    method: ROUTINE_SCHEDULE_METHOD,
    status,
    connectedHostBaseUrl: readString(value, 'connectedHostBaseUrl') ?? readString(value, 'daemonBaseUrl') ?? '',
    scheduleId: readString(value, 'scheduleId') ?? undefined,
    scheduleStatus: readString(value, 'scheduleStatus') ?? undefined,
    scheduleName: readString(value, 'scheduleName') ?? routineName,
    scheduleKind,
    scheduleValue,
    timezone: readString(value, 'timezone') ?? undefined,
    provider: readString(value, 'provider') ?? undefined,
    model: readString(value, 'model') ?? undefined,
    enabled: value.enabled !== false,
    target: {
      kind: readString(target, 'kind') ?? undefined,
      surfaceKind: readString(target, 'surfaceKind') ?? undefined,
      preserveThread: readBoolean(target, 'preserveThread'),
      createIfMissing: readBoolean(target, 'createIfMissing'),
    },
    deliveryMode: readString(value, 'deliveryMode') ?? undefined,
    deliveryTargets,
    failureKind: normalizeFailureKind(value.failureKind),
    failureError: readString(value, 'failureError') ?? undefined,
  };
}

function parseReceiptStore(raw: string): RoutineScheduleReceiptStoreFile {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return { version: RECEIPT_STORE_VERSION, receipts: [] };
  return {
    version: RECEIPT_STORE_VERSION,
    receipts: Array.isArray(parsed.receipts)
      ? parsed.receipts.map(readReceipt).filter((receipt): receipt is RoutineScheduleReceipt => receipt !== null)
      : [],
  };
}

function formatReceiptStore(store: RoutineScheduleReceiptStoreFile): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

function receiptId(createdAt: string, routineId: string, existing: readonly RoutineScheduleReceipt[]): string {
  const dayStamp = createdAt.slice(0, 10).replace(/-/g, '');
  const base = `routine-schedule-${routineId}-${dayStamp}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ids = new Set(existing.map((receipt) => receipt.id));
  if (!ids.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `${base}-${existing.length + 1}`;
}

function scheduleValue(payload: ScheduleCreateInput): string {
  if (payload.kind === 'cron') return String(payload.cron ?? '');
  if (payload.kind === 'every') return String(payload.every ?? '');
  return String(payload.at ?? '');
}

function scheduleKind(payload: ScheduleCreateInput): RoutineScheduleKind {
  if (payload.kind === 'cron' || payload.kind === 'every' || payload.kind === 'at') return payload.kind;
  throw new Error('Routine schedule payload is missing a schedule kind.');
}

function targetSummary(payload: ScheduleCreateInput): RoutineScheduleReceipt['target'] {
  return isRecord(payload.target)
    ? {
      kind: typeof payload.target.kind === 'string' ? payload.target.kind : undefined,
      surfaceKind: typeof payload.target.surfaceKind === 'string' ? payload.target.surfaceKind : undefined,
      preserveThread: typeof payload.target.preserveThread === 'boolean' ? payload.target.preserveThread : undefined,
      createIfMissing: typeof payload.target.createIfMissing === 'boolean' ? payload.target.createIfMissing : undefined,
    }
    : {};
}

function deliveryMode(payload: ScheduleCreateInput): string | undefined {
  return isRecord(payload.delivery) && typeof payload.delivery.mode === 'string' ? payload.delivery.mode : undefined;
}

function resultScheduleRecord(result: RoutineSchedulePromotionResult): Record<string, unknown> {
  return result.ok && isRecord(result.schedule) ? result.schedule : {};
}

function buildReceipt(
  existing: readonly RoutineScheduleReceipt[],
  connection: AgentConnectedHostConnection,
  preview: RoutineSchedulePromotionPreview,
  result: RoutineSchedulePromotionResult,
): RoutineScheduleReceipt {
  const createdAt = nowIso();
  const kind = scheduleKind(preview.payload);
  const schedule = resultScheduleRecord(result);
  const scheduleId = readString(schedule, 'id') ?? undefined;
  const scheduleStatus = readString(schedule, 'status') ?? (schedule.enabled === false ? 'paused' : schedule.enabled === true ? 'enabled' : undefined);
  return {
    id: receiptId(createdAt, preview.routineId, existing),
    createdAt,
    routineId: preview.routineId,
    routineName: preview.routineName,
    route: ROUTINE_SCHEDULE_ROUTE,
    method: ROUTINE_SCHEDULE_METHOD,
    status: result.ok ? 'created' : 'failed',
    connectedHostBaseUrl: connection.baseUrl,
    scheduleId,
    scheduleStatus,
    scheduleName: String(preview.payload.name ?? `Agent routine: ${preview.routineName}`),
    scheduleKind: kind,
    scheduleValue: scheduleValue(preview.payload),
    timezone: kind === 'cron' ? preview.payload.timezone : undefined,
    provider: preview.payload.provider,
    model: preview.payload.model,
    enabled: preview.payload.enabled !== false,
    target: targetSummary(preview.payload),
    deliveryMode: deliveryMode(preview.payload),
    deliveryTargets: redactedDeliveryTargets(preview.payload.delivery),
    failureKind: result.ok ? undefined : result.kind,
    failureError: result.ok ? undefined : result.error,
  };
}

export function routineScheduleReceiptStorePath(shellPaths: ShellPathService): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'routines', 'schedule-receipts.json');
}

export class RoutineScheduleReceiptStore {
  private lastMaintenanceSummary: RoutineScheduleReceiptMaintenance | null = null;

  public constructor(
    private readonly storePath: string,
    private readonly limit = ROUTINE_SCHEDULE_RECEIPT_LIMIT,
    private readonly maxAgeMs = ROUTINE_SCHEDULE_RECEIPT_MAX_AGE_MS,
  ) {}

  public static fromShellPaths(shellPaths: ShellPathService): RoutineScheduleReceiptStore {
    return new RoutineScheduleReceiptStore(routineScheduleReceiptStorePath(shellPaths));
  }

  public get path(): string {
    return this.storePath;
  }

  /** The last read/prune's disclosure record, or null when the store has not been read yet. */
  public lastMaintenance(): RoutineScheduleReceiptMaintenance | null {
    return this.lastMaintenanceSummary;
  }

  public snapshot(): RoutineScheduleReceiptSnapshot {
    // Reading is the recovery point for this store: apply both bounds here and
    // persist the result when anything was actually dropped, so housekeeping is
    // not limited to the write path. A second call drops nothing and writes
    // nothing, which keeps the sweep idempotent.
    const store = this.readStore();
    const prune = pruneReceipts(store.receipts, Date.now(), this.limit, this.maxAgeMs);
    if (prune.expired > 0 || prune.overflow > 0) {
      this.writeStore({ version: RECEIPT_STORE_VERSION, receipts: prune.kept });
      logger.info('Agent routine schedule receipts pruned', {
        path: this.storePath,
        expired: prune.expired,
        overflow: prune.overflow,
        kept: prune.kept.length,
      });
    }
    this.lastMaintenanceSummary = {
      path: this.storePath,
      recovered: this.lastMaintenanceSummary?.recovered ?? 'none',
      expired: prune.expired,
      overflow: prune.overflow,
      kept: prune.kept.length,
    };
    return {
      path: this.storePath,
      receipts: [...prune.kept].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    };
  }

  public get(id: string): RoutineScheduleReceipt | null {
    const normalized = id.trim().toLowerCase();
    if (!normalized) return null;
    return this.snapshot().receipts.find((receipt) => receipt.id.toLowerCase() === normalized) ?? null;
  }

  public append(connection: AgentConnectedHostConnection, preview: RoutineSchedulePromotionPreview, result: RoutineSchedulePromotionResult): RoutineScheduleReceipt {
    const store = this.readStore();
    const receipt = buildReceipt(store.receipts, connection, preview, result);
    const prune = pruneReceipts([...store.receipts, receipt], Date.now(), this.limit, this.maxAgeMs);
    this.writeStore({ version: RECEIPT_STORE_VERSION, receipts: prune.kept });
    if (prune.expired > 0 || prune.overflow > 0) {
      logger.info('Agent routine schedule receipts pruned on append', {
        path: this.storePath,
        expired: prune.expired,
        overflow: prune.overflow,
        kept: prune.kept.length,
      });
    }
    return receipt;
  }

  /**
   * Remove receipts by id. Returns how many were actually removed, so a repeat
   * call over the same ids removes nothing and rewrites nothing.
   */
  public remove(receiptIds: readonly string[]): number {
    const ids = new Set(receiptIds.map((id) => id.trim().toLowerCase()).filter(Boolean));
    if (ids.size === 0) return 0;
    const store = this.readStore();
    const kept = store.receipts.filter((receipt) => !ids.has(receipt.id.toLowerCase()));
    const removed = store.receipts.length - kept.length;
    if (removed === 0) return 0;
    this.writeStore({ version: RECEIPT_STORE_VERSION, receipts: kept });
    return removed;
  }

  /**
   * Read the store, degrading to "no receipts" for anything a crash can leave
   * behind, an unreadable file, a zero-byte file, a truncated JSON body. A
   * corrupt (non-empty, unparseable) body is preserved by renaming it aside
   * rather than being silently discarded; the quarantine slot is a single fixed
   * name that is overwritten, so it cannot itself accumulate.
   */
  private readStore(): RoutineScheduleReceiptStoreFile {
    const empty: RoutineScheduleReceiptStoreFile = { version: RECEIPT_STORE_VERSION, receipts: [] };
    if (!existsSync(this.storePath)) return empty;
    let raw = '';
    try {
      raw = readFileSync(this.storePath, 'utf-8');
    } catch (error) {
      this.noteRecovery('unreadable');
      logger.warn('Agent routine schedule receipt store could not be read; continuing with no receipts', {
        path: this.storePath,
        error: summarizeError(error),
      });
      return empty;
    }
    if (!raw.trim()) {
      this.noteRecovery('empty-file');
      logger.warn('Agent routine schedule receipt store is empty (torn or interrupted write); continuing with no receipts', {
        path: this.storePath,
        bytes: Buffer.byteLength(raw, 'utf-8'),
      });
      return empty;
    }
    try {
      return parseReceiptStore(raw);
    } catch (error) {
      this.quarantine(Buffer.byteLength(raw, 'utf-8'), error);
      return empty;
    }
  }

  private noteRecovery(recovered: RoutineScheduleReceiptMaintenance['recovered']): void {
    this.lastMaintenanceSummary = {
      path: this.storePath,
      recovered,
      expired: 0,
      overflow: 0,
      kept: 0,
    };
  }

  private quarantine(bytes: number, error: unknown): void {
    const quarantinePath = `${this.storePath}.corrupt`;
    let preserved = false;
    try {
      renameSync(this.storePath, quarantinePath);
      preserved = true;
    } catch {
      preserved = false;
    }
    this.noteRecovery(preserved ? 'quarantined' : 'quarantine-failed');
    logger.error('Agent routine schedule receipt store was unreadable; continuing with no receipts', {
      path: this.storePath,
      bytes,
      preserved,
      ...(preserved ? { quarantinePath } : {}),
      error: summarizeError(error),
    });
  }

  private writeStore(store: RoutineScheduleReceiptStoreFile): void {
    writeStoreFile(this.storePath, formatReceiptStore(store));
  }
}

/**
 * Reap receipts whose schedule the connected host authoritatively does not have.
 *
 * Only a successful `automation.schedules.list` is authoritative: when the host
 * is unreachable, unauthorized, or on an incompatible route, `result.ok` is false
 * and NOTHING is reaped, an absent list is not evidence of an absent schedule.
 * Receipts younger than the grace window are also left alone so a schedule created
 * moments ago is never mistaken for one that vanished. Idempotent: the second run
 * finds the receipts already gone and removes nothing.
 */
export function reapMissingRoutineScheduleReceipts(
  store: RoutineScheduleReceiptStore,
  result: RoutineScheduleCorrelationResult,
  now: number = Date.now(),
): RoutineScheduleReceiptReaping {
  if (!result.ok) return { authoritative: false, reaped: 0, withinGrace: 0 };
  const reapable: string[] = [];
  let withinGrace = 0;
  for (const correlation of result.correlations) {
    if (correlation.liveStatus !== 'missing') continue;
    const created = Date.parse(correlation.receipt.createdAt);
    if (Number.isFinite(created) && now - created < ROUTINE_SCHEDULE_RECEIPT_REAP_GRACE_MS) {
      withinGrace += 1;
      continue;
    }
    reapable.push(correlation.receipt.id);
  }
  const reaped = store.remove(reapable);
  if (reaped > 0) {
    logger.info('Agent routine schedule receipts reaped: the connected host no longer has these schedules', {
      path: store.path,
      reaped,
      withinGrace,
      scheduleCount: result.scheduleCount,
    });
  }
  return { authoritative: true, reaped, withinGrace };
}

function normalizeForMatch(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isoTime(value: string): string | null {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function readLiveScheduleDefinition(value: unknown): {
  readonly kind?: RoutineScheduleKind;
  readonly value?: string;
  readonly timezone?: string;
} {
  if (!isRecord(value)) return {};
  if (value.kind === 'cron') {
    return {
      kind: 'cron',
      value: readString(value, 'expression') ?? undefined,
      timezone: readString(value, 'timezone') ?? undefined,
    };
  }
  if (value.kind === 'every') {
    const intervalMs = readNumber(value, 'intervalMs');
    return {
      kind: 'every',
      value: intervalMs === undefined ? undefined : formatEveryInterval(intervalMs),
    };
  }
  if (value.kind === 'at') {
    const at = readNumber(value, 'at');
    return {
      kind: 'at',
      value: at === undefined ? undefined : new Date(at).toISOString(),
    };
  }
  return {};
}

function readLiveScheduleRecord(value: unknown): RoutineScheduleLiveRecord | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id')?.trim();
  const name = readString(value, 'name')?.trim();
  if (!id || !name) return null;
  const schedule = readLiveScheduleDefinition(value.schedule);
  return {
    id,
    name,
    status: readString(value, 'status') ?? undefined,
    enabled: readBoolean(value, 'enabled'),
    scheduleKind: schedule.kind,
    scheduleValue: schedule.value,
    timezone: schedule.timezone,
    nextRunAt: readNumber(value, 'nextRunAt'),
    lastRunAt: readNumber(value, 'lastRunAt'),
    runCount: readNumber(value, 'runCount'),
    successCount: readNumber(value, 'successCount'),
    failureCount: readNumber(value, 'failureCount'),
  };
}

function readLiveSchedules(output: ScheduleListOutput): readonly RoutineScheduleLiveRecord[] {
  const record: Record<string, unknown> = isRecord(output) ? output : {};
  const jobs: readonly unknown[] = Array.isArray(record.jobs) ? record.jobs : [];
  return jobs.map(readLiveScheduleRecord).filter((schedule): schedule is RoutineScheduleLiveRecord => schedule !== null);
}

function cadenceMatches(receipt: RoutineScheduleReceipt, schedule: RoutineScheduleLiveRecord): boolean {
  if (receipt.scheduleKind !== schedule.scheduleKind) return false;
  if (receipt.scheduleKind === 'at') {
    const left = isoTime(receipt.scheduleValue);
    const right = schedule.scheduleValue ? isoTime(schedule.scheduleValue) : null;
    return Boolean(left && right && left === right);
  }
  return normalizeForMatch(receipt.scheduleValue) === normalizeForMatch(schedule.scheduleValue);
}

function findScheduleForReceipt(
  receipt: RoutineScheduleReceipt,
  schedules: readonly RoutineScheduleLiveRecord[],
): { readonly reason: RoutineScheduleCorrelation['matchReason']; readonly schedule?: RoutineScheduleLiveRecord } {
  if (receipt.scheduleId) {
    const byId = schedules.find((schedule) => schedule.id === receipt.scheduleId);
    if (byId) return { reason: 'schedule-id', schedule: byId };
  }
  const byNameAndCadence = schedules.find((schedule) => (
    normalizeForMatch(schedule.name) === normalizeForMatch(receipt.scheduleName)
    && cadenceMatches(receipt, schedule)
  ));
  return byNameAndCadence
    ? { reason: 'name-and-cadence', schedule: byNameAndCadence }
    : { reason: 'not-found' };
}

function correlateReceipts(
  receipts: readonly RoutineScheduleReceipt[],
  schedules: readonly RoutineScheduleLiveRecord[],
): readonly RoutineScheduleCorrelation[] {
  return receipts.map((receipt) => {
    if (receipt.status === 'failed') {
      return {
        receipt,
        liveStatus: 'failed-receipt',
        matchReason: 'failed-receipt',
      };
    }
    const match = findScheduleForReceipt(receipt, schedules);
    return match.schedule
      ? {
        receipt,
        liveStatus: 'matched',
        matchReason: match.reason,
        schedule: match.schedule,
      }
      : {
        receipt,
        liveStatus: 'missing',
        matchReason: 'not-found',
      };
  });
}

async function fetchConnectedHostStatus(connection: AgentConnectedHostConnection): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}> {
  try {
    const response = await fetch(`${connection.baseUrl}/status`, {
      headers: connection.token ? { authorization: `Bearer ${connection.token}` } : undefined,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text.trim() ? JSON.parse(text) as unknown : {};
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: summarizeError(error) };
  }
}

async function classifyScheduleListError(
  error: unknown,
  connection: AgentConnectedHostConnection,
): Promise<RoutineScheduleCorrelationFailure> {
  const message = summarizeError(error);
  const lower = message.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return { ok: false, kind: 'auth_required', error: message, route: ROUTINE_SCHEDULE_ROUTE, baseUrl: connection.baseUrl };
  }
  if (lower.includes('404') || lower.includes('not found')) {
    const connectedHost = await fetchConnectedHostStatus(connection);
    if (connectedHost.ok) {
      return {
        ok: false,
        kind: 'connected_host_incompatible',
        error: 'Connected GoodVibes host compatibility does not satisfy Agent schedule requirements; automation.schedules.list is unavailable.',
        route: ROUTINE_SCHEDULE_ROUTE,
        baseUrl: connection.baseUrl,
      };
    }
    return { ok: false, kind: 'connected_host_route_unavailable', error: message, route: ROUTINE_SCHEDULE_ROUTE, baseUrl: connection.baseUrl };
  }
  if (lower.includes('fetch') || lower.includes('connect') || lower.includes('econnrefused')) {
    return { ok: false, kind: 'connected_host_unavailable', error: message, route: ROUTINE_SCHEDULE_ROUTE, baseUrl: connection.baseUrl };
  }
  return { ok: false, kind: 'connected_host_error', error: message, route: ROUTINE_SCHEDULE_ROUTE, baseUrl: connection.baseUrl };
}

/**
 * Correlate local receipts against the connected host's live schedules.
 *
 * This is the one place where receipt liveness against the host is actually
 * known, so it is where orphaned receipts retire: a successful list response
 * drives reapMissingRoutineScheduleReceipts. A failed response reaps nothing. The
 * store defaults to the one the snapshot came from (snapshot.path), so every
 * existing caller gets the housekeeping without passing anything; pass `store`
 * explicitly to point the reap somewhere else. The returned correlations still
 * describe what was found missing, so the surface can show it before it is gone.
 */
export async function reconcileRoutineScheduleReceipts(
  connection: AgentConnectedHostConnection,
  snapshot: RoutineScheduleReceiptSnapshot,
  store?: RoutineScheduleReceiptStore,
): Promise<RoutineScheduleCorrelationResult> {
  if (!connection.token) {
    return {
      ok: false,
      kind: 'auth_required',
      error: `No connected-host operator token found at ${connection.tokenPath}`,
      route: ROUTINE_SCHEDULE_ROUTE,
      baseUrl: connection.baseUrl,
    };
  }
  try {
    const sdk = createBrowserGoodVibesSdk({ baseUrl: connection.baseUrl, authToken: connection.token });
    const output = await sdk.operator.invoke(ROUTINE_SCHEDULE_LIST_METHOD, {});
    const schedules = readLiveSchedules(output);
    const result: RoutineScheduleCorrelationSuccess = {
      ok: true,
      kind: ROUTINE_SCHEDULE_LIST_METHOD,
      route: ROUTINE_SCHEDULE_ROUTE,
      baseUrl: connection.baseUrl,
      scheduleCount: schedules.length,
      receiptCount: snapshot.receipts.length,
      correlations: correlateReceipts(snapshot.receipts, schedules),
    };
    const reapTarget = store ?? (snapshot.path ? new RoutineScheduleReceiptStore(snapshot.path) : null);
    if (reapTarget) reapMissingRoutineScheduleReceipts(reapTarget, result);
    return result;
  } catch (error) {
    return classifyScheduleListError(error, connection);
  }
}

export interface LiveSchedulesFetch {
  readonly ok: boolean;
  readonly schedules: readonly RoutineScheduleLiveRecord[];
  readonly error?: string;
}

/**
 * Fetch every live schedule from the connected host, with no local-receipt
 * correlation attached, the plain list the /schedule list surface needs.
 * Never throws; connection/auth/host failures resolve to { ok: false }.
 */
export async function fetchLiveSchedules(connection: AgentConnectedHostConnection): Promise<LiveSchedulesFetch> {
  if (!connection.token) {
    return { ok: false, schedules: [], error: `No connected-host operator token found at ${connection.tokenPath}` };
  }
  try {
    const sdk = createBrowserGoodVibesSdk({ baseUrl: connection.baseUrl, authToken: connection.token });
    const output = await sdk.operator.invoke(ROUTINE_SCHEDULE_LIST_METHOD, {});
    return { ok: true, schedules: readLiveSchedules(output) };
  } catch (error) {
    return { ok: false, schedules: [], error: summarizeError(error) };
  }
}
