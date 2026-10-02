import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBrowserGoodVibesSdk } from '@goodvibes-jev/engine/sdk/browser';
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { connectedHostBaseUrl } from '../config/connected-host-dial.ts';
import { formatAgentRecordReviewState } from './record-labels.ts';
import type { AgentRoutineRecord } from './routine-registry.ts';
import {
  deliveryModeFromTargets,
  normalizeProviderModel,
  toDeliveryTargetInput,
  type RoutineScheduleDeliveryKind,
  type RoutineScheduleDeliverySurfaceKind,
  type RoutineScheduleDeliveryTargetSpec,
} from './schedule-delivery-targets.ts';

export const ROUTINE_SCHEDULE_ROUTE = '/api/automation/schedules';
export const ROUTINE_SCHEDULE_METHOD = 'automation.schedules.create';
export const ROUTINE_SCHEDULE_LIST_METHOD = 'automation.schedules.list';

type ScheduleCreateInput = OperatorMethodInput<'automation.schedules.create'>;
type ScheduleCreateOutput = OperatorMethodOutput<'automation.schedules.create'>;

export interface AgentConnectedHostConfigReader {
  get(key: string): unknown;
}

export interface AgentConnectedHostConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly tokenPath: string;
}

export type RoutineScheduleKind = 'cron' | 'every' | 'at';

export interface RoutineScheduleSpec {
  readonly kind: RoutineScheduleKind;
  readonly value: string;
}

// The delivery-target vocabulary is owned by schedule-delivery-targets.ts and
// re-exported here so existing importers keep one import site.
export type {
  RoutineScheduleDeliveryKind,
  RoutineScheduleDeliverySurfaceKind,
  RoutineScheduleDeliveryTargetSpec,
} from './schedule-delivery-targets.ts';

export interface RoutineScheduleReceiptDeliveryTarget {
  readonly kind: RoutineScheduleDeliveryKind;
  readonly surfaceKind?: RoutineScheduleDeliverySurfaceKind;
  readonly address?: string;
  readonly routeId?: string;
  readonly label?: string;
}

export interface ParsedRoutineSchedulePromotionArgs {
  readonly routineId: string | null;
  readonly schedule: RoutineScheduleSpec | null;
  readonly deliveryTargets: readonly RoutineScheduleDeliveryTargetSpec[];
  readonly name?: string;
  readonly timezone?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly enabled: boolean;
  readonly yes: boolean;
  readonly errors: readonly string[];
}

export interface RoutineSchedulePromotionPreview {
  readonly routineId: string;
  readonly routineName: string;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly method: typeof ROUTINE_SCHEDULE_METHOD;
  readonly payload: ScheduleCreateInput;
}

export interface RoutineSchedulePromotionSuccess {
  readonly ok: true;
  readonly kind: typeof ROUTINE_SCHEDULE_METHOD;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly routineId: string;
  readonly routineName: string;
  readonly schedule: ScheduleCreateOutput;
  readonly request: ScheduleCreateInput;
}

export interface RoutineSchedulePromotionFailure {
  readonly ok: false;
  readonly kind:
    | 'confirmation_required'
    | 'auth_required'
    | 'connected_host_unavailable'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error';
  readonly error: string;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly baseUrl?: string;
}

export type RoutineSchedulePromotionResult =
  | RoutineSchedulePromotionSuccess
  | RoutineSchedulePromotionFailure;

export interface RoutineScheduleReceipt {
  readonly id: string;
  readonly createdAt: string;
  readonly routineId: string;
  readonly routineName: string;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly method: typeof ROUTINE_SCHEDULE_METHOD;
  readonly status: 'created' | 'failed';
  readonly connectedHostBaseUrl: string;
  readonly scheduleId?: string;
  readonly scheduleStatus?: string;
  readonly scheduleName: string;
  readonly scheduleKind: RoutineScheduleKind;
  readonly scheduleValue: string;
  readonly timezone?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly enabled: boolean;
  readonly target: {
    readonly kind?: string;
    readonly surfaceKind?: string;
    readonly preserveThread?: boolean;
    readonly createIfMissing?: boolean;
  };
  readonly deliveryMode?: string;
  readonly deliveryTargets?: readonly RoutineScheduleReceiptDeliveryTarget[];
  readonly failureKind?: RoutineSchedulePromotionFailure['kind'];
  readonly failureError?: string;
}

export interface RoutineScheduleReceiptSnapshot {
  readonly path: string;
  readonly receipts: readonly RoutineScheduleReceipt[];
}

export interface RoutineScheduleLiveRecord {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly enabled?: boolean;
  readonly scheduleKind?: RoutineScheduleKind;
  readonly scheduleValue?: string;
  readonly timezone?: string;
  readonly nextRunAt?: number;
  readonly lastRunAt?: number;
  readonly runCount?: number;
  readonly successCount?: number;
  readonly failureCount?: number;
}

export interface RoutineScheduleCorrelation {
  readonly receipt: RoutineScheduleReceipt;
  readonly liveStatus: 'matched' | 'missing' | 'failed-receipt';
  readonly matchReason: 'schedule-id' | 'name-and-cadence' | 'failed-receipt' | 'not-found';
  readonly schedule?: RoutineScheduleLiveRecord;
}

export interface RoutineScheduleCorrelationSuccess {
  readonly ok: true;
  readonly kind: typeof ROUTINE_SCHEDULE_LIST_METHOD;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly baseUrl: string;
  readonly scheduleCount: number;
  readonly receiptCount: number;
  readonly correlations: readonly RoutineScheduleCorrelation[];
}

export interface RoutineScheduleCorrelationFailure {
  readonly ok: false;
  readonly kind:
    | 'auth_required'
    | 'connected_host_unavailable'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error';
  readonly error: string;
  readonly route: typeof ROUTINE_SCHEDULE_ROUTE;
  readonly baseUrl?: string;
}

export type RoutineScheduleCorrelationResult =
  | RoutineScheduleCorrelationSuccess
  | RoutineScheduleCorrelationFailure;


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

export function resolveAgentConnectedHostConnection(
  configManager: AgentConnectedHostConfigReader,
  homeDirectory: string,
): AgentConnectedHostConnection {
  const baseUrl = connectedHostBaseUrl(
    configManager.get('controlPlane.host'),
    configManager.get('controlPlane.port'),
  );
  const tokenPath = join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
  if (!existsSync(tokenPath)) return { baseUrl, token: null, tokenPath };
  try {
    const parsed = JSON.parse(readFileSync(tokenPath, 'utf-8')) as unknown;
    const token = isRecord(parsed) && typeof parsed.token === 'string' ? parsed.token : null;
    return { baseUrl, token, tokenPath };
  } catch {
    return { baseUrl, token: null, tokenPath };
  }
}

export function buildRoutineSchedulePrompt(routine: AgentRoutineRecord): string {
  return [
    'GoodVibes Agent scheduled routine.',
    '',
    `Routine: ${routine.name}`,
    `Routine reference: ${routine.id}`,
    `Review: ${formatAgentRecordReviewState(routine.reviewState)}`,
    `Tags: ${routine.tags.join(', ') || '(none)'}`,
    `Triggers: ${routine.triggers.join(', ') || '(manual)'}`,
    '',
    'Operator policy:',
    '- Run this as a serial GoodVibes Agent operator routine.',
    '- Use isolated Agent Knowledge routes only; never use default knowledge or non-Agent knowledge spaces as fallback.',
    '- Do not perform destructive, costly, externally visible, or secret-handling actions without explicit approval.',
    '- Do not request GoodVibes TUI delegation unless this scheduled routine explicitly delegates build/fix/review work to GoodVibes TUI.',
    '- Summarize what was checked, what changed, and what still needs user review.',
    '',
    'Routine description:',
    routine.description,
    '',
    'Routine steps:',
    routine.steps,
  ].join('\n');
}

export function buildRoutineSchedulePayload(
  routine: AgentRoutineRecord,
  parsed: ParsedRoutineSchedulePromotionArgs,
): ScheduleCreateInput {
  if (!parsed.schedule) throw new Error('Schedule is required.');
  const modelRoute = normalizeProviderModel(parsed.provider, parsed.model);
  const payload: ScheduleCreateInput = {
    name: parsed.name ?? `Agent routine: ${routine.name}`,
    prompt: buildRoutineSchedulePrompt(routine),
    kind: parsed.schedule.kind,
    enabled: parsed.enabled,
    target: {
      kind: 'main',
      surfaceKind: 'service',
      preserveThread: true,
      createIfMissing: true,
    },
    delivery: {
      mode: deliveryModeFromTargets(parsed.deliveryTargets),
      targets: parsed.deliveryTargets.map(toDeliveryTargetInput),
      fallbackTargets: [],
      includeSummary: true,
      includeTranscript: false,
      includeLinks: true,
    },
    failure: {
      action: 'retry',
      maxConsecutiveFailures: 3,
      cooldownMs: 3_600_000,
      retryPolicy: {
        maxAttempts: 2,
        delayMs: 60_000,
        strategy: 'exponential',
        maxDelayMs: 900_000,
        jitterMs: 30_000,
      },
      disableAfterFailures: false,
    },
    lightContext: true,
    autoApprove: false,
    allowUnsafeExternalContent: false,
    ...modelRoute,
  };
  if (parsed.schedule.kind === 'cron') {
    return {
      ...payload,
      cron: parsed.schedule.value,
      timezone: parsed.timezone,
    };
  }
  if (parsed.schedule.kind === 'every') {
    return { ...payload, every: parsed.schedule.value };
  }
  return { ...payload, at: parsed.schedule.value };
}

export function buildRoutineSchedulePreview(
  routine: AgentRoutineRecord,
  parsed: ParsedRoutineSchedulePromotionArgs,
): RoutineSchedulePromotionPreview {
  return {
    routineId: routine.id,
    routineName: routine.name,
    route: ROUTINE_SCHEDULE_ROUTE,
    method: ROUTINE_SCHEDULE_METHOD,
    payload: buildRoutineSchedulePayload(routine, parsed),
  };
}

/** Why a connected-host schedule call failed, in the shape every schedule command reports. */
export interface ConnectedHostScheduleFailure<Route extends string> {
  readonly ok: false;
  readonly kind:
    | 'auth_required'
    | 'connected_host_unavailable'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error';
  readonly error: string;
  readonly route: Route;
  readonly baseUrl?: string;
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

/**
 * Turn a thrown connected-host error into the failure a schedule command
 * reports, for every schedule command.
 *
 * A 404 is the one case that cannot be classified from the error alone: the
 * host may be absent, or present but too old to expose the method. That is
 * what the extra `/status` probe distinguishes, and why `incompatibleMessage`
 * is a parameter (it names the specific method the caller wanted).
 */
export async function classifyConnectedHostScheduleError<Route extends string>(
  error: unknown,
  connection: AgentConnectedHostConnection,
  options: { readonly route: Route; readonly incompatibleMessage: string },
): Promise<ConnectedHostScheduleFailure<Route>> {
  const message = summarizeError(error);
  const lower = message.toLowerCase();
  const base = { ok: false, error: message, route: options.route, baseUrl: connection.baseUrl } as const;
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return { ...base, kind: 'auth_required' };
  }
  if (lower.includes('404') || lower.includes('not found')) {
    const connectedHost = await fetchConnectedHostStatus(connection);
    if (connectedHost.ok) {
      return { ...base, kind: 'connected_host_incompatible', error: options.incompatibleMessage };
    }
    return { ...base, kind: 'connected_host_route_unavailable' };
  }
  if (lower.includes('fetch') || lower.includes('connect') || lower.includes('econnrefused')) {
    return { ...base, kind: 'connected_host_unavailable' };
  }
  return { ...base, kind: 'connected_host_error' };
}

const SCHEDULE_CREATE_INCOMPATIBLE_MESSAGE =
  'Connected GoodVibes host compatibility does not satisfy Agent schedule requirements; automation.schedules.create is unavailable.';

export async function promoteRoutineToConnectedSchedule(
  connection: AgentConnectedHostConnection,
  preview: RoutineSchedulePromotionPreview,
): Promise<RoutineSchedulePromotionResult> {
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
    const schedule = await sdk.operator.invoke(ROUTINE_SCHEDULE_METHOD, preview.payload);
    return {
      ok: true,
      kind: ROUTINE_SCHEDULE_METHOD,
      route: ROUTINE_SCHEDULE_ROUTE,
      routineId: preview.routineId,
      routineName: preview.routineName,
      schedule,
      request: preview.payload,
    };
  } catch (error) {
    return classifyConnectedHostScheduleError(error, connection, {
      route: ROUTINE_SCHEDULE_ROUTE,
      incompatibleMessage: SCHEDULE_CREATE_INCOMPATIBLE_MESSAGE,
    });
  }
}
