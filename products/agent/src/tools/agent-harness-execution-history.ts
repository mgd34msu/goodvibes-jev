import type { CommandContext } from '../input/command-registry.ts';
import type { AgentExecutionRecord, AgentExecutionRouteKind, AgentExecutionStatus } from '../runtime/execution-ledger.ts';
import { fileRecoveryCatalogStatus } from './agent-harness-file-recovery.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface AgentHarnessExecutionHistoryArgs {
  readonly executionRecordId?: unknown;
  readonly recordId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type ExecutionHistoryLookupSource = 'executionRecordId' | 'recordId' | 'target' | 'query';

type ExecutionHistoryResolution =
  | { readonly status: 'found'; readonly record: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

type ActivityCardStatus = AgentExecutionStatus | 'mixed';
type VerificationStatus = 'passed' | 'failed' | 'running' | 'cancelled' | 'not_recorded';

const VERIFICATION_PATTERN = /\b(?:bun\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|pytest|vitest|jest|mocha|cargo\s+test|go\s+test|go\s+vet|tsc|typecheck|lint|eslint|prettier|ruff|mypy|cargo\s+check|make\s+test|build|verify|check)\b/i;
const RESULT_VERIFICATION_PATTERN = /\b(?:pass|passed|fail|failed|test|tests|spec|specs|suite|suites)\b/i;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function iso(value: number | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function lookupFromArgs(args: AgentHarnessExecutionHistoryArgs): { readonly source: ExecutionHistoryLookupSource; readonly input: string } | null {
  const executionRecordId = readString(args.executionRecordId);
  if (executionRecordId) return { source: 'executionRecordId', input: executionRecordId };
  const recordId = readString(args.recordId);
  if (recordId) return { source: 'recordId', input: recordId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function records(context: CommandContext): readonly AgentExecutionRecord[] {
  return context.ops.executionLedger?.getSnapshot().records ?? [];
}

function recordSearchText(record: AgentExecutionRecord): string {
  return [
    record.id,
    record.callId,
    record.turnId,
    record.tool,
    record.routeKind,
    record.status,
    record.phase,
    record.argsPreview,
    record.commandPreview ?? '',
    record.targetPreview ?? '',
    record.resultSummary?.preview ?? '',
    record.error ?? '',
    record.cancelReason ?? '',
  ].join('\n').toLowerCase();
}

function isRecoverableRoute(record: AgentExecutionRecord): boolean {
  if (record.routeKind === 'write') return true;
  const tool = record.tool.toLowerCase();
  return tool.includes('write') || tool.includes('edit') || tool.includes('patch') || tool.includes('delete');
}

function supervisionRoutes(context: CommandContext, record: AgentExecutionRecord): readonly Record<string, unknown>[] {
  const routes: Record<string, unknown>[] = [];
  if (record.routeKind === 'shell') {
    if (typeof context.openProcessModal === 'function') {
      routes.push({
        id: 'process-monitor',
        label: 'Runtime Activity Monitor',
        modelRoute: 'workspace action:"open" surfaceId:"process-monitor"',
        requiresConfirmation: true,
      });
    }
    if (typeof context.openLiveTail === 'function') {
      routes.push({
        id: 'live-tail',
        label: 'Live Process Output',
        modelRoute: 'workspace action:"open" surfaceId:"live-tail"',
        requiresConfirmation: true,
      });
    }
  }
  return routes;
}

function routeForRecord(record: AgentExecutionRecord): string {
  return `execution action:"record" id:"${record.id}"`;
}

function uniqueStrings(values: readonly string[], limit = 8): readonly string[] {
  return Array.from(new Set(values.filter((value) => value.trim()))).slice(0, limit);
}

function dedupeRoutes(routes: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  for (const route of routes) {
    const id = typeof route.id === 'string' && route.id.trim() ? route.id : JSON.stringify(route);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(route);
  }
  return unique;
}

function routeKindSummary(records: readonly AgentExecutionRecord[]): Record<AgentExecutionRouteKind, number> {
  return {
    read: records.filter((record) => record.routeKind === 'read').length,
    write: records.filter((record) => record.routeKind === 'write').length,
    shell: records.filter((record) => record.routeKind === 'shell').length,
    network: records.filter((record) => record.routeKind === 'network').length,
    browser: records.filter((record) => record.routeKind === 'browser').length,
    delegation: records.filter((record) => record.routeKind === 'delegation').length,
    other: records.filter((record) => record.routeKind === 'other').length,
  };
}

function statusSummary(records: readonly AgentExecutionRecord[]): Record<AgentExecutionStatus, number> {
  return {
    running: records.filter((record) => record.status === 'running').length,
    succeeded: records.filter((record) => record.status === 'succeeded').length,
    failed: records.filter((record) => record.status === 'failed').length,
    cancelled: records.filter((record) => record.status === 'cancelled').length,
  };
}

function orderedByReceivedAt(records: readonly AgentExecutionRecord[]): readonly AgentExecutionRecord[] {
  return [...records].sort((left, right) => left.receivedAt - right.receivedAt);
}

function latestByUpdatedAt(records: readonly AgentExecutionRecord[]): AgentExecutionRecord {
  return [...records].sort((left, right) => right.updatedAt - left.updatedAt)[0]!;
}

function cardStatus(records: readonly AgentExecutionRecord[]): ActivityCardStatus {
  if (records.some((record) => record.status === 'running')) return 'running';
  if (records.some((record) => record.status === 'failed')) return 'failed';
  if (records.some((record) => record.status === 'cancelled')) return 'cancelled';
  if (records.every((record) => record.status === 'succeeded')) return 'succeeded';
  return 'mixed';
}

function titleForRecord(record: AgentExecutionRecord, includeParameters: boolean): string {
  const subject = record.commandPreview ?? record.targetPreview ?? record.tool;
  const preview = previewHarnessText(subject, includeParameters ? 96 : 64);
  if (record.routeKind === 'shell') return `Shell: ${preview}`;
  if (record.routeKind === 'write') return `File change: ${preview}`;
  if (record.routeKind === 'read') return `Read: ${preview}`;
  if (record.routeKind === 'network') return `Web: ${preview}`;
  if (record.routeKind === 'browser') return `Browser: ${preview}`;
  if (record.routeKind === 'delegation') return `Delegation: ${preview}`;
  return `Tool: ${preview}`;
}

function titleRecord(records: readonly AgentExecutionRecord[]): AgentExecutionRecord {
  const failed = records.find((record) => record.status === 'failed');
  if (failed) return failed;
  const runningShell = records.find((record) => record.status === 'running' && record.routeKind === 'shell');
  if (runningShell) return runningShell;
  const verification = records.find((record) => looksLikeVerificationRecord(record));
  if (verification) return verification;
  return latestByUpdatedAt(records);
}

function looksLikeVerificationRecord(record: AgentExecutionRecord): boolean {
  const text = [
    record.tool,
    record.commandPreview ?? '',
    record.targetPreview ?? '',
    record.resultSummary?.preview ?? '',
  ].join('\n');
  return record.routeKind === 'shell'
    ? VERIFICATION_PATTERN.test(text) || RESULT_VERIFICATION_PATTERN.test(record.resultSummary?.preview ?? '')
    : VERIFICATION_PATTERN.test(record.tool);
}

function verificationLabel(record: AgentExecutionRecord, includeParameters: boolean): string {
  return previewHarnessText(record.commandPreview ?? record.targetPreview ?? record.tool, includeParameters ? 120 : 72);
}

function verificationStatus(records: readonly AgentExecutionRecord[]): VerificationStatus {
  if (records.length === 0) return 'not_recorded';
  if (records.some((record) => record.status === 'failed')) return 'failed';
  if (records.some((record) => record.status === 'running')) return 'running';
  if (records.some((record) => record.status === 'cancelled')) return 'cancelled';
  return 'passed';
}

function verificationSummary(records: readonly AgentExecutionRecord[], includeParameters: boolean): Record<string, unknown> {
  const verificationRecords = records.filter((record) => looksLikeVerificationRecord(record));
  const status = verificationStatus(verificationRecords);
  return {
    status,
    evidence: verificationRecords.slice(0, 5).map((record) => ({
      executionRecordId: record.id,
      label: verificationLabel(record, includeParameters),
      status: record.status,
      ...(record.resultSummary?.preview ? { outputPreview: previewHarnessText(record.resultSummary.preview, includeParameters ? 180 : 96) } : {}),
      modelRoute: routeForRecord(record),
    })),
    nextAction: status === 'not_recorded'
      ? 'No verification command is recorded in this activity card.'
      : status === 'failed'
        ? 'Inspect the failed verification record before continuing.'
        : status === 'running'
          ? 'Use the process monitor or live-tail route when available.'
          : status === 'cancelled'
            ? 'Inspect the cancelled verification record before retrying.'
            : 'Verification evidence is recorded for this activity card.',
  };
}

function recoverableRecordIds(context: CommandContext, records: readonly AgentExecutionRecord[]): readonly string[] {
  const undoDepth = fileRecoveryCatalogStatus(context).undoDepth as number | undefined;
  if (!undoDepth || undoDepth < 1) return [];
  return records.filter(isRecoverableRoute).map((record) => record.id);
}

function processOutputAttachment(context: CommandContext, records: readonly AgentExecutionRecord[], includeParameters: boolean): Record<string, unknown> | null {
  const shellRecords = records.filter((record) => record.routeKind === 'shell');
  if (shellRecords.length === 0) return null;
  const liveRoutes = dedupeRoutes(shellRecords.flatMap((record) => supervisionRoutes(context, record)))
    .filter((route) => route.id === 'process-monitor' || route.id === 'live-tail');
  const evidence = shellRecords
    .filter((record) => record.resultSummary?.preview)
    .slice(0, 5)
    .map((record) => ({
      executionRecordId: record.id,
      status: record.status,
      outputPreview: previewHarnessText(record.resultSummary?.preview ?? '', includeParameters ? 180 : 96),
      modelRoute: routeForRecord(record),
    }));
  return {
    status: evidence.length > 0 ? 'bounded-summary-attached' : 'live-route-only',
    shellRecords: shellRecords.length,
    evidence,
    liveRoutes,
    policy: 'Cards attach only bounded redacted summaries; use live process routes for visible output instead of raw hidden log capture.',
  };
}

function activityOutcome(status: ActivityCardStatus, records: readonly AgentExecutionRecord[], verification: Record<string, unknown>): string {
  const failed = records.filter((record) => record.status === 'failed').length;
  const running = records.filter((record) => record.status === 'running').length;
  const cancelled = records.filter((record) => record.status === 'cancelled').length;
  const count = `${records.length} record${records.length === 1 ? '' : 's'}`;
  if (status === 'failed') return `Needs attention: ${failed} of ${count} failed.`;
  if (status === 'running') return `Still running: ${running} of ${count} in progress.`;
  if (status === 'cancelled') return `Cancelled: ${cancelled} of ${count} cancelled.`;
  if (verification.status === 'passed') return `Succeeded with verification evidence across ${count}.`;
  if (status === 'succeeded') return `Succeeded: ${count} completed.`;
  return `Mixed outcome across ${count}.`;
}

function activityNextAction(status: ActivityCardStatus, verification: Record<string, unknown>, recoverableIds: readonly string[]): string {
  if (status === 'failed') return recoverableIds.length > 0
    ? 'Inspect the first failure, then use file recovery if an edit needs rollback.'
    : 'Inspect the first failure record before retrying.';
  if (status === 'running') return 'Open the process monitor or live-tail route when available.';
  if (status === 'cancelled') return 'Inspect the cancelled record before deciding whether to retry.';
  if (verification.status === 'not_recorded') return 'Run or inspect verification if the change needs proof.';
  return 'No recovery action is needed from this card.';
}

function activityCard(context: CommandContext, cardRecords: readonly AgentExecutionRecord[], includeParameters: boolean, idPrefix = 'turn'): Record<string, unknown> {
  const ordered = orderedByReceivedAt(cardRecords);
  const latest = latestByUpdatedAt(cardRecords);
  const firstReceived = ordered[0]!;
  const firstFailure = ordered.find((record) => record.status === 'failed');
  const recoverableIds = recoverableRecordIds(context, ordered);
  const supervision = dedupeRoutes(ordered.flatMap((record) => supervisionRoutes(context, record)));
  const verification = verificationSummary(ordered, includeParameters);
  const status = cardStatus(ordered);
  const completedAt = ordered.every((record) => typeof record.completedAt === 'number')
    ? Math.max(...ordered.map((record) => record.completedAt ?? record.updatedAt))
    : null;
  const processOutput = processOutputAttachment(context, ordered, includeParameters);
  const recordIds = ordered.map((record) => record.id);
  return {
    activityCardId: idPrefix === 'record' ? `record:${latest.id}` : `turn:${latest.turnId || latest.id}`,
    turnId: latest.turnId,
    title: titleForRecord(titleRecord(ordered), includeParameters),
    status,
    outcome: activityOutcome(status, ordered, verification),
    records: ordered.length,
    recordIds: recordIds.slice(0, 20),
    ...(recordIds.length > 20 ? { recordIdOverflow: recordIds.length - 20 } : {}),
    tools: uniqueStrings(ordered.map((record) => record.tool)),
    routeKinds: routeKindSummary(ordered),
    startedAt: iso(firstReceived.receivedAt),
    updatedAt: iso(latest.updatedAt),
    ...(completedAt ? { completedAt: iso(completedAt) } : {}),
    ...(typeof completedAt === 'number' ? { durationMs: Math.max(0, completedAt - firstReceived.receivedAt) } : {}),
    verification,
    ...(processOutput ? { processOutput } : {}),
    routes: {
      inspectLatest: routeForRecord(latest),
      ...(firstFailure ? { inspectFirstFailure: routeForRecord(firstFailure) } : {}),
      ...(recoverableIds.length > 0 ? { fileRecovery: 'execution action:"recovery"' } : {}),
      supervision,
    },
    nextAction: activityNextAction(status, verification, recoverableIds),
  };
}

function activityCards(context: CommandContext, records: readonly AgentExecutionRecord[], includeParameters: boolean): readonly Record<string, unknown>[] {
  const groups = new Map<string, AgentExecutionRecord[]>();
  for (const record of records) {
    const key = record.turnId ? `turn:${record.turnId}` : `record:${record.id}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .sort((left, right) => latestByUpdatedAt(right).updatedAt - latestByUpdatedAt(left).updatedAt)
    .map((group) => activityCard(context, group, includeParameters));
}

function activityCardCount(records: readonly AgentExecutionRecord[]): number {
  return new Set(records.map((record) => record.turnId ? `turn:${record.turnId}` : `record:${record.id}`)).size;
}

function describeRecord(
  context: CommandContext,
  record: AgentExecutionRecord,
  includeParameters: boolean,
  lookup?: Record<string, unknown>,
): Record<string, unknown> {
  const recoverable = isRecoverableRoute(record) && (fileRecoveryCatalogStatus(context).undoDepth as number | undefined ?? 0) > 0;
  return {
    executionRecordId: record.id,
    callId: record.callId,
    turnId: record.turnId,
    tool: record.tool,
    routeKind: record.routeKind,
    status: record.status,
    phase: record.phase,
    receivedAt: iso(record.receivedAt),
    updatedAt: iso(record.updatedAt),
    ...(record.completedAt ? { completedAt: iso(record.completedAt) } : {}),
    ...(typeof record.durationMs === 'number' ? { durationMs: record.durationMs } : {}),
    ...(typeof record.permissionApproved === 'boolean' ? { permissionApproved: record.permissionApproved } : {}),
    ...(record.commandPreview ? { commandPreview: previewHarnessText(record.commandPreview, includeParameters ? 180 : 96) } : {}),
    ...(record.targetPreview ? { targetPreview: previewHarnessText(record.targetPreview, includeParameters ? 180 : 96) } : {}),
    argsPreview: previewHarnessText(record.argsPreview, includeParameters ? 360 : 120),
    ...(record.resultSummary ? {
      resultSummary: {
        kind: record.resultSummary.kind,
        byteSize: record.resultSummary.byteSize,
        ...(record.resultSummary.preview ? { preview: previewHarnessText(record.resultSummary.preview, includeParameters ? 220 : 96) } : {}),
      },
    } : {}),
    ...(record.error ? { error: previewHarnessText(record.error, includeParameters ? 220 : 96) } : {}),
    ...(record.cancelReason ? { cancelReason: previewHarnessText(record.cancelReason, includeParameters ? 220 : 96) } : {}),
    userCard: activityCard(context, [record], includeParameters, 'record'),
    supervisionRoutes: supervisionRoutes(context, record),
    ...(recoverable ? { recoveryRoute: 'execution action:"recovery"' } : {}),
    modelRoute: routeForRecord(record),
    ...(lookup ? { lookup } : {}),
    ...(includeParameters ? {
      argsKeys: record.argsKeys,
      policy: {
        effect: 'read-only',
        values: 'Execution history stores bounded, redacted args and result summaries only; raw file bytes, binary bodies, and secret-looking argument keys are not exposed.',
        mutation: 'Follow-up UI routing and file recovery remain confirmation-gated through workspace open routes, execution recovery inspection, or run_file_recovery.',
      },
      modelAccess: {
        inspectHistory: 'execution action:"history"',
        inspectRecord: routeForRecord(record),
        toolInspector: 'execution action:"status"',
        fileRecovery: 'execution action:"recovery"',
      },
    } : {}),
  };
}

function candidate(record: AgentExecutionRecord): Record<string, unknown> {
  return {
    executionRecordId: record.id,
    tool: record.tool,
    routeKind: record.routeKind,
    status: record.status,
    modelRoute: routeForRecord(record),
  };
}

export function executionHistoryCatalogStatus(context: CommandContext): Record<string, unknown> {
  const ledger = context.ops.executionLedger;
  if (!ledger) {
    return {
      modes: ['execution_history', 'execution_history_item'],
      status: 'unavailable',
      readOnly: true,
    };
  }
  const snapshot = ledger.getSnapshot();
  return {
    modes: ['execution_history', 'execution_history_item'],
    status: 'available',
    records: snapshot.total,
    running: snapshot.running,
    failed: snapshot.failed,
    readOnly: true,
  };
}

export function executionHistorySummary(context: CommandContext, args: AgentHarnessExecutionHistoryArgs): Record<string, unknown> {
  const all = records(context);
  const query = readString(args.query).toLowerCase();
  const includeParameters = args.includeParameters === true;
  const filtered = all
    .filter((record) => !query || recordSearchText(record).includes(query))
    .slice(0, readLimit(args.limit, 100));
  const cards = activityCards(context, filtered, includeParameters);
  return {
    status: context.ops.executionLedger ? 'available' : 'unavailable',
    summary: {
      records: all.length,
      activityCards: activityCardCount(all),
      ...statusSummary(all),
      routeKinds: routeKindSummary(all),
    },
    activityCards: cards,
    returnedActivityCards: cards.length,
    records: filtered.map((record) => describeRecord(context, record, includeParameters)),
    returned: filtered.length,
    total: all.length,
    policy: 'Read-only local execution history. Activity cards group bounded redacted records into user-facing outcomes; UI routing and recovery remain separate confirmation-gated modes.',
  };
}

export function describeExecutionHistoryItem(context: CommandContext, args: AgentHarnessExecutionHistoryArgs): ExecutionHistoryResolution {
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'execution action:"record" requires executionRecordId, recordId, target, or query. Use execution action:"history" to inspect recent record ids.',
    };
  }
  const all = records(context);
  const normalized = lookup.input.toLowerCase();
  const exact = all.find((record) => record.id === lookup.input || record.callId === lookup.input);
  if (exact) return { status: 'found', record: describeRecord(context, exact, true, { ...lookup, resolvedBy: 'id' }) };
  const insensitive = all.find((record) => record.id.toLowerCase() === normalized || record.callId.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', record: describeRecord(context, insensitive, true, { ...lookup, resolvedBy: 'case-insensitive-id' }) };
  const searched = all.filter((record) => recordSearchText(record).includes(normalized));
  if (searched.length === 1) return { status: 'found', record: describeRecord(context, searched[0]!, true, { ...lookup, resolvedBy: 'search' }) };
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map(candidate),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown execution history record ${lookup.input}. Use execution action:"history" to inspect recent record ids.`,
  };
}
