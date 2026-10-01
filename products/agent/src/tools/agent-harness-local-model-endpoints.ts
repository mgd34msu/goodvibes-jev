import type { CommandContext } from '../input/command-registry.ts';
import type { LocalModelDetection, LocalModelEndpointSource, LocalModelServerDefaultEndpoint, LocalModelServerDiagnosticsPublication, LocalModelServerEndpoint, LocalModelServerHealthMap, LocalModelServerServingDiagnostics, MutableLocalModelServerEndpoint } from './agent-harness-model-routing-types.ts';
import { listProviderIds, listProviderRegistryProviders, listRegistryModels, modelDisplayName, modelModelId, modelProviderId, modelRegistryKey, readProviderModels } from './agent-harness-model-catalog.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { readLimit, readRecord, readString } from './agent-harness-model-routing-utils.ts';
import { extractUrls, isPrivateOrLocalUrl, localStackFor, modelsUrlFor, normalizeLocalBaseUrl, parseUrlCandidate } from './agent-harness-local-model-url.ts';

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

const LOCAL_MODEL_SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/("?\b(?:api[-_]?key|apikey|token|secret|password|passwd|credential|authorization)\b"?\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"<redacted>"'],
  [/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1=<redacted>'],
  [/(\b(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1<redacted>'],
  [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>'],
];

function redactLocalModelDiagnosticText(value: string): string {
  return LOCAL_MODEL_SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'supported', 'enabled'].includes(normalized)) return true;
    if (['false', 'no', '0', 'unsupported', 'disabled'].includes(normalized)) return false;
  }
  return null;
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

function firstBoolean(record: Record<string, unknown>, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = readBoolean(record[key]);
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

function localServingStatus(record: Record<string, unknown>, loadedModelCount: number): LocalModelServerServingDiagnostics['status'] {
  const value = firstString(record, ['status', 'healthStatus', 'state', 'result', 'outcome']).toLowerCase().replace(/[_\s]+/g, '-');
  if (['ready', 'ok', 'healthy', 'running', 'online', 'passed', 'success', 'succeeded', 'available'].includes(value)) return 'ready';
  if (['blocked', 'missing', 'unavailable', 'unreachable', 'offline', 'not-running', 'needs-setup'].includes(value)) return 'blocked';
  if (['degraded', 'attention', 'warning', 'slow', 'resource-pressure', 'limited'].includes(value)) return 'attention';
  if (loadedModelCount > 0) return 'ready';
  return 'unknown';
}

function localResourcePressure(record: Record<string, unknown>): LocalModelServerServingDiagnostics['resourcePressure'] {
  const value = firstString(record, ['resourcePressure', 'pressure', 'memoryPressure', 'vramPressure']).toLowerCase().replace(/[_\s]+/g, '-');
  if (['low', 'ok', 'normal', 'healthy'].includes(value)) return 'low';
  if (['moderate', 'medium', 'warning', 'attention'].includes(value)) return 'moderate';
  if (['high', 'critical', 'exhausted', 'oom'].includes(value)) return 'high';
  const usage = firstNumber(record, ['memoryUsagePercent', 'memoryPercent', 'vramUsagePercent', 'gpuMemoryPercent']);
  if (usage !== null) return usage >= 90 ? 'high' : usage >= 70 ? 'moderate' : 'low';
  return 'unknown';
}

function localResourceSummary(record: Record<string, unknown>, pressure: LocalModelServerServingDiagnostics['resourcePressure']): string | undefined {
  const explicit = firstString(record, ['resourceSummary', 'resources', 'resourceDetail']);
  if (explicit) return redactLocalModelDiagnosticText(previewHarnessText(explicit, 180));
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

function localServingSchemaStatus(record: Record<string, unknown>): LocalModelServerServingDiagnostics['schemaStatus'] {
  const records = [record, readRecord(record.schema), readRecord(record.contract), readRecord(record.receipt)];
  const explicit = firstStringFromRecords(records, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus']).toLowerCase().replace(/[_\s]+/g, '-');
  if (['certified', 'valid', 'verified', 'schema-certified'].includes(explicit)) return 'certified';
  const schemaVersion = firstStringFromRecords(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const provenance = firstStringFromRecords(records, ['methodId', 'sourceTool', 'actionId']);
  const publicationGuarantee = firstStringFromRecords(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'servingPublicationGuarantee']);
  return schemaVersion && provenance && publicationGuarantee ? 'certified' : 'legacy';
}

function routeTextFromDiagnosticValue(value: unknown): string {
  const direct = readString(value);
  if (direct) return previewHarnessText(redactLocalModelDiagnosticText(direct), 260);
  const record = readRecord(value);
  const route = firstString(record, ['route', 'modelRoute', 'operatorRoute', 'methodRoute', 'commandRoute']);
  return route ? previewHarnessText(redactLocalModelDiagnosticText(route), 260) : '';
}

function diagnosticRouteFromRecord(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const route = routeTextFromDiagnosticValue(record[key]);
    if (route) return route;
  }
  for (const nestedKey of ['routes', 'actions', 'controls', 'operatorRoutes', 'hostRoutes', 'receiptRoutes']) {
    const nested = readRecord(record[nestedKey]);
    for (const key of keys) {
      const route = routeTextFromDiagnosticValue(nested[key]);
      if (route) return route;
    }
  }
  return '';
}

function diagnosticPublicationGuarantee(record: Record<string, unknown>): string {
  const value = firstStringFromRecords(
    [record, readRecord(record.schema), readRecord(record.contract), readRecord(record.receipt)],
    ['publicationGuarantee', 'hostPublicationGuarantee', 'servingPublicationGuarantee'],
  );
  return value ? previewHarnessText(redactLocalModelDiagnosticText(value), 220) : '';
}

function localServingProvenance(
  record: Record<string, unknown>,
  startRoute: string,
  repairRoute: string,
): readonly string[] {
  const explicit = readStringArray(record.provenance);
  const values = [
    ...explicit,
    firstStringFromRecords([record, readRecord(record.receipt)], ['methodId']) ? `method ${firstStringFromRecords([record, readRecord(record.receipt)], ['methodId'])}` : '',
    firstString(record, ['actionId']) ? `action ${firstString(record, ['actionId'])}` : '',
    firstString(record, ['sourceTool']) ? `sourceTool ${firstString(record, ['sourceTool'])}` : '',
    startRoute ? `start ${startRoute}` : '',
    repairRoute ? `repair ${repairRoute}` : '',
  ];
  return [...new Set(values
    .map((entry) => previewHarnessText(redactLocalModelDiagnosticText(entry), 220))
    .filter(Boolean))]
    .slice(0, 8);
}

function setupServingReadModelSources(context: CommandContext): readonly LocalModelServingReadModelSource[] {
  const contextRecord = context as unknown as Record<string, unknown>;
  const platform = readRecord(contextRecord.platform);
  const clients = readRecord(contextRecord.clients);
  const readModels = readRecord(platform.readModels);
  const modelReadModels = readRecord(readModels.models);
  const localModels = readRecord(readModels.localModels);
  const ollama = readRecord(readModels.ollama);
  const llamaCpp = readRecord(readModels.llamaCpp);
  const vllm = readRecord(readModels.vllm);
  const localAi = readRecord(readModels.localAi);
  const openAiCompatible = readRecord(readModels.openAiCompatible);
  const operator = readRecord(clients.operator);
  const operatorModels = readRecord(operator.models);
  return [
    { path: 'context.platform.readModels.localModelServers', source: readModels.localModelServers },
    { path: 'context.platform.readModels.localModelServing', source: readModels.localModelServing },
    { path: 'context.platform.readModels.localModelDiagnostics', source: readModels.localModelDiagnostics },
    { path: 'context.platform.readModels.models.localServers', source: modelReadModels.localServers },
    { path: 'context.platform.readModels.models.servingDiagnostics', source: modelReadModels.servingDiagnostics },
    { path: 'context.platform.readModels.localModels.servingDiagnostics', source: localModels.servingDiagnostics },
    { path: 'context.platform.readModels.ollama.servingDiagnostics', source: ollama.servingDiagnostics },
    { path: 'context.platform.readModels.llamaCpp.servingDiagnostics', source: llamaCpp.servingDiagnostics },
    { path: 'context.platform.readModels.vllm.servingDiagnostics', source: vllm.servingDiagnostics },
    { path: 'context.platform.readModels.localAi.servingDiagnostics', source: localAi.servingDiagnostics },
    { path: 'context.platform.readModels.openAiCompatible.servingDiagnostics', source: openAiCompatible.servingDiagnostics },
    { path: 'context.platform.localModelServing', source: platform.localModelServing },
    { path: 'context.clients.operator.models.servingDiagnostics', source: operatorModels.servingDiagnostics },
    { path: 'context.clients.operator.localModelServingDiagnostics', source: operator.localModelServingDiagnostics },
  ];
}

function readServingSnapshot(source: unknown): unknown {
  if (typeof source === 'function') {
    const value = (source as () => unknown)();
    return value instanceof Promise ? null : value;
  }
  const record = readRecord(source);
  for (const methodName of ['getSnapshot', 'snapshot', 'list', 'listDiagnostics', 'listServingDiagnostics', 'listLocalServers', 'listServers', 'readSnapshot']) {
    const method = record[methodName];
    if (typeof method === 'function') {
      const value = (method as () => unknown)();
      return value instanceof Promise ? null : value;
    }
  }
  return source;
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

function normalizeServingDiagnosticRecord(value: unknown, source: string): LocalModelServingDiagnosticRecord | null {
  const record = {
    ...readRecord(readRecord(value).metadata),
    ...readRecord(value),
  };
  if (!isLocalServingDiagnosticRecord(record)) return null;
  const stack = firstString(record, ['stack', 'serverType', 'backend']) || localStackFor(JSON.stringify(record)) || null;
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
  const status = localServingStatus(record, loadedModelCount);
  const resourcePressure = localResourcePressure(record);
  const summary = redactLocalModelDiagnosticText(firstString(record, ['summary', 'detail', 'message']))
    || `${providerIdLabel(firstString(record, ['providerId', 'provider', 'providerName']))} local serving diagnostics are ${status}.`;
  const serverVersion = firstString(record, ['serverVersion', 'version']);
  const contextWindowTokens = firstNumber(record, ['contextWindowTokens', 'contextWindow', 'maxContextTokens']);
  const toolSupport = firstBoolean(record, ['toolSupport', 'toolCalling', 'supportsTools', 'supportsToolCalling']);
  const startReceiptId = firstString(record, ['startReceiptId', 'startupReceiptId']);
  const repairReceiptId = firstString(record, ['repairReceiptId', 'restartReceiptId']);
  const receiptStatus = firstString(record, ['receiptStatus', 'receiptOutcome']);
  const schemaStatus = localServingSchemaStatus(record);
  const schemaVersion = firstStringFromRecords(
    [record, readRecord(record.schema), readRecord(record.contract), readRecord(record.receipt)],
    ['schemaVersion', 'receiptSchemaVersion', 'contractVersion'],
  );
  const publicationGuarantee = diagnosticPublicationGuarantee(record);
  const publisher = firstString(record, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  const startRoute = diagnosticRouteFromRecord(record, ['startRoute', 'startupRoute', 'startModelServerRoute', 'startServerRoute', 'startActionRoute', 'startCommandRoute']);
  const repairRoute = diagnosticRouteFromRecord(record, ['repairRoute', 'restartRoute', 'restartServerRoute', 'repairModelServerRoute', 'repairActionRoute', 'repairCommandRoute']);
  const provenance = localServingProvenance(record, startRoute, repairRoute);
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
    ...(schemaVersion ? { schemaVersion: previewHarnessText(redactLocalModelDiagnosticText(schemaVersion), 80) } : {}),
    ...(provenance.length > 0 ? { provenance } : {}),
    ...(publicationGuarantee ? { publicationGuarantee } : {}),
    ...(publisher ? { publisher: previewHarnessText(redactLocalModelDiagnosticText(publisher), 80) } : {}),
    ...(serverVersion ? { serverVersion: previewHarnessText(serverVersion, 80) } : {}),
    ...(loadedModelCount > 0 ? { loadedModelCount } : {}),
    loadedModels: loadedModels.map((model) => previewHarnessText(model, 96)),
    ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
    ...(toolSupport !== null ? { toolSupport } : {}),
    resourcePressure,
    ...(localResourceSummary(record, resourcePressure) ? { resourceSummary: localResourceSummary(record, resourcePressure) } : {}),
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

function localServingDiagnosticsIndex(context: CommandContext): LocalModelServingDiagnosticIndex {
  const records: LocalModelServingDiagnosticRecord[] = [];
  const sourcePaths = new Set<string>();
  let sawSource = false;
  let sawError = false;
  for (const entry of setupServingReadModelSources(context)) {
    if (entry.source === undefined || entry.source === null) continue;
    sawSource = true;
    try {
      const sourceRecords = diagnosticEntriesFromSnapshot(readServingSnapshot(entry.source))
        .flatMap((value) => {
          const record = normalizeServingDiagnosticRecord(value, entry.path);
          return record ? [record] : [];
        });
      if (sourceRecords.length > 0) sourcePaths.add(entry.path);
      records.push(...sourceRecords);
    } catch {
      sawError = true;
    }
  }
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
  return {
    records,
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

export function localModelServerEndpoints(
  context: CommandContext,
  includeParameters: boolean,
): readonly LocalModelServerEndpoint[] {
  const servingDiagnostics = localServingDiagnosticsIndex(context);
  return collectLocalServerEndpointCandidates(context).map((endpoint) => describeLocalServerEndpoint(
    endpoint,
    includeParameters,
    servingDiagnosticForEndpoint(servingDiagnostics.records, endpoint),
  ));
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
  const providerIds = new Set<string>();
  const modelRoutes = new Set<string>();
  const stacks = new Set<string>();
  for (const providerId of listProviderIds(context)) {
    const stack = localStackFor(providerId);
    if (!stack) continue;
    providerIds.add(providerId);
    stacks.add(stack);
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
    const stack = localStackFor(fields);
    if (!stack) continue;
    if (providerId) providerIds.add(providerId);
    if (registryKey) modelRoutes.add(registryKey);
    stacks.add(stack);
  }
  return {
    providerIds: [...providerIds].sort((a, b) => a.localeCompare(b)),
    modelRoutes: [...modelRoutes].sort((a, b) => a.localeCompare(b)),
    stacks: [...stacks].sort((a, b) => a.localeCompare(b)),
  };
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
  const stack = input.stack ?? localStackFor(input.baseUrl) ?? localStackFor(`${input.providerId ?? ''}\n${input.sourceDetail}`) ?? 'openai-compatible';
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
    const stack = localStackFor(fields);
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
        stack: stack ?? localStackFor(baseUrl),
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
    const stack = localStackFor(fields);
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
        stack: stack ?? localStackFor(baseUrl),
        source: 'model-registry',
        sourceDetail: registryKey ? `model:${registryKey}` : 'model-registry',
        modelRoutes: registryKey ? [registryKey] : [],
        notes: registryKey ? ['At least one model route is already registered for this endpoint.'] : [],
      });
    }
  }

  const envHints: readonly { readonly key: string; readonly stack: string; readonly note: string }[] = [
    { key: 'OLLAMA_BASE_URL', stack: 'ollama', note: 'Environment override for the Ollama base URL.' },
    { key: 'OLLAMA_HOST', stack: 'ollama', note: 'Environment override for the Ollama host.' },
    { key: 'LM_STUDIO_BASE_URL', stack: 'openai-compatible', note: 'Environment override for LM Studio.' },
    { key: 'OPENAI_COMPATIBLE_BASE_URL', stack: 'openai-compatible', note: 'Environment override for a local OpenAI-compatible server.' },
    { key: 'OPENAI_COMPAT_BASE_URL', stack: 'openai-compatible', note: 'Environment override for a local OpenAI-compatible server.' },
    { key: 'VLLM_BASE_URL', stack: 'vllm', note: 'Environment override for vLLM.' },
    { key: 'LLAMA_CPP_BASE_URL', stack: 'llama.cpp', note: 'Environment override for llama.cpp.' },
    { key: 'LITELLM_BASE_URL', stack: 'openai-compatible', note: 'Environment override for LiteLLM or a local gateway.' },
  ];
  for (const hint of envHints) {
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

export function localModelServerHealthMap(
  context: CommandContext,
  includeParameters: boolean,
): LocalModelServerHealthMap {
  const servingDiagnostics = localServingDiagnosticsIndex(context);
  const rawEndpoints = collectLocalServerEndpointCandidates(context);
  const matchedEndpointCount = rawEndpoints
    .filter((endpoint) => Boolean(servingDiagnosticForEndpoint(servingDiagnostics.records, endpoint)))
    .length;
  const endpoints = rawEndpoints.map((endpoint) => describeLocalServerEndpoint(
    endpoint,
    includeParameters,
    servingDiagnosticForEndpoint(servingDiagnostics.records, endpoint),
  ));
  const returned = endpoints.slice(0, includeParameters ? 8 : 3);
  const suggestedDefaults = localModelServerDefaults().slice(0, includeParameters ? 4 : 2);
  const first = returned[0];
  const hasMatchedDiagnostics = matchedEndpointCount > 0;
  return {
    status: endpoints.length > 0 ? 'candidate-endpoints' : 'no-local-endpoints',
    liveProbe: 'not-run',
    endpointCount: endpoints.length,
    returnedEndpoints: returned.length,
    endpoints: returned,
    suggestedDefaults,
    daemonDiagnostics: {
      ...servingDiagnostics.publication,
      matchedEndpointCount,
      missingSignals: hasMatchedDiagnostics ? [] : servingDiagnostics.publication.missingSignals,
    },
    nextActions: endpoints.length > 0
      ? [
        ...(hasMatchedDiagnostics ? ['Review published local serving diagnostics before smoke, refresh, benchmark, or provider changes.'] : []),
        `Smoke test ${first?.modelsUrl ?? 'the detected model-list endpoint'} before benchmark or route changes.`,
        'Refresh the model catalog after the local server is running and reachable.',
        'Run the local benchmark comparison before making a local route the default.',
      ]
      : [
        'Start one local server from suggestedDefaults, then smoke test its model-list endpoint.',
        'Add or select the provider route only after the server is reachable.',
        'Refresh models and run the local benchmark before changing the default route.',
      ],
    policy: 'Read-only local endpoint map. It derives candidate model-list URLs, smoke commands, confirmed route hints, and daemon-published serving diagnostics from registry/env/read-model metadata; it does not probe the network, install servers, download models, add providers, refresh models, benchmark, or change routes.',
  };
}
