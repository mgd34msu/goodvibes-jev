import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';
import { resolveAgentConnectedHostConnection } from '../agent/routine-schedule-promotion.ts';
import { requireOperatorHttpBinding } from '../agent/operator-contract-routes.ts';

type JsonRecord = Record<string, unknown>;

interface OperatorRouteDescriptor {
  readonly id: string;
  readonly path: string;
}

interface OperatorRouteSuccess {
  readonly ok: true;
  readonly route: OperatorRouteDescriptor;
  readonly body: unknown;
}

interface OperatorRouteFailure {
  readonly ok: false;
  readonly route: OperatorRouteDescriptor;
  readonly kind: 'auth_required' | 'connected_host_unavailable' | 'connected_host_route_unavailable' | 'connected_host_error';
  readonly error: string;
}

type OperatorRouteResult = OperatorRouteSuccess | OperatorRouteFailure;

/**
 * The read-only methods a briefing is assembled from.
 *
 * Ids only: each one's path comes from the contract that publishes it, so the
 * briefing cannot end up reading a route the daemon has moved. Exported because
 * the connected-host capability report describes this same set, and describing
 * it from a second hand-written list is how the two came to disagree.
 */
export const OPERATOR_BRIEFING_METHOD_IDS = [
  'projectPlanning.workPlan.snapshot',
  'approvals.list',
  'automation.integration.snapshot',
  'automation.schedules.list',
  'scheduler.capacity',
] as const;

export function operatorBriefingRoutes(): readonly OperatorRouteDescriptor[] {
  return OPERATOR_BRIEFING_METHOD_IDS.map((id) => ({
    id,
    path: requireOperatorHttpBinding(id).pathTemplate,
  }));
}

// Resolved on first use, not at module load: the route lookup walks into the
// contract binding, and the single-file compiler's nondeterministic module
// order could evaluate this module before the contract's (the build-order
// lottery class fixed at runtime 2.0.13).
let operatorBriefingRoutesCache: readonly OperatorRouteDescriptor[] | null = null;
function briefingRoutes(): readonly OperatorRouteDescriptor[] {
  operatorBriefingRoutesCache ??= operatorBriefingRoutes();
  return operatorBriefingRoutesCache;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(value: unknown, key: string): JsonRecord {
  return isRecord(value) && isRecord(value[key]) ? value[key] as JsonRecord : {};
}

function readArray(value: unknown, key: string): readonly unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function readNumber(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : null;
}

function summarizeFetchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function classifyHttpFailure(route: OperatorRouteDescriptor, status: number, body: unknown): OperatorRouteFailure {
  const detail = isRecord(body) && typeof body.error === 'string' ? body.error : '';
  return {
    ok: false,
    route,
    kind: status === 401 || status === 403
      ? 'auth_required'
      : status === 404
        ? 'connected_host_route_unavailable'
        : 'connected_host_error',
    error: `HTTP ${status}${detail ? `: ${detail}` : ''}`,
  };
}

async function fetchOperatorRoute(
  baseUrl: string,
  token: string,
  route: OperatorRouteDescriptor,
): Promise<OperatorRouteResult> {
  try {
    const response = await fetch(`${baseUrl}${route.path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await readResponseBody(response);
    if (!response.ok) return classifyHttpFailure(route, response.status, body);
    return { ok: true, route, body };
  } catch (error) {
    return {
      ok: false,
      route,
      kind: 'connected_host_unavailable',
      error: summarizeFetchError(error),
    };
  }
}

function formatWorkPlan(body: unknown): string {
  const counts = readRecord(body, 'counts');
  const total = readNumber(counts, 'total') ?? readArray(body, 'tasks').length;
  return `  work plan: total ${total}; pending ${readNumber(counts, 'pending') ?? 0}; active ${readNumber(counts, 'in_progress') ?? 0}; blocked ${readNumber(counts, 'blocked') ?? 0}; done ${readNumber(counts, 'done') ?? 0}`;
}

function formatApprovals(body: unknown): string {
  const approvals = readArray(body, 'approvals');
  const pending = approvals.filter((entry) => readString(entry, 'status') === 'pending').length;
  return `  approvals: pending ${pending}; total ${approvals.length}; mode ${readString(body, 'mode') ?? 'unknown'}; awaiting decision ${readString(body, 'awaitingDecision') ?? String(Boolean(isRecord(body) && body.awaitingDecision))}`;
}

function formatAutomation(body: unknown): string {
  const totals = readRecord(body, 'totals');
  const jobs = readNumber(totals, 'jobs') ?? readArray(body, 'jobs').length;
  return `  automation: jobs ${jobs}; enabled ${readNumber(totals, 'enabled') ?? 0}; paused ${readNumber(totals, 'paused') ?? 0}; recent runs ${readNumber(totals, 'runs') ?? readArray(body, 'recentRuns').length}`;
}

function formatSchedules(body: unknown): string {
  const jobs = readArray(body, 'jobs');
  const runs = readArray(body, 'runs');
  const enabled = jobs.filter((entry) => isRecord(entry) && entry.enabled === true).length;
  return `  schedules: jobs ${jobs.length}; enabled ${enabled}; runs ${runs.length}`;
}

function formatCapacity(body: unknown): string {
  return `  scheduler: slots ${readNumber(body, 'slotsInUse') ?? 0}/${readNumber(body, 'slotsTotal') ?? 0}; queue ${readNumber(body, 'queueDepth') ?? 0}; oldest queued ms ${readNumber(body, 'oldestQueuedAgeMs') ?? 0}`;
}

function formatRouteFailureKind(kind: OperatorRouteFailure['kind']): string {
  if (kind === 'auth_required') return 'authorization required';
  if (kind === 'connected_host_unavailable') return 'connected host unavailable';
  if (kind === 'connected_host_route_unavailable') return 'connected host route unavailable';
  return 'connected host error';
}

function formatRoute(result: OperatorRouteResult): string {
  if (!result.ok) return `  ${result.route.id}: unavailable (${result.kind}; ${result.error})`;
  if (result.route.id === 'projectPlanning.workPlan.snapshot') return formatWorkPlan(result.body);
  if (result.route.id === 'approvals.list') return formatApprovals(result.body);
  if (result.route.id === 'automation.integration.snapshot') return formatAutomation(result.body);
  if (result.route.id === 'automation.schedules.list') return formatSchedules(result.body);
  return formatCapacity(result.body);
}

function formatBriefing(baseUrl: string, results: readonly OperatorRouteResult[]): string {
  const failures = results.filter((result): result is OperatorRouteFailure => !result.ok);
  return [
    'Agent operator briefing',
    `  connected host ${baseUrl}`,
    '  policy read-only public operator routes; no connected-host lifecycle, mutation routes, separate Agent jobs, delegated review, default knowledge, or non-Agent knowledge segments',
    '',
    ...results.map(formatRoute),
    '',
    failures.length === 0
      ? '  warnings: none'
      : `  warnings: ${failures.length} route(s) unavailable; retry after host/auth/version repair`,
  ].join('\n');
}

export function createAgentOperatorBriefingTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): Tool {
  return {
    definition: {
      name: 'agent_operator_briefing',
      description: 'Read connected Agent operator state for a concise briefing.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      sideEffects: ['network'],
    },
    execute: async () => {
      const connection = resolveAgentConnectedHostConnection(configManager, shellPaths.homeDirectory);
      if (!connection.token) {
        return {
          success: false,
          error: `auth_required: no connected-host operator token found at ${connection.tokenPath}`,
        };
      }
      const results: OperatorRouteResult[] = [];
      for (const route of briefingRoutes()) {
        results.push(await fetchOperatorRoute(connection.baseUrl, connection.token, route));
      }
      return {
        success: true,
        output: formatBriefing(connection.baseUrl, results),
      };
    },
  };
}

export function registerAgentOperatorBriefingTool(
  registry: ToolRegistry,
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): void {
  registry.register(createAgentOperatorBriefingTool(shellPaths, configManager));
}
