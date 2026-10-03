import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { readRecord, readString } from './agent-harness-model-routing-utils.ts';
import { redactedPersonalOpsText } from './agent-harness-personal-ops-runner.ts';
import { safeRecordIdPart } from './agent-harness-personal-ops-records.ts';
import type { AutonomyQueueLiveRecord, AutonomyQueueRecordControl, AutonomyQueueRecordOutput } from './agent-harness-autonomy-queue-types.ts';

type WatcherReadModelLane = 'watcher-run' | 'provider-source';
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

const SNAPSHOT_METHODS = ['getSnapshot', 'snapshot', 'toJSON'] as const;
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

function watcherSources(context: CommandContext): readonly WatcherReadModelSource[] {
  const platform = context.platform as unknown as Record<string, unknown>;
  const readModels = readRecord(platform.readModels);
  const clients = readRecord(context.clients);
  const operator = readRecord(clients.operator);
  const automation = readRecord(readModels.automation);
  const watchers = readRecord(readModels.watchers);
  const gmail = readRecord(readModels.gmail);
  const email = readRecord(readModels.email);
  const provider = readRecord(readModels.providers);
  const operatorAutomation = readRecord(operator.automation);
  const operatorWatchers = readRecord(operator.watchers);
  const operatorGmail = readRecord(operator.gmail);
  const operatorEmail = readRecord(operator.email);
  return [
    { path: 'context.platform.readModels.watchers.runs', source: watchers.runs, kind: 'daemon-read-model', lane: 'watcher-run' },
    { path: 'context.platform.readModels.watchers.runHistory', source: watchers.runHistory, kind: 'daemon-read-model', lane: 'watcher-run' },
    { path: 'context.platform.readModels.watchers.watcherRuns', source: watchers.watcherRuns, kind: 'daemon-read-model', lane: 'watcher-run' },
    { path: 'context.platform.readModels.watcherRuns', source: readModels.watcherRuns, kind: 'daemon-read-model', lane: 'watcher-run' },
    { path: 'context.platform.readModels.watcherRunHistory', source: readModels.watcherRunHistory, kind: 'daemon-read-model', lane: 'watcher-run' },
    { path: 'context.platform.readModels.automation.watcherRuns', source: automation.watcherRuns, kind: 'daemon-read-model', lane: 'watcher-run' },
    { path: 'context.platform.readModels.automation.runHistory', source: automation.runHistory, kind: 'daemon-read-model', lane: 'watcher-run' },
    { path: 'context.platform.readModels.gmail.watcherRuns', source: gmail.watcherRuns, kind: 'daemon-read-model', lane: 'watcher-run' },
    { path: 'context.platform.readModels.email.watcherRuns', source: email.watcherRuns, kind: 'daemon-read-model', lane: 'watcher-run' },
    { path: 'context.clients.operator.watchers.runs', source: operatorWatchers.runs, kind: 'sdk-read-model', lane: 'watcher-run' },
    { path: 'context.clients.operator.watchers.runHistory', source: operatorWatchers.runHistory, kind: 'sdk-read-model', lane: 'watcher-run' },
    { path: 'context.clients.operator.automation.watcherRuns', source: operatorAutomation.watcherRuns, kind: 'sdk-read-model', lane: 'watcher-run' },

    { path: 'context.platform.readModels.watchers.sources', source: watchers.sources, kind: 'daemon-read-model', lane: 'provider-source' },
    { path: 'context.platform.readModels.watchers.providerSources', source: watchers.providerSources, kind: 'daemon-read-model', lane: 'provider-source' },
    { path: 'context.platform.readModels.watcherSources', source: readModels.watcherSources, kind: 'daemon-read-model', lane: 'provider-source' },
    { path: 'context.platform.readModels.providerSources', source: readModels.providerSources, kind: 'daemon-read-model', lane: 'provider-source' },
    { path: 'context.platform.readModels.providers.sources', source: provider.sources, kind: 'daemon-read-model', lane: 'provider-source' },
    { path: 'context.platform.readModels.gmail.sources', source: gmail.sources, kind: 'daemon-read-model', lane: 'provider-source' },
    { path: 'context.platform.readModels.gmail.providerSources', source: gmail.providerSources, kind: 'daemon-read-model', lane: 'provider-source' },
    { path: 'context.platform.readModels.gmail.watchers', source: gmail.watchers, kind: 'daemon-read-model', lane: 'provider-source' },
    { path: 'context.platform.readModels.email.sources', source: email.sources, kind: 'daemon-read-model', lane: 'provider-source' },
    { path: 'context.platform.readModels.email.providerSources', source: email.providerSources, kind: 'daemon-read-model', lane: 'provider-source' },
    { path: 'context.platform.readModels.email.watchers', source: email.watchers, kind: 'daemon-read-model', lane: 'provider-source' },
    { path: 'context.clients.operator.watchers.sources', source: operatorWatchers.sources, kind: 'sdk-read-model', lane: 'provider-source' },
    { path: 'context.clients.operator.gmail.sources', source: operatorGmail.sources, kind: 'sdk-read-model', lane: 'provider-source' },
    { path: 'context.clients.operator.email.sources', source: operatorEmail.sources, kind: 'sdk-read-model', lane: 'provider-source' },
  ];
}

function callMethod(source: Record<string, unknown>, method: string): unknown {
  const fn = source[method];
  if (typeof fn !== 'function') return undefined;
  try {
    const result = (fn as () => unknown).call(source);
    return result instanceof Promise ? undefined : result;
  } catch {
    return undefined;
  }
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

function redactWatcherText(value: string): string {
  return redactedPersonalOpsText(value)
    .replace(/("?\b(?:api[-_]?key|apikey|token|secret|password|passwd|credential|authorization)\b"?\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"<redacted>"')
    .replace(/(\b(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1<redacted>');
}

function compactUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return redactWatcherText(value.replace(/\s+/g, ' ').trim());
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return redactWatcherText(JSON.stringify(value).replace(/\s+/g, ' ').trim());
  } catch {
    return '';
  }
}

function safePreview(value: string, limit: number): string {
  return previewHarnessText(redactWatcherText(value), limit);
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

function normalizedStatus(record: Record<string, unknown>, lane: WatcherReadModelLane): string {
  const raw = firstString(record, ['status', 'state', 'outcome', 'result']);
  if (!raw && lane === 'provider-source') {
    const enabled = readBoolean(record, ['enabled', 'active', 'watching']);
    if (enabled === true) return 'ready';
    if (enabled === false) return 'blocked';
  }
  const status = raw.toLowerCase().replace(/[\s_]+/g, '-');
  if (!status) return lane === 'provider-source' ? 'ready' : 'unknown';
  if (['ok', 'ready', 'success', 'succeeded', 'complete', 'completed', 'delivered', 'captured', 'recorded'].includes(status)) return 'succeeded';
  if (['pending', 'scheduled'].includes(status)) return 'queued';
  if (['in-progress', 'active', 'executing', 'processing'].includes(status)) return 'running';
  if (['needs-review', 'needs-setup', 'error-blocked'].includes(status)) return 'blocked';
  if (['fail', 'error', 'errored'].includes(status)) return 'failed';
  if (['cancelled', 'canceled', 'aborted'].includes(status)) return 'cancelled';
  return status;
}

function looksLikeRecord(record: Record<string, unknown>, lane: WatcherReadModelLane): boolean {
  const keys = lane === 'watcher-run'
    ? ['runId', 'watcherRunId', 'automationRunId', 'jobRunId', 'eventId', 'id', 'status', 'outcome']
    : ['sourceId', 'providerSourceId', 'watcherId', 'subscriptionId', 'accountId', 'id', 'scope', 'filter'];
  return firstString(record, keys) !== '';
}

function collectFromSource(
  source: unknown,
  path: string,
  kind: WatcherReadModelSourceKind,
  lane: WatcherReadModelLane,
  visited = new WeakSet<object>(),
  depth = 0,
): readonly CollectedWatcherRecord[] {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source.flatMap((entry, index) => collectFromSource(entry, `${path}[${index}]`, kind, lane, visited, depth + 1));
  }
  if (source instanceof Map) {
    return Array.from(source.entries())
      .flatMap(([key, value]) => collectFromSource(value, `${path}.${String(key)}`, kind, lane, visited, depth + 1));
  }
  if (typeof source !== 'object') return [];
  if (visited.has(source)) return [];
  visited.add(source);

  const record = source as Record<string, unknown>;
  const wrapperKeys = lane === 'watcher-run' ? RUN_WRAPPER_KEYS : SOURCE_WRAPPER_KEYS;
  const methods = lane === 'watcher-run' ? RUN_METHODS : SOURCE_METHODS;
  const fromSnapshots = SNAPSHOT_METHODS.flatMap((method) => {
    const snapshot = callMethod(record, method);
    return snapshot === undefined ? [] : collectFromSource(snapshot, `${path}.${method}()`, kind, lane, visited, depth + 1);
  });
  const fromMethods = methods.flatMap((method) => {
    const snapshot = callMethod(record, method);
    return snapshot === undefined ? [] : collectFromSource(snapshot, `${path}.${method}()`, kind, lane, visited, depth + 1);
  });
  const fromWrappers = wrapperKeys.flatMap((key) => {
    if (!(key in record)) return [];
    return collectFromSource(record[key], `${path}.${key}`, kind, lane, visited, depth + 1);
  });
  if (fromSnapshots.length > 0 || fromMethods.length > 0 || fromWrappers.length > 0) {
    return [...fromSnapshots, ...fromMethods, ...fromWrappers];
  }
  if (looksLikeRecord(record, lane)) return [{ path, kind, lane, record }];
  if (depth >= 3) return [];
  return Object.entries(record)
    .flatMap(([key, value]) => collectFromSource(value, `${path}.${key}`, kind, lane, visited, depth + 1));
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
      ? 'Bounded live watcher output/chunk preview from the connected host; secret-looking text is redacted. Use the route for the full host-owned stream when available.'
      : 'The watcher record exposes an output route but no inline chunks. Use the route only for a user-requested host-owned output view.',
  };
}

function normalizeRun(entry: CollectedWatcherRecord, index: number): AutonomyQueueLiveRecord | null {
  const providerId = firstString(entry.record, ['providerId', 'provider', 'sourceProvider', 'service', 'accountProvider']);
  const watcherId = firstString(entry.record, ['watcherId', 'watchId', 'subscriptionId', 'sourceId', 'providerSourceId']);
  const runId = firstString(entry.record, ['runId', 'watcherRunId', 'automationRunId', 'jobRunId', 'eventId', 'id']) || `${index + 1}`;
  const status = normalizedStatus(entry.record, 'watcher-run');
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

function normalizeProviderSource(entry: CollectedWatcherRecord, index: number): AutonomyQueueLiveRecord | null {
  const providerId = firstString(entry.record, ['providerId', 'provider', 'service', 'kind', 'sourceKind']) || 'provider';
  const sourceId = firstString(entry.record, ['sourceId', 'providerSourceId', 'watcherId', 'subscriptionId', 'accountId', 'id']) || `${index + 1}`;
  const status = normalizedStatus(entry.record, 'provider-source');
  const scope = firstString(entry.record, ['scope', 'sourceScope', 'mailbox', 'folder', 'label']);
  const filter = firstString(entry.record, ['filter', 'query', 'search', 'predicate']);
  const checkpoint = firstString(entry.record, ['checkpoint', 'lastCheckpoint', 'cursor', 'historyId']);
  const lastError = firstString(entry.record, ['lastError', 'error', 'failureReason']) || compactUnknown(entry.record.lastError ?? entry.record.error);
  const inspectRoute = routeFromKeys(entry.record, SOURCE_READ_KEYS)
    || `autonomy action:"item" queueItemId:"automation-runs" query:"${safeRecordIdPart(sourceId)}" includeParameters:true`;
  const refreshRoute = routeFromKeys(entry.record, SOURCE_REFRESH_KEYS);
  const preview = firstString(entry.record, ['lastEventPreview', 'preview', 'snippet', 'lastMessage']);
  const output: AutonomyQueueRecordOutput | undefined = preview
    ? {
      status: 'preview',
      route: inspectRoute,
      source: 'provider-source-preview',
      preview: safePreview(preview, 220),
      policy: 'Bounded provider-source event preview from a daemon or SDK read model; secret-looking text is redacted and provider mutations require separate confirmed routes.',
    }
    : undefined;
  return {
    id: `watcher-source:${safeRecordIdPart(entry.path)}:${safeRecordIdPart(sourceId)}`,
    label: `Provider source: ${safePreview(providerId, 48)} ${safePreview(sourceId, 64)}`,
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

export function watcherReadModelLiveRecords(context: CommandContext): readonly AutonomyQueueLiveRecord[] {
  const records = watcherSources(context)
    .flatMap((source) => collectFromSource(
      source.source,
      source.path,
      source.kind,
      source.lane,
    ))
    .map((entry, index) => entry.lane === 'watcher-run' ? normalizeRun(entry, index) : normalizeProviderSource(entry, index))
    .filter((record): record is AutonomyQueueLiveRecord => record !== null);
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  }).slice(0, 20);
}
