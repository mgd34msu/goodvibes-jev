import {
  MemoryUsageStatsStore,
  type MemoryDoctorReport,
  type MemoryEmbeddingProviderStatus,
  type MemoryVectorStats,
  type MemoryUsageSummary,
} from '@goodvibes-jev/engine/sdk/platform/state';
import type { CommandContext } from '../input/command-registry.ts';
import { buildAgentWorkspaceMemorySnapshot, type buildAgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-snapshot.ts';
import { buildAgentWorkspaceSessionMemoryCount } from '../input/agent-workspace-snapshot-builders.ts';
import { readConfigString } from '../input/agent-workspace-snapshot-config.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { captureCatalogMethods, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import { capturePersonalOpsSnapshot, protectPersonalOpsData } from './agent-harness-personal-ops-source.ts';
import { assertMemoryCurrent, retainMemoryReadingOptions, selectMemoryProvider } from './agent-harness-memory-provider-readings.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { EXTERNAL_MEMORY_RECEIPT_FIELDS, EXTERNAL_MEMORY_REQUIRED_CONTRACTS, aggregateExternalProviderLiveRecord, aggregateExternalProviderSetupStatus, externalMemoryLiveProviderRecords, externalMemoryProviderCatalog, externalMemoryReceiptEvidence, externalProviderLiveReady, liveRecordForProvider, receiptEvidenceForProvider, setupStatusFromLiveRecord } from './agent-harness-memory-external-providers.ts';
import type { ExternalMemoryProviderCatalogEntry, MemoryExternalProviderContractCheck, MemoryExternalProviderContractStatus, MemoryExternalProviderLiveRecord, MemoryExternalProviderReceiptContract, MemoryExternalProviderReceiptEvidence, MemoryExternalProviderRoute, MemoryExternalProviderSetupGuide, MemoryExternalProviderStatus, MemoryPostureProvider, MemoryProviderResolution } from './agent-harness-memory-external-providers.ts';

type MemoryPostureStatus = 'ready' | 'needs-review' | 'empty' | 'unavailable';
type MemoryVectorPostureStatus = 'ready' | 'attention' | 'disabled' | 'unavailable';
interface AgentHarnessMemoryPostureArgs {
  readonly providerId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(parsed)));
}

type MemoryPostureSnapshot = Pick<ReturnType<typeof buildAgentWorkspaceRuntimeSnapshot>, 'localMemoryCount' | 'localMemoryReviewQueueCount'
  | 'localMemoryPromptActiveCount' | 'localMemoryTemporallyPendingCount' | 'localMemoryTemporallyExpiredCount' | 'sessionMemoryCount' | 'embeddingProvider'>;
function memoryPostureSnapshot(context: CommandContext): MemoryPostureSnapshot {
  const memory = buildAgentWorkspaceMemorySnapshot(context);
  return { localMemoryCount: memory.count, localMemoryReviewQueueCount: memory.reviewQueueCount, localMemoryPromptActiveCount: memory.promptActiveCount,
    localMemoryTemporallyPendingCount: memory.temporallyPendingCount, localMemoryTemporallyExpiredCount: memory.temporallyExpiredCount,
    sessionMemoryCount: buildAgentWorkspaceSessionMemoryCount(context), embeddingProvider: readConfigString(context, 'provider.embeddingProvider', '(provider default)') };
}

function memoryApi(context: CommandContext): {
  readonly vectorStats?: () => MemoryVectorStats;
  readonly doctor?: () => Promise<MemoryDoctorReport>;
} | null {
  // Admit every enclosing service descriptor before the typed interface is read.
  modelReadingServicePath(context, ['clients', 'agentKnowledgeApi', 'memory']);
  return context.clients?.agentKnowledgeApi?.memory ?? null;
}

function memoryReadingOptions(context: CommandContext, args: unknown, originalOptions: CatalogRankingOptions): CatalogRankingOptions {
  const options = retainMemoryReadingOptions(originalOptions);
  const input = capturePersonalOpsSnapshot(args);
  const paths = [['clients'], ['clients', 'agentKnowledgeApi'], ['clients', 'agentKnowledgeApi', 'memory'],
    ['session'], ['session', 'runtime'], ['session', 'sessionMemoryStore'], ['platform'], ['platform', 'configManager']] as const;
  const guards: (() => void)[] = [];
  for (const path of paths) {
    const receiver = path.length === 1 ? context : modelReadingServicePath(context, path.slice(0, -1));
    if (receiver === undefined || receiver === null) continue;
    if (typeof receiver !== 'object') throw new ToolInputProjectionError('held');
    const key = path.at(-1); if (key === undefined) throw new ToolInputProjectionError('held');
    guards.push(captureCatalogMethods(receiver, [key]));
  }
  const api = memoryApi(context);
  const apiCurrent = api ? captureCatalogMethods(api, ['doctor', 'vectorStats', 'getAll', 'reviewQueue']) : undefined;
  for (const binding of [ { path: ['session', 'sessionMemoryStore'], keys: ['list'] }, { path: ['platform', 'configManager'], keys: ['get'] } ]) {
    const service = modelReadingServicePath(context, binding.path);
    if (service !== undefined && service !== null) { if (typeof service !== 'object') throw new ToolInputProjectionError('held'); guards.push(captureCatalogMethods(service, binding.keys)); }
  }
  const counts = capturePersonalOpsSnapshot(memoryPostureSnapshot(context));
  const assertSources = () => { options.signal?.throwIfAborted(); for (const guard of guards) guard(); apiCurrent?.();
    input.assertCurrent(args); if (memoryApi(context) !== api) throw new ToolInputProjectionError('held');
    counts.assertCurrent(memoryPostureSnapshot(context)); for (const guard of guards) guard(); apiCurrent?.();
  };
  options.retainCurrent?.(assertSources, 'agent.memory.posture-native');
  const assertCurrent = () => { assertMemoryCurrent(options); assertSources(); };
  assertCurrent(); return { ...options, assertCurrent };
}

async function awaitMemoryRead<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error); });
    if (signal.aborted) abort();
  });
}

function protectedRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ToolInputProjectionError('held');
  return Object.fromEntries(Object.entries(value));
}
function protectedText(value: unknown): string {
  if (typeof value !== 'string') throw new ToolInputProjectionError('held');
  return value;
}
function protectedStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new ToolInputProjectionError('held');
  return value.map(protectedText);
}
function preserveNative(record: Record<string, unknown>, native: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  for (const key of keys) if (!Object.is(record[key], native[key])) throw new ToolInputProjectionError('held');
}
function protectedVector(native: MemoryVectorStats, value: unknown): MemoryVectorStats {
  const record = protectedRecord(value);
  preserveNative(record, { ...native }, ['backend', 'enabled', 'available', 'dimensions', 'indexedRecords', 'embeddingProviderId']);
  return { backend: native.backend, enabled: native.enabled, available: native.available, dimensions: native.dimensions,
    indexedRecords: native.indexedRecords, embeddingProviderId: native.embeddingProviderId,
    embeddingProviderLabel: protectedText(record.embeddingProviderLabel), path: protectedText(record.path),
    ...(native.error !== undefined ? { error: protectedText(record.error) } : {}),
    ...(native.platformLimitReason !== undefined ? { platformLimitReason: protectedText(record.platformLimitReason) } : {}) };
}

async function protectMemoryVector(value: MemoryVectorStats, options: CatalogRankingOptions): Promise<MemoryVectorStats> {
  const source = capturePersonalOpsSnapshot(value);
  const sourceCurrent = () => { options.signal?.throwIfAborted(); source.assertCurrent(value); };
  options.retainCurrent?.(sourceCurrent);
  const protectedValue = await protectPersonalOpsData(value, { ...options, assertCurrent: () => { assertMemoryCurrent(options); sourceCurrent(); } });
  const result = protectedVector(value, protectedValue); assertMemoryCurrent(options); sourceCurrent(); return result;
}

async function protectMemoryDoctor(value: MemoryDoctorReport, options: CatalogRankingOptions): Promise<MemoryDoctorReport> {
  const source = capturePersonalOpsSnapshot(value);
  const sourceCurrent = () => { options.signal?.throwIfAborted(); source.assertCurrent(value); };
  options.retainCurrent?.(sourceCurrent);
  const protectedValue = await protectPersonalOpsData(value, { ...options, assertCurrent: () => { assertMemoryCurrent(options); sourceCurrent(); } });
  const record = protectedRecord(protectedValue), embeddings = protectedRecord(record.embeddings);
  if (record.checkedAt !== value.checkedAt || embeddings.activeProviderId !== value.embeddings.activeProviderId
    || !Array.isArray(embeddings.providers) || embeddings.providers.length !== value.embeddings.providers.length) throw new ToolInputProjectionError('held');
  const protectedProviders = embeddings.providers;
  const providers = value.embeddings.providers.map((native, index): MemoryEmbeddingProviderStatus => {
    const provider = protectedRecord(protectedProviders[index]);
    preserveNative(provider, { ...native }, ['id', 'state', 'configured', 'dimensions', 'deterministic']);
    return { id: native.id, state: native.state, configured: native.configured, dimensions: native.dimensions,
      label: protectedText(provider.label), metadata: protectedRecord(provider.metadata),
      ...(native.deterministic !== undefined ? { deterministic: native.deterministic } : {}),
      ...(native.detail !== undefined ? { detail: protectedText(provider.detail) } : {}) };
  });
  const asyncProviders = protectedStrings(embeddings.asyncProviders), syncProviders = protectedStrings(embeddings.syncProviders);
  if (asyncProviders.length !== value.embeddings.asyncProviders.length || asyncProviders.some((id, index) => id !== value.embeddings.asyncProviders[index])
    || syncProviders.length !== value.embeddings.syncProviders.length || syncProviders.some((id, index) => id !== value.embeddings.syncProviders[index])) throw new ToolInputProjectionError('held');
  const result = { checkedAt: value.checkedAt, vector: protectedVector(value.vector, record.vector), embeddings: {
    activeProviderId: value.embeddings.activeProviderId, providers, asyncProviders, syncProviders, warnings: protectedStrings(embeddings.warnings) } };
  assertMemoryCurrent(options); sourceCurrent(); return result;
}

/**
 * Per-memory usage counters (injected/referenced) from the honest usage-outcome
 * instrumentation. Read-only view built from the same durable sidecar the runtime
 * writes; null when there is no active workspace to resolve the path from.
 */
function readMemoryUsageSummary(context: CommandContext): MemoryUsageSummary | null {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return null;
  try {
    const store = new MemoryUsageStatsStore(shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'learning', 'memory-usage.json'));
    return store.summary();
  } catch {
    return null;
  }
}

function buildUsageSection(summary: MemoryUsageSummary | null): Record<string, unknown> {
  if (!summary) {
    return { status: 'unavailable', signal: 'jev-reading', note: 'No usage instrumentation available in this runtime.' };
  }
  return {
    status: summary.everInjected > 0 ? 'tracked' : 'empty',
    signal: 'jev-reading',
    signalNote: summary.signalNote,
    totalTracked: summary.totalTracked,
    everInjected: summary.everInjected,
    everReferenced: summary.everReferenced,
    neverReferenced: summary.neverReferenced,
    mostReferenced: summary.mostReferenced.map((entry) => ({ id: entry.id, injectedCount: entry.injectedCount, referencedCount: entry.referencedCount, lastReferencedAt: entry.lastReferencedAt })),
    neverReferencedSample: summary.neverReferencedSample.map((entry) => ({ id: entry.id, injectedCount: entry.injectedCount, lastInjectedAt: entry.lastInjectedAt })),
    policy: 'Referenced means the model output overlapped this memory\'s distinctive content (heuristic, not ground truth). Never-referenced injected memories decay first during idle consolidation.',
  };
}

async function readMemoryDoctor(context: CommandContext, options: CatalogRankingOptions): Promise<MemoryDoctorReport | null> {
  assertMemoryCurrent(options);
  const memory = memoryApi(context);
  if (!memory || typeof memory.doctor !== 'function') return null;
  let report: MemoryDoctorReport;
  try { report = await awaitMemoryRead(memory.doctor(), options.signal); }
  catch (error: unknown) { assertMemoryCurrent(options); if (error instanceof ToolInputProjectionError) throw error; return null; }
  assertMemoryCurrent(options);
  return protectMemoryDoctor(report, options);
}

async function readVectorStats(context: CommandContext, doctor: MemoryDoctorReport | null, options: CatalogRankingOptions): Promise<MemoryVectorStats | null> {
  assertMemoryCurrent(options);
  if (doctor?.vector) return doctor.vector;
  const memory = memoryApi(context);
  if (!memory || typeof memory.vectorStats !== 'function') return null;
  let vector: MemoryVectorStats;
  try { vector = memory.vectorStats(); }
  catch (error: unknown) { assertMemoryCurrent(options); if (error instanceof ToolInputProjectionError) throw error; return null; }
  options.assertCurrent?.(); return protectMemoryVector(vector, options);
}

function memoryStatus(snapshot: MemoryPostureSnapshot, memoryAvailable: boolean): MemoryPostureStatus {
  if (!memoryAvailable) return 'unavailable';
  if (snapshot.localMemoryCount === 0) return 'empty';
  if (snapshot.localMemoryPromptActiveCount > 0) return 'ready';
  return 'needs-review';
}

function vectorStatus(vector: MemoryVectorStats | null): MemoryVectorPostureStatus {
  if (!vector) return 'unavailable';
  if (!vector.enabled) return 'disabled';
  if (vector.available && !vector.error) return 'ready';
  return 'attention';
}

function describeEmbeddingProvider(
  provider: MemoryEmbeddingProviderStatus,
  activeProviderId: string | undefined,
  includeParameters: boolean,
): MemoryPostureProvider {
  return {
    id: provider.id,
    label: provider.label,
    kind: 'embedding',
    status: provider.state,
    summary: previewHarnessText(provider.detail ?? `${provider.configured ? 'configured' : 'not configured'} memory embedding provider`, includeParameters ? 180 : 96),
    modelRoute: `memory action:"provider" providerId:${JSON.stringify(provider.id)}`,
    setupRoute: `settings action:"set" key:"provider.embeddingProvider" value:"${provider.id}" confirm:true explicitUserRequest:"..."`,
    configured: provider.configured,
    active: provider.id === activeProviderId,
    dimensions: provider.dimensions,
    ...(typeof provider.deterministic === 'boolean' ? { deterministic: provider.deterministic } : {}),
    ...(includeParameters ? { metadata: provider.metadata } : {}),
  };
}

function externalProviderNextRoutes(
  provider: ExternalMemoryProviderCatalogEntry,
  liveRecord: MemoryExternalProviderLiveRecord | null = null,
): readonly MemoryExternalProviderRoute[] {
  const liveRoutes: MemoryExternalProviderRoute[] = [];
  if (liveRecord?.readRoute) {
    liveRoutes.push({
      id: 'read-provider-memory',
      label: 'Read provider memory',
      modelRoute: liveRecord.readRoute,
      effect: 'read-only',
      why: 'Uses the daemon-published bounded read/search route with provider redaction and provenance policy.',
    });
  }
  if (liveRecord?.writeRoute) {
    liveRoutes.push({
      id: 'write-provider-memory',
      label: 'Write provider memory',
      modelRoute: liveRecord.writeRoute,
      effect: 'confirmed',
      why: 'External memory writes require explicit user request, confirmation, and a durable provider receipt.',
    });
  }
  if (liveRecord?.syncRoute) {
    liveRoutes.push({
      id: 'sync-provider-memory',
      label: 'Sync provider memory',
      modelRoute: liveRecord.syncRoute,
      effect: 'confirmed',
      why: 'Provider sync/import/export crosses a boundary and needs confirmation plus durable receipt evidence.',
    });
  }
  if (liveRecord?.forgetRoute) {
    liveRoutes.push({
      id: 'forget-provider-memory',
      label: 'Forget provider memory',
      modelRoute: liveRecord.forgetRoute,
      effect: 'confirmed',
      why: 'Provider forget/delete/disable effects require explicit user request and durable receipt evidence.',
    });
  }
  return [
    ...liveRoutes,
    {
      id: 'inspect-provider-contract',
      label: 'Inspect provider contract',
      modelRoute: `memory action:"provider" providerId:${JSON.stringify(provider.id)} includeParameters:true`,
      effect: 'read-only',
      why: 'Shows the current SDK/daemon contract checklist, missing receipt fields, credential boundary, and local fallback.',
    },
    {
      id: 'inspect-host-capability',
      label: 'Inspect host capability',
      modelRoute: `host action:"capability" query:${JSON.stringify(`${provider.id} memory provider`)}`,
      effect: 'read-only',
      why: 'Checks whether the connected GoodVibes host publishes a provider capability record for Agent to consume.',
    },
    {
      id: 'inspect-mcp-server',
      label: 'Inspect MCP server',
      modelRoute: `agent_harness mode:"mcp_servers" query:${JSON.stringify(provider.id)}`,
      effect: 'read-only',
      why: 'Finds a matching MCP connector without reading secrets or invoking provider writes.',
    },
    {
      id: 'inspect-memory-settings',
      label: 'Inspect memory settings',
      modelRoute: 'settings action:"list" query:"memory" includeHidden:true',
      effect: 'read-only',
      why: 'Shows safe setting keys and secret-ref posture before any memory-provider configuration change.',
    },
  ];
}

function externalProviderContractChecklist(
  provider: ExternalMemoryProviderCatalogEntry,
  receipts: readonly MemoryExternalProviderReceiptEvidence[] = [],
  liveRecord: MemoryExternalProviderLiveRecord | null = null,
): readonly MemoryExternalProviderContractCheck[] {
  const providerQuery = `${provider.id} memory provider`;
  const hasReceipts = receipts.length > 0;
  const liveInspectRoute = liveRecord?.inspectRoute ?? `host action:"capability" query:${JSON.stringify(providerQuery)}`;
  const providerCertificationPublished: MemoryExternalProviderContractStatus = liveRecord?.certification?.schemaStatus === 'certified'
    && liveRecord.certification.missingSignals.length === 0
    ? 'published'
    : 'missing';
  const statusRecordStatus: MemoryExternalProviderContractStatus = liveRecord ? 'published' : 'missing';
  const credentialStatus: MemoryExternalProviderContractStatus = liveRecord && (liveRecord.credentialState !== null || liveRecord.configured !== null) ? 'published' : 'missing';
  const readStatus: MemoryExternalProviderContractStatus = liveRecord?.readReady === true || liveRecord?.readRoute ? 'published' : 'missing';
  const writeStatus: MemoryExternalProviderContractStatus = liveRecord?.writeReady === true || liveRecord?.writeRoute ? 'published' : 'missing';
  const forgetStatus: MemoryExternalProviderContractStatus = liveRecord && (liveRecord.forgetReady !== null || liveRecord.forgetRoute) ? 'published' : 'missing';
  const syncStatus: MemoryExternalProviderContractStatus = liveRecord?.syncReady === true || liveRecord?.syncRoute || liveRecord?.receiptRoute || liveRecord?.receiptIds.length
    ? 'published'
    : hasReceipts ? 'artifact-evidence-found' : 'missing';
  const promptPolicyStatus: MemoryExternalProviderContractStatus = liveRecord && liveRecord.promptEligible !== null ? 'published' : 'missing';
  return [
    {
      id: 'certified-provider-contract',
      label: 'Certified provider schema/publication evidence',
      status: providerCertificationPublished,
      requiredFor: 'Treat provider readiness as release-grade instead of a legacy host hint.',
      owner: 'goodvibes-sdk-or-daemon',
      inspectRoute: liveInspectRoute,
    },
    {
      id: 'status-record',
      label: 'Provider status/readiness record',
      status: statusRecordStatus,
      requiredFor: 'Show whether the provider is configured, reachable, and safe to use.',
      owner: 'goodvibes-sdk-or-daemon',
      inspectRoute: liveInspectRoute,
    },
    {
      id: 'credential-reference',
      label: 'Credential reference without raw secret values',
      status: credentialStatus,
      requiredFor: 'Let the user repair auth without exposing API keys or memory payloads.',
      owner: 'goodvibes-sdk-or-daemon',
      inspectRoute: liveRecord?.setupRoute ?? 'settings action:"list" query:"memory" includeHidden:true',
    },
    {
      id: 'bounded-read-search',
      label: 'Bounded read/search route',
      status: readStatus,
      requiredFor: 'Review external memories with redaction, provenance, and source limits before prompt use.',
      owner: 'goodvibes-sdk-or-daemon',
      inspectRoute: liveRecord?.readRoute ?? `agent_harness mode:"mcp_servers" query:${JSON.stringify(provider.id)}`,
    },
    {
      id: 'confirmed-write-upsert',
      label: 'Confirmed write/upsert/import route',
      status: writeStatus,
      requiredFor: 'Write external memories only after explicit user request and confirmation.',
      owner: 'goodvibes-sdk-or-daemon',
      inspectRoute: liveRecord?.writeRoute ?? `host action:"capability" query:${JSON.stringify(providerQuery)}`,
    },
    {
      id: 'forget-contract',
      label: 'Forget/delete or explicit not-supported contract',
      status: forgetStatus,
      requiredFor: 'Prove provider memory can be removed or that removal is explicitly unsupported before the provider is relied on.',
      owner: 'goodvibes-sdk-or-daemon',
      inspectRoute: liveRecord?.forgetRoute ?? liveInspectRoute,
    },
    {
      id: 'sync-receipts',
      label: 'Sync/import/export receipts',
      status: syncStatus,
      requiredFor: 'Prove what crossed the provider boundary, when it happened, and what failed.',
      owner: 'goodvibes-sdk-or-daemon',
      inspectRoute: liveRecord?.receiptRoute ?? liveRecord?.syncRoute ?? (hasReceipts
        ? receipts[0]!.inspectRoute
        : `memory action:"provider" providerId:${JSON.stringify(provider.id)} includeParameters:true`),
    },
    {
      id: 'prompt-eligibility-policy',
      label: 'Prompt eligibility policy',
      status: promptPolicyStatus,
      requiredFor: 'Prevent external provider records from silently entering the Agent prompt.',
      owner: 'goodvibes-sdk-or-daemon',
      inspectRoute: 'context action:"prompt" includeParameters:true',
    },
  ];
}

function externalProviderReceiptContract(
  providerId = '<provider-id>',
  receipts: readonly MemoryExternalProviderReceiptEvidence[] = [],
  liveRecord: MemoryExternalProviderLiveRecord | null = null,
): MemoryExternalProviderReceiptContract {
  const liveReceiptsPublished = Boolean(liveRecord && (liveRecord.receiptIds.length > 0 || liveRecord.receiptRoute || liveRecord.syncReady === true || liveRecord.syncRoute));
  const liveReceiptCertified = liveRecord?.certification?.schemaStatus === 'certified' && liveRecord.certification.missingSignals.length === 0;
  const artifactReceiptCertified = receipts.some((receipt) => receipt.certification?.schemaStatus === 'certified' && receipt.certification.missingSignals.length === 0);
  return {
    status: liveReceiptsPublished && liveReceiptCertified ? 'published' : receipts.length > 0 && artifactReceiptCertified ? 'artifact-evidence-found' : 'missing',
    appliesTo: ['status', 'read', 'write', 'upsert', 'import', 'export', 'sync', 'forget'],
    requiredFields: EXTERNAL_MEMORY_RECEIPT_FIELDS,
    nextWhenPublished: `memory action:"provider" providerId:${JSON.stringify(providerId)} includeParameters:true should expose latest receipts and exact follow-up routes.`,
  };
}

function externalProviderSetupGuide(
  provider: ExternalMemoryProviderCatalogEntry,
  receipts: readonly MemoryExternalProviderReceiptEvidence[] = [],
  liveRecord: MemoryExternalProviderLiveRecord | null = null,
): MemoryExternalProviderSetupGuide {
  const latestReceipt = receipts[0] ?? null;
  const liveSetupStatus = setupStatusFromLiveRecord(liveRecord);
  const readiness = liveRecord
    ? [
      `status ${liveRecord.status}`,
      liveRecord.configured === null ? '' : `configured ${liveRecord.configured}`,
      liveRecord.reachable === null ? '' : `reachable ${liveRecord.reachable}`,
      liveRecord.readReady === null ? '' : `read ${liveRecord.readReady}`,
      liveRecord.writeReady === null ? '' : `write ${liveRecord.writeReady}`,
      liveRecord.syncReady === null ? '' : `sync ${liveRecord.syncReady}`,
      liveRecord.forgetReady === null ? '' : `forget ${liveRecord.forgetReady}`,
      liveRecord.promptEligible === null ? '' : `promptEligible ${liveRecord.promptEligible}`,
    ].filter(Boolean).join(', ')
    : '';
  const liveInspectRoutes = liveRecord
    ? [
      liveRecord.inspectRoute,
      liveRecord.readRoute,
      liveRecord.writeRoute,
      liveRecord.syncRoute,
      liveRecord.forgetRoute,
      liveRecord.receiptRoute,
    ].filter((route): route is string => Boolean(route))
    : [];
  return {
    status: liveSetupStatus ?? (latestReceipt ? 'receipt-evidence-found' : 'contract-needed'),
    userOutcome: liveRecord
      ? `Use ${provider.label} as an external memory backend through the daemon-published read model, with bounded reads visible before prompt use and every write/sync/forget route treated as confirmed external provider effect.`
      : `Use ${provider.label} as an external memory backend only after the SDK/daemon publishes provider setup, status, read, write, and receipt contracts for Agent to consume.`,
    currentState: liveRecord
      ? `Live ${provider.label} provider record from ${liveRecord.source} reports ${readiness || liveRecord.status}.${latestReceipt ? ` Latest durable receipt artifact ${latestReceipt.artifactId} reports ${latestReceipt.operation} ${latestReceipt.status}.` : ''}`
      : latestReceipt
      ? `Latest durable ${provider.label} receipt artifact ${latestReceipt.artifactId} reports ${latestReceipt.operation} ${latestReceipt.status}; live provider status/read/write records are still not published by the current SDK/daemon contract.`
      : `No concrete ${provider.label} provider record is published by the current SDK/daemon contract.`,
    safeFirstStep: liveRecord
      ? `Inspect the live ${provider.label} record and use only the published bounded read route until the user explicitly confirms any write, sync, import/export, forget/delete, or prompt-eligibility change.`
      : latestReceipt
      ? `Review ${latestReceipt.artifactId}, then keep Agent-local memory as the active prompt path until a ready provider record and prompt-eligibility policy exist.`
      : `Inspect connected-host and MCP setup for ${provider.label}; keep Agent-local memory as the active path until a ready provider record exists.`,
    inspectRoutes: [...new Set([
      `memory action:"provider" providerId:${JSON.stringify(provider.id)} includeParameters:true`,
      ...liveInspectRoutes,
      `host action:"capability" query:${JSON.stringify(`${provider.id} memory provider`)}`,
      `agent_harness mode:"mcp_servers" query:${JSON.stringify(provider.id)}`,
      'settings action:"list" query:"memory" includeHidden:true',
    ])],
    nextRoutes: externalProviderNextRoutes(provider, liveRecord),
    contractChecklist: externalProviderContractChecklist(provider, receipts, liveRecord),
    receiptContract: externalProviderReceiptContract(provider.id, receipts, liveRecord),
    ...(latestReceipt ? { latestReceipt, receiptHistory: receipts.slice(0, 5) } : {}),
    requiredHostContracts: EXTERNAL_MEMORY_REQUIRED_CONTRACTS,
    credentialPolicy: 'Provider credentials must use secret refs or connected-host auth state; raw API keys, tokens, and user memory payloads are never returned by posture inspection.',
    confirmationPolicy: 'External memory writes, sync, import, export, forget/delete, and prompt-eligibility changes require explicit user request, confirmation, and durable receipts.',
  };
}

function describeExternalProvider(
  provider: ExternalMemoryProviderCatalogEntry,
  includeParameters: boolean,
  receipts: readonly MemoryExternalProviderReceiptEvidence[] = [],
  liveRecord: MemoryExternalProviderLiveRecord | null = null,
): MemoryPostureProvider {
  const latestReceipt = receipts[0] ?? null;
  const status: MemoryExternalProviderStatus = liveRecord?.status ?? (latestReceipt ? 'receipt-evidence-found' : 'not-published');
  const liveSummary = liveRecord
    ? `Live external memory provider record from ${liveRecord.source} reports ${liveRecord.status}; configured ${liveRecord.configured ?? 'unknown'}, read ${liveRecord.readReady ?? 'unknown'}, write ${liveRecord.writeReady ?? 'unknown'}, sync ${liveRecord.syncReady ?? 'unknown'}.`
    : '';
  return {
    id: provider.id,
    label: provider.label,
    kind: 'external-memory',
    status,
    summary: previewHarnessText(liveRecord
      ? liveSummary
      : latestReceipt
      ? `Durable external memory receipt ${latestReceipt.artifactId} reports ${latestReceipt.operation} ${latestReceipt.status}; live provider records are still not published.`
      : 'External memory backend records are not published by the current GoodVibes SDK/daemon contract.', includeParameters ? 180 : 96),
    modelRoute: `memory action:"provider" providerId:${JSON.stringify(provider.id)}`,
    setupRoute: 'host action:"capability" query:"memory provider"',
    configured: liveRecord?.configured ?? (liveRecord ? externalProviderLiveReady(liveRecord) : latestReceipt ? latestReceipt.status === 'succeeded' : false),
    ...(includeParameters && liveRecord ? { liveRecord } : {}),
    ...(latestReceipt ? { latestReceipt } : {}),
    ...(includeParameters && receipts.length > 0 ? { receiptEvidence: receipts.slice(0, 5) } : {}),
    ...(includeParameters ? { setupGuide: externalProviderSetupGuide(provider, receipts, liveRecord) } : {}),
  };
}

function providerSearchText(provider: MemoryPostureProvider): string {
  return [
    provider.id,
    provider.label,
    provider.kind,
    provider.status,
    provider.summary,
    provider.modelRoute,
    provider.setupRoute ?? '',
    provider.liveRecord ? [
      provider.liveRecord.providerId,
      provider.liveRecord.label ?? '',
      provider.liveRecord.status,
      provider.liveRecord.source,
      provider.liveRecord.credentialState ?? '',
      provider.liveRecord.readRoute ?? '',
      provider.liveRecord.writeRoute ?? '',
      provider.liveRecord.syncRoute ?? '',
      provider.liveRecord.receiptIds.join('\n'),
      provider.liveRecord.certification ? [
        provider.liveRecord.certification.schemaStatus,
        provider.liveRecord.certification.schemaVersion ?? '',
        provider.liveRecord.certification.publicationGuarantee ?? '',
        provider.liveRecord.certification.publisher ?? '',
        provider.liveRecord.certification.provenance?.join('\n') ?? '',
        provider.liveRecord.certification.receiptIds?.join('\n') ?? '',
        provider.liveRecord.certification.missingSignals.join('\n'),
      ].join('\n') : '',
    ].join('\n') : '',
    provider.latestReceipt ? [
      provider.latestReceipt.artifactId,
      provider.latestReceipt.operation,
      provider.latestReceipt.status,
      provider.latestReceipt.nextRoute,
      provider.latestReceipt.certification ? [
        provider.latestReceipt.certification.schemaStatus,
        provider.latestReceipt.certification.schemaVersion ?? '',
        provider.latestReceipt.certification.publicationGuarantee ?? '',
        provider.latestReceipt.certification.publisher ?? '',
        provider.latestReceipt.certification.provenance?.join('\n') ?? '',
        provider.latestReceipt.certification.receiptIds?.join('\n') ?? '',
        provider.latestReceipt.certification.missingSignals.join('\n'),
      ].join('\n') : '',
    ].join('\n') : '',
    provider.setupGuide ? [
      provider.setupGuide.status,
      provider.setupGuide.userOutcome,
      provider.setupGuide.currentState,
      provider.setupGuide.safeFirstStep,
      provider.setupGuide.inspectRoutes.join('\n'),
      provider.setupGuide.nextRoutes.map((route) => `${route.id} ${route.label} ${route.modelRoute} ${route.effect} ${route.why}`).join('\n'),
      provider.setupGuide.contractChecklist.map((check) => `${check.id} ${check.label} ${check.status} ${check.requiredFor} ${check.inspectRoute}`).join('\n'),
      provider.setupGuide.receiptContract.appliesTo.join('\n'),
      provider.setupGuide.receiptContract.requiredFields.join('\n'),
      provider.setupGuide.receiptContract.nextWhenPublished,
      provider.setupGuide.latestReceipt ? [
        provider.setupGuide.latestReceipt.artifactId,
        provider.setupGuide.latestReceipt.operation,
        provider.setupGuide.latestReceipt.status,
      ].join('\n') : '',
      provider.setupGuide.requiredHostContracts.join('\n'),
      provider.setupGuide.credentialPolicy,
      provider.setupGuide.confirmationPolicy,
    ].join('\n') : '',
  ].join('\n').toLowerCase();
}

function compactProvider(provider: MemoryPostureProvider, includeParameters: boolean): Record<string, unknown> {
  return {
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    status: provider.status,
    summary: provider.summary,
    modelRoute: provider.modelRoute,
    ...(provider.setupRoute ? { setupRoute: provider.setupRoute } : {}),
    ...(includeParameters && typeof provider.configured === 'boolean' ? { configured: provider.configured } : {}),
    ...(includeParameters && typeof provider.active === 'boolean' ? { active: provider.active } : {}),
    ...(includeParameters && typeof provider.dimensions === 'number' ? { dimensions: provider.dimensions } : {}),
    ...(includeParameters && typeof provider.deterministic === 'boolean' ? { deterministic: provider.deterministic } : {}),
    ...(includeParameters && provider.metadata ? { metadata: provider.metadata } : {}),
    ...(includeParameters && provider.liveRecord ? { liveRecord: provider.liveRecord } : {}),
    ...(provider.latestReceipt ? { latestReceipt: provider.latestReceipt } : {}),
    ...(includeParameters && provider.receiptEvidence ? { receiptEvidence: provider.receiptEvidence } : {}),
    ...(includeParameters && provider.setupGuide ? { setupGuide: provider.setupGuide } : {}),
  };
}

async function buildProviderRecords(
  context: CommandContext,
  args: AgentHarnessMemoryPostureArgs,
  options: CatalogRankingOptions,
): Promise<{
  readonly doctor: MemoryDoctorReport | null;
  readonly vector: MemoryVectorStats | null;
  readonly providers: readonly MemoryPostureProvider[];
  readonly receiptEvidence: readonly MemoryExternalProviderReceiptEvidence[];
  readonly liveRecords: readonly MemoryExternalProviderLiveRecord[];
}> {
  const includeParameters = args.includeParameters === true;
  const doctor = await readMemoryDoctor(context, options);
  const vector = await readVectorStats(context, doctor, options);
  const receiptEvidence = await externalMemoryReceiptEvidence(context, options);
  const liveRecords = await externalMemoryLiveProviderRecords(context, options);
  const embeddingProviders = (doctor?.embeddings.providers ?? []).map((provider) => (
    describeEmbeddingProvider(provider, doctor?.embeddings.activeProviderId, includeParameters)
  ));
  const externalProviders = externalMemoryProviderCatalog(liveRecords, receiptEvidence).map((provider) => (
    describeExternalProvider(
      provider,
      includeParameters,
      receiptEvidenceForProvider(receiptEvidence, provider.id),
      liveRecordForProvider(liveRecords, provider.id),
    )
  ));
  return {
    doctor,
    vector,
    providers: [...embeddingProviders, ...externalProviders],
    receiptEvidence,
    liveRecords,
  };
}

function nextActions(
  snapshot: MemoryPostureSnapshot,
  memoryStatusValue: MemoryPostureStatus,
  vectorStatusValue: MemoryVectorPostureStatus,
  doctor: MemoryDoctorReport | null,
): readonly string[] {
  const actions: string[] = [];
  if (memoryStatusValue === 'empty') actions.push('Create one durable non-secret Agent memory only after the user asks to remember it.');
  if (memoryStatusValue === 'needs-review') actions.push('Review or stale memory candidates before relying on them in the prompt.');
  if (snapshot.localMemoryReviewQueueCount > 0) actions.push('Use learning_curator or memory review routes to clear the memory review queue.');
  if (vectorStatusValue === 'attention') actions.push('Run memory vector doctor, then rebuild the vector index if the reported issue is fixed.');
  if (doctor?.embeddings.warnings.length) actions.push('Inspect the active embedding provider warning before semantic recall or rebuild work.');
  actions.push('Inspect memory action:"provider" for one external backend to see the exact SDK/daemon setup contracts Agent can consume before use.');
  return actions.slice(0, 6);
}

function compactVector(vector: MemoryVectorStats | null): Record<string, unknown> {
  if (!vector) {
    return {
      status: 'unavailable',
      summary: 'Memory vector stats are not exposed in this runtime.',
      modelRoute: 'memory action:"status"',
    };
  }
  return {
    status: vectorStatus(vector),
    backend: vector.backend,
    enabled: vector.enabled,
    available: vector.available,
    indexedRecords: vector.indexedRecords,
    dimensions: vector.dimensions,
    embeddingProviderId: vector.embeddingProviderId,
    embeddingProviderLabel: vector.embeddingProviderLabel,
    ...(vector.error ? { error: previewHarnessText(vector.error, 160) } : {}),
    modelRoute: 'agent_harness mode:"workspace_action" actionId:"memory-vector-status"',
    doctorRoute: 'agent_harness mode:"workspace_action" actionId:"memory-vector-doctor"',
    rebuildRoute: 'agent_harness mode:"run_workspace_action" actionId:"memory-vector-rebuild" confirm:true explicitUserRequest:"..."',
  };
}

export async function memoryPostureCatalogStatus(context: CommandContext, reading: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const options = memoryReadingOptions(context, undefined, reading);
  const snapshot = memoryPostureSnapshot(context);
  const doctor = await readMemoryDoctor(context, options);
  const vector = await readVectorStats(context, doctor, options);
  const receiptEvidence = await externalMemoryReceiptEvidence(context, options);
  const liveRecords = await externalMemoryLiveProviderRecords(context, options);
  const status = memoryStatus(snapshot, Boolean(memoryApi(context)));
  const vectorState = vectorStatus(vector);
  const usageSummary = readMemoryUsageSummary(context);
  return {
    modes: ['memory_posture', 'memory_provider'],
    usageTracked: usageSummary?.everInjected ?? 0,
    usageReferenced: usageSummary?.everReferenced ?? 0,
    usageNeverReferenced: usageSummary?.neverReferenced ?? 0,
    modelRoute: 'memory action:"status"',
    status,
    localMemories: snapshot.localMemoryCount,
    reviewQueue: snapshot.localMemoryReviewQueueCount,
    promptActive: snapshot.localMemoryPromptActiveCount,
    // Visible expiry: still stored (counted in localMemories), never deleted,
    // but outside their temporal validity window so not prompt-injected.
    temporallyPending: snapshot.localMemoryTemporallyPendingCount,
    temporallyExpired: snapshot.localMemoryTemporallyExpiredCount,
    vector: vectorState,
    embeddingProviders: doctor?.embeddings.providers.length ?? 0,
    externalProviders: externalMemoryProviderCatalog(liveRecords, receiptEvidence).length,
    externalProviderRecordsPublished: liveRecords.length > 0,
    externalProviderLiveRecordCount: liveRecords.length,
    externalProviderReceiptEvidenceFound: receiptEvidence.length > 0,
    externalProviderReceiptEvidenceCount: receiptEvidence.length,
    externalProviderSetupGuideStatus: aggregateExternalProviderSetupStatus(liveRecords, receiptEvidence),
  };
}

export async function memoryPostureSummary(context: CommandContext, args: AgentHarnessMemoryPostureArgs, reading: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const options = memoryReadingOptions(context, args, reading);
  const includeParameters = args.includeParameters === true;
  const limit = readLimit(args.limit, 100);
  const query = readString(args.query);
  const snapshot = memoryPostureSnapshot(context);
  const { doctor, vector, providers, receiptEvidence, liveRecords } = await buildProviderRecords(context, args, options);
  const status = memoryStatus(snapshot, Boolean(memoryApi(context)));
  const vectorState = vectorStatus(vector);
  const aggregateLiveRecord = aggregateExternalProviderLiveRecord(liveRecords);
  const ranked = query ? await rankHarnessCatalog(providers, query, provider => ({ id: `${provider.kind}:${provider.id}`,
    description: providerSearchText(provider), evidence: provider }), 'agent.memory.providers', { ...options, requirePreservedSource: true }) : undefined;
  if (ranked?.judgments.some(({ reading }) => reading.outcome !== 'act' || reading.verdict === 'uncertain')) throw new ToolInputProjectionError('held');
  assertMemoryCurrent(options);
  const filteredProviders = (ranked ? ranked.matches.map(({ entry }) => entry) : providers).slice(0, limit)
    .map(provider => compactProvider(provider, includeParameters));
  return {
    status,
    localMemory: {
      total: snapshot.localMemoryCount,
      reviewQueue: snapshot.localMemoryReviewQueueCount,
      promptActive: snapshot.localMemoryPromptActiveCount,
      // Visible expiry (temporal validity window): still stored and counted in
      // `total`, never deleted, but outside [validFrom, validUntil) so not
      // prompt-injected, see memoryRecordTemporalStatus.
      temporallyPending: snapshot.localMemoryTemporallyPendingCount,
      temporallyExpired: snapshot.localMemoryTemporallyExpiredCount,
      sessionMemory: snapshot.sessionMemoryCount,
      policy: 'Only reviewed, high-confidence, temporally-active Agent-local memories are prompt-active. Fresh/stale/setup-blocked/pending/expired behavior stays visible for review.',
      routes: {
        list: 'memory action:"list"',
        search: 'memory action:"search" query:"..."',
        reviewQueue: 'memory action:"curator" query:"memory review"',
        create: 'memory action:"create" summary:"..." explicitUserRequest:"..."',
        curator: 'memory action:"curator"',
      },
    },
    usage: buildUsageSection(readMemoryUsageSummary(context)),
    vector: compactVector(vector),
    embeddings: {
      activeProviderId: doctor?.embeddings.activeProviderId ?? vector?.embeddingProviderId ?? snapshot.embeddingProvider,
      warnings: doctor?.embeddings.warnings.map((warning) => previewHarnessText(warning, includeParameters ? 180 : 96)) ?? [],
      syncProviders: doctor?.embeddings.syncProviders ?? [],
      asyncProviders: doctor?.embeddings.asyncProviders ?? [],
    },
    providers: filteredProviders,
    returned: filteredProviders.length,
    totalProviders: providers.length,
    externalMemory: {
      status: aggregateLiveRecord?.status ?? (receiptEvidence.length > 0 ? 'receipt-evidence-found' : 'not-published'),
      providerRecordsPublished: liveRecords.length > 0,
      liveProviderRecordCount: liveRecords.length,
      latestLiveProviderRecords: liveRecords.slice(0, 5),
      receiptEvidenceFound: receiptEvidence.length > 0,
      receiptEvidenceCount: receiptEvidence.length,
      latestReceipts: receiptEvidence.slice(0, 5),
      setupGuideStatus: aggregateExternalProviderSetupStatus(liveRecords, receiptEvidence),
      checkedProviders: externalMemoryProviderCatalog(liveRecords, receiptEvidence).map((provider) => provider.id),
      requiredHostContracts: EXTERNAL_MEMORY_REQUIRED_CONTRACTS,
      contractChecklist: externalProviderContractChecklist({ id: '<provider-id>', label: 'External memory provider' }, receiptEvidence, aggregateLiveRecord),
      receiptContract: externalProviderReceiptContract('<provider-id>', receiptEvidence, aggregateLiveRecord),
      nextRoutes: [
        {
          id: 'inspect-one-provider',
          label: 'Inspect one provider contract',
          modelRoute: 'memory action:"provider" providerId:"<id>" includeParameters:true',
          effect: 'read-only',
          why: 'Shows provider-specific missing SDK/daemon contracts, receipt requirements, credential policy, and next routes.',
        },
        {
          id: 'inspect-host-memory-capability',
          label: 'Inspect host memory capability',
          modelRoute: 'host action:"capability" query:"memory provider"',
          effect: 'read-only',
          why: 'Checks whether the connected host exposes a provider-backed memory capability.',
        },
      ],
      next: liveRecords.length > 0
        ? 'Inspect the matching live provider record before any provider read; keep write, sync, import/export, forget/delete, and prompt-eligibility changes on confirmed routes with durable receipts.'
        : receiptEvidence.length > 0
        ? 'Review the latest external-memory receipt artifact, then keep Agent-local memory as the active prompt path until live provider status/read/write records are published.'
        : 'Use Agent-local memory now. Inspect one external provider for the required SDK/daemon setup/status/read/write/receipt contracts Agent can consume before provider use.',
      inspectRoute: 'host action:"capability" query:"memory provider"',
      providerLookup: 'memory action:"provider" providerId:"<id>" includeParameters:true',
    },
    nextActions: nextActions(snapshot, status, vectorState, doctor),
    policy: 'Memory posture is read-only. Memory edits, vector rebuilds, and embedding-provider changes stay on existing confirmed Agent-local routes.',
    ...(includeParameters ? {
      checkedAt: doctor?.checkedAt ?? null,
      providerLookup: 'memory action:"provider" providerId:"<id>"',
    } : {}),
  };
}

export async function describeMemoryProvider(context: CommandContext, args: AgentHarnessMemoryPostureArgs, reading: CatalogRankingOptions = {}): Promise<MemoryProviderResolution> {
  const options = memoryReadingOptions(context, args, reading);
  const input = readString(args.providerId) || readString(args.target) || readString(args.query);
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: 'memory action:"provider" requires providerId, target, or query. Use memory action:"status" to inspect available provider ids.',
    };
  }
  const includeParameters = args.includeParameters !== false;
  const { providers } = await buildProviderRecords(context, { ...args, includeParameters }, options);
  const exact = providers.find(provider => provider.id === input);
  assertMemoryCurrent(options);
  if (exact) return { status: 'found', provider: compactProvider(exact, true) };
  if (readString(args.providerId)) return { status: 'missing_lookup', usage: `Unknown memory provider ${input}. Use memory action:"status" to inspect available provider ids.` };
  const selected = await selectMemoryProvider(providers, input, options);
  assertMemoryCurrent(options);
  if (selected) return { status: 'found', provider: compactProvider(selected, true) };
  return {
    status: 'missing_lookup',
    usage: `Unknown memory provider ${input}. Use memory action:"status" to inspect available provider ids.`,
  };
}
