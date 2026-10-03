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

function certificationSchemaStatus(records: readonly Record<string, unknown>[]): RemoteRuntimeRecordCertification['schemaStatus'] {
  const explicit = firstAcross(records, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus']).toLowerCase().replace(/[_\s]+/g, '-');
  if (['certified', 'valid', 'verified', 'schema-certified'].includes(explicit)) return 'certified';
  return firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion'])
    && firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'remoteRuntimePublicationGuarantee'])
    && firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId', 'methodId', 'sourceTool'])
    ? 'certified'
    : 'legacy';
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
}): RemoteRuntimeRecordCertification {
  const records = certificationRecords(input.record);
  const schemaStatus = certificationSchemaStatus(records);
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

function safePathRef(value: string): string | null {
  const redacted = redactText(value);
  if (!redacted) return null;
  const parts = redacted.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return safePreview(redacted, 120);
  return safePreview(`.../${parts.slice(-2).join('/')}`, 120);
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

function outcomeKind(record: Record<string, unknown>): string {
  const raw = nestedString(record, 'kind')
    || nestedString(record, 'type')
    || nestedString(record, 'purpose')
    || nestedString(record, 'operation');
  const normalized = raw.toLowerCase();
  if (normalized.includes('export')) return 'export';
  if (normalized.includes('closeout')) return 'closeout';
  if (normalized.includes('artifact')) return 'artifact';
  if (normalized.includes('capture')) return 'capture';
  return raw || 'remote-outcome';
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

function normalizeOutcome(entry: CollectedRecord, index: number): RemoteCaptureOutcomeRecord | null {
  const runner = runnerId(entry.record);
  if (!runner) return null;
  const kind = outcomeKind(entry.record);
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

function normalizeWorkspace(entry: CollectedRecord, index: number): RemoteWorkspaceEvidenceRecord | null {
  const runner = runnerId(entry.record);
  if (!runner) return null;
  const id = workspaceId(entry.record) || `remote-workspace:${runner}:${index}`;
  const path = nestedString(entry.record, 'worktreePath')
    || nestedString(entry.record, 'workspacePath')
    || nestedString(entry.record, 'path')
    || nestedString(entry.record, 'root')
    || nestedString(entry.record, 'directory');
  const status = workspaceStatus(entry.record);
  const modelRoute = routeForRunner(entry.record, runner);
  const workspace = workspaceId(entry.record) || null;
  const worktreeRef = safePathRef(path);
  const branch = safeNullablePreview(nestedString(entry.record, 'branch') || nestedString(entry.record, 'ref') || nestedString(entry.record, 'baseRef'), 100);
  return {
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
      durableId: id,
      runnerId: runner,
      modelRoute,
      hasWorkspaceEvidence: Boolean(workspace || worktreeRef || branch),
      status,
    }),
  };
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

export function remoteReadModelSnapshot(context: CommandContext): RemoteReadModelSnapshot {
  const outcomeEntries = outcomeSources(context).flatMap((candidate) =>
    collectFromSource(candidate.source, candidate.path, candidate.kind, OUTCOME_WRAPPER_KEYS, OUTCOME_METHODS)
  );
  const workspaceEntries = workspaceSources(context).flatMap((candidate) =>
    collectFromSource(candidate.source, candidate.path, candidate.kind, WORKSPACE_WRAPPER_KEYS, WORKSPACE_METHODS)
  );
  return {
    outcomes: dedupeById(outcomeEntries.map(normalizeOutcome).filter((entry): entry is RemoteCaptureOutcomeRecord => entry !== null)),
    workspaces: dedupeById(workspaceEntries.map(normalizeWorkspace).filter((entry): entry is RemoteWorkspaceEvidenceRecord => entry !== null)),
    sourceCounts: {
      ...sourceCounts(outcomeEntries),
      ...sourceCounts(workspaceEntries),
    },
  };
}
