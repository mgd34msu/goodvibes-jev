import type { BrowserJudgmentRequest, BrowserJudgmentValueMap } from '@goodvibes-jev/engine/daemon-sdk';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from './client-lifetime';
import { randomUuid } from './uuid';

type Refusal = BrowserJudgmentValueMap['webui.errors.daemon-refusal'];
type Request = BrowserJudgmentRequest<'webui.errors.daemon-refusal'>;
const names = ['session_not_found', 'session_closed', 'session_active', 'session_not_local', 'method_unknown'] as const;
const values = new WeakMap<object, { readonly value: Refusal; readonly isCurrent: () => boolean }>();
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Adopt only complete, genuine, settled readings bound to this exact failure request. */
export function readDaemonRefusalResponse(request: Request, status: number, raw: unknown): Refusal | undefined {
  const result = object(raw);
  const structural = status !== 404;
  if (result?.protocolVersion !== 1 || result.batteryVersion !== 1 || result.battery !== request.battery
    || result.requestId !== request.requestId || result.status !== 'settled' || result.outcome !== 'act'
    || !keys(result, ['protocolVersion', 'batteryVersion', 'battery', 'requestId', 'status', 'outcome', 'value', 'readings', 'evidence', ...(structural ? ['structuralBasis'] : [])])) return undefined;
  const basis = object(result.structuralBasis);
  if (structural && (!basis || !keys(basis, ['method_unknown']) || basis.method_unknown !== 'http-status-not-404')) return undefined;
  const value = object(result.value); const readings = object(result.readings);
  const items = names.filter((name) => name !== 'method_unknown' || !structural);
  if (!value || !keys(value, names) || !readings || !keys(readings, items)) return undefined;
  for (const name of names) {
    if (typeof value[name] !== 'boolean') return undefined;
    if (name === 'method_unknown' && structural) { if (value[name]) return undefined; continue; }
    const reading = object(readings[name]);
    if (!reading || !keys(reading, ['kind', 'probability', 'verdict', 'outcome']) || reading.kind !== 'yes-no'
      || !nonnegative(reading.probability) || reading.probability > 1 || reading.outcome !== 'act'
      || (reading.verdict !== 'yes' && reading.verdict !== 'no') || value[name] !== (reading.verdict === 'yes')) return undefined;
  }
  if ((value.session_not_found && (value.session_closed || value.session_active || value.session_not_local))
    || (value.session_closed && value.session_active)
    || (value.method_unknown && (value.session_not_found || value.session_closed || value.session_active || value.session_not_local))) return undefined;
  if (!Array.isArray(result.evidence) || result.evidence.length !== 1) return undefined;
  const evidence = object(result.evidence[0]); const usage = object(evidence?.usage);
  if (!evidence || !keys(evidence, ['decisionId', 'model', 'requestedModel', 'usage', 'latencyMs'])
    || ![evidence.decisionId, evidence.model, evidence.requestedModel].every((item) => typeof item === 'string' && item.trim())
    || !nonnegative(evidence.latencyMs) || !usage || !keys(usage, ['inputTokens', 'outputTokens'])
    || !nonnegative(usage.inputTokens) || !nonnegative(usage.outputTokens)) return undefined;
  return Object.freeze(Object.fromEntries(names.map((name) => [name, value[name]]))) as unknown as Refusal;
}

/** No prose classification here. An unissued/held/uncertain failure remains unclassified. */
export function daemonRefusalValue(error: unknown): Refusal | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const entry = values.get(error);
  return entry?.isCurrent() ? entry.value : undefined;
}

/** Awaited by the actual HTTP caller, before its original failure reaches UI consumers. */
export async function resolveDaemonRefusal(error: unknown,
  run: (request: Request, signal: AbortSignal) => Promise<unknown>,
  options: { readonly signal?: AbortSignal | undefined; readonly isCurrent: () => boolean }): Promise<void> {
  const failure = object(error); const transport = object(failure?.transport);
  const body = object(failure?.body ?? transport?.body);
  const status = failure?.status ?? transport?.status;
  const errorRef = body?.errorRef;
  if (!failure || typeof errorRef !== 'string' || !errorRef.trim() || errorRef.length > 256
    || typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599
    || status === 401 || options.signal?.aborted || !options.isCurrent()) return;
  const lifetime = getClientLifetime(); const abort = new AbortController();
  const cancel = () => abort.abort();
  const unsubscribe = subscribeClientLifetime(cancel);
  options.signal?.addEventListener('abort', cancel, { once: true });
  const isCurrent = () => !options.signal?.aborted && options.isCurrent() && isClientLifetimeCurrent(lifetime);
  try {
    if (!isCurrent() || options.signal?.aborted) return;
    const request: Request = { protocolVersion: 1, requestId: randomUuid(), battery: 'webui.errors.daemon-refusal', batteryVersion: 1, input: { errorRef } };
    const result = await run(request, abort.signal);
    if (abort.signal.aborted || !isCurrent()) return;
    const value = readDaemonRefusalResponse(request, status, result);
    if (value) values.set(failure, { value, isCurrent });
  } catch { /* Preserve the original failure when interpretation is unavailable. */ }
  finally { unsubscribe(); options.signal?.removeEventListener('abort', cancel); }
}
