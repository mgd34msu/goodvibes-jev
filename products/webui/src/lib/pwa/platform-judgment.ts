import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { captureChoiceAnswer } from '@goodvibes-jev/judgment/decisions';

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
    || !distribution || !keys(distribution, ['ios-share-menu', 'other'])
    || typeof reading.outcome !== 'string' || !['act', 'confirm', 'escalate'].includes(reading.outcome) || result.outcome !== reading.outcome) return undefined;
  const probabilities: Record<string, number> = {};
  for (const [option, value] of Object.entries(distribution)) {
    if (!probability(value)) return undefined;
    probabilities[option] = value;
  }
  try { captureChoiceAnswer({ type: 'choice', choice: reading.choice, confidence: reading.confidence, probabilities }); }
  catch { return undefined; }
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

/** Installation instructions follow explicit browser platform tokens, including desktop-mode iPad. */
export async function readInstallPlatform(input: Request['input'], signal: AbortSignal): Promise<PlatformResult> {
  const { userAgent, platform, maxTouchPoints } = input;
  if (typeof userAgent !== 'string' || typeof platform !== 'string' || userAgent.length > 2048 || platform.length > 128
    || !Number.isSafeInteger(maxTouchPoints) || maxTouchPoints < 0 || signal.aborted) return { status: 'held' };
  const appleMobile = /\b(?:iPad|iPhone|iPod)\b/.test(userAgent) || /^(?:iPad|iPhone|iPod)$/.test(platform)
    || (platform === 'MacIntel' && maxTouchPoints > 1);
  const isCurrent = () => !signal.aborted && input.userAgent === userAgent && input.platform === platform && input.maxTouchPoints === maxTouchPoints;
  return { status: 'ready', platform: appleMobile ? 'ios-share-menu' : 'other', isCurrent };
}
