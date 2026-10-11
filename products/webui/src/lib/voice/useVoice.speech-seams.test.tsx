import { afterEach, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { useTts, type UseTtsResult } from './useVoice';
import { ttsEngine } from './tts-player';
import { tokenStore } from '../goodvibes';
const originalFetch = globalThis.fetch;
const originalAudio = Object.getOwnPropertyDescriptor(window, 'AudioContext');
type Request = BrowserJudgmentRequest<'webui.voice.speech-seams'>;
const sentences = Array.from({ length: 100 }, () => 'Dr. Rivera says “Go.”');
const text = sentences.join(' ');
const sentenceOffsets = sentences.map((_, index) => sentences.slice(0, index + 1).join(' ').length);
function validAnswer(request: Request) {
  const candidates = [...text.matchAll(/\s+/g)].map(match => match.index!); candidates.push(text.length);
  const selected = candidates.slice(request.input.cursor, request.input.cursor + 64);
  const yes = (offset: number) => sentenceOffsets.includes(offset);
  return new Response(JSON.stringify({ protocolVersion: 1, requestId: request.requestId, battery: request.battery, batteryVersion: 1,
    status: 'settled', outcome: 'act', value: { endOffsets: selected.filter(yes), nextCursor: request.input.cursor + 64 < candidates.length ? request.input.cursor + 64 : null },
    readings: Object.fromEntries(selected.map((offset, i) => [`seam_${i}`, { kind: 'yes-no', probability: yes(offset) ? 0.999 : 0.001, verdict: yes(offset) ? 'yes' : 'no', outcome: 'act' }])),
    evidence: [{ decisionId: `offline-seam-${request.input.cursor}`, model: 'fixture', requestedModel: 'fixture', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 }],
  }), { headers: { 'Content-Type': 'application/json' } });
}
let contexts = 0; let resumes = 0;
class FakeAudioContext {
  constructor() { contexts++; }
  currentTime = 0; destination = {};
  async decodeAudioData() { return { duration: 0.01 }; }
  async resume() { resumes++; } async close() {}
  createBufferSource() {
    return { buffer: null as unknown, connect() {}, stop() {}, onended: null as (() => void) | null,
      start() { queueMicrotask(() => this.onended?.()); } };
  }
}
function mount() {
  let voice!: UseTtsResult;
  function Harness({ content, sessionId, messageId }: { content: string; sessionId: string; messageId: string }) { voice = useTts({ sessionId, messageId, content }); return null; }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['voice', 'status'], {}); client.setQueryData(['voice', 'config'], {});
  const root = createRoot(document.createElement('div')); let mounted = true;
  const render = (content = text, sessionId = 'chat', messageId = 'message') => flushSync(() => root.render(<QueryClientProvider client={client}><Harness content={content} sessionId={sessionId} messageId={messageId} /></QueryClientProvider>));
  render();
  return { render, voice: () => voice, unmount: () => { if (mounted) { flushSync(() => root.unmount()); mounted = false; } client.clear(); } };
}
function idle() {
  if (ttsEngine.getState().id === null) return Promise.resolve(undefined);
  return new Promise<void>(resolve => { const unsubscribe = ttsEngine.subscribe(state => { if (state.id === null) { unsubscribe(); resolve(); } }); });
}
afterEach(async () => {
  globalThis.fetch = originalFetch; ttsEngine.stop(); await tokenStore.clearToken();
  if (originalAudio) Object.defineProperty(window, 'AudioContext', originalAudio); else Reflect.deleteProperty(window, 'AudioContext');
});
test.each(['stop', 'replace', 'session', 'token', 'unmount'] as const)('actual useTts %s cancels a started reader and rejects its valid late answer', async kind => {
  await tokenStore.setToken('offline-hook-token'); Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
  const started = Promise.withResolvers<undefined>(); const answer = Promise.withResolvers<undefined>(); let judgments = 0; let synth = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes('/judgment/')) { judgments++; const request = JSON.parse(String(init?.body)) as Request; started.resolve(undefined); await answer.promise; return validAnswer(request); }
    if (String(url).includes('/voice/tts')) synth++;
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const harness = mount();
  try {
    harness.voice().speak('message', text); await started.promise; expect(ttsEngine.getState()).toMatchObject({ id: 'message', phase: 'loading' });
    if (kind === 'replace') harness.render(text + ' changed');
    else if (kind === 'session') harness.render(text, 'other-chat');
    else if (kind === 'token') await tokenStore.setToken('offline-other-owner');
    else if (kind === 'stop') harness.voice().stop();
    else harness.unmount();
    expect(ttsEngine.getState().id).toBeNull(); answer.resolve(undefined); await new Promise(resolve => setTimeout(resolve, 0));
    expect(judgments).toBe(1); expect(synth).toBe(0); expect(ttsEngine.getState().error).toBeNull();
  } finally { answer.resolve(undefined); harness.unmount(); }
});
test.each(['success', 'repeat', 'new-source'] as const)('actual useTts %s flows through authenticated judgment, coalescing and synthesis', async kind => {
  await tokenStore.setToken('offline-hook-token'); Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
  const started = Promise.withResolvers<undefined>(); const oldAnswer = Promise.withResolvers<undefined>(); let judgments = 0; const spoken: string[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes('/judgment/')) {
      const request = JSON.parse(String(init?.body)) as Request; judgments++; expect(String(init?.body)).not.toContain('Rivera');
      if (kind !== 'success' && judgments === 1) { started.resolve(undefined); await oldAnswer.promise; }
      return validAnswer(request);
    }
    if (String(url).includes('/voice/tts')) { spoken.push((JSON.parse(String(init?.body)) as { text: string }).text); return new Response(new Uint8Array([1, 2])); }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const harness = mount();
  try {
    const beforeContexts = contexts; const beforeResumes = resumes;
    harness.voice().speak('message', text);
    expect(contexts).toBe(beforeContexts + 1); expect(resumes).toBe(beforeResumes + 1);
    if (kind !== 'success') {
      await started.promise;
      if (kind === 'repeat') harness.voice().speak('message', text);
      else { harness.render('Fresh reply.', 'chat-two', 'message-two'); harness.voice().speak('message-two', 'Fresh reply.'); }
    }
    await idle(); oldAnswer.resolve(undefined); await new Promise(resolve => setTimeout(resolve, 0));
    expect(ttsEngine.getState().error).toBeNull();
    if (kind === 'new-source') expect(spoken).toEqual(['Fresh reply.']);
    else { expect(spoken.length).toBe(2); expect(spoken.join(' ')).toBe(text); expect(spoken.every(segment => segment.length <= 1800)).toBe(true); }
    expect(judgments).toBeGreaterThan(0);
  } finally { oldAnswer.resolve(undefined); harness.unmount(); }
});
