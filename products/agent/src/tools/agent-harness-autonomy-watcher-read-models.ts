import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { readRecord, readString } from './agent-harness-model-routing-utils.ts';
import { captureCatalogData, captureCatalogMethods, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import { assertPersonalOpsDataCurrent, capturePersonalOpsData, protectPersonalOpsData } from './agent-harness-personal-ops-source.ts';
import { readPersonalOpsReceiptStatus } from './agent-harness-personal-ops-readings.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { types as nodeTypes } from 'node:util';
import { safeRecordIdPart } from './agent-harness-personal-ops-records.ts';
import type { AutonomyQueueLiveRecord, AutonomyQueueRecordControl, AutonomyQueueRecordOutput } from './agent-harness-autonomy-queue-types.ts';
import { captureNativeReadModelObservation } from './agent-harness-autonomy-live-records.ts';

type WatcherReadModelLane = 'watcher-run' | 'provider-source' | 'native-watcher';
type WatcherReadModelSourceKind = 'daemon-read-model' | 'sdk-read-model';

interface WatcherReadModelSource {
  readonly path: string;
  readonly source: unknown;
  readonly kind: WatcherReadModelSourceKind;
  readonly lane: WatcherReadModelLane;
}

interface CollectedWatcherRecord {
  readonly path: string;
  readonly kind: WatcherReadModelSourceKind;
  readonly lane: WatcherReadModelLane;
  readonly record: Record<string, unknown>;
}

const SNAPSHOT_METHODS = ['getSnapshot', 'snapshot'] as const;
const RUN_METHODS = ['listRuns', 'listRunHistory', 'listWatcherRuns', 'listAutomationRuns', 'listReceipts', 'listEvents', 'list'] as const;
const SOURCE_METHODS = ['listSources', 'listProviderSources', 'listWatcherSources', 'listWatchers', 'listSubscriptions', 'list'] as const;

const RUN_WRAPPER_KEYS = [
  'records',
  'items',
  'runs',
  'runHistory',
  'history',
  'watcherRuns',
  'automationRuns',
  'watcherRunHistory',
  'events',
  'receipts',
] as const;

const SOURCE_WRAPPER_KEYS = [
  'records',
  'items',
  'sources',
  'sourceRecords',
  'providerSources',
  'watcherSources',
  'watchers',
  'subscriptions',
  'accounts',
  'mailboxes',
] as const;

const RUN_READ_KEYS = ['readRoute', 'inspectRoute', 'reviewRoute', 'watcherRunRoute', 'runRoute', 'modelRoute'];
const RUN_OUTPUT_KEYS = ['outputRoute', 'logsRoute', 'tailRoute', 'chunkRoute', 'streamRoute', 'outputStreamRoute'];
const RUN_CANCEL_KEYS = ['cancelRoute', 'stopRoute', 'abortRoute'];
const RUN_RETRY_KEYS = ['retryRoute', 'rerunRoute', 'replayRoute', 'recoveryRoute'];
const RUN_CHECKPOINT_KEYS = ['checkpointRoute', 'saveCheckpointRoute'];
const RUN_PAUSE_KEYS = ['pauseRoute'];
const RUN_RESUME_KEYS = ['resumeRoute'];
const SOURCE_READ_KEYS = ['readRoute', 'inspectRoute', 'reviewRoute', 'sourceRoute', 'watcherRoute', 'modelRoute'];
const SOURCE_REFRESH_KEYS = ['refreshRoute', 'syncRoute', 'pollRoute', 'readNowRoute'];

const WATCHER_SOURCES = [
  { path: 'context.platform.readModels.watchers.runs', kind: 'daemon-read-model', lane: 'watcher-run' },
  { path: 'context.platform.readModels.watchers.runHistory', kind: 'daemon-read-model', lane: 'watcher-run' },
  { path: 'context.platform.readModels.watchers.watcherRuns', kind: 'daemon-read-model', lane: 'watcher-run' },
  { path: 'context.platform.readModels.watcherRuns', kind: 'daemon-read-model', lane: 'watcher-run' },
  { path: 'context.platform.readModels.watcherRunHistory', kind: 'daemon-read-model', lane: 'watcher-run' },
  { path: 'context.platform.readModels.automation.watcherRuns', kind: 'daemon-read-model', lane: 'watcher-run' },
  { path: 'context.platform.readModels.automation.runHistory', kind: 'daemon-read-model', lane: 'watcher-run' },
  { path: 'context.platform.readModels.gmail.watcherRuns', kind: 'daemon-read-model', lane: 'watcher-run' },
  { path: 'context.platform.readModels.email.watcherRuns', kind: 'daemon-read-model', lane: 'watcher-run' },
  { path: 'context.clients.operator.watchers.runs', kind: 'sdk-read-model', lane: 'watcher-run' },
  { path: 'context.clients.operator.watchers.runHistory', kind: 'sdk-read-model', lane: 'watcher-run' },
  { path: 'context.clients.operator.automation.watcherRuns', kind: 'sdk-read-model', lane: 'watcher-run' },
  { path: 'context.platform.readModels.watchers.sources', kind: 'daemon-read-model', lane: 'provider-source' },
  { path: 'context.platform.readModels.watchers.providerSources', kind: 'daemon-read-model', lane: 'provider-source' },
  { path: 'context.platform.readModels.watcherSources', kind: 'daemon-read-model', lane: 'provider-source' },
  { path: 'context.platform.readModels.providerSources', kind: 'daemon-read-model', lane: 'provider-source' },
  { path: 'context.platform.readModels.providers.sources', kind: 'daemon-read-model', lane: 'provider-source' },
  { path: 'context.platform.readModels.gmail.sources', kind: 'daemon-read-model', lane: 'provider-source' },
  { path: 'context.platform.readModels.gmail.providerSources', kind: 'daemon-read-model', lane: 'provider-source' },
  { path: 'context.platform.readModels.gmail.watchers', kind: 'daemon-read-model', lane: 'provider-source' },
  { path: 'context.platform.readModels.email.sources', kind: 'daemon-read-model', lane: 'provider-source' },
  { path: 'context.platform.readModels.email.providerSources', kind: 'daemon-read-model', lane: 'provider-source' },
  { path: 'context.platform.readModels.email.watchers', kind: 'daemon-read-model', lane: 'provider-source' },
  { path: 'context.clients.operator.watchers.sources', kind: 'sdk-read-model', lane: 'provider-source' },
  { path: 'context.clients.operator.gmail.sources', kind: 'sdk-read-model', lane: 'provider-source' },
  { path: 'context.clients.operator.email.sources', kind: 'sdk-read-model', lane: 'provider-source' },
] as const;

function watcherSources(context: CommandContext): readonly WatcherReadModelSource[] {
  return WATCHER_SOURCES.map(entry => ({ ...entry, source: modelReadingServicePath(context, entry.path.split('.').slice(1)) }));
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  const containers = [
    record,
    readRecord(record.metadata),
    readRecord(record.evidence),
    readRecord(record.source),
    readRecord(record.providerSource),
    readRecord(record.provider),
    readRecord(record.watcher),
    readRecord(record.run),
    readRecord(record.event),
    readRecord(record.route),
    readRecord(record.routes),
  ];
  for (const container of containers) {
    for (const key of keys) {
      const value = readString(container[key]);
      if (value) return value;
    }
  }
  return '';
}

function readBoolean(record: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key] ?? readRecord(record.metadata)[key] ?? readRecord(record.source)[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
  }
  return undefined;
}

function readStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return [...new Set(value.map((entry) => readString(entry)).filter(Boolean))].slice(0, 12);
  const text = readString(value);
  return text ? text.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 12) : [];
}

// These functions consume complete, already protected producer DTOs.
function compactUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/\s+/g, ' ').trim();
}

function safePreview(value: string, limit: number): string {
  return previewHarnessText(value, limit);
}

function readIso(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const text = readString(value);
  if (!text) return '';
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : safePreview(text, 80);
}

function readRoute(value: unknown): string {
  const direct = readString(value);
  if (direct) return direct;
  const route = readRecord(value);
  return firstString(route, ['modelRoute', 'route', 'command', 'action', 'href']);
}

function routeFromKeys(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const route = readRoute(record[key]);
    if (route) return route;
  }
  for (const containerKey of ['routes', 'effectRoutes', 'actions', 'controls']) {
    const routes = readRecord(record[containerKey]);
    for (const key of keys) {
      const route = readRoute(routes[key]);
      if (route) return route;
    }
  }
  return '';
}

/** Literal automation-run grammar and published boolean source state are native facts. */
function nativeStatus(record: Record<string, unknown>, lane: WatcherReadModelLane): string {
  if (lane === 'native-watcher') {
    switch (record.state) {
      case 'stopped': case 'starting': case 'running': case 'degraded': case 'failed': return record.state;
      default: return 'unknown';
    }
  }
  const status = record.status;
  if (lane === 'watcher-run') {
    switch (status) {
      case 'queued': case 'running': case 'failed': case 'cancelled': return status;
      case 'completed': return 'succeeded';
      case 'missed': return 'blocked';
    }
  } else {
    const enabled = record.enabled;
    if (typeof enabled === 'boolean') return enabled ? 'ready' : 'blocked';
  }
  return 'unknown';
}

function collectFromSource(source: unknown, path: string, kind: WatcherReadModelSourceKind,
  lane: WatcherReadModelLane, guards: (() => void)[], visited = new WeakSet<object>()): readonly CollectedWatcherRecord[] {
  if (source === undefined || source === null) return [];
  if (typeof source !== 'object' || nodeTypes.isProxy(source)) throw new ToolInputProjectionError('invalid');
  if (visited.has(source)) throw new ToolInputProjectionError('invalid');
  visited.add(source);
  try {
    if (Array.isArray(source)) return captureCatalogData(source).flatMap((entry, index) => collectFromSource(entry, `${path}[${index}]`, kind, lane, guards, visited));
    if (Object.getPrototypeOf(source) === Map.prototype) {
      if (Reflect.ownKeys(source).length) throw new ToolInputProjectionError('invalid');
      const records: CollectedWatcherRecord[] = [];
      for (const [key, value] of Map.prototype.entries.call(source) as IterableIterator<[unknown, unknown]>) {
        if (typeof key !== 'string') throw new ToolInputProjectionError('invalid');
        records.push(...collectFromSource(value, `${path}.${key}`, kind, lane, guards, visited));
      }
      return records;
    }
    const methodNames = [...SNAPSHOT_METHODS, ...(lane === 'watcher-run' ? RUN_METHODS : SOURCE_METHODS)];
    const wrapperKeys = lane === 'watcher-run' ? RUN_WRAPPER_KEYS : SOURCE_WRAPPER_KEYS;
    const methodsCurrent = captureCatalogMethods(source, [...methodNames, ...wrapperKeys]);
    guards.push(methodsCurrent);
    const records: CollectedWatcherRecord[] = [];
    let materialized = false;
    for (const name of methodNames) {
      const method = modelReadingServicePath(source, [name]);
      if (typeof method !== 'function') continue;
      materialized = true;
      methodsCurrent(); const snapshot: unknown = method.call(source); methodsCurrent();
      if (snapshot instanceof Promise) throw new ToolInputProjectionError('held');
      if (snapshot !== undefined) records.push(...collectFromSource(snapshot, `${path}.${name}()`, kind, lane, guards, visited));
    }
    for (const key of wrapperKeys) {
      const value = modelReadingServicePath(source, [key]);
      if (value !== undefined) { materialized = true; records.push(...collectFromSource(value, `${path}.${key}`, kind, lane, guards, visited)); }
    }
    if (materialized) return records;
    const captured = captureCatalogData(source);
    const record = readRecord(captured);
    const identityKeys = lane === 'watcher-run'
      ? ['runId', 'watcherRunId', 'automationRunId', 'jobRunId', 'eventId', 'id', 'status', 'outcome']
      : ['sourceId', 'providerSourceId', 'watcherId', 'subscriptionId', 'accountId', 'id', 'scope', 'filter'];
    if (firstString(record, identityKeys)) return [{ path, kind, lane, record }];
    return Object.entries(record).flatMap(([key, value]) => value && typeof value === 'object'
      ? collectFromSource(value, `${path}.${key}`, kind, lane, guards, visited) : []);
  } finally { visited.delete(source); }
}

function captureNativeWatchers(context: CommandContext) {
  const guards: (() => void)[] = [];
  let holder: unknown = context;
  for (const key of ['platform', 'readModels', 'watchers']) {
    if (holder === undefined || holder === null) break;
    if (typeof holder !== 'object' || nodeTypes.isProxy(holder)) throw new ToolInputProjectionError('invalid');
    guards.push(captureCatalogMethods(holder, [key]));
    holder = modelReadingServicePath(holder, [key]);
  }
  const assertHolders = () => { for (const guard of guards) guard(); };
  if (holder === undefined || holder === null) return { snapshot: null, entries: [], assertCurrent: assertHolders };
  if (typeof holder !== 'object' || nodeTypes.isProxy(holder)) throw new ToolInputProjectionError('invalid');
  const methods = captureCatalogMethods(holder, ['getSnapshot', 'subscribe']);
  const read = modelReadingServicePath(holder, ['getSnapshot']);
  if (read === undefined) {
    // Legacy daemon aliases have their own complete record reader below.
    return { snapshot: null, entries: [], assertCurrent: () => { assertHolders(); methods(); } };
  }
  if (typeof read !== 'function') throw new ToolInputProjectionError('invalid');
  const observation = captureNativeReadModelObservation(holder);
  const acquire = (): unknown => {
    assertHolders(); methods(); observation();
    const snapshot: unknown = read.call(holder);
    assertHolders(); methods(); observation();
    return snapshot;
  };
  const original = acquire(), snapshot = captureCatalogData(original), complete = capturePersonalOpsData(original);
  const data = readRecord(snapshot);
  if (!Array.isArray(data.watchers)) throw new ToolInputProjectionError('invalid');
  const entries: CollectedWatcherRecord[] = data.watchers.map((watcher, index) => {
    if (!watcher || typeof watcher !== 'object' || Array.isArray(watcher)) throw new ToolInputProjectionError('invalid');
    const record = readRecord(watcher);
    if (typeof record.id !== 'string' || typeof record.kind !== 'string' || typeof record.state !== 'string')
      throw new ToolInputProjectionError('invalid');
    return { path: `context.platform.readModels.watchers.getSnapshot().watchers[${index}]`,
      kind: 'daemon-read-model', lane: 'native-watcher', record };
  });
  const assertCurrent = () => {
    assertHolders(); methods(); observation();
    assertPersonalOpsDataCurrent(original, complete);
    assertPersonalOpsDataCurrent(acquire(), complete);
    assertHolders(); methods(); observation();
  };
  assertCurrent(); return { snapshot, entries, assertCurrent };
}

function captureWatcherRecords(context: CommandContext) {
  const native = captureNativeWatchers(context);
  const sources = watcherSources(context);
  const methods: (() => void)[] = [];
  const collect = () => sources.flatMap(source => collectFromSource(source.source, source.path, source.kind, source.lane, methods));
  const legacyEntries = collect();
  const snapshot = capturePersonalOpsData(legacyEntries);
  const assertCurrent = () => {
    native.assertCurrent();
    for (const guard of methods) guard();
    const current = watcherSources(context);
    if (current.some((source, index) => source.source !== sources[index]?.source)) throw new ToolInputProjectionError('held');
    const refreshed = current.flatMap(source => collectFromSource(source.source, source.path, source.kind, source.lane, []));
    assertPersonalOpsDataCurrent(refreshed, snapshot);
    for (const guard of methods) guard();
    native.assertCurrent();
  };
  assertCurrent(); return { entries: [...legacyEntries, ...native.entries], legacyEntries, native, assertCurrent };
}

/** Startup counts never expose producer text or acquire semantic authority. */
export function watcherReadModelNativeFacts(context: CommandContext): readonly { readonly status: string }[] {
  const source = captureWatcherRecords(context);
  const result = source.entries.map(entry => ({ status: nativeStatus(entry.record, entry.lane) }));
  source.assertCurrent(); return result;
}

function availableControl(id: string, label: string, effect: AutonomyQueueRecordControl['effect'], modelRoute: string): AutonomyQueueRecordControl {
  return {
    id,
    label,
    state: 'available',
    effect,
    confirmationRequired: effect === 'confirmed-effect',
    modelRoute,
  };
}

function unavailableControl(id: string, label: string, reason: string): AutonomyQueueRecordControl {
  return {
    id,
    label,
    state: 'unavailable',
    effect: 'confirmed-effect',
    confirmationRequired: true,
    reason,
  };
}

function effectControl(
  id: string,
  label: string,
  route: string,
  enabled: boolean,
  disabledReason: string,
): AutonomyQueueRecordControl {
  return route && enabled
    ? availableControl(id, label, 'confirmed-effect', route)
    : unavailableControl(id, label, route ? disabledReason : `The ${label.toLowerCase()} route was not published by this watcher read model.`);
}

function outputPreview(record: Record<string, unknown>): string {
  const direct = firstString(record, ['outputPreview', 'lastOutput', 'lastChunk', 'lastMessage', 'resultPreview']);
  if (direct) return safePreview(direct, 240);
  for (const key of ['outputChunks', 'chunks', 'logChunks', 'messages', 'outputs']) {
    const values = Array.isArray(record[key]) ? record[key] : [];
    const joined = values.slice(-4).map((entry) => compactUnknown(entry)).filter(Boolean).join(' ');
    if (joined) return safePreview(joined, 240);
  }
  const result = compactUnknown(record.result ?? record.output);
  return result ? safePreview(result, 240) : '';
}

function runOutputDescriptor(record: Record<string, unknown>, route: string, inspectRoute: string): AutonomyQueueRecordOutput | undefined {
  const preview = outputPreview(record);
  if (!preview && !route) return undefined;
  return {
    status: preview ? 'preview' : 'route-only',
    route: route || inspectRoute,
    source: preview ? 'host-output-chunk' : 'not-published',
    ...(preview ? { preview } : {}),
    policy: preview
      ? 'Bounded live watcher output/chunk preview from the connected host; private text is protected. Use the route for the full host-owned stream when available.'
      : 'The watcher record exposes an output route but no inline chunks. Use the route only for a user-requested host-owned output view.',
  };
}

function normalizeRun(entry: CollectedWatcherRecord, index: number, status: string): AutonomyQueueLiveRecord | null {
  const providerId = firstString(entry.record, ['providerId', 'provider', 'sourceProvider', 'service', 'accountProvider']);
  const watcherId = firstString(entry.record, ['watcherId', 'watchId', 'subscriptionId', 'sourceId', 'providerSourceId']);
  const runId = firstString(entry.record, ['runId', 'watcherRunId', 'automationRunId', 'jobRunId', 'eventId', 'id']) || `${index + 1}`;
  const active = status === 'queued' || status === 'running';
  const retryable = status === 'failed' || status === 'blocked' || status === 'cancelled';
  const trigger = firstString(entry.record, ['triggerKind', 'trigger', 'eventKind', 'kind', 'type', 'operation']) || 'watcher-run';
  const sourceId = firstString(entry.record, ['sourceId', 'providerSourceId', 'mailboxId', 'accountId']);
  const correlationId = firstString(entry.record, ['correlationId', 'turnId', 'sessionId', 'requestId']);
  const checkpoint = firstString(entry.record, ['checkpoint', 'lastCheckpoint', 'cursor', 'historyId']);
  const error = firstString(entry.record, ['error', 'lastError', 'failureReason']) || compactUnknown(entry.record.error ?? entry.record.lastError);
  const inspectRoute = routeFromKeys(entry.record, RUN_READ_KEYS)
    || `autonomy action:"item" queueItemId:"automation-runs" query:"${safeRecordIdPart(runId)}" includeParameters:true`;
  const outputRoute = routeFromKeys(entry.record, RUN_OUTPUT_KEYS);
  const cancelRoute = routeFromKeys(entry.record, RUN_CANCEL_KEYS);
  const retryRoute = routeFromKeys(entry.record, RUN_RETRY_KEYS);
  const checkpointRoute = routeFromKeys(entry.record, RUN_CHECKPOINT_KEYS);
  const pauseRoute = routeFromKeys(entry.record, RUN_PAUSE_KEYS);
  const resumeRoute = routeFromKeys(entry.record, RUN_RESUME_KEYS);
  const output = runOutputDescriptor(entry.record, outputRoute, inspectRoute);
  const controls = [
    availableControl('inspect', 'Inspect watcher run', 'read-only', inspectRoute),
    ...(outputRoute ? [availableControl('output', 'Show watcher output', 'read-only', outputRoute)] : []),
    effectControl('cancel', 'Cancel watcher run', cancelRoute, active, `Watcher run is ${status}; cancel is only offered for queued or running runs.`),
    effectControl('retry', 'Retry watcher run', retryRoute, retryable, `Watcher run is ${status}; retry is only offered for failed, blocked, or cancelled runs.`),
    ...(checkpointRoute ? [availableControl('checkpoint', 'Checkpoint watcher run', 'confirmed-effect', checkpointRoute)] : []),
    ...(pauseRoute ? [effectControl('pause', 'Pause watcher run', pauseRoute, active, `Watcher run is ${status}; pause is only offered for queued or running runs.`)] : []),
    ...(resumeRoute ? [effectControl('resume', 'Resume watcher run', resumeRoute, status === 'paused' || status === 'blocked', `Watcher run is ${status}; resume is only offered for paused or blocked runs.`)] : []),
  ];
  return {
    id: `watcher-run:${safeRecordIdPart(entry.path)}:${safeRecordIdPart(runId)}`,
    label: `Watcher run: ${safePreview(providerId || trigger, 48)} ${safePreview(runId, 64)}`,
    status,
    phase: trigger,
    updatedAt: readIso(entry.record.updatedAt ?? entry.record.completedAt ?? entry.record.endedAt ?? entry.record.startedAt ?? entry.record.createdAt),
    summary: [
      `Live ${entry.kind} watcher run ${safePreview(runId, 80)} from ${entry.path} is ${status}.`,
      providerId ? `Provider ${safePreview(providerId, 64)}.` : '',
      watcherId ? `Watcher ${safePreview(watcherId, 80)}.` : '',
      sourceId ? `Source ${safePreview(sourceId, 80)}.` : '',
      checkpoint ? `Checkpoint ${safePreview(checkpoint, 120)}.` : '',
      correlationId ? `Correlation ${safePreview(correlationId, 80)}.` : '',
      output ? 'Live output route or chunk preview is published.' : 'No live output chunk route is published for this run.',
      error ? `Failure ${safePreview(error, 160)}.` : '',
      controls.some((control) => control.effect === 'confirmed-effect' && control.state === 'available')
        ? 'Published run effects are exact confirmed controls.'
        : 'No confirmed run effect route is currently available.',
    ].filter(Boolean).join(' '),
    inspectRoute,
    ...(active && cancelRoute ? { cancelRoute } : {}),
    ...(checkpointRoute ? { checkpointRoute } : {}),
    ...(pauseRoute && active ? { pauseRoute } : {}),
    ...(resumeRoute && (status === 'paused' || status === 'blocked') ? { resumeRoute } : {}),
    nextSteps: [
      inspectRoute,
      ...(outputRoute ? [outputRoute] : []),
      ...(active && cancelRoute ? [cancelRoute] : []),
      ...(retryable && retryRoute ? [retryRoute] : []),
      'Use exact watcher run controls only after the user authorizes the specific run id.',
    ],
    sourceIds: [
      watcherId,
      runId,
      sourceId,
      providerId,
      correlationId,
      ...readStringArray(entry.record.deliveryIds),
      ...readStringArray(entry.record.eventIds),
    ].filter(Boolean).map((value) => safePreview(value, 96)),
    ...(error ? { logTail: [safePreview(error, 220)] } : {}),
    ...(output ? { output } : {}),
    diagnostics: [
      `source ${entry.path}`,
      `read model ${entry.kind}`,
      `record path ${entry.path}`,
      checkpoint ? `checkpoint ${safePreview(checkpoint, 120)}` : '',
      routeFromKeys(entry.record, RUN_CANCEL_KEYS) ? 'cancel route published' : 'cancel route not published',
      routeFromKeys(entry.record, RUN_RETRY_KEYS) ? 'retry route published' : 'retry route not published',
    ].filter(Boolean),
    controls,
  };
}

function normalizeProviderSource(entry: CollectedWatcherRecord, index: number, status: string): AutonomyQueueLiveRecord | null {
  const nativeWatcher = entry.lane === 'native-watcher';
  const providerId = firstString(entry.record, ['providerId', 'provider', 'service', 'kind', 'sourceKind']) || 'provider';
  const sourceId = firstString(entry.record, ['sourceId', 'providerSourceId', 'watcherId', 'subscriptionId', 'accountId', 'id']) || `${index + 1}`;
  const scope = firstString(entry.record, ['scope', 'sourceScope', 'mailbox', 'folder', 'label']);
  const filter = firstString(entry.record, ['filter', 'query', 'search', 'predicate']);
  const checkpoint = firstString(entry.record, ['checkpoint', 'lastCheckpoint', 'cursor', 'historyId']);
  const lastError = firstString(entry.record, ['lastError', 'error', 'failureReason']) || compactUnknown(entry.record.lastError ?? entry.record.error);
  const inspectRoute = routeFromKeys(entry.record, SOURCE_READ_KEYS)
    || `autonomy action:"item" queueItemId:"automation-runs" query:"${safeRecordIdPart(sourceId)}" includeParameters:true`;
  const refreshRoute = routeFromKeys(entry.record, SOURCE_REFRESH_KEYS);
  const preview = nativeWatcher ? outputPreview(entry.record) : firstString(entry.record, ['lastEventPreview', 'preview', 'snippet', 'lastMessage']);
  const output: AutonomyQueueRecordOutput | undefined = preview
    ? {
      status: 'preview',
      route: inspectRoute,
      source: 'provider-source-preview',
      preview: safePreview(preview, 220),
      policy: 'Bounded provider-source event preview from a daemon or SDK read model; private text is protected and provider mutations require separate confirmed routes.',
    }
    : undefined;
  return {
    id: `watcher-source:${safeRecordIdPart(entry.path)}:${safeRecordIdPart(sourceId)}`,
    label: nativeWatcher ? `Watcher: ${safePreview(firstString(entry.record, ['label']) || sourceId, 64)}`
      : `Provider source: ${safePreview(providerId, 48)} ${safePreview(sourceId, 64)}`,
    status,
    phase: firstString(entry.record, ['sourceKind', 'kind', 'type']) || providerId,
    updatedAt: readIso(entry.record.updatedAt ?? entry.record.syncedAt ?? entry.record.currentAt ?? entry.record.createdAt),
    summary: [
      `Live ${entry.kind} provider source ${safePreview(sourceId, 80)} from ${entry.path} is ${status}.`,
      `Provider ${safePreview(providerId, 64)}.`,
      scope ? `Scope ${safePreview(scope, 96)}.` : '',
      filter ? `Filter ${safePreview(filter, 120)}.` : '',
      checkpoint ? `Checkpoint ${safePreview(checkpoint, 120)}.` : '',
      refreshRoute ? 'A read-only refresh route is published.' : 'No read-only refresh route is published.',
      lastError ? `Last error ${safePreview(lastError, 160)}.` : '',
    ].filter(Boolean).join(' '),
    inspectRoute,
    nextSteps: [
      inspectRoute,
      ...(refreshRoute ? [refreshRoute] : []),
      'Treat source records as read-only context; provider source mutations require separate confirmed provider routes.',
    ],
    sourceIds: [
      sourceId,
      providerId,
      firstString(entry.record, ['watcherId', 'subscriptionId']),
      firstString(entry.record, ['accountId', 'mailboxId']),
      checkpoint,
    ].filter(Boolean).map((value) => safePreview(value, 96)),
    ...(lastError ? { logTail: [safePreview(lastError, 220)] } : {}),
    ...(output ? { output } : {}),
    diagnostics: [
      `source ${entry.path}`,
      `read model ${entry.kind}`,
      `record path ${entry.path}`,
      scope ? `scope ${safePreview(scope, 96)}` : '',
      filter ? `filter ${safePreview(filter, 120)}` : '',
      refreshRoute ? 'refresh route published' : 'refresh route not published',
    ].filter(Boolean),
    controls: [
      availableControl('inspect', 'Inspect provider source', 'read-only', inspectRoute),
      ...(refreshRoute ? [availableControl('refresh', 'Refresh provider source', 'read-only', refreshRoute)] : []),
    ],
  };
}

export async function watcherReadModelLiveRecords(context: CommandContext, options: CatalogRankingOptions = {}): Promise<readonly AutonomyQueueLiveRecord[]> {
  const optionsCurrent = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent']);
  const signal = options.signal, callerCurrent = options.assertCurrent, retainCurrent = options.retainCurrent;
  const assertCaller = () => {
    optionsCurrent(); signal?.throwIfAborted();
    const result: unknown = callerCurrent?.();
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new ToolInputProjectionError('held'); }
    optionsCurrent(); signal?.throwIfAborted();
  };
  assertCaller();
  const source = captureWatcherRecords(context);
  const assertSource = () => { optionsCurrent(); signal?.throwIfAborted(); source.assertCurrent(); };
  const assertCurrent = () => { assertSource(); assertCaller(); assertSource(); };
  const current = { ...options, assertCurrent };
  assertCurrent();
  const protectedData = readRecord(await protectPersonalOpsData({ entries: source.legacyEntries, nativeSnapshot: source.native.snapshot }, current));
  const protectedEntries = protectedData.entries;
  if (!Array.isArray(protectedEntries) || protectedEntries.length !== source.legacyEntries.length) throw new ToolInputProjectionError('held');
  const safeEntries: CollectedWatcherRecord[] = source.legacyEntries.map((entry, index) => {
    const protectedEntry = readRecord(protectedEntries[index]);
    if (typeof protectedEntry.path !== 'string') throw new ToolInputProjectionError('held');
    return { path: protectedEntry.path, kind: entry.kind, lane: entry.lane, record: readRecord(protectedEntry.record) };
  });
  if (source.native.snapshot !== null) {
    const protectedWatchers = readRecord(protectedData.nativeSnapshot).watchers;
    if (!Array.isArray(protectedWatchers) || protectedWatchers.length !== source.native.entries.length) throw new ToolInputProjectionError('held');
    for (const [index, entry] of source.native.entries.entries()) {
      const record = readRecord(protectedWatchers[index]);
      const originalSource = readRecord(entry.record.source), protectedSource = readRecord(record.source);
      if (record.id !== entry.record.id || record.kind !== entry.record.kind || record.state !== entry.record.state
        || protectedSource.id !== originalSource.id || protectedSource.kind !== originalSource.kind)
        throw new ToolInputProjectionError('held');
      safeEntries.push({ ...entry, record });
    }
  }
  const records: AutonomyQueueLiveRecord[] = [];
  for (const [index, entry] of source.entries.entries()) {
    assertCurrent();
    const safeEntry = safeEntries[index];
    if (!safeEntry) throw new ToolInputProjectionError('held');
    const record = safeEntry.record;
    const native = nativeStatus(entry.record, entry.lane);
    const status = native === 'unknown' && entry.lane !== 'native-watcher' ? await readPersonalOpsReceiptStatus(record, current) : native;
    const result = entry.lane === 'watcher-run' ? normalizeRun(safeEntry, index, status) : normalizeProviderSource(safeEntry, index, status);
    if (result) records.push(result);
  }
  assertCurrent(); retainCurrent?.(assertSource, 'personal-ops-watcher-source'); assertCurrent();
  const seen = new Set<string>();
  return records.filter(record => { if (seen.has(record.id)) return false; seen.add(record.id); return true; }).slice(0, 20);
}
