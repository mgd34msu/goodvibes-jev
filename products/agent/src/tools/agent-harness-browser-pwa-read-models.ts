import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface BrowserPwaRecordCertification {
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

export interface BrowserPwaCategoryRouteRecord {
  readonly id: string;
  readonly categoryId: string;
  readonly categoryIds: readonly string[];
  readonly laneId: string | null;
  readonly label: string | null;
  readonly status: string;
  readonly summary: string | null;
  readonly route: string;
  readonly url: string | null;
  readonly mobileReady: boolean;
  readonly pwaReady: boolean;
  readonly capabilities: readonly string[];
  readonly controlRoutes: Readonly<Record<string, string>>;
  readonly modelRoute: string;
  readonly sourcePath: string;
  readonly source: 'daemon-read-model' | 'sdk-read-model';
  readonly certification: BrowserPwaRecordCertification;
}

export interface BrowserPwaFirstRunReceiptRecord {
  readonly id: string;
  readonly status: string;
  readonly summary: string | null;
  readonly url: string | null;
  readonly manifestStatus: string | null;
  readonly serviceWorkerStatus: string | null;
  readonly installStatus: string | null;
  readonly offlineStatus: string | null;
  readonly capabilities: readonly string[];
  readonly controlRoutes: Readonly<Record<string, string>>;
  readonly modelRoute: string;
  readonly sourcePath: string;
  readonly source: 'daemon-read-model' | 'sdk-read-model';
  readonly certification: BrowserPwaRecordCertification;
}

export interface BrowserPwaReadModelSnapshot {
  readonly categoryRoutes: readonly BrowserPwaCategoryRouteRecord[];
  readonly firstRunReceipts: readonly BrowserPwaFirstRunReceiptRecord[];
  readonly sourceCounts: Readonly<Record<string, number>>;
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

const CATEGORY_WRAPPER_KEYS = [
  'records',
  'items',
  'categoryRoutes',
  'workspaceRoutes',
  'agentWorkspaceRoutes',
  'browserRoutes',
  'mobileRoutes',
  'surfaces',
  'lanes',
  'categories',
] as const;

const RECEIPT_WRAPPER_KEYS = [
  'records',
  'items',
  'receipts',
  'firstRunReceipts',
  'runtimeReceipts',
  'completionReceipts',
  'pwaReceipts',
  'events',
  'eventStream',
] as const;

const SNAPSHOT_METHODS = ['getSnapshot', 'snapshot', 'toJSON'] as const;
const CATEGORY_METHODS = ['listCategoryRoutes', 'listWorkspaceRoutes', 'listAgentWorkspaceRoutes', 'listRoutes', 'list'] as const;
const RECEIPT_METHODS = ['listFirstRunReceipts', 'listReceipts', 'listRuntimeReceipts', 'listEvents', 'list'] as const;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return readObject(record.metadata);
}

function nestedString(record: Record<string, unknown>, key: string): string {
  return readString(record[key])
    || readString(readMetadata(record)[key])
    || readString(readObject(record.route)[key])
    || readString(readObject(record.workspace)[key])
    || readString(readObject(record.category)[key])
    || readString(readObject(record.lane)[key])
    || readString(readObject(record.pwa)[key])
    || readString(readObject(record.browser)[key])
    || readString(readObject(record.evidence)[key])
    || readString(readObject(record.receipt)[key]);
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
  if (Array.isArray(value)) return [...new Set(value.map((entry) => readString(entry)).filter(Boolean))].slice(0, 80);
  const text = readString(value);
  return text ? text.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 80) : [];
}

function redactText(value: string): string {
  return value
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/\b(token|secret|password|api[_-]?key|authorization|credential)\s*[:=]\s*[^,\s;/]+/gi, '$1=<redacted>');
}

function safePreview(value: string, limit: number): string {
  return previewHarnessText(redactText(value), limit);
}

function safeNullablePreview(value: string, limit: number): string | null {
  return value ? safePreview(value, limit) : null;
}

function safeUrl(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|authorization|credential|api[-_]?key/i.test(key)) url.searchParams.set(key, '<redacted>');
    }
    return previewHarnessText(url.toString(), 180);
  } catch {
    return safeNullablePreview(value, 180);
  }
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function readyStatus(value: string): boolean {
  const status = normalizeToken(value);
  return [
    'ready',
    'published',
    'complete',
    'completed',
    'ok',
    'success',
    'succeeded',
    'active',
    'available',
    'usable',
    'online',
    'healthy',
    'browser-native-ready',
    'mobile-ready',
    'pwa-ready',
  ].includes(status);
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const token = normalizeToken(value);
    if (['true', 'yes', '1', 'ready', 'available', 'enabled', 'mobile-ready', 'pwa-ready', 'responsive'].includes(token)) return true;
    if (['false', 'no', '0', 'missing', 'disabled', 'not-ready', 'setup-needed', 'blocked'].includes(token)) return false;
  }
  return null;
}

function certificationBase(record: Record<string, unknown>, sourcePath: string): {
  readonly records: readonly Record<string, unknown>[];
  readonly schemaStatus: BrowserPwaRecordCertification['schemaStatus'];
  readonly schemaVersion: string;
  readonly publicationGuarantee: string;
  readonly publisher: string;
  readonly receiptId: string;
  readonly cursor: string;
  readonly provenance: readonly string[];
} {
  const records = certificationRecords(record);
  const explicit = firstAcross(records, ['schemaStatus', 'receiptSchemaStatus', 'certificationStatus']).toLowerCase().replace(/[_\s]+/g, '-');
  const schemaStatus = ['certified', 'valid', 'verified', 'schema-certified'].includes(explicit)
    || (
      firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion'])
      && firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'browserPwaPublicationGuarantee', 'routePublicationGuarantee', 'firstRunPublicationGuarantee'])
      && firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId'])
    )
    ? 'certified'
    : 'legacy';
  const schemaVersion = firstAcross(records, ['schemaVersion', 'receiptSchemaVersion', 'contractVersion']);
  const publicationGuarantee = firstAcross(records, ['publicationGuarantee', 'hostPublicationGuarantee', 'browserPwaPublicationGuarantee', 'routePublicationGuarantee', 'firstRunPublicationGuarantee']);
  const publisher = firstAcross(records, ['publisher', 'publisherId', 'daemonId', 'hostId']);
  const receiptId = firstAcross(records, ['receiptId', 'routeReceiptId', 'categoryRouteReceiptId', 'firstRunReceiptId', 'durableReceiptId', 'eventId']);
  const cursor = firstAcross(records, ['cursor', 'freshnessCursor', 'eventCursor', 'sequence', 'checkpoint', 'streamCursor']);
  const provenance = [...new Set([
    ...stringArray(record.provenance),
    sourcePath ? `source ${sourcePath}` : '',
    firstAcross(records, ['methodId']) ? `method ${firstAcross(records, ['methodId'])}` : '',
    firstAcross(records, ['actionId']) ? `action ${firstAcross(records, ['actionId'])}` : '',
    firstAcross(records, ['sourceTool']) ? `sourceTool ${firstAcross(records, ['sourceTool'])}` : '',
  ].map((entry) => safePreview(entry, 180)).filter(Boolean))].slice(0, 8);
  return {
    records,
    schemaStatus,
    schemaVersion,
    publicationGuarantee,
    publisher,
    receiptId,
    cursor,
    provenance,
  };
}

function certification(input: {
  readonly record: Record<string, unknown>;
  readonly sourcePath: string;
  readonly kind: 'browser-native workspace category route' | 'browser/PWA first-run receipt';
  readonly durableId: string;
  readonly status: string;
  readonly modelRoute: string;
  readonly hasRoute: boolean;
  readonly hasCategories?: boolean;
  readonly hasMobileEvidence?: boolean;
  readonly hasPwaEvidence?: boolean;
}): BrowserPwaRecordCertification {
  const base = certificationBase(input.record, input.sourcePath);
  const missingSignals = [
    ...(base.schemaStatus === 'certified' ? [] : [`Certified ${input.kind} schema is not published.`]),
    ...(input.durableId ? [] : [`Durable ${input.kind} id is not published.`]),
    ...(input.status ? [] : [`${input.kind} status is not published.`]),
    ...(readyStatus(input.status) ? [] : [`${input.kind} status is not ready.`]),
    ...(base.publicationGuarantee ? [] : [`${input.kind} publication guarantee is not published.`]),
    ...(base.publisher ? [] : [`${input.kind} publisher is not published.`]),
    ...(base.provenance.length > 0 ? [] : [`${input.kind} provenance is not published.`]),
    ...(base.cursor ? [] : [`${input.kind} freshness cursor is not published.`]),
    ...(input.modelRoute && input.hasRoute ? [] : [`Exact ${input.kind} inspect/open route is not published.`]),
    ...(input.hasCategories === false ? ['Browser-native Agent workspace category ids are not published.'] : []),
    ...(input.hasMobileEvidence === false ? ['Mobile/touch control evidence is not published for this browser-native route.'] : []),
    ...(input.hasPwaEvidence === false ? ['PWA runtime evidence such as manifest, service-worker, install, or offline status is not published.'] : []),
  ];
  return {
    schemaStatus: base.schemaStatus,
    ...(base.schemaVersion ? { schemaVersion: safePreview(base.schemaVersion, 80) } : {}),
    ...(base.publicationGuarantee ? { publicationGuarantee: safePreview(base.publicationGuarantee, 220) } : {}),
    ...(base.publisher ? { publisher: safePreview(base.publisher, 80) } : {}),
    ...(base.provenance.length > 0 ? { provenance: base.provenance } : {}),
    ...(base.receiptId ? { receiptId: safePreview(base.receiptId, 96) } : {}),
    ...(base.cursor ? { cursor: safePreview(base.cursor, 96) } : {}),
    missingSignals,
    policy: 'Browser/PWA read models certify release readiness only when the SDK or daemon publishes schema, durable ids, ready status, publication guarantee, publisher/provenance, freshness cursor, exact inspect/open routes, mobile/touch evidence, PWA runtime evidence where relevant, and redacted receipt metadata.',
  };
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
    return source.flatMap((entry, index) => collectFromSource(entry, `${path}[${index}]`, kind, wrapperKeys, methods, visited));
  }
  if (source instanceof Map) {
    return Array.from(source.entries()).flatMap(([key, value]) => collectFromSource(value, `${path}.${String(key)}`, kind, wrapperKeys, methods, visited));
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

function routeMap(record: Record<string, unknown>): Readonly<Record<string, string>> {
  const routes = { ...readObject(record.routes), ...readObject(record.controls) };
  const output: Record<string, string> = {};
  for (const key of ['inspect', 'open', 'chat', 'setup', 'approve', 'approvals', 'automations', 'memory', 'channels', 'install', 'manifest', 'serviceWorker', 'offline', 'finish']) {
    const value = readString(routes[key]) || nestedString(record, `${key}Route`);
    if (value) output[key] = safePreview(value, 180);
  }
  return output;
}

function routeForRecord(record: Record<string, unknown>, routes: Readonly<Record<string, string>>): string {
  return nestedString(record, 'browserRoute')
    || nestedString(record, 'openRoute')
    || nestedString(record, 'route')
    || routes.open
    || routes.inspect
    || '';
}

function modelRoute(record: Record<string, unknown>, fallback: string): string {
  return nestedString(record, 'modelRoute')
    || nestedString(record, 'inspectRoute')
    || nestedString(record, 'browserRoute')
    || nestedString(record, 'openRoute')
    || nestedString(record, 'route')
    || fallback;
}

function capabilityTokens(record: Record<string, unknown>): readonly string[] {
  return [...new Set([
    ...stringArray(record.capabilities),
    ...stringArray(record.features),
    ...stringArray(readObject(record.pwa).capabilities),
    ...stringArray(readObject(record.browser).capabilities),
    ...stringArray(readObject(record.evidence).capabilities),
  ].map((entry) => safePreview(entry, 80)).filter(Boolean))].slice(0, 24);
}

function categoryIds(record: Record<string, unknown>, index: number): readonly string[] {
  const ids = [
    ...stringArray(record.categoryIds),
    ...stringArray(readObject(record.route).categoryIds),
    ...stringArray(readObject(record.workspace).categoryIds),
    nestedString(record, 'categoryId'),
    nestedString(record, 'workspaceCategoryId'),
  ].map((entry) => entry.trim()).filter(Boolean);
  return [...new Set(ids.length > 0 ? ids : [`browser-category-${index}`])].slice(0, 80);
}

function evidenceBoolean(record: Record<string, unknown>, keys: readonly string[], terms: readonly string[]): boolean {
  for (const key of keys) {
    const value = readBoolean(record[key])
      ?? readBoolean(readMetadata(record)[key])
      ?? readBoolean(readObject(record.pwa)[key])
      ?? readBoolean(readObject(record.browser)[key])
      ?? readBoolean(readObject(record.evidence)[key]);
    if (value !== null) return value;
  }
  const haystack = [
    ...capabilityTokens(record),
    nestedString(record, 'summary'),
    nestedString(record, 'label'),
    nestedString(record, 'status'),
  ].join('\n').toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function normalizeCategoryRoute(entry: CollectedRecord, index: number): BrowserPwaCategoryRouteRecord | null {
  const ids = categoryIds(entry.record, index);
  const categoryId = ids[0] ?? `browser-category-${index}`;
  const id = nestedString(entry.record, 'id')
    || nestedString(entry.record, 'routeId')
    || nestedString(entry.record, 'receiptId')
    || `browser-category-route:${categoryId}:${index}`;
  const routes = routeMap(entry.record);
  const route = routeForRecord(entry.record, routes);
  const status = nestedString(entry.record, 'status') || nestedString(entry.record, 'state') || 'unknown';
  const routeForModel = modelRoute(entry.record, `computer action:"browser" categoryId:"${categoryId}" includeParameters:true`);
  const capabilities = capabilityTokens(entry.record);
  const mobileReady = evidenceBoolean(entry.record, ['mobileReady', 'touchReady', 'responsive', 'mobileStatus'], ['mobile', 'touch', 'responsive']);
  const pwaReady = evidenceBoolean(entry.record, ['pwaReady', 'installReady', 'offlineReady', 'pwaStatus'], ['pwa', 'install', 'offline', 'service worker', 'manifest']);
  return {
    id,
    categoryId,
    categoryIds: ids,
    laneId: safeNullablePreview(nestedString(entry.record, 'laneId'), 80),
    label: safeNullablePreview(nestedString(entry.record, 'label') || nestedString(entry.record, 'title'), 120),
    status,
    summary: safeNullablePreview(nestedString(entry.record, 'summary') || nestedString(entry.record, 'detail'), 220),
    route: route ? safePreview(route, 180) : routeForModel,
    url: safeUrl(nestedString(entry.record, 'url') || nestedString(entry.record, 'browserUrl')),
    mobileReady,
    pwaReady,
    capabilities,
    controlRoutes: routes,
    modelRoute: routeForModel,
    sourcePath: entry.path,
    source: entry.kind,
    certification: certification({
      record: entry.record,
      sourcePath: entry.path,
      kind: 'browser-native workspace category route',
      durableId: id,
      status,
      modelRoute: routeForModel,
      hasRoute: Boolean(route || Object.keys(routes).length > 0),
      hasCategories: ids.length > 0,
      hasMobileEvidence: mobileReady || Object.keys(routes).length > 0,
    }),
  };
}

function normalizeFirstRunReceipt(entry: CollectedRecord, index: number): BrowserPwaFirstRunReceiptRecord | null {
  const id = nestedString(entry.record, 'id')
    || nestedString(entry.record, 'receiptId')
    || nestedString(entry.record, 'firstRunReceiptId')
    || nestedString(entry.record, 'durableReceiptId')
    || nestedString(entry.record, 'eventId')
    || `browser-pwa-first-run:${index}`;
  const routes = routeMap(entry.record);
  const status = nestedString(entry.record, 'status')
    || nestedString(entry.record, 'state')
    || nestedString(entry.record, 'receiptStatus')
    || nestedString(entry.record, 'result')
    || nestedString(entry.record, 'outcome')
    || 'unknown';
  const routeForModel = modelRoute(entry.record, 'computer action:"browser" includeParameters:true');
  const capabilities = capabilityTokens(entry.record);
  const manifestStatus = safeNullablePreview(nestedString(entry.record, 'manifestStatus'), 80);
  const serviceWorkerStatus = safeNullablePreview(nestedString(entry.record, 'serviceWorkerStatus'), 80);
  const installStatus = safeNullablePreview(nestedString(entry.record, 'installStatus'), 80);
  const offlineStatus = safeNullablePreview(nestedString(entry.record, 'offlineStatus'), 80);
  const hasPwaEvidence = Boolean(manifestStatus || serviceWorkerStatus || installStatus || offlineStatus)
    || evidenceBoolean(entry.record, ['pwaReady', 'manifestReady', 'serviceWorkerReady', 'offlineReady', 'installReady'], ['pwa', 'manifest', 'service worker', 'offline', 'install']);
  return {
    id,
    status,
    summary: safeNullablePreview(nestedString(entry.record, 'summary') || nestedString(entry.record, 'detail'), 220),
    url: safeUrl(nestedString(entry.record, 'url') || nestedString(entry.record, 'browserUrl') || nestedString(entry.record, 'pwaUrl')),
    manifestStatus,
    serviceWorkerStatus,
    installStatus,
    offlineStatus,
    capabilities,
    controlRoutes: routes,
    modelRoute: routeForModel,
    sourcePath: entry.path,
    source: entry.kind,
    certification: certification({
      record: entry.record,
      sourcePath: entry.path,
      kind: 'browser/PWA first-run receipt',
      durableId: id,
      status,
      modelRoute: routeForModel,
      hasRoute: Boolean(Object.keys(routes).length > 0 || routeForModel),
      hasPwaEvidence,
    }),
  };
}

function dedupeById<T extends { readonly id: string }>(records: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    output.push(record);
  }
  return output;
}

function sourceCounts(entries: readonly CollectedRecord[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.path] = (counts[entry.path] ?? 0) + 1;
  return counts;
}

function categorySources(context: CommandContext): readonly SourceCandidate[] {
  const platform = readObject(context.platform);
  const readModels = readObject(platform.readModels);
  const browserPwa = readObject(readModels.browserPwa);
  const webDashboard = readObject(readModels.webDashboard);
  const browserCockpit = readObject(readModels.browserCockpit);
  const pwa = readObject(readModels.pwa);
  const browser = readObject(readModels.browser);
  const opsBrowserPwa = readObject(readObject(context.ops).browserPwa);
  const clients = readObject(context.clients);
  const operator = readObject(clients.operator);
  const operatorSdk = readObject(clients.operatorSdk);
  return [
    { path: 'context.platform.readModels.browserPwa.categoryRoutes', source: browserPwa.categoryRoutes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserPwa.workspaceRoutes', source: browserPwa.workspaceRoutes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserPwa.agentWorkspaceRoutes', source: browserPwa.agentWorkspaceRoutes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.webDashboard.categoryRoutes', source: webDashboard.categoryRoutes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.webDashboard.workspaceRoutes', source: webDashboard.workspaceRoutes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserCockpit.categoryRoutes', source: browserCockpit.categoryRoutes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.pwa.workspaceRoutes', source: pwa.workspaceRoutes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browser.categoryRoutes', source: browser.categoryRoutes, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserPwaRoutes', source: readModels.browserPwaRoutes, kind: 'daemon-read-model' },
    { path: 'context.ops.browserPwa.categoryRoutes', source: opsBrowserPwa.categoryRoutes, kind: 'sdk-read-model' },
    { path: 'context.clients.operator.browserPwa.categoryRoutes', source: readObject(operator.browserPwa).categoryRoutes, kind: 'sdk-read-model' },
    { path: 'context.clients.operatorSdk.browserPwa.categoryRoutes', source: readObject(operatorSdk.browserPwa).categoryRoutes, kind: 'sdk-read-model' },
  ];
}

function receiptSources(context: CommandContext): readonly SourceCandidate[] {
  const platform = readObject(context.platform);
  const readModels = readObject(platform.readModels);
  const browserPwa = readObject(readModels.browserPwa);
  const webDashboard = readObject(readModels.webDashboard);
  const browserCockpit = readObject(readModels.browserCockpit);
  const pwa = readObject(readModels.pwa);
  const firstRun = readObject(readModels.firstRun);
  const opsBrowserPwa = readObject(readObject(context.ops).browserPwa);
  const clients = readObject(context.clients);
  const operator = readObject(clients.operator);
  const operatorSdk = readObject(clients.operatorSdk);
  return [
    { path: 'context.platform.readModels.browserPwa.firstRunReceipts', source: browserPwa.firstRunReceipts, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserPwa.receipts', source: browserPwa.receipts, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserPwa.runtimeReceipts', source: browserPwa.runtimeReceipts, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.webDashboard.firstRunReceipts', source: webDashboard.firstRunReceipts, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.browserCockpit.firstRunReceipts', source: browserCockpit.firstRunReceipts, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.pwa.firstRunReceipts', source: pwa.firstRunReceipts, kind: 'daemon-read-model' },
    { path: 'context.platform.readModels.firstRun.browserPwaReceipts', source: firstRun.browserPwaReceipts, kind: 'daemon-read-model' },
    { path: 'context.ops.browserPwa.firstRunReceipts', source: opsBrowserPwa.firstRunReceipts, kind: 'sdk-read-model' },
    { path: 'context.clients.operator.browserPwa.firstRunReceipts', source: readObject(operator.browserPwa).firstRunReceipts, kind: 'sdk-read-model' },
    { path: 'context.clients.operatorSdk.browserPwa.firstRunReceipts', source: readObject(operatorSdk.browserPwa).firstRunReceipts, kind: 'sdk-read-model' },
  ];
}

export function isCertifiedBrowserPwaCategoryRoute(record: BrowserPwaCategoryRouteRecord): boolean {
  return record.certification.schemaStatus === 'certified' && record.certification.missingSignals.length === 0;
}

export function isCertifiedBrowserPwaFirstRunReceipt(record: BrowserPwaFirstRunReceiptRecord): boolean {
  return record.certification.schemaStatus === 'certified' && record.certification.missingSignals.length === 0;
}

export function browserPwaRouteCoversCategory(record: BrowserPwaCategoryRouteRecord, categoryId: string): boolean {
  const expected = categoryId.toLowerCase();
  return record.categoryIds.some((id) => {
    const value = id.toLowerCase();
    return value === expected || value === '*' || value === 'all' || value === 'agent-workspace';
  });
}

export function certifiedBrowserPwaCategoryRouteForCategory(
  snapshot: BrowserPwaReadModelSnapshot,
  categoryId: string,
): BrowserPwaCategoryRouteRecord | null {
  return snapshot.categoryRoutes.find((record) => isCertifiedBrowserPwaCategoryRoute(record) && browserPwaRouteCoversCategory(record, categoryId)) ?? null;
}

export function certifiedBrowserPwaFirstRunReceipts(
  snapshot: BrowserPwaReadModelSnapshot,
): readonly BrowserPwaFirstRunReceiptRecord[] {
  return snapshot.firstRunReceipts.filter(isCertifiedBrowserPwaFirstRunReceipt);
}

export function browserPwaReadModelSnapshot(context: CommandContext): BrowserPwaReadModelSnapshot {
  const categoryEntries = categorySources(context).flatMap((candidate) =>
    collectFromSource(candidate.source, candidate.path, candidate.kind, CATEGORY_WRAPPER_KEYS, CATEGORY_METHODS)
  );
  const receiptEntries = receiptSources(context).flatMap((candidate) =>
    collectFromSource(candidate.source, candidate.path, candidate.kind, RECEIPT_WRAPPER_KEYS, RECEIPT_METHODS)
  );
  return {
    categoryRoutes: dedupeById(categoryEntries.map(normalizeCategoryRoute).filter((entry): entry is BrowserPwaCategoryRouteRecord => entry !== null)),
    firstRunReceipts: dedupeById(receiptEntries.map(normalizeFirstRunReceipt).filter((entry): entry is BrowserPwaFirstRunReceiptRecord => entry !== null)),
    sourceCounts: {
      ...sourceCounts(categoryEntries),
      ...sourceCounts(receiptEntries),
    },
  };
}
