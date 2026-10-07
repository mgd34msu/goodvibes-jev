import { createBrowserGoodVibesSdk } from '@goodvibes-jev/engine/sdk/browser';
import { getOperatorWorkLedgerProject } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ShellPathService } from '@/runtime/index.ts';
import type { AgentConnectedHostConfigReader } from '../agent/routine-schedule-promotion.ts';
import { resolveAgentConnectedHostConnection } from '../agent/routine-schedule-promotion.ts';
import { requireOperatorHttpBinding } from '../agent/operator-contract-routes.ts';

type WorkLedgerReadClient = ReturnType<typeof createOperatorWorkLedgerReadClient>;
type WorkLedgerReadSnapshot = Awaited<ReturnType<WorkLedgerReadClient['readSnapshot']>>;

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
  'workLedger.project',
  'workLedger.snapshot',
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

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function classifyHttpFailure(route: OperatorRouteDescriptor, status: number): OperatorRouteFailure {
  return {
    ok: false,
    route,
    kind: status === 401 || status === 403
      ? 'auth_required'
      : status === 404
        ? 'connected_host_route_unavailable'
        : 'connected_host_error',
    error: `HTTP ${status}`,
  };
}

async function fetchOperatorRoute(
  baseUrl: string,
  token: string,
  route: OperatorRouteDescriptor,
  signal: AbortSignal,
): Promise<OperatorRouteResult> {
  try {
    const response = await fetch(`${baseUrl}${route.path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    const body = await readResponseBody(response);
    if (!response.ok) return classifyHttpFailure(route, response.status);
    return { ok: true, route, body };
  } catch (error) {
    return {
      ok: false,
      route,
      kind: 'connected_host_unavailable',
      error: 'request unavailable',
    };
  }
}

function formatWorkPlan(body: unknown): string {
  const counts = readRecord(body, 'counts');
  const total = readNumber(counts, 'total') ?? readArray(body, 'tasks').length;
  return `  historical legacy work plan: total ${total}; pending ${readNumber(counts, 'pending') ?? 0}; active ${readNumber(counts, 'in_progress') ?? 0}; blocked ${readNumber(counts, 'blocked') ?? 0}; done ${readNumber(counts, 'done') ?? 0}`;
}

function formatApprovals(body: unknown): string {
  const approvals = readArray(body, 'approvals');
  const pending = approvals.filter((entry) => readString(entry, 'status') === 'pending').length;
  return `  approvals: pending ${pending}; total ${approvals.length}; mode ${['allow-all', 'background-restricted', 'custom', 'default', 'plan'].includes(readString(body, 'mode') ?? '') ? readString(body, 'mode') : 'unknown'}; awaiting decision ${Boolean(isRecord(body) && body.awaitingDecision === true)}`;
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

function formatBriefing(nativeWork: string, results: readonly OperatorRouteResult[]): string {
  const failures = results.filter((result): result is OperatorRouteFailure => !result.ok);
  return [
    'Agent operator briefing',
    '  connected host: selected authenticated host',
    '  policy read-only public operator routes; no connected-host lifecycle, mutation routes, separate Agent jobs, delegated review, default knowledge, or non-Agent knowledge segments',
    '',
    nativeWork,
    ...results.map(formatRoute),
    '',
    failures.length === 0 && !nativeWork.includes('unavailable (')
      ? '  warnings: none'
      : `  warnings: ${failures.length + (nativeWork.includes('unavailable (') ? 1 : 0)} route(s) unavailable; retry after host/auth/version repair`,
  ].join('\n');
}

function formatNativeWork(snapshot: WorkLedgerReadSnapshot): string {
  const reported = { pending: 0, in_progress: 0, blocked: 0, complete: 0, cancelled: 0 };
  const verification = { unverified: 0, verified: 0, failed: 0, unavailable: 0, stale: 0 };
  for (const entry of snapshot.works) {
    reported[entry.work.reportedState] += 1;
    verification[entry.verification.state] += 1;
  }
  const counts = (values: Record<string, number>) => Object.entries(values).map(([state, count]) => `${state} ${count}`).join('; ');
  return [
    `  native work: total ${snapshot.works.length}; revision ${snapshot.revision}`,
    `  reportedState: ${counts(reported)}`,
    `  verification.state: ${counts(verification)}`,
  ].join('\n');
}

export function createAgentOperatorBriefingTool(
  shellPaths: ShellPathService,
  configManager: AgentConnectedHostConfigReader,
): Tool {
  return {
    definition: {
      name: 'agent_operator_briefing',
      description: 'Read native work reported state and verification counts, historical legacy planning, approvals, automation, schedules, and capacity.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      sideEffects: ['network'],
    },
    execute: async (_args, options) => {
      const connection = resolveAgentConnectedHostConnection(configManager, shellPaths.homeDirectory);
      if (!connection.token) return { success: false, error: 'auth_required: no connected-host operator token' };
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      if (options?.signal?.aborted) controller.abort();
      const timeout = setTimeout(onAbort, 5_000);
      timeout.unref?.();
      let reader: WorkLedgerReadClient | undefined;
      let rejectCancelled = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectCancelled = () => reject(new Error('briefing cancelled'));
        controller.signal.addEventListener('abort', rejectCancelled, { once: true });
        if (controller.signal.aborted) rejectCancelled();
      });
      function current(): void {
        const selected = resolveAgentConnectedHostConnection(configManager, shellPaths.homeDirectory);
        if (controller.signal.aborted || selected.baseUrl !== connection.baseUrl
          || selected.token !== connection.token || selected.tokenPath !== connection.tokenPath) {
          controller.abort();
          throw new Error('briefing binding changed or cancelled');
        }
      }
      async function run(): Promise<string> {
        current();
        // No streams, subscriptions, retries, history, or lifecycle calls. This
        // SDK instance owns no persistent resources; its requests are aborted
        // below, and the snapshot reader is always disposed.
        const sdk = createBrowserGoodVibesSdk({ baseUrl: connection.baseUrl,
          getAuthToken: () => { current(); return connection.token; }, retry: { maxAttempts: 1 },
          fetch: async (input, init) => {
            current();
            const response = await fetch(input, init);
            current();
            return response;
          } });
        let nativeWork = '  native work: unavailable (read failed; no historical fallback)';
        try {
          const projectId = await getOperatorWorkLedgerProject(sdk.operator, { signal: controller.signal });
          current();
          reader = createOperatorWorkLedgerReadClient(sdk.operator, projectId, { requestTimeoutMs: 5_000 });
          const snapshot = await reader.readSnapshot();
          current();
          nativeWork = formatNativeWork(snapshot);
        } catch {
          current();
        } finally {
          reader?.dispose();
          reader = undefined;
        }
        const results: OperatorRouteResult[] = [];
        for (const route of briefingRoutes()) {
          if (route.id === 'workLedger.project' || route.id === 'workLedger.snapshot') continue;
          current();
          results.push(await fetchOperatorRoute(connection.baseUrl, connection.token!, route, controller.signal));
          current();
        }
        return formatBriefing(nativeWork, results);
      }
      try {
        const output = await Promise.race([run(), cancelled]);
        current();
        return { success: true, output };
      } catch {
        return { success: false, error: 'briefing_unavailable: cancelled, timed out, or connected host changed; retry against the current host' };
      } finally {
        controller.abort();
        reader?.dispose();
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', rejectCancelled);
        options?.signal?.removeEventListener('abort', onAbort);
      }
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
