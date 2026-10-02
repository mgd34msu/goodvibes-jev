/**
 * Connected-host automation runs source.
 *
 * The away-digest (src/core/away-digest.ts via src/shell/autonomy-surfacing.ts)
 * and the /schedule list surface (src/input/commands/schedule-runtime.ts) both
 * need "what actually happened with scheduled automation since I was last
 * here", and that truth lives on the connected GoodVibes host, not in this
 * Agent process. Local automation execution is disabled by design (see
 * src/runtime/bootstrap.ts), so the agent's local AutomationManager never
 * produces real run outcomes; reading it for these surfaces reports nothing
 * ever happened even when the host ran (and failed, or missed) real
 * schedules overnight.
 *
 * This module is the single place that calls the host's automation.runs.list
 * operator method (?since=<epoch-ms>) and normalizes its output into the
 * plain shapes the digest and the schedule surface both need. It never
 * throws, every failure mode (no token, host unreachable, incompatible
 * host) resolves to an empty result so the caller can stay best-effort and
 * offline-tolerant, matching the away-digest's existing silent-failure
 * contract. It never falls back to the local automation manager.
 */
import { createBrowserGoodVibesSdk } from '@goodvibes-jev/engine/sdk/browser';
import {
  resolveAgentConnectedHostConnection,
  type AgentConnectedHostConfigReader,
  type AgentConnectedHostConnection,
} from './routine-schedule-promotion.ts';

export const AUTOMATION_RUNS_LIST_METHOD = 'automation.runs.list';

/**
 * The full run status enum per the operator contract (packages/contracts
 * artifacts), including the 'missed' status. NOTE: the SDK's generated
 * client type (OperatorMethodOutput<'automation.runs.list'>) has NOT been
 * regenerated to include 'missed' in its status union as of SDK commit
 * 3bddf143 even though the raw contract JSON and the runtime both carry it
 * (packages/sdk/src/platform/automation/manager-runtime-missed.js), so this
 * module parses the wire response as `unknown` and narrows locally rather
 * than trusting that generated type.
 */
export type AutomationRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'missed';

const RUN_STATUSES: ReadonlySet<string> = new Set<AutomationRunStatus>([
  'queued', 'running', 'completed', 'failed', 'cancelled', 'missed',
]);

export interface AutomationRunOutcome {
  readonly id: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly status: AutomationRunStatus;
  readonly queuedAt: number;
  readonly endedAt?: number;
}

export interface AutomationRunDelivery {
  readonly label: string;
  readonly at?: number;
}

export interface AutomationRunsSinceResult {
  readonly runs: readonly AutomationRunOutcome[];
  readonly deliveries: readonly AutomationRunDelivery[];
}

const EMPTY_RESULT: AutomationRunsSinceResult = { runs: [], deliveries: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readRun(value: unknown): AutomationRunOutcome | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  const jobId = readString(value, 'jobId');
  const status = value.status;
  if (!id || !jobId || typeof status !== 'string' || !RUN_STATUSES.has(status)) return null;
  const triggeredBy = isRecord(value.triggeredBy) ? value.triggeredBy : {};
  const jobName = readString(triggeredBy, 'label') ?? jobId;
  return {
    id,
    jobId,
    jobName,
    status: status as AutomationRunStatus,
    queuedAt: readNumber(value, 'queuedAt') ?? 0,
    endedAt: readNumber(value, 'endedAt'),
  };
}

function readDeliveries(run: Record<string, unknown>): readonly AutomationRunDelivery[] {
  const attempts = Array.isArray(run.deliveryAttempts) ? run.deliveryAttempts : [];
  const out: AutomationRunDelivery[] = [];
  for (const attempt of attempts) {
    if (!isRecord(attempt) || attempt.status !== 'sent') continue;
    const target = isRecord(attempt.target) ? attempt.target : {};
    const label = readString(target, 'label') ?? readString(target, 'kind') ?? 'delivery';
    out.push({ label, at: readNumber(attempt, 'endedAt') });
  }
  return out;
}

/**
 * Fetch every automation run active on or after `since` (epoch ms) from the
 * connected host, normalized into outcomes + sent deliveries. Returns an
 * empty result (never throws) when there is no token, the host is
 * unreachable, or the response cannot be parsed, callers must not fall back
 * to a local read on failure; "nothing to report" is the honest answer when
 * the connected host cannot be reached.
 */
export async function listAutomationRunsSince(
  connection: AgentConnectedHostConnection,
  since: number,
): Promise<AutomationRunsSinceResult> {
  if (!connection.token) return EMPTY_RESULT;
  try {
    const sdk = createBrowserGoodVibesSdk({ baseUrl: connection.baseUrl, authToken: connection.token });
    const output: unknown = await sdk.operator.invoke(AUTOMATION_RUNS_LIST_METHOD, { since });
    const record = isRecord(output) ? output : {};
    const rawRuns: readonly unknown[] = Array.isArray(record.runs) ? record.runs : [];
    const runs: AutomationRunOutcome[] = [];
    const deliveries: AutomationRunDelivery[] = [];
    for (const raw of rawRuns) {
      const run = readRun(raw);
      if (run) runs.push(run);
      if (isRecord(raw)) deliveries.push(...readDeliveries(raw));
    }
    return { runs, deliveries };
  } catch {
    return EMPTY_RESULT;
  }
}

/**
 * Build the `listAutomationRunsSince` callback AutonomySurfacingOptions
 * wants, resolving the connected-host connection fresh on every call (the
 * token file can rotate). Extracted here (rather than inlined at the
 * main.ts call site) purely to keep that wiring to one line there.
 */
export function buildListAutomationRunsSince(
  configManager: AgentConnectedHostConfigReader,
  homeDirectory: string,
): (since: number) => Promise<AutomationRunsSinceResult> {
  return (since) => listAutomationRunsSince(resolveAgentConnectedHostConnection(configManager, homeDirectory), since);
}

/**
 * Reduce a run list to the single most-recent run per jobId (by endedAt,
 * falling back to queuedAt for runs that never ended, e.g. a still-running
 * or missed run). Used by the /schedule list surface to annotate each
 * schedule with its latest known outcome instead of staying silent about
 * drift (a missed or failed run) that the schedule record itself doesn't
 * carry (automation.schedules.list has no missed-run signal of its own,
 * only automation.runs.list does).
 */
export function latestRunPerJob(runs: readonly AutomationRunOutcome[]): ReadonlyMap<string, AutomationRunOutcome> {
  const byJob = new Map<string, AutomationRunOutcome>();
  for (const run of runs) {
    const runAt = run.endedAt ?? run.queuedAt;
    const existing = byJob.get(run.jobId);
    const existingAt = existing ? (existing.endedAt ?? existing.queuedAt) : -Infinity;
    if (!existing || runAt > existingAt) byJob.set(run.jobId, run);
  }
  return byJob;
}
