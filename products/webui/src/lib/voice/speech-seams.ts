import { BROWSER_SPEECH_SEAM_BAND, type BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk/browser-judgment-contract';
import { runBrowserJudgment } from '../goodvibes';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from '../client-lifetime';
import { randomUuid } from '../uuid';

export interface SpeechSource { readonly sessionId: string; readonly messageId: string; readonly content: string }
type Request = BrowserJudgmentRequest<'webui.voice.speech-seams'>;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export class SpeechSeamsUnavailable extends Error { constructor() { super('Sentence boundaries are unavailable. Please try reading this reply again.'); } }

/** Validate full evidence, exact request identity and the deterministic candidate projection. */
export function readSpeechSeamsResponse(request: Request, paragraph: string, raw: unknown): readonly number[] | undefined {
  const candidates = [...paragraph.matchAll(/\s+/g)].map(match => match.index); candidates.push(paragraph.length);
  const selected = candidates.slice(request.input.cursor, request.input.cursor + 64);
  const result = object(raw);
  if (result?.protocolVersion !== 1 || result.batteryVersion !== 1 || result.battery !== request.battery || result.requestId !== request.requestId
    || result.status !== 'settled' || result.outcome !== 'act'
    || !keys(result, ['protocolVersion', 'batteryVersion', 'requestId', 'battery', 'status', 'value', 'readings', 'outcome', 'evidence'])) return undefined;
  const readings = object(result.readings); const value = object(result.value);
  if (!readings || !keys(readings, selected.map((_, i) => `seam_${i}`)) || !value || !keys(value, ['endOffsets', 'nextCursor'])) return undefined;
  const offsets: number[] = [];
  for (let i = 0; i < selected.length; i++) {
    const reading = object(readings[`seam_${i}`]);
    if (!reading || !keys(reading, ['kind', 'probability', 'verdict', 'outcome']) || reading.kind !== 'yes-no' || reading.outcome !== 'act'
      || !nonnegative(reading.probability) || reading.probability > 1 || (reading.verdict !== 'yes' && reading.verdict !== 'no')) return undefined;
    if ((reading.verdict === 'yes' ? reading.probability : 1 - reading.probability) < BROWSER_SPEECH_SEAM_BAND[reading.verdict].actAt) return undefined;
    if (reading.verdict === 'yes') offsets.push(selected[i]);
  }
  if (!Array.isArray(result.evidence) || result.evidence.length !== 1) return undefined;
  const evidence = object(result.evidence[0]); const usage = object(evidence?.usage);
  if (!evidence || !keys(evidence, ['decisionId', 'model', 'requestedModel', 'usage', 'latencyMs']) || !nonempty(evidence.decisionId)
    || !nonempty(evidence.model) || !nonempty(evidence.requestedModel) || !nonnegative(evidence.latencyMs)
    || !usage || !keys(usage, ['inputTokens', 'outputTokens']) || !nonnegative(usage.inputTokens) || !nonnegative(usage.outputTokens)) return undefined;
  const nextCursor = request.input.cursor + 64 < candidates.length ? request.input.cursor + 64 : null;
  if (value.nextCursor !== nextCursor || !Array.isArray(value.endOffsets) || value.endOffsets.length !== offsets.length
    || value.endOffsets.some((offset, i) => offset !== offsets[i])) return undefined;
  return offsets;
}

/** Only canonical identities and a digest leave the browser; text is resolved and screened by its owner. */
export async function readSpeechSeams(source: SpeechSource, start: number, end: number, signal: AbortSignal): Promise<readonly number[]> {
  const { sessionId, messageId, content } = source;
  if (!source.sessionId || !source.messageId || source.sessionId.length > 256 || source.messageId.length > 256
    || !source.content || source.content.length > 1_000_000 || start < 0 || end > source.content.length || end <= start) throw new SpeechSeamsUnavailable();
  const paragraph = source.content.slice(start, end);
  const count = [...paragraph.matchAll(/\s+/g)].length + 1;
  if (paragraph.length > 32768 || count > 4096) throw new SpeechSeamsUnavailable();
  const lifetime = getClientLifetime(); const abort = new AbortController();
  const cancel = () => abort.abort(); const unsubscribe = subscribeClientLifetime(cancel);
  signal.addEventListener('abort', cancel, { once: true });
  const assertCurrent = () => { if (signal.aborted || abort.signal.aborted || !isClientLifetimeCurrent(lifetime)
    || source.sessionId !== sessionId || source.messageId !== messageId || source.content !== content) throw new SpeechSeamsUnavailable(); };
  try {
    assertCurrent(); const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)); assertCurrent();
    const contentDigest = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const offsets: number[] = [];
    for (let cursor = 0; cursor < count; cursor += 64) {
      assertCurrent();
      const request: Request = { protocolVersion: 1, requestId: randomUuid(), battery: 'webui.voice.speech-seams', batteryVersion: 1,
        input: { sessionId, messageId, start, end, contentDigest, cursor } };
      const raw = await runBrowserJudgment(request, abort.signal); assertCurrent();
      const result = readSpeechSeamsResponse(request, paragraph, raw); if (!result) throw new SpeechSeamsUnavailable();
      offsets.push(...result);
    }
    assertCurrent(); return offsets;
  } catch { throw new SpeechSeamsUnavailable(); }
  finally { unsubscribe(); signal.removeEventListener('abort', cancel); }
}
