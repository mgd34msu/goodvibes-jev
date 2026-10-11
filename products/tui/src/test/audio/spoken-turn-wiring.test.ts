/**
 * spoken-turn-wiring.test.ts
 *
 * Integration smoke test for wireSpokenTurnRuntime. Verifies the full wiring
 * seam: TURN_SUBMITTED → STREAM_DELTA → TURN_COMPLETED with a fake
 * voiceService and injected player factory. Asserts audio bytes reach the
 * player without spawning any real subprocess.
 */
import { describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { VoiceAudioChunk, VoiceSynthesisRequest, VoiceSynthesisStreamResult } from '@goodvibes-jev/engine/sdk/platform/voice';
import type { StreamingAudioPlayer } from '../../audio/player.ts';
import { wireSpokenTurnRuntime } from '../../audio/spoken-turn-wiring.ts';

// ---------------------------------------------------------------------------
// Minimal fake events surface
// ---------------------------------------------------------------------------

type Handler<E> = (event: E) => void;

function makeFakeEvents() {
  const listeners = new Map<string, Handler<unknown>[]>();

  function on(type: string, handler: Handler<unknown>): () => void {
    const existing = listeners.get(type) ?? [];
    existing.push(handler);
    listeners.set(type, existing);
    return () => {
      const arr = listeners.get(type);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  function emit(type: string, event: unknown): void {
    for (const handler of listeners.get(type) ?? []) handler(event);
  }

  const turns = {
    on: (type: string, handler: Handler<unknown>) => on(type, handler),
  };

  return { turns: turns as never, emit };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* audioChunks(text: string): AsyncIterable<VoiceAudioChunk> {
  yield {
    data: new TextEncoder().encode(text),
    sequence: 1,
    format: 'mp3',
  };
}

function makeFakeVoiceService() {
  const synthesized: string[] = [];
  const voiceService = {
    async synthesizeStream(_providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      synthesized.push(request.text);
      return {
        providerId: 'fake',
        mimeType: 'audio/mpeg',
        format: 'mp3',
        chunks: audioChunks(request.text),
        metadata: {},
      };
    },
  };
  return { voiceService, synthesized };
}

function makeFakePlayer(): { player: StreamingAudioPlayer; played: string[] } {
  const played: string[] = [];
  const player: StreamingAudioPlayer = {
    label: 'fake-player',
    available: true,
    async play(chunks) {
      for await (const chunk of chunks) {
        played.push(new TextDecoder().decode(chunk.data));
      }
    },
    stop() {},
    async waitForDrain() {},
  };
  return { player, played };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wireSpokenTurnRuntime integration seam', () => {
  test('TURN_SUBMITTED → STREAM_DELTA → TURN_COMPLETED delivers audio bytes to player', async () => {
    const { voiceService, synthesized } = makeFakeVoiceService();
    const { player, played } = makeFakePlayer();
    const events = makeFakeEvents();
    const messages: string[] = [];

    const runtime = wireSpokenTurnRuntime({
      voiceService,
      configManager: {
        get(key: string) {
          if (key === 'ui.voiceEnabled') return false;
          if (key === 'tts.provider') return 'fake';
          if (key === 'tts.voice') return '';
          return '';
        },
      } as never,
      events: { turns: events.turns } as never,
      notify: (msg) => messages.push(msg),
      playerFactory: () => player,
    });

    // Arm the turn manually (always-speak is off; simulate /tts <prompt>)
    expect(runtime.submitNextTurn('hello world')).toBe(true);

    events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-wiring-1', prompt: 'hello world' });
    events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'turn-wiring-1', content: 'Hello, world.', accumulated: 'Hello, world.' });
    events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-wiring-1', response: 'Hello, world.', stopReason: 'completed' });

    await drain();

    expect(synthesized.length).toBeGreaterThan(0);
    expect(played.length).toBeGreaterThan(0);
    expect(played.join('')).toContain('Hello, world.');

    // Clean up subscriptions
    for (const unsub of runtime.unsubs) unsub();
  });

  test('always-speak mode arms turns automatically on TURN_SUBMITTED when ui.voiceEnabled is true', async () => {
    const { voiceService, synthesized } = makeFakeVoiceService();
    const { player, played } = makeFakePlayer();
    const events = makeFakeEvents();

    const runtime = wireSpokenTurnRuntime({
      voiceService,
      configManager: {
        get(key: string) {
          if (key === 'ui.voiceEnabled') return true; // always-speak ON
          if (key === 'tts.provider') return 'fake';
          if (key === 'tts.voice') return '';
          return '';
        },
      } as never,
      events: { turns: events.turns } as never,
      notify: () => {},
      playerFactory: () => player,
    });

    // No manual submitNextTurn call, always-speak mode handles it
    events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-auto', prompt: 'auto spoken' });
    events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'turn-auto', content: 'Auto response.', accumulated: 'Auto response.' });
    events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-auto', response: 'Auto response.', stopReason: 'completed' });

    await drain();

    expect(synthesized.length).toBeGreaterThan(0);
    expect(played.join('')).toContain('Auto response.');

    for (const unsub of runtime.unsubs) unsub();
  });

  test('always-speak off does not auto-arm turns', async () => {
    const { voiceService, synthesized } = makeFakeVoiceService();
    const { player, played } = makeFakePlayer();
    const events = makeFakeEvents();

    wireSpokenTurnRuntime({
      voiceService,
      configManager: {
        get(key: string) {
          if (key === 'ui.voiceEnabled') return false; // always-speak OFF
          return '';
        },
      } as never,
      events: { turns: events.turns } as never,
      notify: () => {},
      playerFactory: () => player,
    });

    // No submitNextTurn, always-speak is off, nothing should synthesize
    events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-silent', prompt: 'silent' });
    events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'turn-silent', content: 'Silent.', accumulated: 'Silent.' });
    events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-silent', response: 'Silent.', stopReason: 'completed' });

    await drain();

    expect(synthesized).toHaveLength(0);
    expect(played).toHaveLength(0);
  });

  test('unsubs unregister all event handlers', () => {
    const { voiceService } = makeFakeVoiceService();
    const { player } = makeFakePlayer();
    const events = makeFakeEvents();

    const runtime = wireSpokenTurnRuntime({
      voiceService,
      configManager: { get: () => false } as never,
      events: { turns: events.turns } as never,
      notify: () => {},
      playerFactory: () => player,
    });

    expect(runtime.unsubs.length).toBeGreaterThan(0);
    for (const unsub of runtime.unsubs) unsub();
    // After unsubscribing no throws should occur from emitting events
    expect(() => {
      events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'x', prompt: 'x' });
    }).not.toThrow();
  });
});

function semanticFailurePort(category: string, billing = false) {
  return fakePort((name, question) => {
    if (name === 'category') return choiceAnswer(question, category, 0.99);
    if (name === 'connection_failure') return choiceAnswer(question, 'none', 0.99);
    return noulAnswer(name === 'billing' && billing ? 0.99 : 0.01);
  });
}

function failingRuntime(error: unknown) {
  const requests: VoiceSynthesisRequest[] = [];
  const { player, played } = makeFakePlayer();
  const events = makeFakeEvents();
  const messages: string[] = [];
  const runtime = wireSpokenTurnRuntime({
    voiceService: { async synthesizeStream(_provider: string | undefined, request: VoiceSynthesisRequest) {
      requests.push(request);
      if (requests.length === 1) throw error;
      return { providerId: 'fake', mimeType: 'audio/mpeg', format: 'mp3', chunks: audioChunks(request.text), metadata: {} };
    } } as never,
    configManager: { get(key: string) { return key === 'ui.voiceEnabled' ? true : ''; } } as never,
    events: { turns: events.turns } as never,
    notify: (message) => messages.push(message), playerFactory: () => player,
  });
  return { runtime, requests, events, played, messages,
    speak(id = 'old') {
      events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: id, prompt: id });
      events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: id, content: `${id} answer.`, accumulated: `${id} answer.` });
      events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: id, response: `${id} answer.`, stopReason: 'completed' });
    },
    close() { runtime.stop(); for (const unsub of runtime.unsubs) unsub(); },
  };
}

describe('actual spoken wiring canonical retry semantics', () => {
  test.each([
    ['status', Object.assign(new Error('credentials'), { status: 503 }), 'authentication', false, true, 0],
    ['errno', Object.assign(new Error('credentials'), { code: 'ECONNRESET' }), 'authentication', false, true, 0],
    ['billing 429', Object.assign(new Error('rate limit concurrent 429'), { status: 429 }), 'billing', true, false, 1],
    ['rate limit 429', Object.assign(new Error('account details'), { status: 429 }), 'rate_limit', false, true, 1],
    ['contrary terminal wording', new Error('network timeout socket 429 concurrent'), 'authentication', false, false, 1],
    ['contrary retryable wording', new Error('The blue lantern is resting.'), 'service', false, true, 1],
  ] as const)('%s follows the shared controller through actual wiring', async (_label, error, category, billing, retry, readings) => {
    const fake = semanticFailurePort(category, billing);
    const previous = installJudgmentPort(fake.port);
    const h = failingRuntime(error);
    try {
      h.speak(); await drain();
      if (retry) await new Promise((resolve) => setTimeout(resolve, 1100));
      await drain();
      expect(fake.requests).toHaveLength(readings);
      expect(h.requests).toHaveLength(retry ? 2 : 1);
      expect(h.played).toEqual(retry ? ['old answer.'] : []);
      expect(h.messages.filter((message) => message.includes('Skipping'))).toHaveLength(retry ? 0 : 1);
      if (retry) {
        expect(h.requests[1]?.signal).toBe(h.requests[0]?.signal);
        expect(h.requests[1]?.metadata).toEqual(h.requests[0]?.metadata);
      }
    } finally { h.close(); installJudgmentPort(previous); }
  });

  test('unavailable reading reports once without a keyword retry', async () => {
    const previous = installJudgmentPort({ model: 'fake', ask: async () => { throw new Error('unavailable'); } });
    const h = failingRuntime(new Error('429 network timeout concurrent'));
    try {
      h.speak(); await drain();
      expect(h.requests).toHaveLength(1); expect(h.played).toEqual([]);
      expect(h.messages.filter((message) => message.includes('Skipping'))).toHaveLength(1);
    } finally { h.close(); installJudgmentPort(previous); }
  });

  test.each(['cancel', 'replacement'] as const)('%s while classifying blocks late audio and synthesis', async (mode) => {
    const fake = semanticFailurePort('service');
    let release = () => {};
    let signal: AbortSignal | undefined;
    const previous = installJudgmentPort({ ...fake.port, async ask(request) {
      signal = request.signal;
      await new Promise<void>((resolve) => { release = resolve; });
      return fake.port.ask(request);
    } });
    const h = failingRuntime(new Error('network'));
    try {
      h.speak(); await drain(); expect(signal).toBeDefined();
      if (mode === 'cancel') h.events.emit('TURN_CANCEL', { type: 'TURN_CANCEL', turnId: 'old', stopReason: 'cancelled' });
      else h.speak('new');
      expect(signal?.aborted).toBe(true);
      await drain(); release(); await drain();
      expect(h.requests).toHaveLength(mode === 'replacement' ? 2 : 1);
      expect(h.played).toEqual(mode === 'replacement' ? ['new answer.'] : []);
      expect(h.messages.filter((message) => message.includes('Skipping'))).toEqual([]);
    } finally { release(); h.close(); installJudgmentPort(previous); }
  });

  test('stop during semantic backoff prevents a late retry', async () => {
    const fake = semanticFailurePort('service');
    const previous = installJudgmentPort(fake.port);
    const h = failingRuntime(new Error('The blue lantern is resting.'));
    try {
      h.speak(); await drain(); expect(fake.requests).toHaveLength(1);
      h.runtime.stop();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(h.requests).toHaveLength(1); expect(h.played).toEqual([]);
      expect(h.messages.filter((message) => message.includes('Skipping'))).toEqual([]);
    } finally { h.close(); installJudgmentPort(previous); }
  });
});


test('live consumer awaits canonical speech seams before synthesis and honors cancellation', async () => {
  const source = 'Dr. Rivera paid 3.14 dollars. Next fragment';
  const fake = fakePort((name, _question, raw) => {
    const state = raw as { paragraph: string; candidates: number[] };
    return noulAnswer(state.paragraph.slice(0, state.candidates[Number(name.slice(5))]) === 'Dr. Rivera paid 3.14 dollars.' ? 0.99 : 0.01);
  });
  const previous = installJudgmentPort(fake.port);
  const events = makeFakeEvents();
  const { voiceService, synthesized } = makeFakeVoiceService();
  const { player, played } = makeFakePlayer();
  const runtime = wireSpokenTurnRuntime({ voiceService: voiceService as never, configManager: { get: () => false } as never,
    events: { turns: events.turns } as never, notify() {}, playerFactory: () => player });
  try {
    runtime.submitNextTurn('prompt');
    events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'seams', prompt: 'prompt' });
    events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'seams', content: source, accumulated: source });
    await drain();
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(synthesized).toEqual(['Dr. Rivera paid 3.14 dollars.']);
    expect(played).toEqual(['Dr. Rivera paid 3.14 dollars.']);
    events.emit('TURN_CANCEL', { type: 'TURN_CANCEL', turnId: 'seams', stopReason: 'cancelled' });
    events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'seams', response: source, stopReason: 'completed' });
    await drain();
    expect(synthesized).toHaveLength(1);
  } finally { runtime.stop(); runtime.unsubs.forEach(unsub => unsub()); installJudgmentPort(previous); }
});


test.each(['startup', 'notification'] as const)('consumer contains throwing %s callback without rejected event work', async mode => {
  const { voiceService } = makeFakeVoiceService(); const { player } = makeFakePlayer(); const events = makeFakeEvents();
  const runtime = wireSpokenTurnRuntime({ voiceService: voiceService as never,
    configManager: { get(key: string) {
      if (key === 'ui.voiceEnabled') return false;
      if (mode === 'startup') throw new Error('host config failed');
      return '';
    } } as never, events: { turns: events.turns } as never,
    notify() { throw new Error('host notify failed'); }, playerFactory: () => player });
  try {
    runtime.submitNextTurn('prompt');
    expect(() => events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'throws', prompt: 'prompt' })).not.toThrow();
    await drain();
    expect(() => events.emit('TURN_CANCEL', { type: 'TURN_CANCEL', turnId: 'throws', stopReason: 'cancelled' })).not.toThrow();
    await drain();
  } finally { runtime.stop(); runtime.unsubs.forEach(unsub => unsub()); }
});
