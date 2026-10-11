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
test.each(['cancel', 'client-change'])('%s aborts pending interpretation and rejects late answers', async kind => {
  const barrier = Promise.withResolvers<unknown>(); transport = () => barrier.promise;
  const abort = new AbortController(); const pending = readInstallPlatform(request().input, abort.signal);
  await Promise.resolve(); if (kind === 'cancel') abort.abort(); else invalidateClientLifetime();
  expect(calls[0]!.signal.aborted).toBe(true); barrier.resolve(response(calls[0]!.input));
  expect(await pending).toEqual({ status: 'unavailable' });
});
test('the adopted interpretation expires with its selected host identity', async () => {
  const result = await readInstallPlatform(request().input, new AbortController().signal);
  expect(result.status).toBe('ready'); if (result.status !== 'ready') throw new Error('Missing fixture reading');
  expect(result.isCurrent()).toBe(true); invalidateClientLifetime(); expect(result.isCurrent()).toBe(false);
});

test('array-coerced choices and outcomes are never accepted', () => {
  const input = request();
  for (const property of ['choice', 'outcome'] as const) {
    const raw = response(input);
    Object.assign(raw.readings.platform, { [property]: [raw.readings.platform[property]] });
    expect(readPlatformResponse(input, raw)).toBeUndefined();
  }
});
