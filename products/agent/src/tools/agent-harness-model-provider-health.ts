import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import type { ModelProviderHealthSignal } from './agent-harness-model-routing-types.ts';
import { readBoolean, readFiniteNumber, readRecord, readString, safeIso } from './agent-harness-model-routing-utils.ts';

function readPotentialProviderHealthSnapshot(source: unknown): unknown {
  if (!source || typeof source !== 'object') return null;
  const record = source as Record<string, unknown>;
  const directSnapshot = ['getSnapshot', 'snapshot', 'list', 'listProviders', 'listRoutes', 'listHealth']
    .map((method) => {
      const fn = record[method];
      if (typeof fn !== 'function') return null;
      const result = (fn as () => unknown).call(record);
      return result instanceof Promise ? null : result;
    })
    .find((result) => result !== null);
  return directSnapshot ?? record.snapshot ?? record.data ?? record.state ?? source;
}

const PROVIDER_HEALTH_SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/("?\b(?:api[-_]?key|apikey|token|secret|password|passwd|credential|authorization)\b"?\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1"<redacted>"'],
  [/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|BEARER)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1=<redacted>'],
  [/(\b(?:token|secret|password|passwd|api[-_]?key|apikey|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1<redacted>'],
  [/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>'],
];

function redactProviderHealthText(value: string): string {
  return PROVIDER_HEALTH_SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function entryWithKey(key: unknown, entry: unknown): Record<string, unknown> {
  const record = readRecord(entry);
  const textKey = readString(key);
  if (!textKey) return record;
  const looksLikeRoute = textKey.includes(':') || textKey.includes('/');
  return {
    ...record,
    ...(looksLikeRoute ? { modelRouteId: readString(record.modelRouteId) || readString(record.routeId) || textKey } : {}),
    providerId: readString(record.providerId) || readString(record.provider) || (looksLikeRoute ? readString(record.providerId) : textKey),
  };
}

function looksLikeProviderHealthRecord(record: Record<string, unknown>): boolean {
  return Boolean(
    readString(record.providerId)
      || readString(record.provider)
      || readString(record.modelRouteId)
      || readString(record.routeId)
      || readString(record.registryKey)
      || readString(record.status)
      || readFiniteNumber(record.avgLatencyMs) !== undefined
      || Object.keys(readRecord(record.stats)).length > 0,
  );
}

function providerHealthCandidatesFromSnapshot(snapshot: unknown): readonly Record<string, unknown>[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  if (snapshot instanceof Map) {
    return [...snapshot.entries()].map(([key, entry]) => entryWithKey(key, entry));
  }
  const record = readRecord(snapshot);
  for (const key of ['providers', 'providerHealth', 'routes', 'modelRoutes', 'routeHealth', 'providerRoutes', 'records', 'items', 'entries', 'health']) {
    const value = record[key];
    if (value instanceof Map) return [...value.entries()].map(([entryKey, entry]) => entryWithKey(entryKey, entry));
    if (Array.isArray(value)) return value.map((entry) => readRecord(entry));
    const valueRecord = readRecord(value);
    if (Object.keys(valueRecord).length > 0) return Object.entries(valueRecord).map(([entryKey, entry]) => entryWithKey(entryKey, entry));
  }
  return looksLikeProviderHealthRecord(record) ? [record] : [];
}

function providerHealthCandidateProviderId(candidate: Record<string, unknown>): string {
  return readString(candidate.providerId)
    || readString(candidate.provider)
    || readString(candidate.providerName)
    || (readString(candidate.id).includes(':') ? '' : readString(candidate.id));
}

function providerHealthCandidateRouteId(candidate: Record<string, unknown>): string {
  return readString(candidate.modelRouteId)
    || readString(candidate.registryKey)
    || readString(candidate.routeId)
    || readString(candidate.modelRoute)
    || (readString(candidate.id).includes(':') ? readString(candidate.id) : '');
}

function providerHealthCandidateMatchesProvider(candidate: Record<string, unknown>, providerId: string): boolean {
  return providerHealthCandidateProviderId(candidate) === providerId;
}

function providerHealthRecordStats(candidate: Record<string, unknown>): Record<string, unknown> {
  return readRecord(candidate.stats);
}

function providerHealthRecordRateLimit(candidate: Record<string, unknown>): Record<string, unknown> {
  return readRecord(candidate.rateLimit);
}

function providerHealthRecordErrors(candidate: Record<string, unknown>): Record<string, unknown> {
  return readRecord(candidate.errors);
}

function isoFromUnknown(value: unknown): string | null {
  const numeric = readFiniteNumber(value);
  if (numeric !== undefined) return safeIso(numeric);
  const text = readString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function firstTimestamp(values: readonly unknown[]): string | null {
  for (const value of values) {
    const timestamp = isoFromUnknown(value);
    if (timestamp) return timestamp;
  }
  return null;
}

function providerHealthTimestamp(candidate: Record<string, unknown>, stats: Record<string, unknown>, key: string): string | null {
  return firstTimestamp([candidate[key], stats[key]]);
}

function nestedNumber(candidate: Record<string, unknown>, stats: Record<string, unknown>, nested: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readFiniteNumber(candidate[key]) ?? readFiniteNumber(stats[key]) ?? readFiniteNumber(nested[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function readProviderHealthSignal(context: CommandContext, providerId: string, modelRouteId?: string): ModelProviderHealthSignal {
  const base: Omit<ModelProviderHealthSignal, 'status' | 'daemonPublication' | 'agentConsumption' | 'missingSignals' | 'policy'> = {
    providerId,
    ...(modelRouteId ? { modelRouteId } : {}),
    sdkContract: {
      providerHealthTypes: 'available',
      importSurface: '@goodvibes-jev/engine/sdk/platform/runtime/ui',
      note: 'The SDK publishes provider-health domain and UI enrichment types; types alone do not prove live connected-host health.',
    },
  };
  const policy = 'Provider health is live route-condition evidence. Local benchmark artifacts remain separate task-fit evidence and must not be treated as provider-health publication.';
  const platform = context.platform as unknown as Record<string, unknown>;
  const readModels = readRecord(platform.readModels);
  const clients = readRecord(context.clients as unknown as Record<string, unknown>);
  const operator = readRecord(clients.operator);
  const sourceEntries: readonly { readonly path: string; readonly source: unknown }[] = [
    { path: 'context.platform.readModels.providerHealth', source: readModels.providerHealth },
    { path: 'context.platform.readModels.providersHealth', source: readModels.providersHealth },
    { path: 'context.platform.readModels.modelRouteHealth', source: readModels.modelRouteHealth },
    { path: 'context.platform.readModels.routeHealth', source: readModels.routeHealth },
    { path: 'context.platform.readModels.models.providerHealth', source: readRecord(readModels.models).providerHealth },
    { path: 'context.platform.readModels.models.routeHealth', source: readRecord(readModels.models).routeHealth },
    { path: 'context.platform.providerHealth', source: platform.providerHealth },
    { path: 'context.clients.operator.providerHealth', source: operator.providerHealth },
  ];

  for (const entry of sourceEntries) {
    if (entry.source === undefined || entry.source === null) continue;
    try {
      const snapshot = readPotentialProviderHealthSnapshot(entry.source);
      const candidates = providerHealthCandidatesFromSnapshot(snapshot);
      const candidate = (modelRouteId
        ? candidates.find((item) => providerHealthCandidateRouteId(item) === modelRouteId)
        : undefined)
        ?? candidates.find((item) => providerHealthCandidateMatchesProvider(item, providerId));
      if (!candidate) {
        return {
          ...base,
          status: 'read-model-empty',
          daemonPublication: {
            status: 'published-read-model',
            requiredPath: entry.path,
            evidence: 'A provider-health read model path exists, but no matching provider record was returned.',
          },
          agentConsumption: {
            status: 'waiting-for-published-feed',
            readModelPath: entry.path,
            evidence: `No provider-health record matched provider "${providerId}".`,
          },
          missingSignals: [`No daemon-published provider-health record matched provider "${providerId}" in ${entry.path}.`],
          policy,
        };
      }

      const stats = providerHealthRecordStats(candidate);
      const rateLimit = providerHealthRecordRateLimit(candidate);
      const errors = providerHealthRecordErrors(candidate);
      const avgLatencyMs = readFiniteNumber(candidate.avgLatencyMs) ?? readFiniteNumber(stats.avgLatencyMs);
      const minLatencyMs = readFiniteNumber(candidate.minLatencyMs) ?? readFiniteNumber(stats.minLatencyMs);
      const maxLatencyMs = readFiniteNumber(candidate.maxLatencyMs) ?? readFiniteNumber(candidate.p95LatencyMs) ?? readFiniteNumber(stats.maxLatencyMs);
      const healthStatus = readString(candidate.status) || 'unknown';
      const rateLimitRemaining = nestedNumber(candidate, stats, rateLimit, ['rateLimitRemaining', 'remaining', 'requestsRemaining']);
      const rateLimitLimit = nestedNumber(candidate, stats, rateLimit, ['rateLimitLimit', 'limit', 'requestsLimit']);
      const rateLimitResetAt = firstTimestamp([candidate.rateLimitResetAt, stats.rateLimitResetAt, rateLimit.resetAt, rateLimit.resetsAt]);
      const lastErrorAt = firstTimestamp([candidate.lastErrorAt, stats.lastErrorAt, errors.lastErrorAt]);
      const lastErrorMessage = readString(candidate.lastErrorMessage)
        || readString(stats.lastErrorMessage)
        || readString(errors.lastErrorMessage)
        || readString(errors.message);
      const errorRate = nestedNumber(candidate, stats, errors, ['errorRate', 'recentErrorRate']);
      const consecutiveErrors = nestedNumber(candidate, stats, errors, ['consecutiveErrors', 'failureStreak']);
      const hasRateLimitPosture = rateLimitRemaining !== undefined || rateLimitLimit !== undefined || rateLimitResetAt !== null;
      const hasErrorPosture = lastErrorAt !== null || lastErrorMessage || errorRate !== undefined || consecutiveErrors !== undefined;
      return {
        ...base,
        status: 'record-found',
        daemonPublication: {
          status: 'published-read-model',
          requiredPath: entry.path,
          evidence: `Provider-health record found for provider "${providerId}".`,
        },
        agentConsumption: {
          status: 'consumed',
          readModelPath: entry.path,
          evidence: 'Agent consumed the published provider-health record for exact model-route readiness.',
        },
        sourceRecordId: readString(candidate.recordId) || readString(candidate.id) || providerHealthCandidateRouteId(candidate) || providerHealthCandidateProviderId(candidate),
        ...(providerHealthCandidateRouteId(candidate) ? { modelRouteId: providerHealthCandidateRouteId(candidate) } : {}),
        healthStatus,
        isConfigured: readBoolean(candidate.isConfigured),
        isActive: readBoolean(candidate.isActive),
        avgLatencyMs,
        minLatencyMs,
        maxLatencyMs,
        lastSuccessAt: providerHealthTimestamp(candidate, stats, 'lastSuccessAt'),
        lastErrorAt,
        lastErrorMessage: lastErrorMessage ? previewHarnessText(redactProviderHealthText(lastErrorMessage), 160) : undefined,
        errorRate,
        consecutiveErrors,
        lastCheckedAt: providerHealthTimestamp(candidate, stats, 'lastCheckedAt'),
        rateLimitResetAt,
        rateLimitRemaining,
        rateLimitLimit,
        missingSignals: [
          ...(avgLatencyMs === undefined ? ['Provider-health record did not include average latency.'] : []),
          ...(minLatencyMs === undefined ? ['Provider-health record did not include minimum latency.'] : []),
          ...(maxLatencyMs === undefined ? ['Provider-health record did not include maximum or p95 latency.'] : []),
          ...(hasRateLimitPosture ? [] : ['Provider-health record did not include rate-limit posture.']),
          ...(hasErrorPosture ? [] : ['Provider-health record did not include error posture.']),
        ],
        policy,
      };
    } catch (error) {
      return {
        ...base,
        status: 'read-model-error',
        daemonPublication: {
          status: 'published-read-model',
          requiredPath: entry.path,
          evidence: `Provider-health read model exists but failed while reading: ${previewHarnessText(error instanceof Error ? error.message : String(error), 120)}`,
        },
        agentConsumption: {
          status: 'waiting-for-published-feed',
          readModelPath: entry.path,
          evidence: 'Agent could not safely consume this provider-health read model.',
        },
        missingSignals: ['Provider-health read model exists but failed while Agent was reading it.'],
        policy,
      };
    }
  }

  return {
    ...base,
    status: 'not-reachable-in-command-context',
    daemonPublication: {
      status: 'not-published',
      requiredPath: 'context.platform.readModels.providerHealth',
      evidence: 'No daemon-published provider-health read model is reachable from Agent CommandContext.',
    },
    agentConsumption: {
      status: 'waiting-for-published-feed',
      readModelPath: null,
      evidence: 'Agent cannot attach provider status or latency to exact routes until the connected host publishes a stable feed.',
    },
    missingSignals: [
      'SDK provider-health types are available, but no daemon-published provider.health feed is reachable in Agent CommandContext.',
      'Agent has not consumed provider status, configured state, live latency, rate-limit posture, or last error for this route.',
    ],
    policy,
  };
}
