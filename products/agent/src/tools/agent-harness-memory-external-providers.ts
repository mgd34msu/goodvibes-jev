import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { memoryExternalProviderLiveCertification, memoryExternalProviderReceiptCertification } from './agent-harness-memory-provider-certification.ts';
import type { MemoryExternalProviderCertification } from './agent-harness-memory-provider-certification.ts';

export type MemoryExternalProviderStatus = 'not-published' | 'receipt-evidence-found' | 'available' | 'needs-setup' | 'blocked' | 'error' | 'disabled' | 'unknown';
export type MemoryExternalProviderSetupStatus = 'contract-needed' | 'receipt-evidence-found' | 'ready' | 'needs-setup' | 'blocked' | 'error' | 'disabled';
export type MemoryExternalProviderContractStatus = 'missing' | 'artifact-evidence-found' | 'published';

interface ArtifactListLike {
  readonly list?: (limit?: number) => readonly ArtifactDescriptor[];
}

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
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const raw = readString(value).toLowerCase();
  if (['true', 'yes', 'y', '1', 'on', 'enabled', 'available', 'ready', 'configured', 'connected', 'healthy', 'supported'].includes(raw)) return true;
  if (['false', 'no', 'n', '0', 'off', 'disabled', 'unavailable', 'not-configured', 'not_configured', 'missing', 'blocked'].includes(raw)) return false;
  return null;
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(parsed)));
}

function readTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const raw = readString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const EXTERNAL_MEMORY_SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/("?\b(?:api[-_]?key|apikey|token|secret|password|passwd|credential|authorization)\b"?\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"<redacted>"'],
  [/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1=<redacted>'],
  [/(\b(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1<redacted>'],
  [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>'],
];

function sanitizeExternalProviderText(value: unknown, limit = 160): string | null {
  const raw = readString(value);
  if (!raw) return null;
  const redacted = EXTERNAL_MEMORY_SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), raw);
  return previewHarnessText(redacted, limit);
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

function upperCamel(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function readLiveRoute(record: Record<string, unknown>, aliases: readonly string[]): string | null {
  const containers = [
    record,
    readRecord(record.routes),
    readRecord(record.modelRoutes),
    readRecord(record.actions),
    readRecord(record.commands),
    readRecord(record.links),
  ];
  for (const alias of aliases) {
    for (const container of containers) {
      const route = readRouteValue(container[`${alias}Route`])
        || readRouteValue(container[alias])
        || readRouteValue(container[`${alias}Command`])
        || readRouteValue(container[`${alias}Action`]);
      if (route) return route;
    }
  }
  return null;
}

function readCapabilityState(value: unknown): boolean | null {
  const direct = readBooleanLike(value);
  if (direct !== null) return direct;
  const record = readRecord(value);
  return readBooleanLike(record.ready)
    ?? readBooleanLike(record.enabled)
    ?? readBooleanLike(record.available)
    ?? readBooleanLike(record.supported)
    ?? readBooleanLike(record.configured)
    ?? readBooleanLike(record.allowed)
    ?? (readRouteValue(record) ? true : null);
}

function readCapabilityFlag(
  record: Record<string, unknown>,
  aliases: readonly string[],
  route: string | null,
): boolean | null {
  const containers = [
    record,
    readRecord(record.capabilities),
    readRecord(record.operations),
    readRecord(record.features),
    readRecord(record.supports),
    readRecord(record.readiness),
  ];
  let sawFalse = false;
  for (const alias of aliases) {
    const keys = [alias, `${alias}Ready`, `${alias}Enabled`, `${alias}Supported`, `can${upperCamel(alias)}`];
    for (const container of containers) {
      for (const key of keys) {
        const state = readCapabilityState(container[key]);
        if (state === true) return true;
        if (state === false) sawFalse = true;
      }
    }
  }
  if (route) return true;
  return sawFalse ? false : null;
}

function normalizeExternalProviderCredentialState(record: Record<string, unknown>): string | null {
  const candidate = record.credentialState
    ?? record.authState
    ?? record.authenticationState
    ?? record.credentialRef
    ?? record.secretRef
    ?? record.credentials
    ?? record.auth
    ?? record.configured;
  const boolState = readBooleanLike(candidate);
  if (boolState === true) return 'configured-secret-ref';
  if (boolState === false) return 'missing';
  const candidateRecord = readRecord(candidate);
  if (Object.keys(candidateRecord).length > 0) {
    const nestedState = readBooleanLike(candidateRecord.present)
      ?? readBooleanLike(candidateRecord.configured)
      ?? readBooleanLike(candidateRecord.connected)
      ?? readBooleanLike(candidateRecord.available)
      ?? readBooleanLike(candidateRecord.ready);
    if (nestedState === true) return 'configured-secret-ref';
    if (nestedState === false) return 'missing';
  }
  const raw = readString(candidate).toLowerCase();
  if (!raw) return null;
  if (['missing', 'none', 'not-configured', 'not_configured', 'required', 'needs-setup', 'needs_setup', 'unauthenticated'].includes(raw)) return 'missing';
  if (raw.includes('oauth') || raw.includes('connected-host')) return 'connected-host-auth';
  if (raw.includes('secret') || raw.includes('ref') || raw.includes('configured') || raw.includes('present') || raw.includes('available')) return 'configured-secret-ref';
  return 'published-redacted';
}

function normalizeExternalProviderLiveStatus(
  value: unknown,
  configured: boolean | null,
  reachable: boolean | null,
  enabled: boolean | null,
): MemoryExternalProviderStatus {
  if (enabled === false) return 'disabled';
  const raw = readString(value).toLowerCase().replace(/_/g, '-');
  if (['ok', 'ready', 'healthy', 'available', 'connected', 'active', 'succeeded', 'success', 'synced'].includes(raw)) return 'available';
  if (['needs-setup', 'setup-needed', 'not-configured', 'missing-credentials', 'auth-required', 'unauthenticated'].includes(raw)) return 'needs-setup';
  if (['blocked', 'denied', 'forbidden', 'permission-denied'].includes(raw)) return 'blocked';
  if (['error', 'errored', 'failed', 'failure', 'unreachable'].includes(raw)) return 'error';
  if (['disabled', 'inactive', 'off'].includes(raw)) return 'disabled';
  if (configured === true && reachable !== false) return 'available';
  return raw ? 'unknown' : 'unknown';
}

function readExternalProviderLiveRecordId(record: Record<string, unknown>): string {
  return normalizeExternalProviderId(
    readString(record.providerId)
    || readString(record.provider)
    || readString(record.externalProviderId)
    || readString(record.memoryProviderId)
    || readString(record.backendId)
    || readString(record.id)
    || readString(record.key)
    || readString(record.name),
  );
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

function normalizeExternalProviderLiveRecord(value: unknown, source: string): MemoryExternalProviderLiveRecord | null {
  const record = readRecord(value);
  const providerId = readExternalProviderLiveRecordId(record);
  if (!providerId) return null;
  const label = readString(record.label) || readString(record.displayName) || readString(record.title) || titleFromProviderId(providerId);
  const setupRoute = readLiveRoute(record, ['setup', 'configure', 'connect']);
  const readRoute = readLiveRoute(record, ['read', 'search', 'query']);
  const writeRoute = readLiveRoute(record, ['write', 'upsert', 'import']);
  const syncRoute = readLiveRoute(record, ['sync', 'export']);
  const forgetRoute = readLiveRoute(record, ['forget', 'delete', 'disable']);
  const receiptRoute = readLiveRoute(record, ['receipt', 'receipts', 'history']);
  const inspectRoute = readLiveRoute(record, ['inspect', 'status'])
    ?? `memory action:"provider" providerId:"${providerId}" includeParameters:true`;
  const configured = readBooleanLike(record.configured)
    ?? readBooleanLike(record.isConfigured)
    ?? readBooleanLike(record.ready);
  const reachable = readBooleanLike(record.reachable)
    ?? readBooleanLike(record.connected)
    ?? readBooleanLike(record.available)
    ?? readBooleanLike(record.healthy);
  const enabled = readBooleanLike(record.enabled);
  const readReady = readCapabilityFlag(record, ['read', 'search', 'query'], readRoute);
  const writeReady = readCapabilityFlag(record, ['write', 'upsert', 'import'], writeRoute);
  const syncReady = readCapabilityFlag(record, ['sync', 'export'], syncRoute);
  const forgetReady = readCapabilityFlag(record, ['forget', 'delete', 'disable'], forgetRoute);
  const receiptIds = liveRecordReceiptIds(record);
  return {
    providerId,
    label,
    status: normalizeExternalProviderLiveStatus(
      record.status ?? record.state ?? record.readiness ?? record.connectionStatus ?? record.setupStatus,
      configured,
      reachable,
      enabled,
    ),
    source,
    configured,
    reachable,
    credentialState: normalizeExternalProviderCredentialState(record),
    readReady,
    writeReady,
    syncReady,
    forgetReady,
    promptEligible: readBooleanLike(record.promptEligible)
      ?? readBooleanLike(record.promptEligibility)
      ?? readBooleanLike(readRecord(record.promptPolicy).eligible),
    setupRoute,
    readRoute,
    writeRoute,
    syncRoute,
    forgetRoute,
    receiptRoute,
    receiptIds,
    sourceCount: readNumber(record.sourceCount ?? record.sourcesCount ?? readRecord(record.stats).sourceCount),
    recordCount: readNumber(record.recordCount ?? record.memoryCount ?? record.itemCount ?? readRecord(record.stats).recordCount),
    redaction: sanitizeExternalProviderText(record.redaction ?? record.redactionPolicy, 96),
    failureReason: sanitizeExternalProviderText(record.failureReason ?? record.error ?? record.errorMessage ?? record.statusDetail),
    lastReadAt: readTimestamp(record.lastReadAt ?? record.lastSearchAt),
    lastWriteAt: readTimestamp(record.lastWriteAt ?? record.lastUpsertAt ?? record.lastImportAt),
    lastSyncAt: readTimestamp(record.lastSyncAt ?? record.lastExportAt),
    updatedAt: readTimestamp(record.updatedAt ?? record.checkedAt ?? record.createdAt),
    inspectRoute,
    certification: memoryExternalProviderLiveCertification({
      record,
      sourcePath: source,
      providerId,
      readContractPublished: readReady === true || Boolean(readRoute),
      writeContractPublished: writeReady === true || Boolean(writeRoute),
      syncContractPublished: syncReady === true || Boolean(syncRoute) || Boolean(receiptRoute) || receiptIds.length > 0,
      forgetContractPublished: forgetReady !== null || Boolean(forgetRoute),
      receiptIds,
      receiptRoute,
    }),
  };
}

interface ExternalMemoryProviderReadModelSource {
  readonly path: string;
  readonly source: unknown;
}

function externalMemoryReadModelSources(context: CommandContext): readonly ExternalMemoryProviderReadModelSource[] {
  const platform = context.platform as unknown as Record<string, unknown>;
  const clients = readRecord(context.clients);
  const extensions = context.extensions as unknown as Record<string, unknown>;
  const readModels = readRecord(platform.readModels);
  const platformMemory = readRecord(readModels.memory);
  const platformAgentMemory = readRecord(readModels.agentMemory);
  const agentKnowledgeApi = readRecord(clients.agentKnowledgeApi);
  const agentKnowledgeMemory = readRecord(agentKnowledgeApi.memory);
  const agentKnowledgeService = readRecord(extensions.agentKnowledgeService);
  return [
    { path: 'context.platform.readModels.memory.externalProviders', source: platformMemory.externalProviders },
    { path: 'context.platform.readModels.memory.providers', source: platformMemory.providers },
    { path: 'context.platform.readModels.agentMemory.externalProviders', source: platformAgentMemory.externalProviders },
    { path: 'context.platform.readModels.externalMemoryProviders', source: readModels.externalMemoryProviders },
    { path: 'context.platform.readModels.memoryProviders', source: readModels.memoryProviders },
    { path: 'context.platform.externalMemoryProviders', source: platform.externalMemoryProviders },
    { path: 'context.clients.agentKnowledgeApi.memory.externalProviders', source: agentKnowledgeMemory.externalProviders },
    { path: 'context.clients.agentKnowledgeApi.memory.providers', source: agentKnowledgeMemory.providers },
    { path: 'context.clients.agentKnowledgeApi.externalMemoryProviders', source: agentKnowledgeApi.externalMemoryProviders },
    { path: 'context.extensions.agentKnowledgeService.externalMemoryProviders', source: agentKnowledgeService.externalMemoryProviders },
    { path: 'context.extensions.externalMemoryProviders', source: extensions.externalMemoryProviders },
    {
      path: 'context.clients.agentKnowledgeApi.memory.listExternalProviders()',
      source: typeof agentKnowledgeMemory.listExternalProviders === 'function'
        ? () => (agentKnowledgeMemory.listExternalProviders as () => unknown)()
        : undefined,
    },
    {
      path: 'context.clients.agentKnowledgeApi.memory.listProviders()',
      source: typeof agentKnowledgeMemory.listProviders === 'function'
        ? () => (agentKnowledgeMemory.listProviders as () => unknown)()
        : undefined,
    },
  ];
}

async function readExternalProviderSnapshot(source: unknown): Promise<unknown> {
  if (typeof source === 'function') return await (source as () => unknown | Promise<unknown>)();
  const record = readRecord(source);
  for (const methodName of ['getSnapshot', 'snapshot', 'listExternalProviders', 'listProviders', 'list']) {
    const method = record[methodName];
    if (typeof method === 'function') return await (method as () => unknown | Promise<unknown>)();
  }
  return source;
}

function externalProviderRecordsFromSnapshot(snapshot: unknown): readonly unknown[] {
  if (Array.isArray(snapshot)) return snapshot;
  const record = readRecord(snapshot);
  for (const key of ['externalProviders', 'providers', 'memoryProviders', 'records', 'items', 'entries']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    const valueRecord = readRecord(value);
    if (Object.keys(valueRecord).length > 0) {
      return Object.entries(valueRecord).map(([providerId, entry]) => {
        const entryRecord = readRecord(entry);
        if (Object.keys(entryRecord).length === 0 || readExternalProviderLiveRecordId(entryRecord)) return entry;
        return { ...entryRecord, providerId };
      });
    }
  }
  return readExternalProviderLiveRecordId(record) ? [record] : [];
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

export async function externalMemoryLiveProviderRecords(
  context: CommandContext,
  options: { readonly signal?: AbortSignal } = {},
): Promise<readonly MemoryExternalProviderLiveRecord[]> {
  const byProvider = new Map<string, MemoryExternalProviderLiveRecord>();
  options.signal?.throwIfAborted();
  for (const entry of externalMemoryReadModelSources(context)) {
    options.signal?.throwIfAborted();
    if (entry.source === undefined || entry.source === null) continue;
    try {
      const snapshot = await awaitExternalProviderSnapshot(readExternalProviderSnapshot(entry.source), options.signal);
      options.signal?.throwIfAborted();
      for (const value of externalProviderRecordsFromSnapshot(snapshot)) {
        const record = normalizeExternalProviderLiveRecord(value, entry.path);
        if (!record) continue;
        const current = byProvider.get(record.providerId);
        byProvider.set(record.providerId, current ? preferLiveProviderRecord(current, record) : record);
      }
    } catch {
      options.signal?.throwIfAborted();
      // A broken host read model should not make Agent-local memory posture disappear.
    }
  }
  return [...byProvider.values()].sort((left, right) => {
    const rankDelta = liveProviderStatusRank(right) - liveProviderStatusRank(left);
    if (rankDelta !== 0) return rankDelta;
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.providerId.localeCompare(right.providerId);
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
  return Boolean(record && (record.status === 'available' || (
    record.configured === true
    && record.reachable !== false
    && (record.readReady === true || record.writeReady === true || record.syncReady === true)
  )));
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

function artifactStore(context: CommandContext): ArtifactListLike | null {
  const candidate = (context.platform as { readonly artifactStore?: unknown }).artifactStore;
  return candidate && typeof candidate === 'object' ? candidate as ArtifactListLike : null;
}

function normalizeExternalProviderId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const exact = EXTERNAL_MEMORY_PROVIDERS.find((provider) => provider.id === normalized);
  if (exact) return exact.id;
  const label = EXTERNAL_MEMORY_PROVIDERS.find((provider) => provider.label.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized);
  return label?.id ?? normalized;
}

function isExternalMemoryReceiptArtifact(artifact: ArtifactDescriptor): boolean {
  const metadata = readRecord(artifact.metadata);
  const purpose = readString(metadata.purpose).toLowerCase();
  if (EXTERNAL_MEMORY_RECEIPT_PURPOSES.has(purpose)) return true;
  return purpose.includes('memory') && purpose.includes('receipt') && Boolean(readExternalMemoryReceiptProviderId(metadata));
}

function readExternalMemoryReceiptProviderId(metadata: Record<string, unknown>): string {
  return normalizeExternalProviderId(
    readString(metadata.providerId)
    || readString(metadata.provider)
    || readString(metadata.externalProviderId)
    || readString(metadata.memoryProviderId)
    || readString(metadata.backendId),
  );
}

function readReceiptCreatedAt(artifact: ArtifactDescriptor, metadata: Record<string, unknown>): string | null {
  const explicit = readString(metadata.createdAt) || readString(metadata.timestamp) || readString(metadata.completedAt);
  if (explicit) {
    const parsed = Date.parse(explicit);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return typeof artifact.createdAt === 'number' && Number.isFinite(artifact.createdAt)
    ? new Date(artifact.createdAt).toISOString()
    : null;
}

function normalizeReceiptStatus(value: unknown): string {
  const raw = readString(value).toLowerCase();
  if (!raw) return 'unknown';
  if (['ok', 'ready', 'success', 'succeeded', 'complete', 'completed', 'synced', 'written', 'imported', 'exported'].includes(raw)) return 'succeeded';
  if (['blocked', 'needs-review', 'needs_setup', 'needs-setup'].includes(raw)) return 'blocked';
  if (['fail', 'failed', 'error', 'errored'].includes(raw)) return 'failed';
  if (['running', 'pending', 'in-progress', 'in_progress'].includes(raw)) return 'running';
  return raw;
}

function describeExternalMemoryReceiptArtifact(artifact: ArtifactDescriptor): MemoryExternalProviderReceiptEvidence | null {
  const metadata = readRecord(artifact.metadata);
  if (!isExternalMemoryReceiptArtifact(artifact)) return null;
  const providerId = readExternalMemoryReceiptProviderId(metadata);
  if (!providerId) return null;
  const operation = readString(metadata.operation)
    || readString(metadata.action)
    || readString(metadata.memoryOperation)
    || readString(metadata.receiptOperation)
    || 'external-memory';
  const nextRoute = readString(metadata.nextRoute)
    || `memory action:"provider" providerId:"${providerId}" includeParameters:true`;
  return {
    providerId,
    artifactId: artifact.id,
    filename: artifact.filename ?? null,
    operation,
    status: normalizeReceiptStatus(metadata.status ?? metadata.outcome ?? metadata.result),
    createdAt: readReceiptCreatedAt(artifact, metadata),
    sourceCount: readNumber(metadata.sourceCount ?? metadata.recordCount ?? metadata.itemCount),
    redaction: readString(metadata.redaction) || readString(metadata.redactionPolicy) || null,
    failureReason: readString(metadata.failureReason) || readString(metadata.error) || null,
    nextRoute,
    inspectRoute: `agent_artifacts show artifactId:"${artifact.id}" includeContent:false`,
    correlationId: readString(metadata.correlationId) || readString(metadata.runId) || null,
    certification: memoryExternalProviderReceiptCertification({
      metadata,
      sourcePath: `artifact ${artifact.id}`,
      providerId,
      artifactId: artifact.id,
    }),
  };
}

export function externalMemoryReceiptEvidence(context: CommandContext): readonly MemoryExternalProviderReceiptEvidence[] {
  const store = artifactStore(context);
  if (!store?.list) return [];
  return store.list(100)
    .map(describeExternalMemoryReceiptArtifact)
    .filter((entry): entry is MemoryExternalProviderReceiptEvidence => entry !== null)
    .sort((left, right) => {
      const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
      const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
      if (rightTime !== leftTime) return rightTime - leftTime;
      return right.artifactId.localeCompare(left.artifactId);
    });
}

export function receiptEvidenceForProvider(
  evidence: readonly MemoryExternalProviderReceiptEvidence[],
  providerId: string,
): readonly MemoryExternalProviderReceiptEvidence[] {
  return evidence.filter((entry) => entry.providerId === providerId);
}
