import {
  BROWSER_JUDGMENT_BATTERY_IDS, BROWSER_JUDGMENT_LIMITS as LIMIT,
  BrowserJudgmentError, type BrowserJudgmentRequest,
} from './browser-judgment-contract.js';

const invalid = (): never => { throw new BrowserJudgmentError('JUDGMENT_INVALID_INPUT'); };
const large = (): never => { throw new BrowserJudgmentError('JUDGMENT_INPUT_TOO_LARGE'); };
export function judgmentRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))) return invalid();
  if (Object.values(descriptors).some((d) => !('value' in d))) return invalid();
  return value as Record<string, unknown>;
}
export function judgmentText(value: unknown, max: number = LIMIT.referenceChars): string {
  if (typeof value !== 'string' || !value.length) return invalid();
  if (value.length > max) return large();
  return value;
}

/** Bounded JSON shape capture BEFORE inspecting discriminants or reading accessors. */
export function captureBrowserJudgmentJson(value: unknown): unknown {
  let nodes = 0; let chars = 0;
  const ancestors = new Set<object>();
  function capture(entry: unknown, depth: number): unknown {
    if (++nodes > LIMIT.nodes || depth > LIMIT.depth) return large();
    if (typeof entry === 'string') { chars += entry.length; if (chars > LIMIT.textChars) return large(); return entry; }
    if (entry === null || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : invalid();
    if (!entry || typeof entry !== 'object' || ancestors.has(entry)) return invalid();
    const array = Array.isArray(entry);
    const proto: unknown = Object.getPrototypeOf(entry);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Object.getOwnPropertySymbols(entry).length || Object.values(descriptors).some((d) => !('value' in d))) return invalid();
    ancestors.add(entry);
    try {
      if (array) {
        const length: unknown = descriptors.length?.value;
        if (typeof length !== 'number' || length > LIMIT.arrayItems) return large();
        if (Object.keys(descriptors).length !== length + 1) return invalid();
        return Object.freeze(Array.from({ length }, (_, index) => {
          const d = descriptors[String(index)]; if (!d) return invalid(); return capture(d.value, depth + 1);
        }));
      }
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, d] of Object.entries(descriptors)) {
        chars += key.length; if (chars > LIMIT.textChars) return large();
        if (!d.enumerable || key === '__proto__' || key === 'constructor' || key === 'prototype') return invalid();
        out[key] = capture(d.value, depth + 1);
      }
      return Object.freeze(out);
    } finally { ancestors.delete(entry); }
  }
  return capture(value, 0);
}

export function parseBrowserJudgmentRequest(value: unknown): BrowserJudgmentRequest {
  const request = judgmentRecord(captureBrowserJudgmentJson(value), ['protocolVersion', 'requestId', 'battery', 'batteryVersion', 'input']);
  if (!Number.isInteger(request.protocolVersion)) return invalid();
  if (request.protocolVersion !== 1) throw new BrowserJudgmentError('JUDGMENT_PROTOCOL_VERSION_UNSUPPORTED');
  const requestId = judgmentText(request.requestId, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return invalid();
  const battery = judgmentText(request.battery, 128);
  if (!(BROWSER_JUDGMENT_BATTERY_IDS as readonly string[]).includes(battery)) throw new BrowserJudgmentError('JUDGMENT_BATTERY_UNKNOWN');
  if (!Number.isInteger(request.batteryVersion) || Number(request.batteryVersion) < 1) return invalid();
  if (request.batteryVersion !== 1) throw new BrowserJudgmentError('JUDGMENT_BATTERY_VERSION_UNSUPPORTED');
  if (battery === 'webui.code.language' || battery === 'webui.voice.speech-seams') {
    const input = judgmentRecord(request.input, ['sessionId', 'messageId', 'start', 'end', 'contentDigest', ...(battery === 'webui.voice.speech-seams' ? ['cursor'] : [])]);
    if (battery === 'webui.voice.speech-seams' && (typeof input.cursor !== 'number' || !Number.isInteger(input.cursor) || input.cursor < 0 || input.cursor >= 4096 || input.cursor % 64 !== 0)) return invalid();
    judgmentText(input.sessionId); judgmentText(input.messageId);
    if (typeof input.contentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.contentDigest)
      || typeof input.start !== 'number' || !Number.isInteger(input.start) || input.start < 0
      || typeof input.end !== 'number' || !Number.isInteger(input.end) || input.end <= input.start || input.end > 1_000_000) return invalid();
  } else if ((battery === 'webui.config.credential-key' || battery === 'webui.settings.card-material-key')) {
    const input = judgmentRecord(request.input, ['keys']);
    if (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 64) return invalid();
    const seen = new Set<string>();
    for (const key of input.keys) { const name = judgmentText(key, 256); if (seen.has(name)) return invalid(); seen.add(name); }
  } else if ((battery === 'webui.credentials.provider-key' || battery === 'webui.models.catalog-provider-match')) {
    const input = judgmentRecord(request.input, ['providerId', 'keys']); judgmentText(input.providerId, 128);
    if (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 64) return invalid();
    const seen = new Set<string>();
    for (const key of input.keys) { const name = judgmentText(key, 256); if (seen.has(name)) return invalid(); seen.add(name); }
  } else if (battery === 'webui.pwa.install-platform') {
    const input = judgmentRecord(request.input, ['userAgent', 'platform', 'maxTouchPoints']);
    judgmentText(input.userAgent, 2048);
    if (typeof input.platform !== 'string' || input.platform.length > 128 || typeof input.maxTouchPoints !== 'number'
      || !Number.isInteger(input.maxTouchPoints) || input.maxTouchPoints < 0 || input.maxTouchPoints > 256) return invalid();
  } else if (battery === 'webui.errors.daemon-refusal') {
    const input = judgmentRecord(request.input, ['errorRef']); judgmentText(input.errorRef);
  } else if (battery === 'webui.mail.reply-subject') {
    const input = judgmentRecord(request.input, ['subjectRef']); judgmentText(input.subjectRef);
  } else if (battery === 'webui.status.badge-tone') {
    const input = judgmentRecord(request.input, ['vocabulary', 'source']);
    if (input.vocabulary !== 'badge' && input.vocabulary !== 'library-dot') return invalid();
    const source = input.source as Record<string, unknown> | null;
    if (source?.kind === 'catalog') judgmentText(judgmentRecord(source, ['kind', 'labelId']).labelId);
    else if (source?.kind === 'daemon') judgmentText(judgmentRecord(source, ['kind', 'statusRef']).statusRef);
    else return invalid();
  } else {
    const input = judgmentRecord(request.input, ['query', 'registryVersion', 'candidates']);
    judgmentText(input.registryVersion);
    const query = input.query as Record<string, unknown> | null;
    if (query?.kind === 'inline') judgmentText(judgmentRecord(query, ['kind', 'text']).text, LIMIT.queryChars);
    else if (query?.kind === 'reference') judgmentText(judgmentRecord(query, ['kind', 'queryRef']).queryRef);
    else return invalid();
    if (!Array.isArray(input.candidates) || input.candidates.length < 1) return invalid();
    if (input.candidates.length > LIMIT.candidates) return large();
    const ids = new Set<string>();
    for (const item of input.candidates) {
      const candidate = item as Record<string, unknown> | null;
      let id: string;
      if (candidate?.kind === 'builtin') id = `builtin:${judgmentText(judgmentRecord(candidate, ['kind', 'commandId']).commandId)}`;
      else if (candidate?.kind === 'chat') id = `chat:${judgmentText(judgmentRecord(candidate, ['kind', 'sessionId']).sessionId)}`;
      else return invalid();
      if (ids.has(id)) return invalid(); ids.add(id);
    }
  }
  return request as unknown as BrowserJudgmentRequest;
}
