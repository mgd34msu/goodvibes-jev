import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { capturePersonalOpsData, capturePersonalOpsSnapshot, assertPersonalOpsDataCurrent } from './agent-harness-personal-ops-source.ts';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { readRemotePublisherOutcomeKind, readRemotePublisherSchemaStatus } from './agent-harness-remote-publisher-readings.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface RemoteCaptureOutcomeRecord {
  readonly id: string;
  readonly runnerId: string;
  readonly status: string;
  readonly kind: string;
  readonly task: string | null;
  readonly summary: string | null;
  readonly captureId: string | null;
  readonly exportId: string | null;
  readonly artifactId: string | null;
  readonly sourcePath: string;
  readonly source: 'daemon-read-model' | 'sdk-read-model';
  readonly redaction: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly modelRoute: string;
  readonly certification: RemoteRuntimeRecordCertification;
}

export interface RemoteWorkspaceEvidenceRecord {
  readonly id: string;
  readonly runnerId: string;
  readonly status: string;
  readonly workspaceId: string | null;
  readonly isolationKind: string;
  readonly label: string | null;
  readonly worktreeRef: string | null;
  readonly branch: string | null;
  readonly sourcePath: string;
  readonly source: 'daemon-read-model' | 'sdk-read-model';
  readonly redaction: string;
  readonly modelRoute: string;
  readonly certification: RemoteRuntimeRecordCertification;
}

export interface RemoteReadModelSnapshot {
  readonly outcomes: readonly RemoteCaptureOutcomeRecord[];
  readonly workspaces: readonly RemoteWorkspaceEvidenceRecord[];
  readonly sourceCounts: Readonly<Record<string, number>>;
}

export interface RemoteRuntimeRecordCertification {
  readonly schemaStatus: 'certified' | 'legacy';
  readonly schemaVersion?: string;
  readonly publicationGuarantee?: string;
  readonly publisher?: string;
  readonly provenance?: readonly string[];
  readonly receiptId?: string;
  readonly cursor?: string;
  readonly missingSignals: readonly string[];
  readonly policy: string;
}

interface SourceCandidate {
  readonly path: string;
  readonly source: unknown;
  readonly kind: 'daemon-read-model' | 'sdk-read-model';
}

interface CollectedRecord {
  readonly path: string;
  readonly kind: 'daemon-read-model' | 'sdk-read-model';
  readonly record: Record<string, unknown>;
}

const OUTCOME_WRAPPER_KEYS = [
  'records',
  'items',
  'outcomes',
  'captureOutcomes',
  'captures',
  'captureRecords',
  'exports',
  'exportOutcomes',
  'closeouts',
  'closeoutOutcomes',
  'artifacts',
] as const;

const WORKSPACE_WRAPPER_KEYS = [
  'records',
  'items',
  'workspaces',
  'workspaceRecords',
  'workspaceIsolation',
  'workspaceEvidence',
  'worktrees',
  'worktreeRecords',
] as const;

const SNAPSHOT_METHODS = [
  'getSnapshot',
  'snapshot',
  'toJSON',
] as const;

const OUTCOME_METHODS = [
  'listCaptureOutcomes',
  'listOutcomes',
  'listCaptures',
  'listExports',
  'listCloseouts',
  'listArtifacts',
  'list',
] as const;

const WORKSPACE_METHODS = [
  'listWorkspaceEvidence',
  'listWorkspaceIsolation',
  'listWorkspaces',
  'listWorktrees',
  'list',
] as const;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return readObject(record.metadata);
}

function certificationRecords(record: Record<string, unknown>): readonly Record<string, unknown>[] {
  return [
    record,
    readMetadata(record),
    readObject(record.schema),
    readObject(record.contract),
    readObject(record.publication),
    readObject(record.receipt),
    readObject(record.certification),
  ];
}

function nestedString(record: Record<string, unknown>, key: string): string {
  return readString(record[key])
    || readString(readMetadata(record)[key])
    || readString(readObject(record.task)[key])
    || readString(readObject(record.evidence)[key])
    || readString(readObject(record.workspace)[key]);
}

function firstAcross(records: readonly Record<string, unknown>[], keys: readonly string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = readString(record[key]);
      if (value) return value;
    }
  }
  return '';
}

function stringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return [...new Set(value.map((entry) => readString(entry)).filter(Boolean))].slice(0, 10);
  const text = readString(value);
  return text ? text.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 10) : [];
}

function redactText(value: string): string {
  return value
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^,\s;/]+/gi, '$1=<redacted>');
}

function safePreview(value: string, limit: number): string {
  return previewHarnessText(redactText(value), limit);
}

function safeNullablePreview(value: string, limit: number): string | null {
  return value ? safePreview(value, limit) : null;
}


function remoteCertification(input: {
  readonly record: Record<string, unknown>;
  readonly sourcePath: string;
  readonly recordKind: 'remote outcome' | 'remote workspace';
  readonly durableId: string;
  readonly runnerId: string;
  readonly modelRoute: string;
  readonly hasOutcomeEvidence?: boolean;
  readonly hasWorkspaceEvidence?: boolean;
  readonly status: string;
  readonly schemaStatus: RemoteRuntimeRecordCertification['schemaStatus'];
}): RemoteRuntimeRecordCertification {
  const records = certificationRecords(input.record);
  const schemaStatus = input.schemaStatus;
  const schemaVersion = firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const publicationGuarantee = firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'remoteRuntimePublicationGuarantee']);
  const publisher = firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  const receiptId = firstAcross(records, ['receiptId', 'operationReceiptId', 'captureReceiptId', 'exportReceiptId', 'closeoutReceiptId', 'workspaceReceiptId']);
  const cursor = firstAcross(records, ['cursor', 'freshnessCursor', 'sequence', 'checkpoint']);
  const provenance = [...new Set([
    ...stringArray(input.record.provenance),
    input.sourcePath ? `source ${input.sourcePath}` : '',
    firstAcross(records, ['methodId']) ? `method ${firstAcross(records, ['methodId'])}` : '',
    firstAcross(records, ['sourceTool']) ? `sourceTool ${firstAcross(records, ['sourceTool'])}` : '',
  ].map((entry) => safePreview(entry, 180)).filter(Boolean))].slice(0, 8);
  const missingSignals = [
    ...(schemaStatus === 'certified' ? [] : [`Certified ${input.recordKind} schema is not published.`]),
    ...(input.durableId ? [] : [`Durable ${input.recordKind} id is not published.`]),
    ...(input.runnerId ? [] : [`${input.recordKind} runner id is not published.`]),
    ...(publicationGuarantee ? [] : [`${input.recordKind} publication guarantee is not published.`]),
    ...(publisher ? [] : [`${input.recordKind} publisher is not published.`]),
    ...(provenance.length > 0 ? [] : [`${input.recordKind} provenance is not published.`]),
    ...(cursor ? [] : [`${input.recordKind} freshness cursor is not published.`]),
    ...(input.modelRoute ? [] : [`${input.recordKind} inspect route is not published.`]),
    ...(input.status ? [] : [`${input.recordKind} status is not published.`]),
    ...(input.hasOutcomeEvidence === false ? ['Remote capture/export/closeout/artifact evidence id is not published.'] : []),
    ...(input.hasWorkspaceEvidence === false ? ['Remote workspace/worktree isolation evidence is not published.'] : []),
  ];
  return {
    schemaStatus,
    ...(schemaVersion ? { schemaVersion: safePreview(schemaVersion, 80) } : {}),
    ...(publicationGuarantee ? { publicationGuarantee: safePreview(publicationGuarantee, 220) } : {}),
    ...(publisher ? { publisher: safePreview(publisher, 80) } : {}),
    ...(provenance.length > 0 ? { provenance } : {}),
    ...(receiptId ? { receiptId: safePreview(receiptId, 96) } : {}),
    ...(cursor ? { cursor: safePreview(cursor, 96) } : {}),
    missingSignals,
    policy: 'Remote runtime read models certify release readiness only when the SDK or daemon publishes schema, durable runner/evidence ids, publication guarantee, publisher/provenance, freshness cursor, exact inspect route, and redacted outcome or workspace isolation evidence.',
  };
}

function pathReferenceLayout(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? value : `.../${parts.slice(-2).join('/')}`;
}

function safePathRef(value: string): string | null {
  const redacted = redactText(value);
  return redacted ? safePreview(pathReferenceLayout(redacted), 120) : null;
}

function timestampString(value: unknown): string | null {
  const raw = readString(value);
  if (raw) return safePreview(raw, 80);
  const numeric = readNumber(value);
  if (!numeric) return null;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? String(numeric) : date.toISOString();
}

function callMethod(source: Record<string, unknown>, method: string): unknown {
  const fn = source[method];
  if (typeof fn !== 'function') return undefined;
  try {
    return (fn as () => unknown).call(source);
  } catch {
    return undefined;
  }
}

function collectFromSource(
  source: unknown,
  path: string,
  kind: 'daemon-read-model' | 'sdk-read-model',
  wrapperKeys: readonly string[],
  methods: readonly string[],
  visited = new WeakSet<object>(),
): readonly CollectedRecord[] {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source
      .flatMap((entry, index) => collectFromSource(entry, `${path}[${index}]`, kind, wrapperKeys, methods, visited));
  }
  if (source instanceof Map) {
    return Array.from(source.entries())
      .flatMap(([key, value]) => collectFromSource(value, `${path}.${String(key)}`, kind, wrapperKeys, methods, visited));
  }
  if (typeof source !== 'object') return [];
  if (visited.has(source)) return [];
  visited.add(source);

  const record = source as Record<string, unknown>;
  const fromSnapshots = SNAPSHOT_METHODS.flatMap((method) => {
    const snapshot = callMethod(record, method);
    return snapshot === undefined ? [] : collectFromSource(snapshot, `${path}.${method}()`, kind, wrapperKeys, methods, visited);
  });
  const fromMethods = methods.flatMap((method) => {
    const snapshot = callMethod(record, method);
    return snapshot === undefined ? [] : collectFromSource(snapshot, `${path}.${method}()`, kind, wrapperKeys, methods, visited);
  });
  const fromWrappers = wrapperKeys.flatMap((key) => {
    if (!(key in record)) return [];
    return collectFromSource(record[key], `${path}.${key}`, kind, wrapperKeys, methods, visited);
  });
  if (fromSnapshots.length > 0 || fromMethods.length > 0 || fromWrappers.length > 0) {
    return [...fromSnapshots, ...fromMethods, ...fromWrappers];
  }
  return [{ path, kind, record }];
}

function runnerId(record: Record<string, unknown>): string {
  return nestedString(record, 'runnerId')
    || nestedString(record, 'agentId')
    || nestedString(record, 'linkedAgentId')
    || nestedString(record, 'remoteRunnerId')
    || nestedString(record, 'runner');
}

function routeForRunner(record: Record<string, unknown>, runner: string): string {
  return nestedString(record, 'modelRoute')
    || nestedString(record, 'inspectRoute')
    || nestedString(record, 'reviewRoute')
    || (runner ? `agent_harness mode:"agent_orchestration_agent" agentId:"${runner}" includeParameters:true` : 'agent_harness mode:"agent_orchestration" includeParameters:true');
}

function outcomeText(record: Record<string, unknown>): string {
  return nestedString(record, 'kind')
    || nestedString(record, 'type')
    || nestedString(record, 'purpose')
    || nestedString(record, 'operation');

}

function outcomeStatus(record: Record<string, unknown>): string {
  return nestedString(record, 'status')
    || nestedString(record, 'outcome')
    || nestedString(record, 'result')
    || nestedString(record, 'state')
    || 'unknown';
}

function outcomeId(record: Record<string, unknown>, runner: string, kind: string, index: number): string {
  return nestedString(record, 'id')
    || nestedString(record, 'outcomeId')
    || nestedString(record, 'captureId')
    || nestedString(record, 'exportId')
    || nestedString(record, 'artifactId')
    || `remote-outcome:${runner || 'unknown'}:${kind}:${index}`;
}

type RemoteOutcomeKind = Awaited<ReturnType<typeof readRemotePublisherOutcomeKind>>;
interface PublisherSemantics {
  readonly schemaStatus: RemoteRuntimeRecordCertification['schemaStatus'];
  readonly kind: RemoteOutcomeKind;
}

interface RemotePublisherMeanings {
  readonly outcomes: readonly PublisherSemantics[];
  readonly workspaces: readonly RemoteRuntimeRecordCertification['schemaStatus'][];
}

/** Validate the canonical reading protocol after complete native capture.
 * These exact enum values are result schema, never publisher word synonyms. */
function captureRemotePublisherMeanings(value: unknown): RemotePublisherMeanings {
  const captured = capturePersonalOpsData(value);
  if (captured === null || typeof captured !== 'object' || Array.isArray(captured)
    || !('outcomes' in captured) || !('workspaces' in captured) || Object.keys(captured).length !== 2
    || !Array.isArray(captured.outcomes) || !Array.isArray(captured.workspaces)) throw new ToolInputProjectionError('held');
  const outcomes = captured.outcomes.map((entry: unknown): PublisherSemantics => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || !('schemaStatus' in entry) || !('kind' in entry) || Object.keys(entry).length !== 2) throw new ToolInputProjectionError('held');
    const schemaStatus = entry.schemaStatus, kind = entry.kind;
    if (schemaStatus !== 'certified' && schemaStatus !== 'legacy') throw new ToolInputProjectionError('held');
    if (kind !== 'capture' && kind !== 'export' && kind !== 'closeout' && kind !== 'artifact' && kind !== 'other')
      throw new ToolInputProjectionError('held');
    return { schemaStatus, kind };
  });
  const workspaces = captured.workspaces.map((schemaStatus: unknown): RemoteRuntimeRecordCertification['schemaStatus'] => {
    if (schemaStatus !== 'certified' && schemaStatus !== 'legacy') throw new ToolInputProjectionError('held');
    return schemaStatus;
  });
  return { outcomes, workspaces };
}

function normalizeOutcome(entry: CollectedRecord, index: number, meaning?: PublisherSemantics): RemoteCaptureOutcomeRecord | null {
  const runner = runnerId(entry.record);
  if (!runner) return null;
  const kind = meaning?.kind ?? 'other';
  const task = nestedString(entry.record, 'task') || nestedString(entry.record, 'title') || nestedString(entry.record, 'request');
  const summary = nestedString(entry.record, 'summary')
    || nestedString(entry.record, 'description')
    || nestedString(entry.record, 'logTail')
    || nestedString(entry.record, 'message');
  const id = outcomeId(entry.record, runner, kind, index);
  const status = outcomeStatus(entry.record);
  const captureId = nestedString(entry.record, 'captureId') || null;
  const exportId = nestedString(entry.record, 'exportId') || null;
  const artifactId = nestedString(entry.record, 'artifactId') || nestedString(entry.record, 'sourceArtifactId') || null;
  const modelRoute = routeForRunner(entry.record, runner);
  return {
    id,
    runnerId: runner,
    status,
    kind,
    task: safeNullablePreview(task, 140),
    summary: safeNullablePreview(summary, 220),
    captureId,
    exportId,
    artifactId,
    sourcePath: entry.path,
    source: entry.kind,
    redaction: nestedString(entry.record, 'redaction') || nestedString(entry.record, 'redactionPolicy') || 'bounded-redacted-read-model',
    startedAt: timestampString(entry.record.startedAt ?? readMetadata(entry.record).startedAt),
    completedAt: timestampString(entry.record.completedAt ?? entry.record.finishedAt ?? readMetadata(entry.record).completedAt),
    modelRoute,
    certification: remoteCertification({
      record: entry.record,
      sourcePath: entry.path,
      recordKind: 'remote outcome',
      schemaStatus: meaning?.schemaStatus ?? 'legacy',
      durableId: id,
      runnerId: runner,
      modelRoute,
      hasOutcomeEvidence: Boolean(captureId || exportId || artifactId || kind === 'closeout'),
      status,
    }),
  };
}

function workspaceId(record: Record<string, unknown>): string {
  return nestedString(record, 'workspaceId')
    || nestedString(record, 'worktreeId')
    || nestedString(record, 'id');
}

function workspaceStatus(record: Record<string, unknown>): string {
  return nestedString(record, 'status')
    || nestedString(record, 'state')
    || nestedString(record, 'outcome')
    || 'unknown';
}

const WORKSPACE_PATH_KEYS: readonly string[] = ['worktreePath', 'workspacePath', 'path', 'root', 'directory'];

function selectedNestedWorkspacePath(record: Record<string, unknown>, key: string): { readonly owner: Record<string, unknown>; readonly key: string; readonly value: string } | undefined {
  let owner = record, value = readString(owner[key]);
  if (value) return { owner, key, value };
  owner = readMetadata(record); value = readString(owner[key]);
  if (value) return { owner, key, value };
  owner = readObject(record.task); value = readString(owner[key]);
  if (value) return { owner, key, value };
  owner = readObject(record.evidence); value = readString(owner[key]);
  if (value) return { owner, key, value };
  owner = readObject(record.workspace); value = readString(owner[key]);
  return value ? { owner, key, value } : undefined;
}

function selectedWorkspacePath(record: Record<string, unknown>): { readonly owner: Record<string, unknown>; readonly key: string; readonly value: string } | undefined {
  return selectedNestedWorkspacePath(record, 'worktreePath')
    || selectedNestedWorkspacePath(record, 'workspacePath')
    || selectedNestedWorkspacePath(record, 'path')
    || selectedNestedWorkspacePath(record, 'root')
    || selectedNestedWorkspacePath(record, 'directory');
}

function normalizeWorkspaceOwned(entry: CollectedRecord, index: number, schemaStatus: RemoteRuntimeRecordCertification['schemaStatus'] = 'legacy'): {
  readonly record: RemoteWorkspaceEvidenceRecord;
  readonly path: ReturnType<typeof selectedWorkspacePath>;
} | null {
  const runner = runnerId(entry.record);
  if (!runner) return null;
  const id = workspaceId(entry.record) || `remote-workspace:${runner}:${index}`;
  const selectedPath = selectedWorkspacePath(entry.record);
  const path = selectedPath?.value ?? '';
  const status = workspaceStatus(entry.record);
  const modelRoute = routeForRunner(entry.record, runner);
  const workspace = workspaceId(entry.record) || null;
  const worktreeRef = safePathRef(path);
  const branch = safeNullablePreview(nestedString(entry.record, 'branch') || nestedString(entry.record, 'ref') || nestedString(entry.record, 'baseRef'), 100);
  return { record: {
    id,
    runnerId: runner,
    status,
    workspaceId: workspace,
    isolationKind: nestedString(entry.record, 'isolationKind')
      || nestedString(entry.record, 'workspaceKind')
      || nestedString(entry.record, 'kind')
      || 'workspace',
    label: safeNullablePreview(nestedString(entry.record, 'label') || nestedString(entry.record, 'name') || nestedString(entry.record, 'summary'), 120),
    worktreeRef,
    branch,
    sourcePath: entry.path,
    source: entry.kind,
    redaction: nestedString(entry.record, 'redaction') || nestedString(entry.record, 'redactionPolicy') || 'path-bounded-read-model',
    modelRoute,
    certification: remoteCertification({
      record: entry.record,
      sourcePath: entry.path,
      recordKind: 'remote workspace',
      schemaStatus,
      durableId: id,
      runnerId: runner,
      modelRoute,
      hasWorkspaceEvidence: Boolean(workspace || worktreeRef || branch),
      status,
    }),
  }, path: selectedPath };
}

function dedupeById<T extends { readonly id: string; readonly runnerId: string }>(records: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const record of records) {
    const key = `${record.runnerId}:${record.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(record);
  }
  return output;
}

function sourceCounts(entries: readonly CollectedRecord[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.path] = (counts[entry.path] ?? 0) + 1;
  return counts;
}

function outcomeSources(context: CommandContext): readonly SourceCandidate[] {
  const platform = readObject(context.platform);
  const readModels = readObject(platform.readModels);
  const remoteRuntime = readObject(readModels.remoteRuntime);
  const remoteRunners = readObject(readModels.remoteRunners);
  const remote = readObject(readModels.remote);
  const opsRemote = readObject(readObject(context.ops).remoteRuntime);
  const opsReadModels = readObject(opsRemote.readModels);
  const clients = readObject(context.clients);
  const operator = readObject(clients.operator);
  const operatorRemote = readObject(operator.remoteRuntime);
  return [
    { path: 'context.platform.readModels.remoteRuntime.captureOutcomes', source: remoteRuntime.captureOutcomes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteRuntime.outcomes', source: remoteRuntime.outcomes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteRuntime.captures', source: remoteRuntime.captures, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteRuntime.exports', source: remoteRuntime.exports, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteRuntime.closeouts', source: remoteRuntime.closeouts, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteRunners.captureOutcomes', source: remoteRunners.captureOutcomes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remote.captureOutcomes', source: remote.captureOutcomes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteCaptureOutcomes', source: readModels.remoteCaptureOutcomes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteRunnerOutcomes', source: readModels.remoteRunnerOutcomes, kind: 'daemon-read-model' },
    { path: 'context.ops.remoteRuntime.readModels.captureOutcomes', source: opsReadModels.captureOutcomes, kind: 'sdk-read-model' },
    { path: 'context.clients.operator.remoteRuntime.captureOutcomes', source: operatorRemote.captureOutcomes, kind: 'sdk-read-model' },
  ];
}

function workspaceSources(context: CommandContext): readonly SourceCandidate[] {
  const platform = readObject(context.platform);
  const readModels = readObject(platform.readModels);
  const remoteRuntime = readObject(readModels.remoteRuntime);
  const remoteRunners = readObject(readModels.remoteRunners);
  const remote = readObject(readModels.remote);
  const worktrees = readObject(readModels.worktrees);
  const opsRemote = readObject(readObject(context.ops).remoteRuntime);
  const opsReadModels = readObject(opsRemote.readModels);
  const clients = readObject(context.clients);
  const operator = readObject(clients.operator);
  const operatorRemote = readObject(operator.remoteRuntime);
  return [
    { path: 'context.platform.readModels.remoteRuntime.workspaces', source: remoteRuntime.workspaces, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteRuntime.workspaceIsolation', source: remoteRuntime.workspaceIsolation, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteRuntime.worktrees', source: remoteRuntime.worktrees, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteRunners.workspaces', source: remoteRunners.workspaces, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remote.workspaceIsolation', source: remote.workspaceIsolation, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteWorkspaces', source: readModels.remoteWorkspaces, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.remoteWorkspaceIsolation', source: readModels.remoteWorkspaceIsolation, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.worktrees.remote', source: worktrees.remote, kind: 'daemon-read-model' },
    { path: 'context.ops.remoteRuntime.readModels.workspaces', source: opsReadModels.workspaces, kind: 'sdk-read-model' },
    { path: 'context.clients.operator.remoteRuntime.workspaces', source: operatorRemote.workspaces, kind: 'sdk-read-model' },
  ];
}

interface NativeWorkspaceDisplayCapture {
  readonly record: RemoteWorkspaceEvidenceRecord;
  readonly snapshot: unknown;
  readonly source: Record<string, unknown>;
  readonly sourceSnapshot: unknown;
  readonly path: string;
}

function acquireRemoteEntries(context: CommandContext) {
  return {
    outcomeEntries: outcomeSources(context).flatMap((candidate) =>
      collectFromSource(candidate.source, candidate.path, candidate.kind, OUTCOME_WRAPPER_KEYS, OUTCOME_METHODS)),
    workspaceEntries: workspaceSources(context).flatMap((candidate) =>
      collectFromSource(candidate.source, candidate.path, candidate.kind, WORKSPACE_WRAPPER_KEYS, WORKSPACE_METHODS)),
  };
}

type RemoteEntries = ReturnType<typeof acquireRemoteEntries>;

function normalizeRemoteEntries(entries: RemoteEntries, captures?: NativeWorkspaceDisplayCapture[],
  meanings?: RemotePublisherMeanings): RemoteReadModelSnapshot {
  const { outcomeEntries, workspaceEntries } = entries;
  const outcomes = dedupeById(outcomeEntries.map((entry, index) => normalizeOutcome(entry, index, meanings?.outcomes[index]))
    .filter((entry): entry is RemoteCaptureOutcomeRecord => entry !== null));
  const workspaces = workspaceEntries.map((entry, index) => {
    const native = normalizeWorkspaceOwned(entry, index, meanings?.workspaces[index]);
    if (captures && native?.path) captures.push({ record: native.record, snapshot: capturePersonalOpsData(native.record),
      source: entry.record, sourceSnapshot: capturePersonalOpsData(entry.record), path: native.path.value });
    return native?.record ?? null;
  });
  return {
    outcomes,
    workspaces: dedupeById(workspaces.filter((entry): entry is RemoteWorkspaceEvidenceRecord => entry !== null)),
    sourceCounts: { ...sourceCounts(outcomeEntries), ...sourceCounts(workspaceEntries) },
  };
}

function readRemoteSnapshot(context: CommandContext): RemoteReadModelSnapshot {
  return normalizeRemoteEntries(acquireRemoteEntries(context));
}

export function remoteReadModelSnapshot(context: CommandContext): RemoteReadModelSnapshot {
  return readRemoteSnapshot(context);
}

const nativeWorkspaceDisplays = new WeakMap<object, {
  readonly snapshot: RemoteReadModelSnapshot;
  readonly snapshotData: unknown;
  readonly captures: readonly NativeWorkspaceDisplayCapture[];
  binding?: { readonly records: readonly RemoteWorkspaceEvidenceRecord[]; readonly snapshot: unknown };
}>();

interface NativePublisherCapture {
  readonly context: CommandContext;
  readonly entries: RemoteEntries;
  readonly assertEntries: (value: unknown) => void;
  state: { readonly kind: 'captured' } | { readonly kind: 'settling' } | { readonly kind: 'retired' }
    | { readonly kind: 'settled'; readonly meanings: RemotePublisherMeanings; readonly assertCurrent: () => void };
}
const nativePublisherCaptures = new WeakMap<object, NativePublisherCapture>();

export interface NativeRemotePublisherProjection {
  readonly projectPath: (value: string) => { readonly displayText: string; readonly validationText: string };
  readonly projectText: (value: string) => { readonly displayText: string; readonly validationText: string };
  /** Canonical privacy projection into complete ordered fields, including literal display-marker parts. */
  readonly protectFields: (value: unknown, options: CatalogRankingOptions) => Promise<unknown>;
}

/** This synchronous observation never interprets publisher words. Semantic
 * publication requires settlement of this exact native capture first. */
export function captureNativeRemoteReadModelSnapshot(context: CommandContext): { readonly snapshot: RemoteReadModelSnapshot; readonly token: object } {
  const entries = acquireRemoteEntries(context), captured = capturePersonalOpsSnapshot(entries);
  const snapshot = normalizeRemoteEntries(entries), token = Object.freeze({});
  nativePublisherCaptures.set(token, { context, entries, assertEntries: captured.assertCurrent, state: { kind: 'captured' } });
  nativeWorkspaceDisplays.set(token, { snapshot, snapshotData: capturePersonalOpsData(snapshot), captures: [] });
  return { snapshot, token };
}

function assertPublisherEntryCurrent(owner: NativePublisherCapture, assertCurrent: () => void): void {
  assertCurrent(); owner.assertEntries(owner.entries); assertCurrent();
  owner.assertEntries(acquireRemoteEntries(owner.context)); assertCurrent();
}

/** Publisher prose is read only after complete native path/text projection.
 * A failed or uncertain reading retires this capture; no word or field-presence
 * fallback can publish a certified schema or classify an operation. */
export async function settleNativeRemotePublisherSemantics(token: object, options: CatalogRankingOptions & {
  readonly assertCurrent: () => void; readonly assertSourceCurrent: () => void;
},
  projection: NativeRemotePublisherProjection): Promise<RemoteReadModelSnapshot> {
  const owner = nativePublisherCaptures.get(token), display = nativeWorkspaceDisplays.get(token);
  if (!owner || owner.state.kind !== 'captured' || !display || display.binding) throw new ToolInputProjectionError('held');
  owner.state = { kind: 'settling' };
  try {
    const assertOptions = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'assertSourceCurrent', 'retainCurrent']);
    const assertProjection = captureCatalogMethods(projection, ['projectPath', 'projectText', 'protectFields']);
    const { signal, sourceOwner, assertCurrent: callerCurrent, assertSourceCurrent: backendCurrent, retainCurrent } = options;
    const { projectPath, projectText, protectFields } = projection;
    const retained = new Map<string | (() => void), () => void>();
    const retain = (guard: () => void, key?: string) => {
      if (!retained.has(key ?? guard)) retained.set(key ?? guard, guard);
      retainCurrent?.call(options, guard, key);
    };
    const assertSourceCurrent = () => {
      assertOptions(); assertProjection(); signal?.throwIfAborted();
      if (options.signal !== signal || options.sourceOwner !== sourceOwner || options.assertCurrent !== callerCurrent || options.assertSourceCurrent !== backendCurrent || options.retainCurrent !== retainCurrent
        || projection.projectPath !== projectPath || projection.projectText !== projectText || projection.protectFields !== protectFields
        || owner.state.kind === 'retired') throw new ToolInputProjectionError('held');
      assertPublisherEntryCurrent(owner, () => {
        signal?.throwIfAborted(); const result: unknown = backendCurrent.call(options);
        if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new ToolInputProjectionError('held'); }
      });
      for (const guard of retained.values()) guard();
      signal?.throwIfAborted(); assertOptions(); assertProjection();
      // Arbitrary backend/retained callbacks may write a record. Close that
      // boundary with a complete comparison before this restriction returns.
      owner.assertEntries(owner.entries);
    };
    const assertCurrent = () => {
      assertSourceCurrent();
      const result: unknown = callerCurrent.call(options);
      if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new ToolInputProjectionError('held'); }
      assertSourceCurrent();
    };
    const current = { ...options, assertCurrent, retainCurrent: retain };
    const projectData = (value: unknown): NativeWorkspacePathProjection => {
      if (typeof value === 'string') {
        assertCurrent(); const projected = projectText(value); assertCurrent();
        return { display: projected.displayText, validation: projected.validationText };
      }
      if (Array.isArray(value)) {
        const entries = value.map(projectData);
        return { display: entries.map(entry => entry.display), validation: entries.map(entry => entry.validation) };
      }
      if (value === null || typeof value !== 'object') return { display: value, validation: value };
      const display: Record<string, unknown> = Object.create(null), validation: Record<string, unknown> = Object.create(null);
      for (const [key, child] of Object.entries(value)) {
        const projected = projectData(child);
        Object.defineProperty(display, key, { value: projected.display, enumerable: true });
        Object.defineProperty(validation, key, { value: projected.validation, enumerable: true });
      }
      return { display, validation };
    };
    const projectSource = (entry: CollectedRecord, recordKind: 'remote outcome' | 'remote workspace'): unknown => {
      assertCurrent();
      const header = projectData(capturePersonalOpsData({ recordKind, sourcePath: entry.path, source: entry.kind,
        selectedStatusText: firstAcross(certificationRecords(entry.record), ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus']),
        ...(recordKind === 'remote outcome' ? { selectedOutcomeText: outcomeText(entry.record) } : {}),
      }));
      const record = recordKind === 'remote workspace'
        ? projectNativeRemoteWorkspacePathSource(captureNativeRemoteWorkspacePathSource(entry.record, 'snapshot'), projectPath, projectText, assertCurrent)
        : projectData(capturePersonalOpsData(entry.record));
      const paired = { display: { header: header.display, record: record.display }, validation: { header: header.validation, record: record.validation } };
      snapshotJudgmentInput(paired.validation); assertCurrent();
      return paired.display;
    };
    assertCurrent();
    // Finish complete native admission, including every duplicate and
    // unselected record, before the first privacy or semantic request.
    const projectedOutcomes = owner.entries.outcomeEntries.map(entry => projectSource(entry, 'remote outcome'));
    const projectedWorkspaces = owner.entries.workspaceEntries.map(entry => projectSource(entry, 'remote workspace'));
    assertCurrent();
    const outcomes: PublisherSemantics[] = [];
    for (const source of projectedOutcomes) {
      const fields = await protectFields(source, current); assertCurrent();
      const schemaStatus = await readRemotePublisherSchemaStatus(fields, current);
      assertCurrent();
      const kind = await readRemotePublisherOutcomeKind(fields, current);
      assertCurrent(); outcomes.push({ schemaStatus, kind });
    }
    const workspaces: RemoteRuntimeRecordCertification['schemaStatus'][] = [];
    for (const source of projectedWorkspaces) {
      const fields = await protectFields(source, current); assertCurrent();
      workspaces.push(await readRemotePublisherSchemaStatus(fields, current)); assertCurrent();
    }
    const meanings = captureRemotePublisherMeanings({ outcomes, workspaces });
    const meaningsSnapshot = capturePersonalOpsSnapshot(meanings);
    retain(() => meaningsSnapshot.assertCurrent(meanings), 'agent.remote-publisher.settled-readings');
    assertSourceCurrent();
    const captures: NativeWorkspaceDisplayCapture[] = [];
    const snapshot = normalizeRemoteEntries(owner.entries, captures, meanings);
    assertCurrent();
    nativeWorkspaceDisplays.set(token, { snapshot, snapshotData: capturePersonalOpsData(snapshot), captures });
    owner.state = { kind: 'settled', meanings, assertCurrent: assertSourceCurrent };
    // Retain source restrictions only. The one-use caller guard may itself
    // visit the publication guard map, so retaining it would recurse.
    retainCurrent?.call(options, assertSourceCurrent, 'agent.remote-publisher.native-capture');
    assertCurrent(); return snapshot;
  } catch (error) { owner.state = { kind: 'retired' }; throw error; }
}

/** Fresh native records must remain complete and exact before previously
 * settled readings are reused. This synchronous guard never reruns a reading. */
export function currentNativeRemoteReadModelSnapshot(context: CommandContext, token: object): RemoteReadModelSnapshot {
  const owner = nativePublisherCaptures.get(token);
  if (!owner || owner.context !== context || owner.state.kind !== 'settled') throw new ToolInputProjectionError('held');
  const { assertCurrent, meanings } = owner.state;
  assertCurrent();
  const entries = acquireRemoteEntries(context);
  owner.assertEntries(entries); assertCurrent();
  // Recheck these exact references after the last arbitrary callback.
  owner.assertEntries(entries);
  return normalizeRemoteEntries(entries, undefined, meanings);
}

/** Called only at the operation's native snapshot-to-DTO copy boundary. */
export function bindNativeRemoteWorkspaceDisplays(token: object, records: readonly RemoteWorkspaceEvidenceRecord[]): void {
  const owner = nativeWorkspaceDisplays.get(token);
  if (!owner || owner.binding || nativePublisherCaptures.get(token)?.state.kind !== 'settled') throw new ToolInputProjectionError('held');
  assertPersonalOpsDataCurrent(records, owner.snapshot.workspaces);
  owner.binding = { records, snapshot: capturePersonalOpsData(records) };
}

export function assertNativeRemoteWorkspaceDisplaysCurrent(token: object): void {
  const owner = nativeWorkspaceDisplays.get(token), binding = owner?.binding;
  if (!owner || !binding || nativePublisherCaptures.get(token)?.state.kind !== 'settled') throw new ToolInputProjectionError('held');
  const publisher = nativePublisherCaptures.get(token);
  if (publisher?.state.kind !== 'settled') throw new ToolInputProjectionError('held');
  publisher.state.assertCurrent();
  assertPersonalOpsDataCurrent(owner.snapshot, owner.snapshotData);
  assertPersonalOpsDataCurrent(binding.records, binding.snapshot);
  for (const capture of owner.captures) {
    assertPersonalOpsDataCurrent(capture.source, capture.sourceSnapshot);
    assertPersonalOpsDataCurrent(capture.record, capture.snapshot);
  }
}

/** Retain exact producer record occurrences, then translate only those paths
 * through the complete descriptor capture. Equal caller records cannot adopt
 * the association, and the native reference itself is never reconstructed. */
export function projectNativeRemoteWorkspaceDisplayReferences(
  token: object, value: unknown,
  projectPath: (value: string) => { readonly displayText: string; readonly validationText: string },
  assertCurrent: () => void,
): readonly { readonly path: readonly (string | number)[]; readonly displayText: string; readonly validationText: string }[] {
  const owner = nativeWorkspaceDisplays.get(token), binding = owner?.binding;
  if (!owner || !binding) throw new ToolInputProjectionError('held');
  const assertOwned = () => {
    assertCurrent(); assertNativeRemoteWorkspaceDisplaysCurrent(token); assertCurrent();
  };
  assertOwned();
  const byRecord = new Map<object, NativeWorkspaceDisplayCapture>();
  for (const [index, record] of owner.snapshot.workspaces.entries()) {
    const capture = owner.captures.find(entry => entry.record === record);
    const bound = binding.records[index];
    if (capture && bound) byRecord.set(bound, capture);
  }
  const captured = capturePersonalOpsData(value);
  const references: { readonly path: readonly (string | number)[]; readonly displayText: string; readonly validationText: string }[] = [];
  const visit = (original: unknown, detached: unknown, path: readonly (string | number)[]): void => {
    if (detached === null || typeof detached !== 'object') return;
    if (original === null || typeof original !== 'object' || Array.isArray(original) !== Array.isArray(detached)) throw new ToolInputProjectionError('held');
    const native = byRecord.get(original);
    if (native) {
      assertOwned(); const parsed = projectPath(native.path); assertOwned();
      if (typeof native.record.worktreeRef !== 'string') throw new ToolInputProjectionError('held');
      references.push({ path: [...path, 'worktreeRef'], displayText: native.record.worktreeRef,
        validationText: previewHarnessText(pathReferenceLayout(parsed.validationText), 120) });
    }
    for (const [key, child] of Object.entries(detached)) {
      const descriptor = Object.getOwnPropertyDescriptor(original, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new ToolInputProjectionError('held');
      visit(descriptor.value, child, [...path, Array.isArray(detached) ? Number(key) : key]);
    }
  };
  visit(value, captured, []);
  assertPersonalOpsDataCurrent(value, captured); assertOwned();
  return references;
}


interface NativeWorkspacePathProjection {
  readonly display: unknown;
  readonly validation: unknown;
}

const nativeWorkspacePathSources = new WeakMap<object, {
  readonly source: unknown;
  readonly snapshot: unknown;
  readonly layout: 'snapshot' | 'map-entries';
}>();

/** Local native observation only. The opaque association never enters the
 * public snapshot and cannot be reconstructed from a path, id or display. */
export function captureNativeRemoteWorkspacePathSource(source: unknown, layout: 'snapshot' | 'map-entries'): object {
  const token = Object.freeze({});
  nativeWorkspacePathSources.set(token, { source, snapshot: capturePersonalOpsData(source), layout });
  return token;
}

/** Use the producer's original complete wrapper and path precedence on its
 * already materialized data. No snapshot/list method can survive that native
 * descriptor capture, and Map keys remain structural rather than records. */
export function projectNativeRemoteWorkspacePathSource(
  token: object,
  projectPath: (value: string) => { readonly displayText: string; readonly validationText: string },
  projectText: (value: string) => { readonly displayText: string; readonly validationText: string },
  assertCurrent: () => void,
): NativeWorkspacePathProjection {
  const owned = nativeWorkspacePathSources.get(token);
  if (!owned) throw new ToolInputProjectionError('held');
  const nativeRecords: { readonly record: RemoteWorkspaceEvidenceRecord; readonly snapshot: unknown }[] = [];
  const assertOwned = () => {
    assertCurrent(); assertPersonalOpsDataCurrent(owned.source, owned.snapshot);
    for (const native of nativeRecords) assertPersonalOpsDataCurrent(native.record, native.snapshot);
    assertCurrent();
  };
  assertOwned();
  const entries: CollectedRecord[] = [];
  if (owned.layout === 'map-entries') {
    if (!Array.isArray(owned.snapshot)) throw new ToolInputProjectionError('held');
    for (const [index, pair] of owned.snapshot.entries()) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') throw new ToolInputProjectionError('held');
      entries.push(...collectFromSource(pair[1], `native-workspace-map[${index}]`, 'sdk-read-model', WORKSPACE_WRAPPER_KEYS, WORKSPACE_METHODS));
    }
  } else entries.push(...collectFromSource(owned.snapshot, 'native-workspace-snapshot', 'sdk-read-model', WORKSPACE_WRAPPER_KEYS, WORKSPACE_METHODS));
  const selected = new Map<object, Map<string, { readonly value: string; readonly record: RemoteWorkspaceEvidenceRecord }>>();
  for (const [index, entry] of entries.entries()) {
    const native = normalizeWorkspaceOwned(entry, index);
    const path = native?.path;
    // The producer selected ownership above. This complete extra inspection
    // can only restrict malformed unselected native path data.
    for (const key of WORKSPACE_PATH_KEYS) {
      for (const owner of [entry.record, readMetadata(entry.record), readObject(entry.record.task), readObject(entry.record.evidence), readObject(entry.record.workspace)]) {
        const value = owner[key];
        if (value !== undefined && value !== null && value !== '' && typeof value !== 'string') throw new ToolInputProjectionError('held');
      }
    }
    if (!path) {
      if (!native && selectedWorkspacePath(entry.record)) throw new ToolInputProjectionError('held');
      continue;
    }
    if (!native) throw new ToolInputProjectionError('held');
    nativeRecords.push({ record: native.record, snapshot: capturePersonalOpsData(native.record) });
    const fields = selected.get(path.owner) ?? new Map<string, { readonly value: string; readonly record: RemoteWorkspaceEvidenceRecord }>();
    fields.set(path.key, { value: path.value, record: native.record }); selected.set(path.owner, fields);
  }
  assertOwned();
  const visit = (value: unknown): NativeWorkspacePathProjection => {
    if (typeof value === 'string') {
      assertOwned(); const parsed = projectText(value); assertOwned();
      return { display: parsed.displayText, validation: parsed.validationText };
    }
    if (Array.isArray(value)) {
      const display: unknown[] = [], validation: unknown[] = [];
      for (const child of value) { const projected = visit(child); display.push(projected.display); validation.push(projected.validation); }
      return { display, validation };
    }
    if (value === null || typeof value !== 'object') return { display: value, validation: value };
    const display: Record<string, unknown> = Object.create(null), validation: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      let projected: NativeWorkspacePathProjection;
      const nativePath = selected.get(value)?.get(key);
      if (nativePath !== undefined) {
        assertOwned();
        const parsed = projectPath(nativePath.value);
        assertOwned();
        // Selection trims only for the native display. Preserve surrounding
        // source whitespace in the complete paired original DTO.
        if (typeof child !== 'string' || child.trim() !== nativePath.value) throw new ToolInputProjectionError('held');
        const start = child.indexOf(nativePath.value), end = start + nativePath.value.length;
        projected = { display: child.slice(0, start) + parsed.displayText + child.slice(end), validation: child.slice(0, start) + parsed.validationText + child.slice(end) };
      } else projected = visit(child);
      Object.defineProperty(display, key, { value: projected.display, enumerable: true });
      Object.defineProperty(validation, key, { value: projected.validation, enumerable: true });
    }
    return { display, validation };
  };
  const projected = visit(owned.snapshot);
  assertOwned(); return projected;
}
