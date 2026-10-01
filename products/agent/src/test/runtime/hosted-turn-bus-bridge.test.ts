/**
 * hosted-turn-bus-bridge.test.ts
 *
 * A daemon-hosted turn's frames only reach anything watching this process's
 * own `events.turns` (spoken output, notably, see audio/spoken-turn-wiring.ts)
 * if something republishes them there; hosted-frame-render.ts only reads them
 * to update the conversation transcript. These tests check the republishing
 * directly (frame in, envelope out) and, end to end, that a hosted turn's
 * frames actually reach the spoken-turn controller the way a local turn's do.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createUiRuntimeEvents } from '@/runtime/index.ts';
import { bridgeHostedFrameOntoRuntimeBus } from '../../runtime/client/hosted-turn-bus-bridge.ts';
import { wireSpokenTurnRuntime } from '../../audio/spoken-turn-wiring.ts';
import type { HostedSessionFrame } from '../../runtime/client/hosted-frame-render.ts';
import type { VoiceAudioChunk, VoiceSynthesisRequest, VoiceSynthesisStreamResult } from '@goodvibes-jev/engine/sdk/platform/voice';
import type { StreamingAudioPlayer } from '../../audio/player.ts';

function frame(type: string, payload: Record<string, unknown> = {}): HostedSessionFrame {
  return { type, payload };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('bridgeHostedFrameOntoRuntimeBus', () => {
  test('republishes TURN_SUBMITTED, STREAM_DELTA and TURN_COMPLETED as the SDK turn events they mirror', async () => {
    const bus = new RuntimeEventBus();
    const events = createUiRuntimeEvents(bus);
    const seen: Array<{ type: string; turnId: string }> = [];
    events.turns.on('TURN_SUBMITTED', (event) => seen.push({ type: event.type, turnId: event.turnId }));
    events.turns.on('STREAM_DELTA', (event) => seen.push({ type: event.type, turnId: event.turnId }));
    events.turns.on('TURN_COMPLETED', (event) => seen.push({ type: event.type, turnId: event.turnId }));

    const options = { runtimeBus: bus, sessionId: 'local-session', source: 'goodvibes-agent' };
    bridgeHostedFrameOntoRuntimeBus(frame('TURN_SUBMITTED', { turnId: 't1', prompt: 'hello' }), options);
    bridgeHostedFrameOntoRuntimeBus(frame('STREAM_DELTA', { turnId: 't1', content: 'Hi', accumulated: 'Hi' }), options);
    bridgeHostedFrameOntoRuntimeBus(frame('TURN_COMPLETED', { turnId: 't1', response: 'Hi', stopReason: 'completed' }), options);

    await drain();

    expect(seen).toEqual([
      { type: 'TURN_SUBMITTED', turnId: 't1' },
      { type: 'STREAM_DELTA', turnId: 't1' },
      { type: 'TURN_COMPLETED', turnId: 't1' },
    ]);
  });

  test('a frame with no turnId is ignored rather than guessed at', async () => {
    const bus = new RuntimeEventBus();
    const events = createUiRuntimeEvents(bus);
    let fired = false;
    events.turns.on('STREAM_DELTA', () => { fired = true; });

    bridgeHostedFrameOntoRuntimeBus(frame('STREAM_DELTA', { content: 'no turn id', accumulated: 'no turn id' }), {
      runtimeBus: bus,
      sessionId: 'local-session',
      source: 'goodvibes-agent',
    });

    await drain();
    expect(fired).toBe(false);
  });

  test('a frame type outside the bridged set is ignored', async () => {
    const bus = new RuntimeEventBus();
    const events = createUiRuntimeEvents(bus);
    let fired = false;
    events.turns.on('LLM_RESPONSE_RECEIVED', () => { fired = true; });

    bridgeHostedFrameOntoRuntimeBus(frame('LLM_RESPONSE_RECEIVED', { turnId: 't1', provider: 'anthropic', model: 'x' }), {
      runtimeBus: bus,
      sessionId: 'local-session',
      source: 'goodvibes-agent',
    });

    await drain();
    expect(fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End to end: a hosted turn's frames reach the spoken-turn controller
// ---------------------------------------------------------------------------

function makeFakeVoiceService() {
  const synthesized: string[] = [];
  const voiceService = {
    async synthesizeStream(_providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      synthesized.push(request.text);
      async function* chunks(): AsyncIterable<VoiceAudioChunk> {
        yield { data: new TextEncoder().encode(request.text), sequence: 1, format: 'mp3' };
      }
      return { providerId: 'fake', mimeType: 'audio/mpeg', format: 'mp3', chunks: chunks(), metadata: {} };
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
      for await (const chunk of chunks) played.push(new TextDecoder().decode(chunk.data));
    },
    stop() {},
    async waitForDrain() {},
  };
  return { player, played };
}

describe('a daemon-hosted turn speaks through the same bus a local turn uses', () => {
  test('always-speak mode synthesizes and plays a hosted turn routed through the bridge', async () => {
    const bus = new RuntimeEventBus();
    const events = createUiRuntimeEvents(bus);
    const { voiceService, synthesized } = makeFakeVoiceService();
    const { player, played } = makeFakePlayer();

    const runtime = wireSpokenTurnRuntime({
      voiceService: voiceService as never,
      configManager: {
        get(key: string) {
          if (key === 'ui.voiceEnabled') return true;
          if (key === 'tts.provider') return 'fake';
          if (key === 'tts.voice') return '';
          return '';
        },
      } as never,
      events,
      notify: () => {},
      playerFactory: () => player,
    });

    // No local orchestrator ran this turn, everything below is exactly what
    // a daemon-hosted turn's SSE stream would hand the router as frames.
    const bridgeOptions = { runtimeBus: bus, sessionId: 'local-session', source: 'goodvibes-agent' };
    bridgeHostedFrameOntoRuntimeBus(frame('TURN_SUBMITTED', { turnId: 'hosted-t1', prompt: 'what is the weather' }), bridgeOptions);
    bridgeHostedFrameOntoRuntimeBus(frame('STREAM_DELTA', { turnId: 'hosted-t1', content: 'It is sunny.', accumulated: 'It is sunny.' }), bridgeOptions);
    bridgeHostedFrameOntoRuntimeBus(frame('TURN_COMPLETED', { turnId: 'hosted-t1', response: 'It is sunny.', stopReason: 'completed' }), bridgeOptions);

    await drain();

    expect(synthesized.length).toBeGreaterThan(0);
    expect(played.join('')).toContain('It is sunny.');

    for (const unsub of runtime.unsubs) unsub();
  });
});
