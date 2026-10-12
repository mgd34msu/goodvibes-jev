import { types as nodeTypes } from 'node:util';
import { redactText } from '@goodvibes-jev/engine/terminal-shell';
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { assertProjectionCurrent } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogMethods } from './agent-harness-catalog-ranking.ts';
import { captureModelReadModelData, captureModelProviderReadingFacts, MODEL_PROVIDER_READING_FACT_FIELDS, captureModelReadingInput, assertModelReadingInputCurrent, modelReadingServicePath, withModelReadingSource, type ModelReadingOptions } from './agent-harness-model-reading-source.ts';
import { protectPersonalOpsData } from './agent-harness-personal-ops-source.ts';
import { readLocalServingBoolean, readLocalServingStatus, readLocalResourcePressure, readLocalServingSchemaStatus } from './agent-harness-local-model-readings.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { LocalModelDetection, LocalModelEndpointSource, LocalModelServerDefaultEndpoint, LocalModelServerDiagnosticsPublication, LocalModelServerEndpoint, LocalModelServerHealthMap, LocalModelServerServingDiagnostics, MutableLocalModelServerEndpoint } from './agent-harness-model-routing-types.ts';
import { listProviderRegistryProviders, listRegistryModels, modelDisplayName, modelModelId, modelProviderId, modelRegistryKey, readProviderModels } from './agent-harness-model-catalog.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { readLimit, readRecord, readString } from './agent-harness-model-routing-utils.ts';
import { extractUrls, isPrivateOrLocalUrl, localStackFor, modelsUrlFor, normalizeLocalBaseUrl, parseUrlCandidate } from './agent-harness-local-model-url.ts';

export type { LocalModelStack } from './agent-harness-local-model-url.ts';
export { cleanUrlCandidate, extractUrls, isPrivateOrLocalHost, isPrivateOrLocalUrl, localStackFor, modelsUrlFor, normalizeLocalBaseUrl, parseUrlCandidate } from './agent-harness-local-model-url.ts';

export function localProviderNameFor(providerId: string | null, stack: string | null, fallback: string): string {
  const seed = providerId || stack || fallback;
  const normalized = seed.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'local-openai';
}

export function localProviderAddRoute(providerId: string | null, stack: string | null, baseUrl: string): string {
  const name = localProviderNameFor(providerId, stack, 'local-openai');
  return `agent_harness mode:"run_command" command:"/provider add ${name} ${baseUrl} local --yes" confirm:true explicitUserRequest:"Add this local provider after the server is running."`;
}

export function localEndpointId(baseUrl: string): string {
  return `local-${baseUrl.toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

export function localEndpointInspectRoute(endpointId: string): string {
  return `agent_harness mode:"model_route" modelRouteId:"${endpointId}"`;
}

export function localEndpointSmokeRoute(endpointId?: string): string {
  const target = endpointId ? ` modelRouteId:"${endpointId}"` : '';
  return `models action:"smoke"${target} confirm:true explicitUserRequest:"Check local model servers."`;
}

export function localEndpointDiagnostics(endpoint: MutableLocalModelServerEndpoint, providerExists: boolean): NonNullable<LocalModelServerEndpoint['diagnostics']> {
  const stack = endpoint.stack ?? 'OpenAI-compatible';
  return {
    liveProbe: 'not-run',
    successCriteria: [
      'The confirmed smoke command exits 0.',
      'The model-list endpoint returns JSON without credentials in output.',
      'At least one model id is visible before refresh or benchmark.',
    ],
    failureTriage: [
      `If connection is refused, start the ${stack} server and load a model before refreshing Agent models.`,
      'If the endpoint returns 404, verify the base URL path; most OpenAI-compatible servers should use /v1.',
      'If the host is 0.0.0.0 or a LAN address, switch Agent to a trusted client URL such as 127.0.0.1 or the intended private host.',
    ],
    afterSmoke: providerExists
      ? ['Run the refresh route, then run a local benchmark before changing the default route.']
      : ['Add the provider route only after smoke succeeds, then refresh models and run a local benchmark.'],
    policy: 'Diagnostics are read-only criteria and confirmed route hints. Agent probes local model-list endpoints only through models action:"smoke" after explicit confirmation; provider add, refresh, benchmark, and route changes remain separate actions.',
  };
}

interface LocalModelServingReadModelSource {
  readonly path: string;
  readonly source: unknown;
}

interface LocalModelServingDiagnosticRecord extends LocalModelServerServingDiagnostics {
  readonly baseUrl: string | null;
  readonly modelsUrl: string | null;
  readonly providerId: string | null;
  readonly stack: string | null;
}

interface LocalModelServingDiagnosticIndex {
  readonly records: readonly LocalModelServingDiagnosticRecord[];
  readonly publication: Omit<LocalModelServerDiagnosticsPublication, 'matchedEndpointCount'>;
  readonly assertCurrent: () => void;
}

const LOCAL_MODEL_SERVING_READ_MODEL_PATHS = [
  'context.platform.readModels.localModelServers',
  'context.platform.readModels.localModelServing',
  'context.platform.readModels.localModelDiagnostics',
  'context.platform.readModels.models.localServers',
  'context.platform.readModels.models.servingDiagnostics',
  'context.platform.readModels.localModels.servingDiagnostics',
  'context.platform.readModels.ollama.servingDiagnostics',
  'context.platform.readModels.llamaCpp.servingDiagnostics',
  'context.platform.readModels.vllm.servingDiagnostics',
  'context.platform.readModels.localAi.servingDiagnostics',
  'context.platform.readModels.openAiCompatible.servingDiagnostics',
  'context.platform.localModelServing',
  'context.clients.operator.models.servingDiagnostics',
  'context.clients.operator.localModelServingDiagnostics',
] as const;

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function readStringArray(value: unknown): readonly string[] {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((entry) => {
    if (typeof entry === 'string') return entry.trim();
    const record = readRecord(entry);
    return readString(record.id) || readString(record.name) || readString(record.model) || readString(record.modelId);
  }).filter(Boolean))].slice(0, 12);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return '';
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = readNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

async function firstBoolean(record: Record<string, unknown>, keys: readonly string[], options: ModelReadingOptions): Promise<boolean | null> {
  for (const key of keys) {
    const value = await readLocalServingBoolean(record[key], key, record, options);
    if (value !== null) return value;
  }
  return null;
}

function isoFromDiagnosticValue(value: unknown): string | null {
  const timestamp = typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? Date.parse(value)
      : Number.NaN;
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

async function localServingStatus(record: Record<string, unknown>, options: ModelReadingOptions): Promise<LocalModelServerServingDiagnostics['status']> {
  return readLocalServingStatus(firstString(record, ['status', 'healthStatus', 'state', 'result', 'outcome']), record, options);
}

async function localResourcePressure(record: Record<string, unknown>, options: ModelReadingOptions): Promise<LocalModelServerServingDiagnostics['resourcePressure']> {
  const value = firstString(record, ['resourcePressure', 'pressure', 'memoryPressure', 'vramPressure']);
  if (value) return readLocalResourcePressure(value, record, options);
  const usage = firstNumber(record, ['memoryUsagePercent', 'memoryPercent', 'vramUsagePercent', 'gpuMemoryPercent']);
  if (usage !== null) return usage >= 90 ? 'high' : usage >= 70 ? 'moderate' : 'low';
  return 'unknown';
}

async function localResourceSummary(record: Record<string, unknown>, pressure: LocalModelServerServingDiagnostics['resourcePressure'], options: ModelReadingOptions): Promise<string | undefined> {
  const explicit = firstString(record, ['resourceSummary', 'resources', 'resourceDetail']);
  if (explicit) return previewHarnessText(await redactText(explicit, options), 180);
  const parts = [
    firstNumber(record, ['memoryUsagePercent', 'memoryPercent']) !== null ? `memory ${firstNumber(record, ['memoryUsagePercent', 'memoryPercent'])}%` : '',
    firstNumber(record, ['vramUsagePercent', 'gpuMemoryPercent']) !== null ? `vram ${firstNumber(record, ['vramUsagePercent', 'gpuMemoryPercent'])}%` : '',
    firstNumber(record, ['cpuPercent', 'cpuUsagePercent']) !== null ? `cpu ${firstNumber(record, ['cpuPercent', 'cpuUsagePercent'])}%` : '',
  ].filter(Boolean);
  if (parts.length > 0) return `${pressure} pressure; ${parts.join(', ')}.`;
  return undefined;
}

function firstStringFromRecords(records: readonly Record<string, unknown>[], keys: readonly string[]): string {
  for (const record of records) {
    const value = firstString(record, keys);
    if (value) return value;
  }
  return '';
}

async function localServingSchemaStatus(record: Record<string, unknown>, options: ModelReadingOptions): Promise<LocalModelServerServingDiagnostics['schemaStatus']> {
  const records = [record, readRecord(record.schema), readRecord(record.contract), readRecord(record.receipt)];
  const explicit = firstStringFromRecords(records, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus']);
  if (explicit) return await readLocalServingSchemaStatus(explicit, record, options) ? 'certified' : 'legacy';
  const schemaVersion = firstStringFromRecords(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const provenance = firstStringFromRecords(records, ['methodId', 'sourceTool', 'actionId']);
  const publicationGuarantee = firstStringFromRecords(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'servingPublicationGuarantee']);
  return schemaVersion && provenance && publicationGuarantee ? 'certified' : 'legacy';
}

async function routeTextFromDiagnosticValue(value: unknown, options: ModelReadingOptions): Promise<string> {
  const direct = readString(value);
  if (direct) return previewHarnessText(await redactText(direct, options), 260);
  const record = readRecord(value);
  const route = firstString(record, ['route', 'modelRoute', 'operatorRoute', 'methodRoute', 'commandRoute']);
  return route ? previewHarnessText(await redactText(route, options), 260) : '';
}

async function diagnosticRouteFromRecord(record: Record<string, unknown>, keys: readonly string[], options: ModelReadingOptions): Promise<string> {
  for (const key of keys) {
    const route = await routeTextFromDiagnosticValue(record[key], options);
    if (route) return route;
  }
  for (const nestedKey of ['routes', 'actions', 'controls', 'operatorRoutes', 'hostRoutes', 'receiptRoutes']) {
    const nested = readRecord(record[nestedKey]);
    for (const key of keys) {
      const route = await routeTextFromDiagnosticValue(nested[key], options);
      if (route) return route;
    }
  }
  return '';
}

async function diagnosticPublicationGuarantee(record: Record<string, unknown>, options: ModelReadingOptions): Promise<string> {
  const value = firstStringFromRecords(
    [record, readRecord(record.schema), readRecord(record.contract), readRecord(record.receipt)],
    ['publicationGuarantee', 'hostPublicationGuarantee', 'servingPublicationGuarantee'],
  );
  return value ? previewHarnessText(await redactText(value, options), 220) : '';
}

async function localServingProvenance(
  record: Record<string, unknown>,
  startRoute: string,
  repairRoute: string,
  options: ModelReadingOptions,
): Promise<readonly string[]> {
  const explicit = readStringArray(record.provenance);
  const values = [
    ...explicit,
    firstStringFromRecords([record, readRecord(record.receipt)], ['methodId']) ? `method ${firstStringFromRecords([record, readRecord(record.receipt)], ['methodId'])}` : '',
    firstString(record, ['actionId']) ? `action ${firstString(record, ['actionId'])}` : '',
    firstString(record, ['sourceTool']) ? `sourceTool ${firstString(record, ['sourceTool'])}` : '',
    startRoute ? `start ${startRoute}` : '',
    repairRoute ? `repair ${repairRoute}` : '',
  ];
  const redacted = await Promise.all(values.filter(Boolean).map(async (entry) => previewHarnessText(await redactText(entry, options), 220)));
  return [...new Set(redacted.filter(Boolean))].slice(0, 8);
}

function setupServingReadModelSources(context: CommandContext): readonly LocalModelServingReadModelSource[] {
  return LOCAL_MODEL_SERVING_READ_MODEL_PATHS.map(path => ({
    path, source: modelReadingServicePath(context, path.split('.').slice(1)),
  }));
}

function sourceMethods(source: unknown, keys: readonly string[]): () => void {
  if (source === null || source === undefined) return () => {};
  if (typeof source !== 'object' || nodeTypes.isProxy(source)) throw new Error('Unsupported local model source.');
  return captureCatalogMethods(source, keys);
}

const SERVING_SNAPSHOT_METHODS = ['getSnapshot', 'snapshot', 'list', 'listDiagnostics', 'listServingDiagnostics', 'listLocalServers', 'listServers', 'readSnapshot'] as const;
function captureServingSource(context: CommandContext, entry: LocalModelServingReadModelSource): {
  readonly data: unknown; readonly assertCurrent: () => void;
} {
  const source = entry.source;
  if ((typeof source === 'function' || source !== null && typeof source === 'object') && nodeTypes.isProxy(source)) throw new Error('Unsupported local serving source.');
  const methods = typeof source === 'function' ? () => {} : sourceMethods(source, SERVING_SNAPSHOT_METHODS);
  const read = typeof source === 'function' ? source : SERVING_SNAPSHOT_METHODS
    .map(key => modelReadingServicePath(source, [key])).find(method => typeof method === 'function');
  if (typeof read === 'function' && nodeTypes.isProxy(read)) throw new Error('Unsupported local serving snapshot method.');
  const acquire = () => {
    methods();
    const value: unknown = typeof read === 'function' ? Reflect.apply(read, source, []) : source;
    if (nodeTypes.isPromise(value)) {
      void Reflect.apply(Promise.prototype.then, value, [undefined, () => {}]);
      throw new Error('Local serving diagnostics must publish synchronous native snapshots.');
    }
    methods(); return value;
  };
  const original = acquire(), data = captureModelReadModelData(original, false);
  const serialized = JSON.stringify(data);
  const assertCurrent = () => {
    if (modelReadingServicePath(context, entry.path.split('.').slice(1)) !== source) throw new Error('Local serving diagnostic source changed.');
    methods();
    assertModelReadingInputCurrent(captureModelReadModelData(original, false), serialized);
    assertModelReadingInputCurrent(captureModelReadModelData(acquire(), false), serialized);
    methods();
  };
  assertCurrent(); return { data, assertCurrent };
}

function diagnosticEntriesFromSnapshot(snapshot: unknown): readonly unknown[] {
  if (Array.isArray(snapshot)) return snapshot;
  if (snapshot instanceof Map) return [...snapshot.entries()].map(([id, entry]) => {
    const entryRecord = readRecord(entry);
    return Object.keys(entryRecord).length > 0 && !readString(entryRecord.id) ? { ...entryRecord, id } : entry;
  });
  const record = readRecord(snapshot);
  for (const key of ['localModelServers', 'localServers', 'servingDiagnostics', 'diagnostics', 'servers', 'endpoints', 'records', 'items', 'entries']) {
    const value = record[key];
    if (value instanceof Map) return [...value.entries()].map(([id, entry]) => {
      const entryRecord = readRecord(entry);
      return Object.keys(entryRecord).length > 0 && !readString(entryRecord.id) ? { ...entryRecord, id } : entry;
    });
    if (Array.isArray(value)) return value;
    const valueRecord = readRecord(value);
    if (Object.keys(valueRecord).length > 0) {
      return Object.entries(valueRecord).map(([id, entry]) => {
        const entryRecord = readRecord(entry);
        return Object.keys(entryRecord).length > 0 && !readString(entryRecord.id) ? { ...entryRecord, id } : entry;
      });
    }
  }
  return Object.keys(record).length > 0 ? [record] : [];
}

function isLocalServingDiagnosticRecord(record: Record<string, unknown>): boolean {
  const base = firstString(record, ['baseUrl', 'baseURL', 'endpoint', 'url', 'modelsUrl', 'serverUrl']);
  const providerId = firstString(record, ['providerId', 'provider', 'providerName']);
  if (!base && !providerId) return false;
  return Boolean(
    firstString(record, ['serverVersion', 'version', 'resourcePressure', 'status', 'healthStatus', 'startReceiptId', 'repairReceiptId', 'receiptId'])
      || readStringArray(record.loadedModels).length > 0
      || readStringArray(record.models).length > 0
      || firstNumber(record, ['loadedModelCount', 'modelCount', 'contextWindowTokens', 'memoryUsagePercent', 'vramUsagePercent']) !== null,
  );
}

async function normalizeServingDiagnosticRecord(value: unknown, source: string, options: ModelReadingOptions): Promise<LocalModelServingDiagnosticRecord | null> {
  const record = {
    ...readRecord(readRecord(value).metadata),
    ...readRecord(value),
  };
  if (!isLocalServingDiagnosticRecord(record)) return null;
  const stack = await localStackFor(firstString(record, ['stack', 'serverType', 'backend']) || JSON.stringify(record), options, record);
  const rawBaseUrl = firstString(record, ['baseUrl', 'baseURL', 'endpoint', 'url', 'serverUrl']);
  const rawModelsUrl = firstString(record, ['modelsUrl', 'modelListUrl']);
  const baseUrl = rawBaseUrl
    ? normalizeLocalBaseUrl(rawBaseUrl, stack)
    : rawModelsUrl
      ? normalizeLocalBaseUrl(rawModelsUrl, stack)
      : null;
  const modelsUrl = rawModelsUrl
    ? modelsUrlFor(normalizeLocalBaseUrl(rawModelsUrl, stack) ?? rawModelsUrl.replace(/\/models\/?$/i, ''))
    : baseUrl
      ? modelsUrlFor(baseUrl)
      : null;
  const loadedModels = readStringArray(record.loadedModels).length > 0
    ? readStringArray(record.loadedModels)
    : readStringArray(record.models).length > 0
      ? readStringArray(record.models)
      : readStringArray(record.modelIds);
  const loadedModelCount = firstNumber(record, ['loadedModelCount', 'modelCount']) ?? loadedModels.length;
  const status = await localServingStatus(record, options);
  const resourcePressure = await localResourcePressure(record, options);
  const summary = await redactText(firstString(record, ['summary', 'detail', 'message']), options)
    || `${providerIdLabel(firstString(record, ['providerId', 'provider', 'providerName']))} local serving diagnostics are ${status}.`;
  const serverVersion = firstString(record, ['serverVersion', 'version']);
  const contextWindowTokens = firstNumber(record, ['contextWindowTokens', 'contextWindow', 'maxContextTokens']);
  const toolSupport = await firstBoolean(record, ['toolSupport', 'toolCalling', 'supportsTools', 'supportsToolCalling'], options);
  const startReceiptId = firstString(record, ['startReceiptId', 'startupReceiptId']);
  const repairReceiptId = firstString(record, ['repairReceiptId', 'restartReceiptId']);
  const receiptStatus = firstString(record, ['receiptStatus', 'receiptOutcome']);
  const schemaStatus = await localServingSchemaStatus(record, options);
  const schemaVersion = firstStringFromRecords(
    [record, readRecord(record.schema), readRecord(record.contract), readRecord(record.receipt)],
    ['schemaVersion', 'receiptSchemaVersion', 'contractVersion'],
  );
  const publicationGuarantee = await diagnosticPublicationGuarantee(record, options);
  const publisher = firstString(record, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  const startRoute = await diagnosticRouteFromRecord(record, ['startRoute', 'startupRoute', 'startModelServerRoute', 'startServerRoute', 'startActionRoute', 'startCommandRoute'], options);
  const repairRoute = await diagnosticRouteFromRecord(record, ['repairRoute', 'restartRoute', 'restartServerRoute', 'repairModelServerRoute', 'repairActionRoute', 'repairCommandRoute'], options);
  const provenance = await localServingProvenance(record, startRoute, repairRoute, options);
  const resourceSummary = await localResourceSummary(record, resourcePressure, options);
  const missingSignals = [
    ...(schemaStatus === 'certified' ? [] : ['Certified local serving diagnostics schema is not published.']),
    ...(serverVersion ? [] : ['Server version is not published.']),
    ...(loadedModelCount > 0 ? [] : ['Loaded model detail is not published.']),
    ...(contextWindowTokens !== null ? [] : ['Context-window support is not published.']),
    ...(toolSupport !== null ? [] : ['Tool-support capability is not published.']),
    ...(resourcePressure !== 'unknown' ? [] : ['Resource pressure is not published.']),
    ...(startReceiptId || repairReceiptId ? [] : ['Start/repair receipt ids are not published.']),
    ...(startRoute || repairRoute ? [] : ['Host-published start/repair execution routes are not published.']),
  ];
  return {
    status,
    source,
    summary: previewHarnessText(summary, 220),
    schemaStatus,
    ...(schemaVersion ? { schemaVersion: previewHarnessText(await redactText(schemaVersion, options), 80) } : {}),
    ...(provenance.length > 0 ? { provenance } : {}),
    ...(publicationGuarantee ? { publicationGuarantee } : {}),
    ...(publisher ? { publisher: previewHarnessText(await redactText(publisher, options), 80) } : {}),
    ...(serverVersion ? { serverVersion: previewHarnessText(serverVersion, 80) } : {}),
    ...(loadedModelCount > 0 ? { loadedModelCount } : {}),
    loadedModels: loadedModels.map((model) => previewHarnessText(model, 96)),
    ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
    ...(toolSupport !== null ? { toolSupport } : {}),
    resourcePressure,
    ...(resourceSummary ? { resourceSummary } : {}),
    lastCheckedAt: isoFromDiagnosticValue(firstString(record, ['lastCheckedAt', 'checkedAt', 'updatedAt', 'timestamp']) || record.lastCheckedAt || record.checkedAt || record.updatedAt || record.timestamp),
    ...(startReceiptId ? { startReceiptId } : {}),
    ...(repairReceiptId ? { repairReceiptId } : {}),
    ...(receiptStatus ? { receiptStatus } : {}),
    ...(startRoute ? { startRoute } : {}),
    ...(repairRoute ? { repairRoute } : {}),
    inspectRoute: firstString(record, ['inspectRoute', 'modelRoute', 'route']) || 'models action:"local" includeParameters:true',
    missingSignals,
    policy: 'Read-only daemon-published local serving diagnostics. Agent consumes certified version/model/capability/resource/receipt metadata when present, and surfaces start/repair routes only when the host publishes exact confirmed routes; provider edits, refresh, smoke, benchmark, and route changes remain separate visible confirmed actions.',
    baseUrl,
    modelsUrl,
    providerId: firstString(record, ['providerId', 'provider', 'providerName']) || null,
    stack,
  };
}

function providerIdLabel(providerId: string): string {
  return providerId || 'Detected';
}

async function localServingDiagnosticsIndex(context: CommandContext, options: ModelReadingOptions): Promise<LocalModelServingDiagnosticIndex> {
  const optionsCurrent = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const retained: Array<() => void> = [];
  let owner: JudgmentPortCapture | undefined;
  let portCurrent: (() => void) | undefined;
  const sourceCurrent = () => {
    optionsCurrent(); signal?.throwIfAborted();
    if (options.signal !== signal || options.assertCurrent !== callerCurrent) throw new Error('Local serving diagnostic owner changed.');
  };
  const assertSource = () => {
    sourceCurrent();
    assertProjectionCurrent(callerCurrent);
    sourceCurrent();
  };
  options.retainCurrent?.(sourceCurrent, 'agent.local-serving-diagnostics.owner');
  const assertCurrent = () => { assertSource(); for (const guard of retained) guard(); portCurrent?.(); };
  assertCurrent();
  const records: LocalModelServingDiagnosticRecord[] = [];
  const sourcePaths = new Set<string>();
  let sawSource = false;
  let sawError = false;
  const observations: Array<{ readonly entry: LocalModelServingReadModelSource; readonly observation: ReturnType<typeof captureServingSource> }> = [];
  for (const entry of setupServingReadModelSources(context)) {
    if (entry.source === undefined || entry.source === null) continue;
    sawSource = true;
    try {
      const observation = captureServingSource(context, entry);
      retained.push(observation.assertCurrent);
      options.retainCurrent?.(observation.assertCurrent, `agent.local-serving-diagnostics.source:${entry.path}`);
      observations.push({ entry, observation });
    } catch { sawError = true; }
  }
  assertCurrent();
  for (const { entry, observation } of observations) {
    try {
      owner ??= captureJudgmentPort('agent.local-serving-diagnostics', { ...options, assertCurrent: assertSource });
      portCurrent = owner.assertCurrent;
      const reading = { ...options, signal: owner.signal, assertCurrent: () => { owner?.assertCurrent(); assertCurrent(); } };
      const protectedSnapshot = await protectPersonalOpsData(observation.data, reading);
      const sourceRecords = await withModelReadingSource(protectedSnapshot, reading, async (snapshot, scoped) => {
        const normalized: LocalModelServingDiagnosticRecord[] = [];
        for (const value of diagnosticEntriesFromSnapshot(snapshot)) {
          const record = await normalizeServingDiagnosticRecord(value, entry.path, scoped);
          if (record) normalized.push(record);
        }
        scoped.assertCurrent?.(); return normalized;
      });
      assertCurrent();
      if (sourceRecords.length > 0) sourcePaths.add(entry.path);
      records.push(...sourceRecords);
    } catch {
      sawError = true;
    }
  }
  assertCurrent();
  const status = records.length > 0
    ? 'published-read-model'
    : sawError
      ? 'read-model-error'
      : sawSource
        ? 'read-model-empty'
        : 'not-published';
  const missingSignals = records.length > 0
    ? []
    : ['No daemon-published local serving diagnostics read model is available to Agent yet.'];
  if (owner) {
    const restriction = owner.consumeObservation(); portCurrent = restriction.assertCurrent;
    options.retainCurrent?.(restriction.assertCurrent, 'agent.local-serving-diagnostics.port');
  }
  assertCurrent();
  return {
    records,
    assertCurrent,
    publication: {
      status,
      requiredPaths: LOCAL_MODEL_SERVING_READ_MODEL_PATHS,
      sourcePaths: [...sourcePaths],
      recordCount: records.length,
      missingSignals,
      policy: 'Agent reads local serving diagnostics only from SDK/daemon read models. It does not probe local servers until the user confirms models action:"smoke".',
    },
  };
}

function servingDiagnosticForEndpoint(
  records: readonly LocalModelServingDiagnosticRecord[],
  endpoint: MutableLocalModelServerEndpoint,
): LocalModelServingDiagnosticRecord | null {
  return records.find((record) => record.baseUrl === endpoint.baseUrl || record.modelsUrl === modelsUrlFor(endpoint.baseUrl))
    ?? records.find((record) => Boolean(record.providerId && endpoint.providerId && record.providerId === endpoint.providerId))
    ?? null;
}

function localModelInspectionOptions(context: CommandContext, options: ModelReadingOptions): ModelReadingOptions {
  const optionsCurrent = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const assertOptions = () => { optionsCurrent(); signal?.throwIfAborted(); };
  const assertCaller = () => {
    assertOptions();
    assertProjectionCurrent(callerCurrent);
    assertOptions();
  };
  assertCaller();
  const native = captureLocalModelRegistry(context);
  const assertCurrent = () => { assertCaller(); native.assertCurrent(); };
  options.retainCurrent?.(assertOptions, 'agent.local-model.inspection-owner');
  options.retainCurrent?.(native.assertCurrent, 'agent.local-model.inspection-registry');
  assertCurrent(); return { ...options, assertCurrent };
}

export async function localModelServerEndpoints(
  context: CommandContext,
  includeParameters: boolean,
  options: ModelReadingOptions = {},
): Promise<readonly LocalModelServerEndpoint[]> {
  const reading = localModelInspectionOptions(context, options);
  const servingDiagnostics = await localServingDiagnosticsIndex(context, reading);
  const endpoints = (await readLocalServerEndpointCandidates(context, reading)).map((endpoint) => describeLocalServerEndpoint(
    endpoint,
    includeParameters,
    servingDiagnosticForEndpoint(servingDiagnostics.records, endpoint),
  ));
  servingDiagnostics.assertCurrent();
  return endpoints;
}

export function localModelServerDefaults(): readonly LocalModelServerDefaultEndpoint[] {
  const defaults = [
    {
      id: 'ollama',
      label: 'Ollama',
      stack: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      startHint: 'Start Ollama, pull a practical model, then refresh models.',
    },
    {
      id: 'lm-studio',
      label: 'LM Studio',
      stack: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
      startHint: 'Start the LM Studio local server and load one model.',
    },
    {
      id: 'llama-cpp',
      label: 'llama.cpp',
      stack: 'llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      startHint: 'Run llama-server with a GGUF model before adding the provider.',
    },
    {
      id: 'vllm',
      label: 'vLLM',
      stack: 'vllm',
      baseUrl: 'http://127.0.0.1:8000/v1',
      startHint: 'Start the vLLM OpenAI-compatible API server after GPU/driver checks.',
    },
  ] as const;
  return defaults.map((entry) => ({
    ...entry,
    modelsUrl: modelsUrlFor(entry.baseUrl),
    smokeCommand: `curl -fsS ${modelsUrlFor(entry.baseUrl)}`,
    addProviderRoute: localProviderAddRoute(null, entry.stack, entry.baseUrl),
  }));
}

export function localModelDetection(context: CommandContext): LocalModelDetection {
  const endpoints = collectLocalServerEndpointCandidates(context);
  return {
    providerIds: [...new Set(endpoints.flatMap(endpoint => endpoint.providerId ? [endpoint.providerId] : []))].sort(),
    modelRoutes: [...new Set(endpoints.flatMap(endpoint => [...endpoint.modelRoutes]))].sort(),
    stacks: [], // Registry wording is read only by explicit asynchronous inspection.
  };
}

interface LocalModelRegistrySnapshot {
  readonly providers: readonly unknown[];
  readonly models: readonly unknown[];
  readonly providerIds: readonly string[];
  readonly environment: readonly { readonly key: string; readonly value: string; readonly stack: string; readonly note: string }[];
}

const LOCAL_MODEL_ENV_HINTS = [
  { key: 'OLLAMA_BASE_URL', stack: 'ollama', note: 'Environment override for the Ollama base URL.' },
  { key: 'OLLAMA_HOST', stack: 'ollama', note: 'Environment override for the Ollama host.' },
  { key: 'LM_STUDIO_BASE_URL', stack: 'openai-compatible', note: 'Environment override for LM Studio.' },
  { key: 'OPENAI_COMPATIBLE_BASE_URL', stack: 'openai-compatible', note: 'Environment override for a local OpenAI-compatible server.' },
  { key: 'OPENAI_COMPAT_BASE_URL', stack: 'openai-compatible', note: 'Environment override for a local OpenAI-compatible server.' },
  { key: 'VLLM_BASE_URL', stack: 'vllm', note: 'Environment override for vLLM.' },
  { key: 'LLAMA_CPP_BASE_URL', stack: 'llama.cpp', note: 'Environment override for llama.cpp.' },
  { key: 'LITELLM_BASE_URL', stack: 'openai-compatible', note: 'Environment override for LiteLLM or a local gateway.' },
] as const;

export function captureLocalModelRegistry(context: CommandContext): {
  readonly data: LocalModelRegistrySnapshot; readonly assertCurrent: () => void;
} {
  const registry = modelReadingServicePath(context, ['provider', 'providerRegistry']);
  const api = modelReadingServicePath(context, ['clients', 'providerApi']);
  const registryMethods = sourceMethods(registry, ['listProviders', 'listModels']);
  const apiMethods = sourceMethods(api, ['listProviderIds']);
  const providerList = registry == null ? undefined : modelReadingServicePath(registry, ['listProviders']);
  const modelList = registry == null ? undefined : modelReadingServicePath(registry, ['listModels']);
  const providerIdsList = api == null ? undefined : modelReadingServicePath(api, ['listProviderIds']);
  const originalArrays: Array<() => void> = [];
  const acquireList = (method: unknown, receiver: unknown, retain: boolean): readonly unknown[] => {
    registryMethods(); apiMethods();
    if (method === undefined) return [];
    if (typeof method !== 'function' || nodeTypes.isProxy(method)) throw new Error('Local model registry list method unavailable.');
    const result: unknown = Reflect.apply(method, receiver, []);
    registryMethods(); apiMethods();
    if (nodeTypes.isPromise(result)) {
      void Reflect.apply(Promise.prototype.then, result, [undefined, () => {}]);
      throw new Error('Local model registry must publish synchronous native arrays.');
    }
    if (!Array.isArray(result) || nodeTypes.isProxy(result) || Object.getPrototypeOf(result) !== Array.prototype) throw new Error('Local model registry must publish native arrays.');
    const descriptors = Object.getOwnPropertyDescriptors(result), keys = Reflect.ownKeys(result);
    const length: unknown = Object.getOwnPropertyDescriptor(result, 'length')?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 20_000
      || keys.length !== length + 1 || keys.some(key => typeof key !== 'string')) throw new Error('Unsupported complete local model registry array layout.');
    const slots = captureCatalogMethods(result, Object.getOwnPropertyNames(result));
    const assertArray = () => { slots(); if (Reflect.ownKeys(result).length !== keys.length) throw new Error('Local model registry array layout changed.'); };
    assertArray();
    const values: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const field = descriptors[String(index)];
      if (!field || !('value' in field)) throw new Error('Unsupported complete local model registry array layout.');
      values.push(field.value);
    }
    assertArray(); if (retain) originalArrays.push(assertArray);
    return Object.freeze(values);
  };
  const snapshot = (retain = false): LocalModelRegistrySnapshot => {
    const providers = acquireList(providerList, registry, retain), models = acquireList(modelList, registry, retain);
    const providerIds = acquireList(providerIdsList, api, retain);
    if (!providerIds.every((id): id is string => typeof id === 'string')) throw new Error('Invalid local provider ID inventory.');
    return { providers, models, providerIds,
      environment: LOCAL_MODEL_ENV_HINTS.map(hint => ({ ...hint, value: readString(process.env[hint.key]) })) };
  };
  const original = snapshot(true);
  const providers = [...original.providers], models = [...original.models];
  const providerGuards = providers.map(provider => {
    if (provider === null || typeof provider !== 'object' || nodeTypes.isProxy(provider)) throw new Error('Unsupported native provider adapter.');
    const guard = captureCatalogMethods(provider, [...MODEL_PROVIDER_READING_FACT_FIELDS, 'isConfigured']);
    const configured = modelReadingServicePath(provider, ['isConfigured']);
    if (configured !== undefined && typeof configured === 'function' && nodeTypes.isProxy(configured)) throw new Error('Unsupported native provider metadata method.');
    const configuredCall = typeof configured === 'function' ? captureCatalogMethods(configured, ['call']) : () => {};
    if (typeof configured === 'function' && configured.call !== Function.prototype.call) throw new Error('Unsupported native provider metadata invocation.');
    const modelsField = Object.getOwnPropertyDescriptor(provider, 'models');
    return () => {
      guard(); configuredCall();
      const current = Object.getOwnPropertyDescriptor(provider, 'models');
      if ((modelsField === undefined) !== (current === undefined) || modelsField?.value !== current?.value
        || modelsField?.get !== current?.get || modelsField?.set !== current?.set
        || modelsField?.enumerable !== current?.enumerable || modelsField?.configurable !== current?.configurable
        || modelsField?.writable !== current?.writable) throw new Error('Native provider model metadata changed.');
    };
  });
  const metadataSnapshot = (native: LocalModelRegistrySnapshot, initial = true): LocalModelRegistrySnapshot => {
    for (const guard of providerGuards) guard();
    const facts = native.providers.map(provider => captureModelProviderReadingFacts(provider, initial));
    for (const guard of providerGuards) guard();
    return { ...native, providers: facts };
  };
  const data = captureModelReadingInput(metadataSnapshot(original)), serialized = JSON.stringify(data);
  const assertCurrent = () => {
    for (const guard of originalArrays) guard();
    if (modelReadingServicePath(context, ['provider', 'providerRegistry']) !== registry
      || modelReadingServicePath(context, ['clients', 'providerApi']) !== api) throw new Error('Local model registry owner changed.');
    registryMethods(); apiMethods();
    assertModelReadingInputCurrent(metadataSnapshot(original, false), serialized);
    const fresh = snapshot();
    if (fresh.providers.length !== providers.length || fresh.models.length !== models.length
      || fresh.providers.some((provider, index) => provider !== providers[index]) || fresh.models.some((model, index) => model !== models[index])) throw new Error('Local model registration changed.');
    assertModelReadingInputCurrent(metadataSnapshot(fresh, false), serialized);
    registryMethods(); apiMethods();
  };
  assertCurrent(); return { data, assertCurrent };
}

async function readLocalRegistry(context: CommandContext, options: ModelReadingOptions): Promise<{
  readonly detection: LocalModelDetection; readonly endpoints: readonly MutableLocalModelServerEndpoint[];
}> {
  const optionsCurrent = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const assertOptions = () => { optionsCurrent(); signal?.throwIfAborted(); };
  const assertCaller = () => {
    assertOptions();
    assertProjectionCurrent(callerCurrent);
    assertOptions();
  };
  assertCaller();
  const native = captureLocalModelRegistry(context);
  const assertCurrent = () => { assertCaller(); native.assertCurrent(); };
  options.retainCurrent?.(assertOptions, 'agent.local-model.registry-owner');
  options.retainCurrent?.(native.assertCurrent, 'agent.local-model.registry-source');
  return withModelReadingSource(native.data, { ...options, assertCurrent }, async (snapshot, scoped) => {
    const providerIds = new Set<string>(), modelRoutes = new Set<string>(), stacks = new Set<string>();
    const endpoints = new Map<string, MutableLocalModelServerEndpoint>();
    for (const providerId of snapshot.providerIds) {
      const stack = await localStackFor(providerId, scoped, { providerId, providers: snapshot.providers, models: snapshot.models });
      if (stack) { providerIds.add(providerId); stacks.add(stack); }
    }
    for (const provider of snapshot.providers) {
      const record = readRecord(provider);
      const providerId = firstString(record, ['name', 'id', 'providerId', 'provider']);
      const stack = await localStackFor(JSON.stringify(record), scoped, record);
      if (stack) { if (providerId) providerIds.add(providerId); stacks.add(stack); }
      const fields = JSON.stringify(record), routes = readProviderModels(record.models, providerId);
      const urls = [readString(record.baseURL), readString(record.baseUrl), readString(record.endpoint), ...extractUrls(fields)].filter(Boolean);
      for (const baseUrl of urls) addLocalServerEndpoint(endpoints, { baseUrl, providerId: providerId || null, stack,
        source: 'provider-registry', sourceDetail: providerId ? `provider:${providerId}` : 'provider-registry',
        modelRoutes: routes, notes: providerId ? ['Provider already exists in the registry.'] : [] });
    }
    for (const model of snapshot.models) {
      const record = readRecord(model), providerId = modelProviderId(model), registryKey = modelRegistryKey(model);
      const stack = await localStackFor(JSON.stringify(record), scoped, record);
      if (stack) { if (providerId) providerIds.add(providerId); if (registryKey) modelRoutes.add(registryKey); stacks.add(stack); }
      const urls = [readString(record.baseURL), readString(record.baseUrl), readString(record.endpoint), ...extractUrls(readString(record.description))].filter(Boolean);
      for (const baseUrl of urls) addLocalServerEndpoint(endpoints, { baseUrl, providerId: providerId || null, stack,
        source: 'model-registry', sourceDetail: registryKey ? `model:${registryKey}` : 'model-registry', modelRoutes: registryKey ? [registryKey] : [],
        notes: registryKey ? ['At least one model route is already registered for this endpoint.'] : [] });
    }
    for (const hint of snapshot.environment) if (hint.value) {
      addLocalServerEndpoint(endpoints, { baseUrl: hint.value, stack: hint.stack, source: 'environment', sourceDetail: `env:${hint.key}`, notes: [hint.note] });
    }
    scoped.assertCurrent?.();
    return { detection: { providerIds: [...providerIds].sort(), modelRoutes: [...modelRoutes].sort(), stacks: [...stacks].sort() },
      endpoints: [...endpoints.values()].sort((left, right) => left.baseUrl.localeCompare(right.baseUrl)) };
  });
}

export async function readLocalModelDetection(context: CommandContext, options: ModelReadingOptions): Promise<LocalModelDetection> {
  return (await readLocalRegistry(context, options)).detection;
}
export async function readLocalServerEndpointCandidates(context: CommandContext, options: ModelReadingOptions): Promise<readonly MutableLocalModelServerEndpoint[]> {
  return (await readLocalRegistry(context, options)).endpoints;
}

export function addLocalServerEndpoint(
  endpoints: Map<string, MutableLocalModelServerEndpoint>,
  input: {
    readonly baseUrl: string;
    readonly providerId?: string | null;
    readonly stack?: string | null;
    readonly source: LocalModelEndpointSource;
    readonly sourceDetail: string;
    readonly modelRoutes?: readonly string[];
    readonly notes?: readonly string[];
  },
): void {
  const normalized = normalizeLocalBaseUrl(input.baseUrl, input.stack);
  if (!normalized) return;
  const stack = input.stack ?? null;
  const existing = endpoints.get(normalized);
  if (existing) {
    if (!existing.providerId && input.providerId) existing.providerId = input.providerId;
    if (!existing.stack && stack) existing.stack = stack;
    existing.sources.add(input.source);
    existing.sourceDetails.add(input.sourceDetail);
    for (const route of input.modelRoutes ?? []) existing.modelRoutes.add(route);
    for (const note of input.notes ?? []) existing.notes.add(note);
    return;
  }
  endpoints.set(normalized, {
    providerId: input.providerId ?? null,
    stack,
    baseUrl: normalized,
    sources: new Set([input.source]),
    sourceDetails: new Set([input.sourceDetail]),
    modelRoutes: new Set(input.modelRoutes ?? []),
    notes: new Set(input.notes ?? []),
  });
}

export function collectLocalServerEndpointCandidates(context: CommandContext): readonly MutableLocalModelServerEndpoint[] {
  const endpoints = new Map<string, MutableLocalModelServerEndpoint>();
  for (const provider of listProviderRegistryProviders(context)) {
    const record = readRecord(provider);
    const providerId = readString(record.name) || readString(record.id) || readString(record.providerId) || readString(record.provider);
    const fields = [
      providerId,
      readString(record.label),
      readString(record.displayName),
      readString(record.description),
      readString(record.baseURL),
      readString(record.baseUrl),
      readString(record.endpoint),
      JSON.stringify(record.serviceNames ?? ''),
      JSON.stringify(record.envVars ?? ''),
    ].join('\n');
    const stack = null;
    const routes = readProviderModels(record.models, providerId);
    const urls = [
      readString(record.baseURL),
      readString(record.baseUrl),
      readString(record.endpoint),
      ...extractUrls(fields),
    ].filter(Boolean);
    for (const baseUrl of urls) {
      addLocalServerEndpoint(endpoints, {
        baseUrl,
        providerId: providerId || null,
        stack,
        source: 'provider-registry',
        sourceDetail: providerId ? `provider:${providerId}` : 'provider-registry',
        modelRoutes: routes,
        notes: providerId ? ['Provider already exists in the registry.'] : [],
      });
    }
  }

  for (const model of listRegistryModels(context)) {
    const record = readRecord(model);
    const providerId = modelProviderId(model);
    const registryKey = modelRegistryKey(model);
    const fields = [
      providerId,
      registryKey,
      modelModelId(model),
      modelDisplayName(model),
      readString(record.description),
      readString(record.baseURL),
      readString(record.baseUrl),
      readString(record.serverType),
      JSON.stringify(record.providerEnvVars ?? ''),
    ].join('\n');
    const stack = null;
    const urls = [
      readString(record.baseURL),
      readString(record.baseUrl),
      readString(record.endpoint),
      ...extractUrls(readString(record.description)),
    ].filter(Boolean);
    for (const baseUrl of urls) {
      addLocalServerEndpoint(endpoints, {
        baseUrl,
        providerId: providerId || null,
        stack,
        source: 'model-registry',
        sourceDetail: registryKey ? `model:${registryKey}` : 'model-registry',
        modelRoutes: registryKey ? [registryKey] : [],
        notes: registryKey ? ['At least one model route is already registered for this endpoint.'] : [],
      });
    }
  }

  for (const hint of LOCAL_MODEL_ENV_HINTS) {
    const value = readString(process.env[hint.key]);
    if (!value) continue;
    addLocalServerEndpoint(endpoints, {
      baseUrl: value,
      stack: hint.stack,
      source: 'environment',
      sourceDetail: `env:${hint.key}`,
      notes: [hint.note],
    });
  }

  return [...endpoints.values()].sort((left, right) => left.baseUrl.localeCompare(right.baseUrl));
}

export function describeLocalServerEndpoint(
  endpoint: MutableLocalModelServerEndpoint,
  includeParameters = false,
  servingDiagnostics?: LocalModelServerServingDiagnostics | null,
): LocalModelServerEndpoint {
  const modelsUrl = modelsUrlFor(endpoint.baseUrl);
  const providerExists = Boolean(endpoint.providerId) || endpoint.modelRoutes.size > 0;
  const notes = new Set(endpoint.notes);
  if (endpoint.baseUrl.includes('0.0.0.0')) {
    notes.add('0.0.0.0 is usually a listen address; prefer 127.0.0.1 or a trusted LAN host for the client provider URL.');
  }
  if (!providerExists) {
    notes.add('No registered model route was found for this endpoint yet.');
  }
  const id = localEndpointId(endpoint.baseUrl);
  return {
    kind: 'local-server-endpoint',
    id,
    providerId: endpoint.providerId,
    stack: endpoint.stack,
    baseUrl: endpoint.baseUrl,
    modelsUrl,
    diagnosticStatus: providerExists ? 'registered-route-needs-smoke' : 'needs-provider-after-smoke',
    inspectRoute: localEndpointInspectRoute(id),
    sources: [...endpoint.sources].sort((a, b) => a.localeCompare(b)),
    sourceDetails: [...endpoint.sourceDetails].sort((a, b) => a.localeCompare(b)),
    modelRoutes: [...endpoint.modelRoutes].sort((a, b) => a.localeCompare(b)),
    smokeCommand: `curl -fsS ${modelsUrl}`,
    smokeRoute: localEndpointSmokeRoute(id),
    refreshRoute: 'agent_harness mode:"run_command" command:"/refresh-models" confirm:true explicitUserRequest:"Refresh models after verifying the local server."',
    addProviderRoute: providerExists ? null : localProviderAddRoute(endpoint.providerId, endpoint.stack, endpoint.baseUrl),
    notes: [...notes],
    ...(servingDiagnostics ? { servingDiagnostics } : {}),
    ...(includeParameters ? { diagnostics: localEndpointDiagnostics(endpoint, providerExists) } : {}),
  };
}

export async function localModelServerHealthMap(
  context: CommandContext,
  includeParameters: boolean,
  options: ModelReadingOptions = {},
): Promise<LocalModelServerHealthMap> {
  const reading = localModelInspectionOptions(context, options);
  const servingDiagnostics = await localServingDiagnosticsIndex(context, reading);
  const rawEndpoints = await readLocalServerEndpointCandidates(context, reading);
  const matchedEndpointCount = rawEndpoints
    .filter((endpoint) => Boolean(servingDiagnosticForEndpoint(servingDiagnostics.records, endpoint)))
    .length;
  const endpoints = rawEndpoints.map((endpoint) => describeLocalServerEndpoint(
    endpoint,
    includeParameters,
    servingDiagnosticForEndpoint(servingDiagnostics.records, endpoint),
  ));
  const facts = localModelEndpointFacts(endpoints, includeParameters);
  const hasMatchedDiagnostics = matchedEndpointCount > 0;
  servingDiagnostics.assertCurrent();
  return {
    ...facts,
    daemonDiagnostics: {
      ...servingDiagnostics.publication,
      matchedEndpointCount,
      missingSignals: hasMatchedDiagnostics ? [] : servingDiagnostics.publication.missingSignals,
    },
    nextActions: [
      ...(hasMatchedDiagnostics ? ['Review published local serving diagnostics before smoke, refresh, benchmark, or provider changes.'] : []),
      ...facts.nextActions,
    ],
    policy: 'Read-only local endpoint map with canonical redacted daemon-published serving diagnostics. Probes, installs, downloads, provider edits, refresh, benchmarks, and route changes remain confirmed actions.',
  };
}

/** Startup snapshots contain registry facts and static hints; daemon prose is read only by explicit inspection. */
export function localModelServerFacts(context: CommandContext, includeParameters: boolean): Omit<LocalModelServerHealthMap, 'daemonDiagnostics'> {
  return localModelEndpointFacts(collectLocalServerEndpointCandidates(context)
    .map(endpoint => describeLocalServerEndpoint(endpoint, includeParameters)), includeParameters);
}

function localModelEndpointFacts(endpoints: readonly LocalModelServerEndpoint[], includeParameters: boolean): Omit<LocalModelServerHealthMap, 'daemonDiagnostics'> {
  const returned = endpoints.slice(0, includeParameters ? 8 : 3);
  const suggestedDefaults = localModelServerDefaults().slice(0, includeParameters ? 4 : 2);
  const first = returned[0];
  return {
    status: endpoints.length > 0 ? 'candidate-endpoints' : 'no-local-endpoints',
    liveProbe: 'not-run',
    endpointCount: endpoints.length,
    returnedEndpoints: returned.length,
    endpoints: returned,
    suggestedDefaults,
    nextActions: endpoints.length > 0
      ? [
        `Smoke test ${first?.modelsUrl ?? 'the detected model-list endpoint'} before benchmark or route changes.`,
        'Refresh the model catalog after the local server is running and reachable.',
        'Run the local benchmark comparison before making a local route the default.',
      ]
      : [
        'Start one local server from suggestedDefaults, then smoke test its model-list endpoint.',
        'Add or select the provider route only after the server is reachable.',
        'Refresh models and run the local benchmark before changing the default route.',
      ],
    policy: 'Read-only local endpoint facts from registry and environment metadata. Serving diagnostics are deferred until explicit inspection. Probes, installs, downloads, provider edits, refresh, benchmarks, and route changes remain confirmed actions.',
  };
}
