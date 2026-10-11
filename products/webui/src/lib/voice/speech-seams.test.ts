import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { readSpeechSeams, readSpeechSeamsResponse } from './speech-seams';
import { tokenStore } from '../goodvibes';
const originalFetch = globalThis.fetch;
type Request = BrowserJudgmentRequest<'webui.voice.speech-seams'>;
const paragraph = 'Dr. Rivera paused… then said “Go.” Next came silence.';
function wire(request: Request, text = paragraph) {
  const candidates = [...text.matchAll(/\s+/g)].map(match => match.index!); candidates.push(text.length);
  const selected = candidates.slice(request.input.cursor, request.input.cursor + 64);
  const yes = (offset: number) => offset === text.indexOf(' Next') || offset === text.length;
  return { ...request, input: undefined, protocolVersion: 1, requestId: request.requestId, battery: request.battery, batteryVersion: 1,
    status: 'settled', outcome: 'act', value: { endOffsets: selected.filter(yes), nextCursor: request.input.cursor + 64 < candidates.length ? request.input.cursor + 64 : null },
    readings: Object.fromEntries(selected.map((offset, i) => [`seam_${i}`, { kind: 'yes-no', probability: yes(offset) ? 0.999 : 0.001, verdict: yes(offset) ? 'yes' : 'no', outcome: 'act' }])),
    evidence: [{ decisionId: 'offline-seam', model: 'fixture', requestedModel: 'fixture', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 }],
  };
}
function response(request: Request, text = paragraph) { const body = wire(request, text); delete (body as { input?: unknown }).input; return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }); }
beforeEach(async () => { await tokenStore.setToken('offline-speech-token'); });
afterEach(async () => { globalThis.fetch = originalFetch; await tokenStore.clearToken(); });
test('real authenticated route sends bounded identities and digest, never the paragraph', async () => {
  let body = ''; let authorization: string | null = null;
  globalThis.fetch = (async (_url, init) => { body = String(init?.body); authorization = new Headers(init?.headers).get('Authorization'); return response(JSON.parse(body) as Request); }) as typeof fetch;
  expect(await readSpeechSeams({ sessionId: 'chat', messageId: 'message', content: paragraph }, 0, paragraph.length, new AbortController().signal)).toEqual([paragraph.indexOf(' Next'), paragraph.length]);
  expect(body).not.toContain('Rivera'); expect(body.length).toBeLessThan(500); expect(String(authorization)).toBe('Bearer offline-speech-token');
});
test.each(['cancel', 'identity'] as const)('%s cannot publish a late valid answer', async kind => {
  const started = Promise.withResolvers<undefined>(); const answer = Promise.withResolvers<undefined>(); const abort = new AbortController();
  globalThis.fetch = (async (_url, init) => { const request = JSON.parse(String(init?.body)) as Request; started.resolve(undefined); await answer.promise; return response(request); }) as typeof fetch;
  const pending = readSpeechSeams({ sessionId: 'chat', messageId: 'message', content: paragraph }, 0, paragraph.length, abort.signal);
  await started.promise; if (kind === 'cancel') abort.abort(); else await tokenStore.setToken('offline-other-owner'); answer.resolve(undefined); await expect(pending).rejects.toBeDefined();
});
test('paging validates each batch and retains no raw text in requests', async () => {
  const text = Array.from({ length: 130 }, () => 'word').join(' '); const cursors: number[] = [];
  globalThis.fetch = (async (_url, init) => { const request = JSON.parse(String(init?.body)) as Request; cursors.push(request.input.cursor); expect(String(init?.body)).not.toContain('word'); return response(request, text); }) as typeof fetch;
  expect(await readSpeechSeams({ sessionId: 'chat', messageId: 'message', content: text }, 0, text.length, new AbortController().signal)).toEqual([text.length]);
  expect(cursors).toEqual([0, 64, 128]);
});
test('malformed offsets, evidence, unknown fields and foreign identities are unavailable', () => {
  const request: Request = { protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.voice.speech-seams', batteryVersion: 1, input: { sessionId: 's', messageId: 'm', start: 0, end: paragraph.length, contentDigest: 'a'.repeat(64), cursor: 0 } };
  const valid = JSON.parse(JSON.stringify(wire(request)));
  expect(readSpeechSeamsResponse(request, paragraph, valid)).toEqual([paragraph.indexOf(' Next'), paragraph.length]);
  for (const invalid of [{ ...valid, requestId: crypto.randomUUID() }, { ...valid, evidence: [] }, { ...valid, extra: true }, { ...valid, value: { ...valid.value, endOffsets: [3] } }, { ...valid, readings: { ...valid.readings, seam_0: { kind: 'yes-no', probability: 0.5, verdict: 'yes', outcome: 'act' } } }]) expect(readSpeechSeamsResponse(request, paragraph, invalid)).toBeUndefined();
});
