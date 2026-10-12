import { types as nodeTypes } from 'node:util';
import { previewHarnessText } from './agent-harness-text.ts';
import { memoryExternalProviderLiveCertification, memoryExternalProviderReceiptCertification } from './agent-harness-memory-provider-certification.ts';
import type { MemoryExternalProviderCertification } from './agent-harness-memory-provider-certification.ts';
import { captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import { capturePersonalOpsSnapshot, protectPersonalOpsData } from './agent-harness-personal-ops-source.ts';
import { readPersonalOpsBoolean, readPersonalOpsReceiptStatus } from './agent-harness-personal-ops-readings.ts';
import { assertMemoryCurrent, retainMemoryReadingOptions, readMemoryCredentialState, readMemoryLiveStatus, readMemoryPublicText, readMemoryReceiptMember, readMemoryRouteRole, selectMemoryProvider } from './agent-harness-memory-provider-readings.ts';
import { findCredentialCandidates } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';

export type MemoryExternalProviderStatus = 'not-published' | 'receipt-evidence-found' | 'available' | 'needs-setup' | 'blocked' | 'error' | 'disabled' | 'unknown';
export type MemoryExternalProviderSetupStatus = 'contract-needed' | 'receipt-evidence-found' | 'ready' | 'needs-setup' | 'blocked' | 'error' | 'disabled';
export type MemoryExternalProviderContractStatus = 'missing' | 'artifact-evidence-found' | 'published';

export interface MemoryPostureProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: 'embedding' | 'external-memory';
  readonly status: string;
  readonly summary: string;
  readonly modelRoute: string;
  readonly setupRoute?: string;
  readonly configured?: boolean;
  readonly active?: boolean;
  readonly dimensions?: number;
  readonly deterministic?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly liveRecord?: MemoryExternalProviderLiveRecord;
  readonly setupGuide?: MemoryExternalProviderSetupGuide;
  readonly latestReceipt?: MemoryExternalProviderReceiptEvidence;
  readonly receiptEvidence?: readonly MemoryExternalProviderReceiptEvidence[];
}

export interface MemoryExternalProviderSetupGuide {
  readonly status: MemoryExternalProviderSetupStatus;
  readonly userOutcome: string;
  readonly currentState: string;
  readonly safeFirstStep: string;
  readonly inspectRoutes: readonly string[];
  readonly nextRoutes: readonly MemoryExternalProviderRoute[];
  readonly contractChecklist: readonly MemoryExternalProviderContractCheck[];
  readonly receiptContract: MemoryExternalProviderReceiptContract;
  readonly latestReceipt?: MemoryExternalProviderReceiptEvidence;
  readonly receiptHistory?: readonly MemoryExternalProviderReceiptEvidence[];
  readonly requiredHostContracts: readonly string[];
  readonly credentialPolicy: string;
  readonly confirmationPolicy: string;
}

export interface MemoryExternalProviderRoute {
  readonly id: string;
  readonly label: string;
  readonly modelRoute: string;
  readonly effect: 'read-only' | 'confirmed';
  readonly why: string;
}

export interface MemoryExternalProviderContractCheck {
  readonly id: string;
  readonly label: string;
  readonly status: MemoryExternalProviderContractStatus;
  readonly requiredFor: string;
  readonly owner: 'goodvibes-sdk-or-daemon';
  readonly inspectRoute: string;
}

export interface MemoryExternalProviderReceiptContract {
  readonly status: MemoryExternalProviderContractStatus;
  readonly appliesTo: readonly string[];
  readonly requiredFields: readonly string[];
  readonly nextWhenPublished: string;
}

export interface MemoryExternalProviderLiveRecord {
  readonly providerId: string;
  readonly label: string | null;
  readonly status: MemoryExternalProviderStatus;
  readonly source: string;
  readonly configured: boolean | null;
  readonly reachable: boolean | null;
  readonly credentialState: string | null;
  readonly readReady: boolean | null;
  readonly writeReady: boolean | null;
  readonly syncReady: boolean | null;
  readonly forgetReady: boolean | null;
  readonly promptEligible: boolean | null;
  readonly setupRoute: string | null;
  readonly readRoute: string | null;
  readonly writeRoute: string | null;
  readonly syncRoute: string | null;
  readonly forgetRoute: string | null;
  readonly receiptRoute: string | null;
  readonly receiptIds: readonly string[];
  readonly sourceCount: number | null;
  readonly recordCount: number | null;
  readonly redaction: string | null;
  readonly failureReason: string | null;
  readonly lastReadAt: string | null;
  readonly lastWriteAt: string | null;
  readonly lastSyncAt: string | null;
  readonly updatedAt: string | null;
  readonly inspectRoute: string;
  readonly certification?: MemoryExternalProviderCertification;
}

export interface MemoryExternalProviderReceiptEvidence {
  readonly providerId: string;
  readonly artifactId: string;
  readonly filename: string | null;
  readonly operation: string;
  readonly status: string;
  readonly createdAt: string | null;
  readonly sourceCount: number | null;
  readonly redaction: string | null;
  readonly failureReason: string | null;
  readonly nextRoute: string;
  readonly inspectRoute: string;
  readonly correlationId: string | null;
  readonly certification?: MemoryExternalProviderCertification;
}

export interface ExternalMemoryProviderCatalogEntry {
  readonly id: string;
  readonly label: string;
}

export type MemoryProviderResolution =
  | { readonly status: 'found'; readonly provider: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

const EXTERNAL_MEMORY_PROVIDERS: readonly ExternalMemoryProviderCatalogEntry[] = [
  { id: 'honcho', label: 'Honcho' },
  { id: 'openviking', label: 'OpenViking' },
  { id: 'mem0', label: 'Mem0' },
  { id: 'hindsight', label: 'Hindsight' },
  { id: 'holographic', label: 'Holographic' },
  { id: 'retaindb', label: 'RetainDB' },
  { id: 'byterover', label: 'ByteRover' },
  { id: 'supermemory', label: 'Supermemory' },
];

export const EXTERNAL_MEMORY_REQUIRED_CONTRACTS = [
  'Certified schema/version/publication/publisher/provenance evidence for provider records and receipts.',
  'Provider status/readiness record with stable provider id.',
  'Credential reference or setup state that never returns raw secret values.',
  'Bounded read/search route with redaction and source provenance.',
  'Explicit write/upsert/import route with confirmation and durable receipt.',
  'Forget/delete/disable route or an explicit not-supported contract.',
  'Sync/export/import receipts with timestamps and failure reasons.',
  'Prompt-injection eligibility policy for what may enter the Agent prompt.',
] as const;

export const EXTERNAL_MEMORY_RECEIPT_FIELDS = [
  'receiptId',
  'providerId',
  'operation',
  'status',
  'createdAt',
  'sourceCount',
  'redaction',
  'failureReason',
  'nextRoute',
  'schemaVersion',
  'publicationGuarantee',
  'publisher',
  'provenance',
] as const;

const EXTERNAL_MEMORY_RECEIPT_PURPOSES = new Set([
  'agent-memory-provider-receipt',
  'connected-host-memory-provider-receipt',
  'external-memory-provider-receipt',
  'goodvibes-memory-provider-receipt',
  'memory-provider-receipt',
  'external-memory-receipt',
]);

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

function readTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const raw = readString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sanitizeExternalProviderText(value: unknown, limit = 160): string | null {
  const raw = readString(value);
  return raw ? previewHarnessText(raw, limit) : null;
}

function titleFromProviderId(providerId: string): string {
  const known = EXTERNAL_MEMORY_PROVIDERS.find((provider) => provider.id === providerId);
  if (known) return known.label;
  return providerId
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim() || providerId;
}

function readRouteValue(value: unknown): string {
  const direct = readString(value);
  if (direct) return direct;
  const record = readRecord(value);
  return readString(record.modelRoute)
    || readString(record.route)
    || readString(record.command)
    || readString(record.action)
    || readString(record.href)
    || readString(record.url);
}

/** Preserve stable native identities. Labels and names do not mint provider ids. */
function readExternalProviderLiveRecordId(record: Record<string, unknown>): string {
  return readString(record.providerId) || readString(record.externalProviderId) || readString(record.memoryProviderId)
    || readString(record.backendId) || readString(record.id) || readString(record.key);
}

async function readProviderIdentity(record: Record<string, unknown>, options: CatalogRankingOptions): Promise<string> {
  const native = readExternalProviderLiveRecordId(record);
  if (native) return native;
  const phrase = readString(record.provider) || readString(record.name);
  if (!phrase) return '';
  const selected = await selectMemoryProvider(EXTERNAL_MEMORY_PROVIDERS, phrase, options);
  return selected?.id ?? '';
}

async function readBoolean(value: unknown, parameter: string, record: unknown, options: CatalogRankingOptions): Promise<boolean> {
  assertMemoryCurrent(options);
  if (value === 1) return true;
  if (value === 0) return false;
  const state = await readPersonalOpsBoolean({ parameter, value, record }, options);
  assertMemoryCurrent(options);
  if (state === null) throw new ToolInputProjectionError('held');
  return state;
}

async function firstBoolean(record: Record<string, unknown>, keys: readonly string[], options: CatalogRankingOptions): Promise<boolean | null> {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    return readBoolean(record[key], key, record, options);
  }
  return null;
}

type OperationRole = Awaited<ReturnType<typeof readMemoryRouteRole>>['role'];
interface OperationEvidence { readonly route: string | null; readonly ready: boolean | null }

async function publishedOperations(record: Record<string, unknown>, options: CatalogRankingOptions): Promise<ReadonlyMap<OperationRole, OperationEvidence>> {
  const result = new Map<OperationRole, OperationEvidence>();
  const containers = [ { name: 'record', value: record }, ...['routes', 'modelRoutes', 'actions', 'commands', 'links',
    'capabilities', 'operations', 'features', 'supports', 'readiness'].map(name => ({ name, value: readRecord(record[name]) })) ];
  for (const container of containers) for (const [field, value] of Object.entries(container.value)) {
    // The full record and field are available to the registered reader. There is no lexical shortlist.
    const { role, form } = await readMemoryRouteRole({ record, container: container.name, field, value }, options);
    assertMemoryCurrent(options);
    if (role === 'none') continue;
    const nested = readRecord(value);
    const ready = form === 'flag' && (value === null || typeof value !== 'object')
      ? await readBoolean(value, field, record, options)
      : await firstBoolean(nested, ['ready', 'enabled', 'available', 'supported', 'configured', 'allowed'], options);
    if (form === 'flag' && ready === null) throw new ToolInputProjectionError('held');
    const route = form === 'route' ? readRouteValue(value) || null : null;
    if (form === 'route' && route === null) throw new ToolInputProjectionError('held');
    const previous = result.get(role);
    // Explicit false is never overridden by the existence of a route.
    if (previous?.ready !== null && previous?.ready !== undefined && ready !== null && previous.ready !== ready)
      throw new ToolInputProjectionError('held');
    if (previous?.route && route && previous.route !== route) throw new ToolInputProjectionError('held');
    result.set(role, { route: previous?.route ?? route, ready: previous?.ready ?? ready });
  }
  return result;
}

/** Complete producer capture precedes every semantic read; held sources never fall back to word rules. */
async function protectExternalMemoryData(value: unknown, options: CatalogRankingOptions): Promise<unknown> {
  const capture = capturePersonalOpsSnapshot(value);
  const assertSource = () => { options.signal?.throwIfAborted(); capture.assertCurrent(value); };
  options.retainCurrent?.(assertSource);
  const current = { ...options, assertCurrent: () => { assertMemoryCurrent(options); assertSource(); } };
  const protectedValue = await protectPersonalOpsData(capture.captured, current);
  const visit = async (entry: unknown): Promise<unknown> => {
    current.assertCurrent();
    if (typeof entry === 'string') return findCredentialCandidates(entry).length ? readMemoryPublicText(entry, current) : entry;
    if (Array.isArray(entry)) { const values: unknown[] = []; for (const child of entry) values.push(await visit(child)); return values; }
    if (entry !== null && typeof entry === 'object') {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, child] of Object.entries(entry)) Object.defineProperty(result, key, { value: await visit(child), enumerable: true });
      return result;
    }
    return entry;
  };
  const result = await visit(protectedValue); current.assertCurrent(); return result;
}

function readReceiptIds(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((entry) => {
      const direct = readString(entry);
      if (direct) return [direct];
      const record = readRecord(entry);
      return [
        readString(record.receiptId),
        readString(record.id),
        readString(record.artifactId),
      ].filter(Boolean);
    }))];
  }
  const direct = readString(value);
  if (!direct) return [];
  return [...new Set(direct.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

function liveRecordReceiptIds(record: Record<string, unknown>): readonly string[] {
  return [
    ...readReceiptIds(record.receiptIds),
    ...readReceiptIds(record.receipts),
    ...readReceiptIds(record.latestReceiptId),
    ...readReceiptIds(record.receiptId),
  ].filter((value, index, list) => list.indexOf(value) === index);
}

async function normalizeExternalProviderLiveRecord(value: unknown, source: string, options: CatalogRankingOptions): Promise<MemoryExternalProviderLiveRecord | null> {
  const raw = readRecord(value);
  const nativeProviderId = readExternalProviderLiveRecordId(raw);
  const record = readRecord(await protectExternalMemoryData(value, options));
  if (nativeProviderId && readExternalProviderLiveRecordId(record) !== nativeProviderId) throw new ToolInputProjectionError('held');
  const providerId = await readProviderIdentity(record, options);
  if (!providerId) return null;
  const label = readString(record.label) || readString(record.displayName) || readString(record.title) || titleFromProviderId(providerId);
  const operations = await publishedOperations(record, options);
  const setupRoute = operations.get('setup')?.route ?? null, readRoute = operations.get('read')?.route ?? null;
  const writeRoute = operations.get('write')?.route ?? null, syncRoute = operations.get('sync')?.route ?? null;
  const forgetRoute = operations.get('forget')?.route ?? null, receiptRoute = operations.get('receipt')?.route ?? null;
  const inspectRoute = operations.get('inspect')?.route ?? `memory action:"provider" providerId:${JSON.stringify(providerId)} includeParameters:true`;
  const configured = await firstBoolean(record, ['configured', 'isConfigured', 'ready'], options);
  const reachable = await firstBoolean(record, ['reachable', 'connected', 'available', 'healthy'], options);
  const enabled = await firstBoolean(record, ['enabled'], options);
  const readReady = operations.get('read')?.ready ?? null, writeReady = operations.get('write')?.ready ?? null;
  const syncReady = operations.get('sync')?.ready ?? null, forgetReady = operations.get('forget')?.ready ?? null;
  const receiptIds = liveRecordReceiptIds(record);
  const status = enabled === false ? 'disabled' : await readMemoryLiveStatus({ record, configured, reachable, enabled }, options);
  const credentialState = await readMemoryCredentialState(record, options);
  const promptEligible = await firstBoolean(record, ['promptEligible', 'promptEligibility'], options)
    ?? await firstBoolean(readRecord(record.promptPolicy), ['eligible'], options);
  const certification = await memoryExternalProviderLiveCertification({ record, sourcePath: source, providerId,
    readContractPublished: readReady === true || Boolean(readRoute), writeContractPublished: writeReady === true || Boolean(writeRoute),
    syncContractPublished: syncReady === true || Boolean(syncRoute) || Boolean(receiptRoute) || receiptIds.length > 0,
    forgetContractPublished: forgetReady !== null || Boolean(forgetRoute), receiptIds, receiptRoute,
  }, options);
  assertMemoryCurrent(options);
  return {
    providerId, label, status, source, configured, reachable, credentialState, readReady, writeReady, syncReady, forgetReady, promptEligible,
    setupRoute, readRoute, writeRoute, syncRoute, forgetRoute, receiptRoute, receiptIds,
    sourceCount: readNumber(record.sourceCount ?? record.sourcesCount ?? readRecord(record.stats).sourceCount),
    recordCount: readNumber(record.recordCount ?? record.memoryCount ?? record.itemCount ?? readRecord(record.stats).recordCount),
    redaction: sanitizeExternalProviderText(record.redaction ?? record.redactionPolicy, 96),
    failureReason: sanitizeExternalProviderText(record.failureReason ?? record.error ?? record.errorMessage ?? record.statusDetail),
    lastReadAt: readTimestamp(record.lastReadAt ?? record.lastSearchAt), lastWriteAt: readTimestamp(record.lastWriteAt ?? record.lastUpsertAt ?? record.lastImportAt),
    lastSyncAt: readTimestamp(record.lastSyncAt ?? record.lastExportAt), updatedAt: readTimestamp(record.updatedAt ?? record.checkedAt ?? record.createdAt),
    inspectRoute, certification,
  };
}

const EXTERNAL_MEMORY_SOURCE_PATHS = [
  ['platform', 'readModels', 'memory', 'externalProviders'], ['platform', 'readModels', 'memory', 'providers'],
  ['platform', 'readModels', 'agentMemory', 'externalProviders'], ['platform', 'readModels', 'externalMemoryProviders'],
  ['platform', 'readModels', 'memoryProviders'], ['platform', 'externalMemoryProviders'],
  ['clients', 'agentKnowledgeApi', 'memory', 'externalProviders'], ['clients', 'agentKnowledgeApi', 'memory', 'providers'],
  ['clients', 'agentKnowledgeApi', 'externalMemoryProviders'], ['extensions', 'agentKnowledgeService', 'externalMemoryProviders'],
  ['extensions', 'externalMemoryProviders'], ['clients', 'agentKnowledgeApi', 'memory', 'listExternalProviders'],
  ['clients', 'agentKnowledgeApi', 'memory', 'listProviders'],
] as const;
const SNAPSHOT_METHODS = ['getSnapshot', 'snapshot', 'listExternalProviders', 'listProviders', 'list'] as const;

function acquireSource(context: unknown, path: readonly string[], options: CatalogRankingOptions): {
  readonly source: unknown; readonly receiver: object | undefined;
  readonly assertSource: () => void; readonly assertCurrent: () => void;
} {
  const guards: (() => void)[] = [];
  let receiver: object | undefined, current: unknown = context;
  for (const key of path) {
    if (current === undefined || current === null) break;
    if (typeof current !== 'object') throw new ToolInputProjectionError('held');
    guards.push(captureCatalogMethods(current, [key]));
    receiver = current; current = modelReadingServicePath(current, [key]);
  }
  const source = current;
  const assertSource = () => { options.signal?.throwIfAborted(); for (const guard of guards) guard();
    if (modelReadingServicePath(context, path) !== source) throw new ToolInputProjectionError('held'); };
  const assertCurrent = () => { assertMemoryCurrent(options); assertSource(); };
  options.retainCurrent?.(assertSource, `agent.memory.source:${path.join('.')}`);
  assertCurrent(); return { source, receiver, assertSource, assertCurrent };
}

async function readExternalProviderSnapshot(acquired: ReturnType<typeof acquireSource>, options: CatalogRankingOptions): Promise<{
  readonly snapshot: unknown; readonly fresh: (() => unknown) | undefined;
}> {
  acquired.assertCurrent();
  let read: (() => unknown) | undefined;
  if (typeof acquired.source === 'function') {
    const method = acquired.source, callCurrent = captureCatalogMethods(method, ['call']);
    options.retainCurrent?.(callCurrent);
    read = () => { acquired.assertSource(); callCurrent(); const result: unknown = method.call(acquired.receiver); acquired.assertSource(); callCurrent(); return result; };
  } else if (acquired.source !== null && typeof acquired.source === 'object') {
    const methodsCurrent = captureCatalogMethods(acquired.source, SNAPSHOT_METHODS);
    options.retainCurrent?.(methodsCurrent);
    for (const name of SNAPSHOT_METHODS) {
      acquired.assertCurrent(); methodsCurrent();
      const method = modelReadingServicePath(acquired.source, [name]);
      if (typeof method !== 'function') continue;
      const callCurrent = captureCatalogMethods(method, ['call']); options.retainCurrent?.(callCurrent);
      read = () => { acquired.assertSource(); methodsCurrent(); callCurrent(); const result: unknown = method.call(acquired.source);
        acquired.assertSource(); methodsCurrent(); callCurrent(); return result; };
      break;
    }
  }
  if (read === undefined) return { snapshot: acquired.source, fresh: () => { acquired.assertSource(); return acquired.source; } };
  acquired.assertCurrent();
  const result = read();
  acquired.assertCurrent();
  if (nodeTypes.isProxy(result)) throw new ToolInputProjectionError('held');
  if (nodeTypes.isPromise(result)) {
    const snapshot = await awaitExternalProviderSnapshot(result, options.signal); acquired.assertCurrent();
    return { snapshot, fresh: undefined };
  }
  // Admission rejects foreign thenables and accessor-backed DTOs before Promise assimilation can invoke them.
  capturePersonalOpsSnapshot(result);
  return { snapshot: result, fresh: read };
}

function externalProviderRecordsFromSnapshot(snapshot: unknown): readonly unknown[] {
  if (Array.isArray(snapshot)) return snapshot;
  const record = readRecord(snapshot);
  for (const key of ['externalProviders', 'providers', 'memoryProviders', 'records', 'items', 'entries']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    const valueRecord = readRecord(value);
    if (Object.keys(valueRecord).length > 0) return Object.entries(valueRecord).map(([providerId, entry]) => {
      const entryRecord = readRecord(entry);
      return Object.keys(entryRecord).length === 0 || readExternalProviderLiveRecordId(entryRecord) ? entry : { ...entryRecord, providerId };
    });
  }
  return readExternalProviderLiveRecordId(record) || readString(record.provider) || readString(record.name) ? [record] : [];
}

function liveProviderStatusRank(record: MemoryExternalProviderLiveRecord): number {
  if (record.status === 'available') return 5;
  if (record.status === 'needs-setup') return 4;
  if (record.status === 'blocked') return 3;
  if (record.status === 'error') return 2;
  if (record.status === 'disabled') return 1;
  return 0;
}

function preferLiveProviderRecord(
  current: MemoryExternalProviderLiveRecord,
  candidate: MemoryExternalProviderLiveRecord,
): MemoryExternalProviderLiveRecord {
  const rankDelta = liveProviderStatusRank(candidate) - liveProviderStatusRank(current);
  if (rankDelta > 0) return candidate;
  if (rankDelta < 0) return current;
  const currentTime = current.updatedAt ? Date.parse(current.updatedAt) : 0;
  const candidateTime = candidate.updatedAt ? Date.parse(candidate.updatedAt) : 0;
  if (candidateTime > currentTime) return candidate;
  return current;
}

/**
 * The legacy snapshot sources expose no cancellation contract. Stop waiting on
 * abort, but keep both handlers attached to observe eventual settlement. This
 * does not stop the source's I/O; the caller discards its result and starts no
 * subsequent snapshot. Remove the abort listener on every settlement path.
 */
function awaitExternalProviderSnapshot(work: Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted ? signal.reason : error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

export async function externalMemoryLiveProviderRecords(context: unknown, originalOptions: CatalogRankingOptions = {}): Promise<readonly MemoryExternalProviderLiveRecord[]> {
  const options = retainMemoryReadingOptions(originalOptions);
  const byProvider = new Map<string, MemoryExternalProviderLiveRecord>();
  assertMemoryCurrent(options);
  // Capture every source identity before reading any source. A mutation of a later source retires this same invocation.
  const sources = EXTERNAL_MEMORY_SOURCE_PATHS.map(path => ({ path, acquired: acquireSource(context, path, options) }));
  const assertSourceRestrictions = () => { options.signal?.throwIfAborted(); for (const source of sources) source.acquired.assertSource(); };
  const assertSources = () => { assertMemoryCurrent(options); assertSourceRestrictions(); };
  options.retainCurrent?.(assertSourceRestrictions, 'agent.memory.sources');
  const current = { ...options, assertCurrent: assertSources };
  for (const entry of sources) {
    assertSources();
    if (entry.acquired.source === undefined || entry.acquired.source === null) continue;
    let acquiredSnapshot: Awaited<ReturnType<typeof readExternalProviderSnapshot>>;
    try { acquiredSnapshot = await readExternalProviderSnapshot(entry.acquired, current); }
    catch (error: unknown) {
      assertSources();
      if (error instanceof ToolInputProjectionError) throw error;
      // An installed unreadable backend cannot be presented as an absent publication.
      throw new ToolInputProjectionError('held');
    }
    assertSources();
    const snapshot = acquiredSnapshot.snapshot, capture = capturePersonalOpsSnapshot(snapshot);
    const assertSnapshotRestriction = () => { assertSourceRestrictions(); capture.assertCurrent(snapshot);
      if (acquiredSnapshot.fresh) {
        const fresh = acquiredSnapshot.fresh();
        if (nodeTypes.isPromise(fresh)) { void fresh.catch(() => {}); throw new ToolInputProjectionError('held'); }
        capture.assertCurrent(fresh);
      }
      assertSourceRestrictions();
    };
    const assertSnapshot = () => { assertMemoryCurrent(options); assertSnapshotRestriction(); };
    options.retainCurrent?.(assertSnapshotRestriction, `agent.memory.snapshot:${entry.path.join('.')}`);
    const reading = { ...options, assertCurrent: assertSnapshot };
    for (const value of externalProviderRecordsFromSnapshot(capture.captured)) {
      const record = await normalizeExternalProviderLiveRecord(value, `context.${entry.path.join('.')}`, reading);
      assertSnapshot(); if (!record) continue;
      const previous = byProvider.get(record.providerId);
      byProvider.set(record.providerId, previous ? preferLiveProviderRecord(previous, record) : record);
    }
  }
  assertSources();
  return [...byProvider.values()].sort((left, right) => {
    const rankDelta = liveProviderStatusRank(right) - liveProviderStatusRank(left);
    if (rankDelta !== 0) return rankDelta;
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0, rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    return rightTime !== leftTime ? rightTime - leftTime : left.providerId.localeCompare(right.providerId);
  });
}

export function externalMemoryProviderCatalog(
  liveRecords: readonly MemoryExternalProviderLiveRecord[],
  receipts: readonly MemoryExternalProviderReceiptEvidence[] = [],
): readonly ExternalMemoryProviderCatalogEntry[] {
  const providers = [...EXTERNAL_MEMORY_PROVIDERS];
  for (const record of liveRecords) {
    if (providers.some((provider) => provider.id === record.providerId)) continue;
    providers.push({ id: record.providerId, label: record.label ?? titleFromProviderId(record.providerId) });
  }
  for (const receipt of receipts) {
    if (providers.some((provider) => provider.id === receipt.providerId)) continue;
    providers.push({ id: receipt.providerId, label: titleFromProviderId(receipt.providerId) });
  }
  return providers;
}

export function liveRecordForProvider(
  liveRecords: readonly MemoryExternalProviderLiveRecord[],
  providerId: string,
): MemoryExternalProviderLiveRecord | null {
  return liveRecords.find((record) => record.providerId === providerId) ?? null;
}

export function externalProviderLiveReady(record: MemoryExternalProviderLiveRecord | null): boolean {
  return record?.status === 'available' && record.reachable !== false;
}

export function setupStatusFromLiveRecord(record: MemoryExternalProviderLiveRecord | null): MemoryExternalProviderSetupStatus | null {
  if (!record) return null;
  if (externalProviderLiveReady(record)) return 'ready';
  if (record.status === 'needs-setup') return 'needs-setup';
  if (record.status === 'blocked') return 'blocked';
  if (record.status === 'error') return 'error';
  if (record.status === 'disabled') return 'disabled';
  return 'needs-setup';
}

export function aggregateExternalProviderLiveRecord(
  liveRecords: readonly MemoryExternalProviderLiveRecord[],
): MemoryExternalProviderLiveRecord | null {
  if (liveRecords.length === 0) return null;
  const latest = liveRecords[0]!;
  const any = (select: (record: MemoryExternalProviderLiveRecord) => boolean | null): boolean | null => {
    if (liveRecords.some((record) => select(record) === true)) return true;
    if (liveRecords.every((record) => select(record) === false)) return false;
    return null;
  };
  return {
    providerId: '<provider-id>',
    label: 'External memory provider',
    status: liveRecords.some(externalProviderLiveReady) ? 'available' : latest.status,
    source: [...new Set(liveRecords.map((record) => record.source))].join(', '),
    configured: any((record) => record.configured),
    reachable: any((record) => record.reachable),
    credentialState: liveRecords.some((record) => record.credentialState !== null) ? 'published-redacted' : null,
    readReady: any((record) => record.readReady),
    writeReady: any((record) => record.writeReady),
    syncReady: any((record) => record.syncReady),
    forgetReady: any((record) => record.forgetReady),
    promptEligible: any((record) => record.promptEligible),
    setupRoute: latest.setupRoute,
    readRoute: latest.readRoute,
    writeRoute: latest.writeRoute,
    syncRoute: latest.syncRoute,
    forgetRoute: latest.forgetRoute,
    receiptRoute: latest.receiptRoute,
    receiptIds: [...new Set(liveRecords.flatMap((record) => record.receiptIds))],
    sourceCount: liveRecords.reduce((total, record) => total + (record.sourceCount ?? 0), 0) || null,
    recordCount: liveRecords.reduce((total, record) => total + (record.recordCount ?? 0), 0) || null,
    redaction: latest.redaction,
    failureReason: latest.failureReason,
    lastReadAt: latest.lastReadAt,
    lastWriteAt: latest.lastWriteAt,
    lastSyncAt: latest.lastSyncAt,
    updatedAt: latest.updatedAt,
    inspectRoute: 'memory action:"status" query:"external memory provider" includeParameters:true',
    certification: latest.certification,
  };
}

export function aggregateExternalProviderSetupStatus(
  liveRecords: readonly MemoryExternalProviderLiveRecord[],
  receipts: readonly MemoryExternalProviderReceiptEvidence[],
): MemoryExternalProviderSetupStatus {
  if (liveRecords.length > 0) return liveRecords.some(externalProviderLiveReady) ? 'ready' : 'needs-setup';
  return receipts.length > 0 ? 'receipt-evidence-found' : 'contract-needed';
}

/** Exact native artifact purpose identifiers stay deterministic; all untyped receipt membership is read. */
async function isExternalMemoryReceiptArtifact(artifact: Readonly<Record<string, unknown>>, options: CatalogRankingOptions): Promise<boolean> {
  const metadata = readRecord(artifact.metadata);
  const purpose = readString(metadata.purpose);
  return EXTERNAL_MEMORY_RECEIPT_PURPOSES.has(purpose) || readMemoryReceiptMember(artifact, options);
}

function readExternalMemoryReceiptProviderId(metadata: Record<string, unknown>): string {
  return readString(metadata.providerId) || readString(metadata.externalProviderId) || readString(metadata.memoryProviderId) || readString(metadata.backendId);
}

function readReceiptCreatedAt(artifact: Readonly<Record<string, unknown>>, metadata: Record<string, unknown>): string | null {
  const explicit = readString(metadata.createdAt) || readString(metadata.timestamp) || readString(metadata.completedAt);
  if (explicit) {
    const parsed = Date.parse(explicit);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return typeof artifact.createdAt === 'number' && Number.isFinite(artifact.createdAt)
    ? new Date(artifact.createdAt).toISOString()
    : null;
}

async function describeExternalMemoryReceiptArtifact(value: unknown, options: CatalogRankingOptions): Promise<MemoryExternalProviderReceiptEvidence | null> {
  const original = readRecord(value), nativeArtifactId = readString(original.id);
  if (!nativeArtifactId) throw new ToolInputProjectionError('held');
  const artifact = readRecord(await protectExternalMemoryData(value, options)), metadata = readRecord(artifact.metadata);
  if (readString(artifact.id) !== nativeArtifactId) throw new ToolInputProjectionError('held');
  if (!await isExternalMemoryReceiptArtifact(artifact, options)) return null;
  const nativeProviderId = readExternalMemoryReceiptProviderId(readRecord(original.metadata));
  const providerId = await readProviderIdentity(metadata, options);
  if (!providerId) return null;
  if (nativeProviderId && readExternalMemoryReceiptProviderId(metadata) !== nativeProviderId) throw new ToolInputProjectionError('held');
  const operation = readString(metadata.operation) || readString(metadata.action) || readString(metadata.memoryOperation) || readString(metadata.receiptOperation) || 'external-memory';
  const nextRoute = readString(metadata.nextRoute) || `memory action:"provider" providerId:${JSON.stringify(providerId)} includeParameters:true`;
  const status = await readPersonalOpsReceiptStatus(artifact, options);
  const certification = await memoryExternalProviderReceiptCertification({ metadata, sourcePath: `artifact ${nativeArtifactId}`, providerId, artifactId: nativeArtifactId }, options);
  assertMemoryCurrent(options);
  return {
    providerId, artifactId: nativeArtifactId, filename: readString(artifact.filename) || null, operation, status,
    createdAt: readReceiptCreatedAt(artifact, metadata), sourceCount: readNumber(metadata.sourceCount ?? metadata.recordCount ?? metadata.itemCount),
    redaction: readString(metadata.redaction) || readString(metadata.redactionPolicy) || null,
    failureReason: readString(metadata.failureReason) || readString(metadata.error) || null, nextRoute,
    inspectRoute: `agent_artifacts show artifactId:${JSON.stringify(nativeArtifactId)} includeContent:false`,
    correlationId: readString(metadata.correlationId) || readString(metadata.runId) || null, certification,
  };
}

export async function externalMemoryReceiptEvidence(context: unknown, originalOptions: CatalogRankingOptions = {}): Promise<readonly MemoryExternalProviderReceiptEvidence[]> {
  const options = retainMemoryReadingOptions(originalOptions);
  const acquired = acquireSource(context, ['platform', 'artifactStore'], options);
  if (acquired.source === null || acquired.source === undefined) return [];
  if (typeof acquired.source !== 'object') throw new ToolInputProjectionError('held');
  const storeCurrent = captureCatalogMethods(acquired.source, ['list']);
  options.retainCurrent?.(storeCurrent, 'agent.memory.artifact-list');
  const method = modelReadingServicePath(acquired.source, ['list']);
  if (method === undefined) return [];
  if (typeof method !== 'function') throw new ToolInputProjectionError('held');
  const callCurrent = captureCatalogMethods(method, ['call']); options.retainCurrent?.(callCurrent);
  acquired.assertCurrent(); storeCurrent(); callCurrent();
  const value: unknown = method.call(acquired.source, 100);
  acquired.assertCurrent(); storeCurrent();
  const capture = capturePersonalOpsSnapshot(value);
  if (!Array.isArray(capture.captured)) throw new ToolInputProjectionError('held');
  const assertArtifactRestriction = () => { acquired.assertSource(); storeCurrent(); callCurrent(); capture.assertCurrent(value);
    const fresh: unknown = method.call(acquired.source, 100); acquired.assertSource(); storeCurrent(); callCurrent(); capture.assertCurrent(fresh); };
  const assertCurrent = () => { assertMemoryCurrent(options); assertArtifactRestriction(); };
  options.retainCurrent?.(assertArtifactRestriction, 'agent.memory.artifacts');
  const reading = { ...options, assertCurrent };
  const result: MemoryExternalProviderReceiptEvidence[] = [];
  for (const artifact of capture.captured) {
    const receipt = await describeExternalMemoryReceiptArtifact(artifact, reading); assertCurrent();
    if (receipt) result.push(receipt);
  }
  assertCurrent();
  return result.sort((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0, rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
    return rightTime !== leftTime ? rightTime - leftTime : right.artifactId.localeCompare(left.artifactId);
  });
}

export function receiptEvidenceForProvider(
  evidence: readonly MemoryExternalProviderReceiptEvidence[],
  providerId: string,
): readonly MemoryExternalProviderReceiptEvidence[] {
  return evidence.filter((entry) => entry.providerId === providerId);
}
