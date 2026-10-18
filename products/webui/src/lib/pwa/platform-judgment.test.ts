import { afterEach, expect, mock, test } from 'bun:test';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { invalidateClientLifetime } from '../client-lifetime';
type Request = BrowserJudgmentRequest<'webui.pwa.install-platform'>;
let calls: { input: Request; signal: AbortSignal }[] = [];
let transport: (input: Request, signal: AbortSignal) => Promise<unknown> = async input => response(input);
mock.module('../goodvibes', () => ({ runBrowserJudgment: (input: Request, signal: AbortSignal) => { calls.push({ input, signal }); return transport(input, signal); } }));
const { readInstallPlatform, readPlatformResponse } = await import('./platform-judgment');
const request = (): Request => ({ protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.pwa.install-platform', batteryVersion: 1,
  input: { userAgent: 'Macintosh synthetic iPad', platform: 'MacIntel', maxTouchPoints: 5 } });
function response(input: Request, platform = 'ios-share-menu', held = false) {
  return { protocolVersion: 1, batteryVersion: 1, requestId: input.requestId, battery: input.battery,
    status: held ? 'held' : 'settled', ...(held ? { reason: 'uncertain' } : { value: { platform } }),
    readings: { platform: { kind: 'choice', choice: platform, confidence: held ? 0.5 : 0.99,
      probabilities: { 'ios-share-menu': platform === 'ios-share-menu' ? 0.99 : 0.01, other: platform === 'other' ? 0.99 : 0.01 }, outcome: held ? 'confirm' : 'act' } },
    outcome: held ? 'confirm' : 'act', evidence: [{ decisionId: 'fixture', model: 'fixture', requestedModel: 'fixture', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 }] };
}
afterEach(() => { calls = []; transport = async input => response(input); });
test.each(['ios-share-menu', 'other'])('accepts only a genuine-shaped %s reading', platform => {
  const input = request(); expect(readPlatformResponse(input, response(input, platform))).toEqual({ status: 'ready', platform });
});
test('held readings offer no instructions', () => { const input = request(); expect(readPlatformResponse(input, response(input, 'ios-share-menu', true))).toEqual({ status: 'held' }); });
test.each(['request', 'value', 'distribution', 'reading', 'evidence'])('rejects %s substitution', kind => {
  const input = request(); const raw = response(input);
  if (kind === 'request') raw.requestId = crypto.randomUUID();
  if (kind === 'value') Object.assign(raw, { value: { platform: 'other' } });
  if (kind === 'distribution') raw.readings.platform.probabilities.other = 0.5;
  if (kind === 'reading') raw.readings.platform.outcome = 'confirm';
  if (kind === 'evidence') raw.evidence = [];
  expect(readPlatformResponse(input, raw)).toBeUndefined();
});
test('platform instructions need no transport and survive an unrelated host replacement', async () => {
  const result = await readInstallPlatform(request().input, new AbortController().signal);
  expect(result.status).toBe('ready'); if (result.status !== 'ready') throw new Error('Missing local platform');
  expect(result.platform).toBe('ios-share-menu'); expect(calls).toHaveLength(0);
  invalidateClientLifetime(); expect(result.isCurrent()).toBe(true);
});
test('cancellation and changed browser metadata expire local platform facts', async () => {
  const input = request().input; const abort = new AbortController();
  const result = await readInstallPlatform(input, abort.signal);
  if (result.status !== 'ready') throw new Error('Missing local platform');
  Object.assign(input, { platform: 'Linux x86_64' }); expect(result.isCurrent()).toBe(false);
  abort.abort(); expect(await readInstallPlatform(request().input, abort.signal)).toEqual({ status: 'held' });
});
test('desktop Mac and Android do not get iOS instructions', async () => {
  for (const input of [{ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 }, { userAgent: 'Android', platform: 'Linux aarch64', maxTouchPoints: 5 }]) {
    const result = await readInstallPlatform(input, new AbortController().signal);
    expect(result.status === 'ready' && result.platform).toBe('other');
  }
  expect(calls).toHaveLength(0);
});

test('array-coerced choices and outcomes are never accepted', () => {
  const input = request();
  for (const property of ['choice', 'outcome'] as const) {
    const raw = response(input);
    Object.assign(raw.readings.platform, { [property]: [raw.readings.platform[property]] });
    expect(readPlatformResponse(input, raw)).toBeUndefined();
  }
});

test('the shared approximate-unit Choice policy admits the original platform values', () => {
  const input = request(); const raw = response(input);
  raw.readings.platform.probabilities = { 'ios-share-menu': 0.99, other: 0 };
  const original = structuredClone(raw);
  expect(readPlatformResponse(input, raw)).toEqual({ status: 'ready', platform: 'ios-share-menu' });
  expect(raw).toEqual(original);
});

test.each(['negative', 'over-one', 'non-finite', 'non-maximal', 'unknown-choice', 'missing-option', 'extra-option', 'outside-total', 'invalid-confidence'])(
  'rejects %s platform Choice evidence', kind => {
    const input = request(); const raw = response(input); const reading = raw.readings.platform;
    if (kind === 'negative') reading.probabilities = { 'ios-share-menu': 1, other: -0.001 };
    if (kind === 'over-one') reading.probabilities = { 'ios-share-menu': 1.001, other: 0 };
    if (kind === 'non-finite') reading.probabilities = { 'ios-share-menu': NaN, other: 0 };
    if (kind === 'non-maximal') reading.probabilities = { 'ios-share-menu': 0.5, other: 0.5000000001 };
    if (kind === 'unknown-choice') { reading.choice = 'invented'; Object.assign(raw, { value: { platform: 'invented' } }); }
    if (kind === 'missing-option') Object.assign(reading, { probabilities: { 'ios-share-menu': 1 } });
    if (kind === 'extra-option') Object.assign(reading, { probabilities: { ...reading.probabilities, invented: 0 } });
    if (kind === 'outside-total') reading.probabilities = { 'ios-share-menu': 0.98, other: 0 };
    if (kind === 'invalid-confidence') reading.confidence = -0.01;
    expect(readPlatformResponse(input, raw)).toBeUndefined();
  });
