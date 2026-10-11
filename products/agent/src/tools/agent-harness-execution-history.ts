import type { CommandContext } from '../input/command-registry.ts';
import { captureJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { executionVerification, gateJudgmentRegistry, prepareJudgmentResult } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SOURCE_SCREENING_LIMITS, type ProtectedSource, type SourceScreeningReceipt } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogData, captureCatalogMethods, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
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
type VerificationStatus = 'passed' | 'failed' | 'running' | 'cancelled' | 'not_recorded' | 'held';
type VerificationReading = Awaited<ReturnType<typeof executionVerification.run>>['readings']['verification'];
type VerificationObservation = { readonly status: 'settled'; readonly verification: boolean; readonly judgment: VerificationReading }
  | { readonly status: 'held' };
type VerificationObservations = ReadonlyMap<string, VerificationObservation>;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function iso(value: number | undefined): string | null {
  if (value === undefined) return null;
  const date = new Date(value);
  if (!Number.isFinite(value) || !Number.isFinite(date.getTime())) throw new ToolInputProjectionError('invalid');
  return date.toISOString();
}

/** These clocks come from the ledger producer; borrowed values are not exempt. */
function verificationRecordView(record: AgentExecutionRecord) {
  const { receivedAt, updatedAt, completedAt, ...data } = record;
  return { ...data, receivedAt: iso(receivedAt), updatedAt: iso(updatedAt),
    ...(completedAt === undefined ? {} : { completedAt: iso(completedAt) }) };
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
  ].join('\n');
}

function isRecoverableRoute(record: AgentExecutionRecord): boolean {
  return record.routeKind === 'write';
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

function titleRecord(records: readonly AgentExecutionRecord[], observations: VerificationObservations): AgentExecutionRecord {
  const failed = records.find((record) => record.status === 'failed');
  if (failed) return failed;
  const runningShell = records.find((record) => record.status === 'running' && record.routeKind === 'shell');
  if (runningShell) return runningShell;
  const verification = records.find((record) => {
    const observation = observations.get(record.id);
    return observation?.status === 'settled' && observation.verification;
  });
  if (verification) return verification;
  return latestByUpdatedAt(records);
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

function verificationSummary(records: readonly AgentExecutionRecord[], includeParameters: boolean, observations: VerificationObservations): Record<string, unknown> {
  const verificationRecords = records.filter((record) => {
    const observation = observations.get(record.id);
    return observation?.status === 'settled' && observation.verification;
  });
  const held = records.filter(record => observations.get(record.id)?.status !== 'settled');
  const status = held.length ? 'held' : verificationStatus(verificationRecords);
  return {
    status,
    ...(held.length ? { heldExecutionRecordIds: held.map(record => record.id), reason: 'verification_evidence_role_unsettled' } : {}),
    evidence: verificationRecords.slice(0, 5).map((record) => ({
      executionRecordId: record.id,
      label: verificationLabel(record, includeParameters),
      status: record.status,
      judgment: observations.get(record.id),
      ...(record.resultSummary?.preview ? { outputPreview: previewHarnessText(record.resultSummary.preview, includeParameters ? 180 : 96) } : {}),
      modelRoute: routeForRecord(record),
    })),
    nextAction: status === 'held'
      ? 'Verification evidence is held until its recorded meaning is settled.'
      : status === 'not_recorded'
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

function activityCard(context: CommandContext, cardRecords: readonly AgentExecutionRecord[], includeParameters: boolean, observations: VerificationObservations, idPrefix = 'turn'): Record<string, unknown> {
  const ordered = orderedByReceivedAt(cardRecords);
  const latest = latestByUpdatedAt(cardRecords);
  const firstReceived = ordered[0]!;
  const firstFailure = ordered.find((record) => record.status === 'failed');
  const recoverableIds = recoverableRecordIds(context, ordered);
  const supervision = dedupeRoutes(ordered.flatMap((record) => supervisionRoutes(context, record)));
  const verification = verificationSummary(ordered, includeParameters, observations);
  const status = cardStatus(ordered);
  const completedAt = ordered.every((record) => typeof record.completedAt === 'number')
    ? Math.max(...ordered.map((record) => record.completedAt ?? record.updatedAt))
    : null;
  const processOutput = processOutputAttachment(context, ordered, includeParameters);
  const recordIds = ordered.map((record) => record.id);
  return {
    activityCardId: idPrefix === 'record' ? `record:${latest.id}` : `turn:${latest.turnId || latest.id}`,
    turnId: latest.turnId,
    title: titleForRecord(titleRecord(ordered, observations), includeParameters),
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

function activityCards(context: CommandContext, records: readonly AgentExecutionRecord[], includeParameters: boolean, observations: VerificationObservations): readonly Record<string, unknown>[] {
  const groups = new Map<string, AgentExecutionRecord[]>();
  for (const record of records) {
    const key = record.turnId ? `turn:${record.turnId}` : `record:${record.id}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .sort((left, right) => latestByUpdatedAt(right).updatedAt - latestByUpdatedAt(left).updatedAt)
    .map((group) => activityCard(context, group, includeParameters, observations));
}

function activityCardCount(records: readonly AgentExecutionRecord[]): number {
  return new Set(records.map((record) => record.turnId ? `turn:${record.turnId}` : `record:${record.id}`)).size;
}

function describeRecord(
  context: CommandContext,
  record: AgentExecutionRecord,
  includeParameters: boolean,
  observations: VerificationObservations,
  lookup?: Record<string, unknown>,
): Record<string, unknown> {
  const recoverable = isRecoverableRoute(record) && (fileRecoveryCatalogStatus(context).undoDepth as number | undefined ?? 0) > 0;
  return {
    executionRecordId: record.id,
    callId: record.callId,
    turnId: record.turnId,
    tool: record.tool,
    routeKind: record.routeKind,
    ...(record.routeKindError ? { routeKindError: record.routeKindError } : {}),
    ...(record.argsReadingError ? { argsReadingError: record.argsReadingError } : {}),
    ...(record.autonomousDecision ? { autonomousDecision: record.autonomousDecision } : {}),
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
    userCard: activityCard(context, [record], includeParameters, observations, 'record'),
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
    ...(record.routeKindError ? { routeKindError: record.routeKindError } : {}),
    ...(record.argsReadingError ? { argsReadingError: record.argsReadingError } : {}),
    ...(record.autonomousDecision ? { autonomousDecision: record.autonomousDecision } : {}),
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

function historySources(context: CommandContext) {
  return captureCatalogData({ records: records(context), recovery: fileRecoveryCatalogStatus(context), sessionId: context.session.runtime.sessionId,
    processMonitor: typeof context.openProcessModal === 'function', liveTail: typeof context.openLiveTail === 'function' });
}

function captureHistoryBackend(context: CommandContext) {
  const guards = [captureCatalogMethods(context, ['ops', 'workspace', 'session', 'openProcessModal', 'openLiveTail']),
    captureCatalogMethods(context.ops, ['executionLedger']), captureCatalogMethods(context.workspace, ['fileUndoManager', 'shellPaths']),
    captureCatalogMethods(context.session, ['runtime']), captureCatalogMethods(context.session.runtime, ['sessionId'])];
  if (context.ops.executionLedger) guards.push(captureCatalogMethods(context.ops.executionLedger, ['getSnapshot']));
  if (context.workspace.shellPaths) guards.push(captureCatalogMethods(context.workspace.shellPaths, ['workingDirectory']));
  if (context.workspace.fileUndoManager) guards.push(captureCatalogMethods(context.workspace.fileUndoManager, ['peekUndo', 'undoDepth', 'redoDepth']));
  return () => { for (const guard of guards) guard(); };
}

function retainHistorySources(context: CommandContext, sources: ReturnType<typeof historySources>, options: CatalogRankingOptions, assertBackend: () => void) {
  const revision = JSON.stringify(sources);
  const assertCurrent = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    assertBackend();
    if (JSON.stringify(historySources(context)) !== revision) throw new ToolInputProjectionError('stale');
    assertBackend();
  };
  options.retainCurrent?.(assertCurrent, 'agent.harness.execution-history.sources');
  assertCurrent(); return assertCurrent;
}

async function matchingRecords(all: readonly AgentExecutionRecord[], query: string, options: CatalogRankingOptions) {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (!query) return { matches: all.map(entry => ({ entry, judgment: undefined })), judgments: [] };
  return rankHarnessCatalog(all, query, record => ({ id: record.id, description: recordSearchText(record), evidence: verificationRecordView(record) }),
    'agent.harness.execution-history', { ...options, requirePreservedSource: true });
}

async function readVerificationObservations(all: readonly AgentExecutionRecord[], options: CatalogRankingOptions): Promise<VerificationObservations> {
  const observations = new Map<string, VerificationObservation>(all.map(record => [record.id, { status: 'held' }]));
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (!all.length || !options.sourceOwner) return observations;
  if (observations.size !== all.length) throw new ToolInputProjectionError('invalid');
  const owner = options.sourceOwner, signal = options.signal, callerCurrent = options.assertCurrent;
  const assertOwnerCurrent = captureCatalogMethods(owner, ['capture', 'screen', 'project', 'release']);
  const releaseSource = owner.release;
  const readingRecords = all.map(verificationRecordView);
  const source = readingRecords.map(record => JSON.stringify(record));
  if (source.reduce((sum, text) => sum + text.length, 0) > 1_000_000) throw new ToolInputProjectionError('held');
  const batches: string[][] = [];
  for (const text of source) {
    if (text.length > SOURCE_SCREENING_LIMITS.characters) throw new ToolInputProjectionError('held');
    let batch = batches.at(-1);
    if (!batch || batch.length === SOURCE_SCREENING_LIMITS.parts || batch.reduce((sum, part) => sum + part.length, 0) + text.length > SOURCE_SCREENING_LIMITS.characters) {
      batch = []; batches.push(batch);
    }
    batch.push(text);
  }
  if (batches.length > SOURCE_SCREENING_LIMITS.sources) throw new ToolInputProjectionError('held');
  const handles: ProtectedSource[] = [];
  const receipts: { readonly receipt: SourceScreeningReceipt; readonly projection: readonly string[] }[] = [];
  let released = false, releasing: Promise<void> | undefined;
  let assertBackend: (() => void) | undefined;
  const assertPublicationCurrent = () => {
    if (options.sourceOwner !== owner || options.signal !== signal || options.assertCurrent !== callerCurrent) throw new ToolInputProjectionError('held');
    signal?.throwIfAborted(); callerCurrent?.(); assertOwnerCurrent(); assertBackend?.();
  };
  const assertOwnedCurrent = () => {
    assertPublicationCurrent();
    if (released) throw new ToolInputProjectionError('held');
    for (const { receipt, projection } of receipts) {
      const current = owner.project(receipt);
      if (current.length !== projection.length || current.some((text, index) => text !== projection[index])) throw new ToolInputProjectionError('held');
    }
  };
  const release = () => {
    if (releasing) return releasing;
    released = true; signal?.removeEventListener('abort', abort);
    releasing = Promise.resolve().then(async () => { await Promise.all(handles.map(handle => Promise.resolve().then(() => releaseSource.call(owner, handle)))); });
    return releasing;
  };
  const abort = () => { void release().catch(() => {}); };
  try {
    assertOwnedCurrent();
    for (const batch of batches) { assertOwnedCurrent(); handles.push(owner.capture(batch)); }
    signal?.addEventListener('abort', abort, { once: true });
    const projected: string[] = [];
    for (const handle of handles) {
      assertOwnedCurrent();
      const screened = await owner.screen(handle);
      assertOwnedCurrent();
      if (screened.status !== 'settled') throw new ToolInputProjectionError('held');
      const projection = owner.project(screened.receipt);
      receipts.push({ receipt: screened.receipt, projection }); projected.push(...projection);
    }
    assertOwnedCurrent();
    if (projected.length !== source.length || projected.some((text, index) => text !== source[index])) throw new ToolInputProjectionError('held');
    const assertDefinitionSlots = captureCatalogMethods(executionVerification, ['name', 'version', 'description', 'accuracyFloor', 'model', 'items', 'fixtureCount', 'run', 'checkFixtures']);
    const batteryRevision = JSON.stringify(captureCatalogData({ name: executionVerification.name, version: executionVerification.version,
      description: executionVerification.description, accuracyFloor: executionVerification.accuracyFloor, model: executionVerification.model,
      items: executionVerification.items, fixtureCount: executionVerification.fixtureCount }));
    const run = executionVerification.run, checkFixtures = executionVerification.checkFixtures;
    const assertDefinitionCurrent = () => {
      assertDefinitionSlots();
      const descriptors = Object.getOwnPropertyDescriptors(executionVerification);
      if (!descriptors.run || !('value' in descriptors.run) || descriptors.run.value !== run
        || !descriptors.checkFixtures || !('value' in descriptors.checkFixtures) || descriptors.checkFixtures.value !== checkFixtures
        || Object.values(descriptors).some(descriptor => !('value' in descriptor))
        || gateJudgmentRegistry.get('engine.gate.execution-verification') !== executionVerification
        || JSON.stringify(captureCatalogData({ name: executionVerification.name, version: executionVerification.version,
          description: executionVerification.description, accuracyFloor: executionVerification.accuracyFloor, model: executionVerification.model,
          items: executionVerification.items, fixtureCount: executionVerification.fixtureCount })) !== batteryRevision) throw new ToolInputProjectionError('held');
    };
    let capture: ReturnType<typeof captureJudgmentPort>;
    try { capture = captureJudgmentPort('agent.harness.execution-verification', { ...(signal ? { signal } : {}), assertCurrent: () => {
      signal?.throwIfAborted(); callerCurrent?.(); assertDefinitionCurrent();
    }, prepareResultCapture: prepareJudgmentResult }); }
    catch (error) { if (error instanceof JudgmentPortMissingError) return observations; throw error; }
    assertBackend = capture.assertCurrent;
    options.retainCurrent?.(capture.assertCurrent, 'agent.harness.execution-verification.backend');
    const recorder = capture.port.recorder;
    const port: typeof capture.port = { model: capture.port.model,
      ...(recorder ? { recorder: {
        recordReadings: (...args: Parameters<typeof recorder.recordReadings>) => { assertOwnedCurrent(); recorder.recordReadings(...args); assertOwnedCurrent(); },
        recordAction: (...args: Parameters<typeof recorder.recordAction>) => { assertOwnedCurrent(); recorder.recordAction(...args); assertOwnedCurrent(); },
      } } : {}),
      ask: async request => { assertOwnedCurrent(); const result = await capture.port.ask({ ...request,
        beforeAttempt: () => { request.beforeAttempt?.(); assertOwnedCurrent(); },
        assertLogCurrent: () => { request.assertLogCurrent?.(); assertOwnedCurrent(); },
      }); assertOwnedCurrent(); return result; },
    };
    for (const [index, record] of all.entries()) {
      assertOwnedCurrent();
      const result = await run.call(executionVerification, port, { id: record.id, recordJson: projected[index]! }, { site: 'agent.harness.execution-verification', signal: capture.signal, beforeAttempt: assertOwnedCurrent });
      assertOwnedCurrent();
      const judgment = result.readings.verification;
      if (judgment.outcome === 'act' && judgment.verdict !== 'uncertain') observations.set(record.id, { status: 'settled', verification: judgment.verdict === 'yes', judgment });
    }
    return observations;
  } finally { await release(); assertPublicationCurrent(); }
}

export async function executionHistorySummary(context: CommandContext, args: AgentHarnessExecutionHistoryArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const assertBackend = captureHistoryBackend(context);
  const sources = historySources(context);
  const assertCurrent = retainHistorySources(context, sources, options, assertBackend);
  const all = sources.records;
  const query = readString(args.query);
  const includeParameters = args.includeParameters === true;
  const selected = await matchingRecords(all, query, { ...options, assertCurrent });
  assertCurrent();
  const filtered = selected.matches.slice(0, readLimit(args.limit, 100));
  const observations = await readVerificationObservations(filtered.map(({ entry }) => entry), { ...options, assertCurrent });
  assertCurrent();
  const cards = activityCards(context, filtered.map(({ entry }) => entry), includeParameters, observations);
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
    records: filtered.map(({ entry: record, judgment }) => ({ ...describeRecord(context, record, includeParameters, observations), ...(judgment ? { judgment } : {}) })),
    judgments: selected.judgments,
    returned: filtered.length,
    total: all.length,
    policy: 'Read-only local execution history. Activity cards group bounded redacted records into user-facing outcomes; UI routing and recovery remain separate confirmation-gated modes.',
  };
}

export async function describeExecutionHistoryItem(context: CommandContext, args: AgentHarnessExecutionHistoryArgs, options: CatalogRankingOptions = {}): Promise<ExecutionHistoryResolution> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const assertBackend = captureHistoryBackend(context);
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'execution action:"record" requires executionRecordId, recordId, target, or query. Use execution action:"history" to inspect recent record ids.',
    };
  }
  const sources = historySources(context);
  const assertCurrent = retainHistorySources(context, sources, options, assertBackend);
  const all = sources.records;
  const describe = async (record: AgentExecutionRecord, resolvedBy: string) => {
    const observations = await readVerificationObservations([record], { ...options, assertCurrent });
    assertCurrent(); return describeRecord(context, record, true, observations, { ...lookup, resolvedBy });
  };
  const normalized = lookup.input.toLowerCase();
  const exact = all.find((record) => record.id === lookup.input || record.callId === lookup.input);
  if (exact) return { status: 'found', record: await describe(exact, 'id') };
  const insensitive = all.find((record) => record.id.toLowerCase() === normalized || record.callId.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', record: await describe(insensitive, 'case-insensitive-id') };
  const selected = lookup.source === 'executionRecordId' || lookup.source === 'recordId' ? { matches: [], judgments: [] }
    : await matchingRecords(all, lookup.input, { ...options, assertCurrent });
  assertCurrent();
  const searched = selected.matches;
  if (searched.length === 1 && searched[0]!.judgment?.reading.verdict === 'yes' && searched[0]!.judgment.reading.outcome === 'act') return { status: 'found', record: { ...await describe(searched[0]!.entry, 'search'), judgment: searched[0]!.judgment } };
  if (searched.length > 0) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map(({ entry, judgment }) => ({ ...candidate(entry), judgment })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown execution history record ${lookup.input}. Use execution action:"history" to inspect recent record ids.`,
  };
}
