import type { CommandContext } from '../input/command-registry.ts';
import type { AgentHarnessModelRoutingArgs, LocalModelServerDefaultEndpoint, LocalModelServerEndpoint, LocalModelSmokeTarget } from './agent-harness-model-routing-types.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { readLimit, readRecord, readString } from './agent-harness-model-routing-utils.ts';
import { collectLocalServerEndpointCandidates, describeLocalServerEndpoint, isPrivateOrLocalUrl, localEndpointSmokeRoute, localModelServerDefaults, parseUrlCandidate } from './agent-harness-local-model-endpoints.ts';

function localModelSmokeTargetFromEndpoint(endpoint: LocalModelServerEndpoint): LocalModelSmokeTarget {
  return {
    kind: endpoint.kind,
    id: endpoint.id,
    label: `Local model server ${endpoint.baseUrl}`,
    providerId: endpoint.providerId,
    stack: endpoint.stack,
    baseUrl: endpoint.baseUrl,
    modelsUrl: endpoint.modelsUrl,
    smokeCommand: endpoint.smokeCommand,
    smokeRoute: endpoint.smokeRoute,
    refreshRoute: endpoint.refreshRoute,
    addProviderRoute: endpoint.addProviderRoute,
    source: endpoint.sources.join(', ') || 'local-endpoint',
    notes: endpoint.notes,
  };
}

function localModelSmokeTargetFromDefault(endpoint: LocalModelServerDefaultEndpoint): LocalModelSmokeTarget {
  return {
    kind: 'suggested-local-server',
    id: endpoint.id,
    label: endpoint.label,
    providerId: null,
    stack: endpoint.stack,
    baseUrl: endpoint.baseUrl,
    modelsUrl: endpoint.modelsUrl,
    smokeCommand: endpoint.smokeCommand,
    smokeRoute: localEndpointSmokeRoute(endpoint.id),
    refreshRoute: 'agent_harness mode:"run_command" command:"/refresh-models" confirm:true explicitUserRequest:"Refresh models after verifying the local server."',
    addProviderRoute: endpoint.addProviderRoute,
    source: 'suggested-default',
    notes: [endpoint.startHint],
  };
}

function localSmokeTargetSearchText(target: LocalModelSmokeTarget): string {
  return [
    target.kind,
    target.id,
    target.label,
    target.providerId ?? '',
    target.stack ?? '',
    target.baseUrl,
    target.modelsUrl,
    target.source,
    ...target.notes,
  ].join('\n').toLowerCase();
}

function localModelSmokeLookup(args: AgentHarnessModelRoutingArgs): string {
  const fields = readRecord(args.fields);
  return readString(args.modelRouteId)
    || readString(args.target)
    || readString(args.query)
    || readString(fields.endpointId)
    || readString(fields.modelRouteId)
    || readString(fields.baseUrl)
    || readString(fields.modelsUrl);
}

/** The endpoints this run will probe, alongside how many were available. */
interface LocalModelSmokeSelection {
  readonly targets: readonly LocalModelSmokeTarget[];
  /** Candidates before `limit` narrowed the run, reported so a partial sweep is not read as a clean bill of health for every endpoint. */
  readonly candidateTotal: number;
}

/** The lookup did not resolve to endpoints; `unresolved` is the report to return instead. */
interface LocalModelSmokeUnresolved {
  readonly unresolved: Record<string, unknown>;
}

function localModelSmokeTargets(
  context: CommandContext,
  args: AgentHarnessModelRoutingArgs,
): LocalModelSmokeSelection | LocalModelSmokeUnresolved {
  const endpoints = collectLocalServerEndpointCandidates(context)
    .map((endpoint) => localModelSmokeTargetFromEndpoint(describeLocalServerEndpoint(endpoint, true)));
  const defaults = localModelServerDefaults().map(localModelSmokeTargetFromDefault);
  const lookup = localModelSmokeLookup(args);
  const allTargets = [...endpoints, ...defaults];
  if (lookup) {
    const normalized = lookup.toLowerCase();
    // An ambiguity report names at most 8 candidates. When more matched, the
    // count says so, a caller shown 8 of 14 would otherwise pick from a list
    // it believed was the whole set of matches.
    const ambiguous = (matches: readonly LocalModelSmokeTarget[]): LocalModelSmokeUnresolved => ({
      unresolved: {
        status: 'ambiguous',
        input: lookup,
        candidateTotal: matches.length,
        candidates: matches.slice(0, 8).map((target) => ({
          kind: target.kind,
          id: target.id,
          label: target.label,
          baseUrl: target.baseUrl,
          modelsUrl: target.modelsUrl,
        })),
        ...(matches.length > 8
          ? { note: `Showing 8 of ${matches.length} matching endpoints; narrow the lookup to see the rest.` }
          : {}),
      },
    });
    const exact = allTargets.filter((target) => target.id === lookup || target.baseUrl === lookup || target.modelsUrl === lookup);
    if (exact.length === 1) return { targets: exact, candidateTotal: 1 };
    if (exact.length > 1) return ambiguous(exact);
    const searched = allTargets.filter((target) => localSmokeTargetSearchText(target).includes(normalized));
    if (searched.length === 1) return { targets: searched, candidateTotal: 1 };
    if (searched.length > 1) return ambiguous(searched);
    return {
      unresolved: {
        status: 'missing_lookup',
        input: lookup,
        usage: 'Unknown local model endpoint. Use models action:"local" includeParameters:true to inspect local endpoint ids, or omit the lookup to check detected/default local servers.',
      },
    };
  }
  const pool = endpoints.length ? endpoints : defaults;
  return { targets: pool.slice(0, readLimit(args.limit, 4)), candidateTotal: pool.length };
}

function readSmokeTimeoutMs(value: unknown): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return 1500;
  return Math.max(250, Math.min(10000, Math.trunc(parsed)));
}

function localSmokeNetworkScope(modelsUrl: string): { readonly allowed: boolean; readonly scope: string; readonly reason?: string } {
  const url = parseUrlCandidate(modelsUrl);
  if (!url || !/^https?:$/.test(url.protocol)) return { allowed: false, scope: 'invalid-url', reason: 'The model-list URL is not a valid HTTP(S) URL.' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '0.0.0.0') {
    return { allowed: false, scope: 'bind-all-host', reason: '0.0.0.0 is a bind address, not a client URL. Use 127.0.0.1 or the intended LAN host.' };
  }
  if (!isPrivateOrLocalUrl(url.href)) {
    return { allowed: false, scope: 'non-local-host', reason: 'Local model smoke only probes loopback, local-name, or private LAN endpoints.' };
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return { allowed: true, scope: 'loopback' };
  if (host.endsWith('.local') || !host.includes('.')) return { allowed: true, scope: 'local-name' };
  return { allowed: true, scope: 'private-lan' };
}

/**
 * @returns `total`, every distinct model id the endpoint advertised, and `ids`,
 *   the first 12 of them. Both, because the capped list used to be the only
 *   thing returned and `modelCount` was taken from it, a server offering 40
 *   models reported 40 as 12.
 */
function extractModelIdsFromPayload(payload: unknown): { readonly ids: readonly string[]; readonly total: number } {
  const record = readRecord(payload);
  const candidates = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : Array.isArray(payload)
        ? payload
        : [];
  const ids = candidates.map((entry) => {
    if (typeof entry === 'string') return entry;
    const item = readRecord(entry);
    return readString(item.id) || readString(item.name) || readString(item.model);
  }).filter(Boolean);
  const distinct = [...new Set(ids)];
  return { ids: distinct.slice(0, 12), total: distinct.length };
}

function safeSmokeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return previewHarnessText(message.replace(/https?:\/\/\S+/g, '[redacted-url]'), 180);
}

async function smokeOneLocalModelTarget(target: LocalModelSmokeTarget, timeoutMs: number): Promise<Record<string, unknown>> {
  const network = localSmokeNetworkScope(target.modelsUrl);
  if (!network.allowed) {
    return {
      ...target,
      status: 'blocked',
      liveProbe: 'confirmed',
      networkScope: network.scope,
      failure: network.reason,
      nextActions: ['Inspect the endpoint route and correct the base URL before running smoke again.'],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(target.modelsUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - started;
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    let payload: unknown = null;
    let jsonValid = false;
    try {
      payload = text ? JSON.parse(text) : null;
      jsonValid = true;
    } catch {
      jsonValid = false;
    }
    const models = jsonValid ? extractModelIdsFromPayload(payload) : { ids: [] as readonly string[], total: 0 };
    const status = !response.ok
      ? 'http-error'
      : !jsonValid
        ? 'invalid-json'
        : models.total === 0
          ? 'no-models'
          : 'passed';
    return {
      ...target,
      status,
      liveProbe: 'confirmed',
      networkScope: network.scope,
      httpStatus: response.status,
      contentType,
      elapsedMs,
      jsonValid,
      modelCount: models.total,
      sampleModelIds: models.ids.slice(0, 5),
      success: status === 'passed',
      nextActions: status === 'passed'
        ? ['Refresh the model catalog, then run a local benchmark before changing the default model.']
        : ['Start or fix the local server, confirm /v1/models returns model ids, then retry this smoke check.'],
    };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const aborted = controller.signal.aborted;
    return {
      ...target,
      status: aborted ? 'timeout' : 'unreachable',
      liveProbe: 'confirmed',
      networkScope: network.scope,
      elapsedMs,
      timeoutMs,
      success: false,
      failure: aborted ? `Timed out after ${timeoutMs}ms.` : safeSmokeError(error),
      nextActions: ['Start the local server, load at least one model, verify the base URL, then retry this smoke check.'],
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runLocalModelServerSmoke(context: CommandContext, args: AgentHarnessModelRoutingArgs): Promise<Record<string, unknown>> {
  const selection = localModelSmokeTargets(context, args);
  if ('unresolved' in selection) {
    return {
      kind: 'local-model-smoke',
      liveProbe: 'not-run',
      ...selection.unresolved,
      policy: 'No local model endpoint was probed because the requested endpoint lookup did not resolve exactly.',
    };
  }
  const { targets, candidateTotal } = selection;
  if (targets.length === 0) {
    return {
      kind: 'local-model-smoke',
      status: 'no-candidates',
      liveProbe: 'not-run',
      endpoints: [],
      nextActions: ['Use the local model cookbook to start a local server or configure a local provider endpoint.'],
      cookbookRoute: 'models action:"local" includeParameters:true',
      policy: 'No local model endpoint was probed because no candidate endpoints were available.',
    };
  }
  const timeoutMs = readSmokeTimeoutMs(args.timeoutMs);
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(targets.map((target) => smokeOneLocalModelTarget(target, timeoutMs)));
  const passed = results.filter((result) => result.success === true);
  const blocked = results.filter((result) => result.status === 'blocked');
  return {
    kind: 'local-model-smoke',
    status: passed.length > 0 ? 'ready' : blocked.length === results.length ? 'blocked' : 'needs-attention',
    liveProbe: 'confirmed',
    checkedAt,
    timeoutMs,
    endpointCount: results.length,
    // How many endpoints existed, not just how many were probed. Without it a
    // limited run reports "2 passed, 0 failed" over a host with six endpoints
    // and reads as every endpoint being healthy.
    candidateEndpointCount: candidateTotal,
    passedCount: passed.length,
    failedCount: results.length - passed.length,
    ...(results.length < candidateTotal
      ? { note: `Probed ${results.length} of ${candidateTotal} candidate endpoints; the rest were not checked. Raise limit to probe them.` }
      : {}),
    endpoints: results,
    nextActions: passed.length > 0
      ? ['Refresh the model catalog and run the local benchmark action before changing the default route.']
      : ['Start a local model server, load one model, and rerun this confirmed smoke check.'],
    cookbookRoute: 'models action:"local" includeParameters:true',
    policy: 'Confirmed read-only local model smoke. Agent only sends bounded GET requests to discovered or suggested local/private model-list endpoints; it does not add providers, refresh catalogs, benchmark, download models, or change routes.',
  };
}
