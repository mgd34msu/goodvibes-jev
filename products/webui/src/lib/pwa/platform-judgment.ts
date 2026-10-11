import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { runBrowserJudgment } from '../goodvibes';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from '../client-lifetime';
import { randomUuid } from '../uuid';

type Request = BrowserJudgmentRequest<'webui.pwa.install-platform'>;
export type InstallPlatform = 'ios-share-menu' | 'other';
export type PlatformResult = { readonly status: 'ready'; readonly platform: InstallPlatform; readonly isCurrent: () => boolean } | { readonly status: 'held' | 'unavailable' };
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const probability = (value: unknown): value is number => nonnegative(value) && value <= 1;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Bind the complete evidence and closed choice to this request, never accept a value-only response. */
export function readPlatformResponse(request: Request, raw: unknown): { readonly status: 'ready'; readonly platform: InstallPlatform } | { readonly status: 'held' } | undefined {
  const result = object(raw);
  if (result?.protocolVersion !== 1 || result.batteryVersion !== 1 || result.battery !== request.battery
    || result.requestId !== request.requestId || (result.status !== 'settled' && result.status !== 'held')) return undefined;
  const settled = result.status === 'settled';
  if (!keys(result, ['protocolVersion', 'batteryVersion', 'requestId', 'battery', 'status', settled ? 'value' : 'reason', 'readings', 'outcome', 'evidence'])) return undefined;
  const readings = object(result.readings);
  const reading = object(readings?.platform);
  const distribution = object(reading?.probabilities);
  if (!readings || !keys(readings, ['platform']) || !reading || !keys(reading, ['kind', 'choice', 'confidence', 'probabilities', 'outcome'])
    || reading.kind !== 'choice' || !probability(reading.confidence) || typeof reading.choice !== 'string' || !['ios-share-menu', 'other'].includes(reading.choice)
    || !distribution || !keys(distribution, ['ios-share-menu', 'other']) || !Object.values(distribution).every(probability)
    || Math.abs(Number(distribution['ios-share-menu']) + Number(distribution.other) - 1) > 1e-6
    || Number(distribution[reading.choice]) < Math.max(...Object.values(distribution).map(Number))
    || typeof reading.outcome !== 'string' || !['act', 'confirm', 'escalate'].includes(reading.outcome) || result.outcome !== reading.outcome) return undefined;
  if (!Array.isArray(result.evidence) || result.evidence.length !== 1) return undefined;
  const evidence = object(result.evidence[0]); const usage = object(evidence?.usage);
  if (!evidence || !keys(evidence, ['decisionId', 'model', 'requestedModel', 'usage', 'latencyMs']) || !nonempty(evidence.decisionId)
    || !nonempty(evidence.model) || !nonempty(evidence.requestedModel) || !nonnegative(evidence.latencyMs)
    || !usage || !keys(usage, ['inputTokens', 'outputTokens']) || !nonnegative(usage.inputTokens) || !nonnegative(usage.outputTokens)) return undefined;
  if (!settled) return result.reason === 'uncertain' && reading.outcome !== 'act' ? { status: 'held' } : undefined;
  const value = object(result.value);
  if (!value || !keys(value, ['platform']) || reading.outcome !== 'act' || value.platform !== reading.choice) return undefined;
  return { status: 'ready', platform: reading.choice as InstallPlatform };
}

export async function readInstallPlatform(input: Request['input'], signal: AbortSignal): Promise<PlatformResult> {
  if (!input.userAgent || input.userAgent.length > 2048 || input.platform.length > 128 || signal.aborted) return { status: 'held' };
  const lifetime = getClientLifetime(); const abort = new AbortController();
  const cancel = () => abort.abort(); const unsubscribe = subscribeClientLifetime(cancel);
  signal.addEventListener('abort', cancel, { once: true });
  const isCurrent = () => !signal.aborted && !abort.signal.aborted && isClientLifetimeCurrent(lifetime);
  try {
    if (!isCurrent()) return { status: 'unavailable' };
    const request: Request = { protocolVersion: 1, requestId: randomUuid(), battery: 'webui.pwa.install-platform', batteryVersion: 1, input };
    const raw = await runBrowserJudgment(request, abort.signal);
    if (!isCurrent()) return { status: 'unavailable' };
    const result = readPlatformResponse(request, raw);
    return result?.status === 'ready' ? { ...result, isCurrent } : result ?? { status: 'unavailable' };
  } catch { return { status: 'unavailable' }; }
  finally { unsubscribe(); signal.removeEventListener('abort', cancel); }
}
