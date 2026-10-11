import { afterEach, beforeEach, expect, test } from 'bun:test';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment/decisions';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { TtsTextChunker } from '../sdk/src/platform/voice/spoken-turn/text-chunker.js';
import { SpokenTurnController } from '../sdk/src/platform/voice/spoken-turn/controller.js';
import type { TurnEvent } from '../sdk/src/events/turn.js';
import type { VoiceSynthesisRequest } from '../sdk/src/platform/voice/types.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function reader(yes: (text: string, end: number) => boolean, probability?: number) {
  const fake = fakePort((name, _question, raw) => {
    const state = raw as { paragraph: string; candidates: number[] };
    return noulAnswer(probability ?? (yes(state.paragraph, state.candidates[Number(name.slice(5))]!) ? 0.99 : 0.01));
  });
  installJudgmentPort(fake.port); return fake;
}

test('streamed abbreviations and decimals retain meaning; only canonical yes releases a sentence', async () => {
  const source = 'Dr. Rivera paid 3.14 dollars. Next fragment';
  const fake = reader((text, end) => text.slice(0, end) === 'Dr. Rivera paid 3.14 dollars.');
  const chunker = new TtsTextChunker({ minBoundaryChars: 3 });
  expect(await chunker.push('Dr.')).toEqual([]);
  expect(await chunker.push(' Rivera paid 3.14 dollars. Next fragment')).toEqual(['Dr. Rivera paid 3.14 dollars.']);
  expect(await chunker.flushAll()).toEqual(['Next fragment']);
  expect(fake.requests.some(request => (request.state as { paragraph: string }).paragraph === source)).toBe(true);
});

test.each(['none', 'uncertain', 'unavailable'] as const)('%s never falls back to punctuation; latency remains mechanical', async kind => {
  if (kind !== 'unavailable') reader(() => false, kind === 'uncertain' ? 0.5 : 0.01);
  let now = 0;
  const chunker = new TtsTextChunker({ minBoundaryChars: 3, now: () => now, maxLatencyMs: 100 });
  expect(await chunker.push('Dr. Rivera.')).toEqual([]);
  now = 100;
  expect(await chunker.flushDue()).toEqual(['Dr. Rivera.']);
});

test('length cap wins even when model calls the whole source one sentence', async () => {
  reader(() => true);
  const chunker = new TtsTextChunker({ minBoundaryChars: 3, maxChunkChars: 18 });
  const chunks = [...await chunker.push('alpha beta gamma delta epsilon zeta'), ...await chunker.flushAll()];
  expect(chunks.every(text => text.length <= 18)).toBe(true);
  expect(chunks.join(' ')).toBe('alpha beta gamma delta epsilon zeta');
});

test.each(['fenced', 'long', 'split'] as const)('complete %s private tail is refused before sampling', async kind => {
  const fake = reader(() => kind !== 'split');
  const chunker = new TtsTextChunker({ minBoundaryChars: 3 });
  if (kind === 'split') expect(await chunker.push('Auth')).toEqual([]);
  const text = kind === 'fenced' ? 'Safe introduction.\n```\nAuthorization: Bearer private-fixture\n```'
    : kind === 'long' ? 'safe '.repeat(8000) + 'Authorization: Bearer private-fixture'
    : 'orization: Bearer private-fixture';
  await expect(chunker.push(text)).rejects.toBeDefined();
  expect(fake.requests).toHaveLength(kind === 'split' ? 1 : 0);
});

function harness() {
  const requests: VoiceSynthesisRequest[] = [], played: string[] = [];
  const config: Record<string, unknown> = { 'tts.provider': 'fixture', 'tts.voice': 'original', 'tts.speed': 1 };
  let timer: (() => void) | undefined;
  const controller = new SpokenTurnController({
    configManager: { get: (key: string) => config[key] } as never,
    voiceService: { async synthesizeStream(providerId, request) {
      requests.push(request);
      return { providerId: providerId ?? 'fixture', mimeType: 'audio/mpeg', format: 'mp3', metadata: {},
        chunks: (async function* () { yield { data: new TextEncoder().encode(request.text), sequence: 1, format: 'mp3' as const }; })() };
    } },
    sink: { label: 'fixture', available: true, stop() {}, async waitForDrain() {}, async play(chunks) {
      for await (const chunk of chunks) played.push(new TextDecoder().decode(chunk.data));
    } },
    setInterval: ((callback: () => void) => { timer = callback; return 1; }) as never,
    clearInterval: (() => {}) as never,
  });
  const send = (event: object) => controller.handleTurnEvent({ turnId: 'turn', ...event } as TurnEvent);
  const start = async () => { controller.submitNextTurn('prompt'); await send({ type: 'TURN_SUBMITTED', prompt: 'prompt' }); };
  return { controller, config, requests, played, send, start, timer: () => timer?.() };
}

test.each(['cancel', 'config', 'port', 'same-port', 'source'] as const)('%s during classification prevents synthesis and playback', async kind => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = reader(() => true); const originalAsk = fake.port.ask;
  fake.port.ask = async request => { entered.resolve(); await release.promise; return originalAsk(request); };
  let sourceCurrent = true;
  bindJudgmentPortAuthority(fake.port, () => ({ identity: {}, assertCurrent() { if (!sourceCurrent) throw new Error('source retired'); } }));
  const h = harness(); await h.start();
  const pending = h.send({ type: 'STREAM_DELTA', content: 'This complete sentence has enough text.' });
  await entered.promise;
  if (kind === 'cancel') h.controller.stop();
  if (kind === 'source') sourceCurrent = false;
  if (kind === 'config') h.config['tts.voice'] = 'replacement';
  if (kind === 'port') reader(() => true);
  if (kind === 'same-port') bindJudgmentPortAuthority(fake.port, () => ({ identity: {}, assertCurrent() {} }));
  release.resolve(); await pending; await tick();
  expect(h.requests).toEqual([]); expect(h.played).toEqual([]);
  h.controller.stop();
});

test('actual controller streams canonical seams to its bounded synthesis pipeline with original metadata', async () => {
  const fake = reader((text, end) => text.slice(0, end) === 'Dr. Rivera paid 3.14 dollars.');
  const h = harness(); await h.start();
  await h.send({ type: 'STREAM_DELTA', content: 'Dr. Rivera paid 3.14 dollars. Next fragment' });
  await tick();
  expect(fake.requests.length).toBeGreaterThan(0);
  expect(h.requests.map(request => request.text)).toEqual(['Dr. Rivera paid 3.14 dollars.']);
  expect(h.requests[0]).toMatchObject({ voiceId: 'original', speed: 1, metadata: { turnId: 'turn', source: 'goodvibes-sdk', sequence: 1 } });
  await h.send({ type: 'TURN_COMPLETED' }); await tick();
  expect(h.played.join(' ')).toBe('Dr. Rivera paid 3.14 dollars. Next fragment');
  h.controller.stop();
});

test('blocked synthesis keeps two slots and retires queued speech with its original port', async () => {
  const fake = reader(() => true);
  const hold = Promise.withResolvers<void>();
  let active = 0, peak = 0;
  const blocking = new SpokenTurnController({
    configManager: { get: () => '' } as never,
    voiceService: { async synthesizeStream() { active++; peak = Math.max(peak, active); await hold.promise; active--; throw new Error('fixture unavailable'); } },
    sink: { available: true, label: 'blocked', stop() {}, async waitForDrain() {}, async play() { throw new Error('must not play'); } },
    setInterval: (() => 1) as never, clearInterval: (() => {}) as never,
  });
  blocking.submitNextTurn('prompt');
  await blocking.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 'blocked', prompt: 'prompt' } as TurnEvent);
  for (let index = 0; index < 12; index++) {
    await blocking.handleTurnEvent({ type: 'STREAM_DELTA', turnId: 'blocked', content: `A complete fixture sentence number ${index}. `, accumulated: '' });
  }
  expect(peak).toBe(2);
  bindJudgmentPortAuthority(fake.port, () => ({ identity: {}, assertCurrent() {} }));
  hold.resolve(); await tick();
  expect(peak).toBe(2); expect(active).toBe(0);
  blocking.stop();
});

test('classification backlog is bounded and overload cannot publish late speech', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = reader(() => true); const ask = fake.port.ask;
  fake.port.ask = async request => { entered.resolve(); await release.promise; return ask(request); };
  const chunker = new TtsTextChunker({ minBoundaryChars: 3 });
  const first = chunker.push('Complete fixture sentence.').catch(() => []);
  await entered.promise;
  const queued = Array.from({ length: 300 }, () => chunker.push(' x').catch(() => []));
  release.resolve();
  expect((await Promise.all([first, ...queued])).flat()).toEqual([]);
});

test.each(['latency', 'completion', 'cap'] as const)('held reader cannot block mechanical %s or emit twice', async mode => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = reader(() => true); const ask = fake.port.ask;
  fake.port.ask = async request => { entered.resolve(); await release.promise; return ask(request); };
  let now = 0;
  const chunker = new TtsTextChunker({ minBoundaryChars: 3, maxChunkChars: 24, maxLatencyMs: 100, now: () => now });
  const first = chunker.push('First fragment');
  await entered.promise;
  now = 100;
  const next = mode === 'latency' ? chunker.flushDue()
    : mode === 'completion' ? chunker.flushAll() : chunker.push(' appended words over cap');
  const output = [...await first, ...await next, ...await chunker.flushAll()];
  expect(output.join(' ')).toBe(mode === 'cap' ? 'First fragment appended words over cap' : 'First fragment');
  release.resolve(); await tick();
  expect(await chunker.flushAll()).toEqual([]);
});

test('already over-cap source uses mechanical limit without waiting for a reader', async () => {
  const fake = reader(() => true);
  fake.port.ask = async () => new Promise(() => {});
  const chunker = new TtsTextChunker({ minBoundaryChars: 3, maxChunkChars: 12 });
  const chunks = await chunker.push('alpha beta gamma delta');
  expect(chunks.length).toBeGreaterThan(0);
  expect([...chunks, ...await chunker.flushAll()].join(' ')).toBe('alpha beta gamma delta');
});

test.each(['config', 'source', 'caller', 'exit-drain'] as const)('completed streaming playback fences %s while preserving authorized drain', async mode => {
  const fake = reader(() => true);
  let sourceCurrent = true;
  bindJudgmentPortAuthority(fake.port, () => ({ identity: {}, assertCurrent() { if (!sourceCurrent) throw new Error('retired source'); } }));
  const first = Promise.withResolvers<void>(), next = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>();
  const played: string[] = [];
  let voice = 'original';
  const configManager = { get: (key: string) => key === 'tts.voice' ? voice : '' };
  const controller = new SpokenTurnController({ configManager: configManager as never,
    voiceService: { async synthesizeStream() { return {
      providerId: 'fake', mimeType: 'audio/mpeg', format: 'mp3', metadata: {},
      chunks: (async function* () {
        yield { data: new TextEncoder().encode('first'), sequence: 1, format: 'mp3' as const };
        await next.promise;
        yield { data: new TextEncoder().encode('second'), sequence: 2, format: 'mp3' as const };
      })(),
    }; } },
    sink: { available: true, label: 'delayed', stop() {}, async waitForDrain() { await drained.promise; }, async play(chunks) {
      try { for await (const chunk of chunks) { played.push(new TextDecoder().decode(chunk.data)); first.resolve(); } }
      finally { drained.resolve(); }
    } }, setInterval: (() => 1) as never, clearInterval: (() => {}) as never,
  });
  controller.submitNextTurn('prompt');
  await controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 'audio', prompt: 'prompt' } as TurnEvent);
  const pushing = controller.handleTurnEvent({ type: 'STREAM_DELTA', turnId: 'audio', content: 'Complete response.', accumulated: '' });
  await controller.handleTurnEvent({ type: 'TURN_COMPLETED', turnId: 'audio' } as TurnEvent);
  await pushing; await first.promise;
  if (mode === 'config') voice = 'replacement';
  if (mode === 'source') sourceCurrent = false;
  if (mode === 'caller') configManager.get = () => '';
  const exiting = mode === 'exit-drain' ? controller.stopForExit() : undefined;
  next.resolve(); await drained.promise; await exiting; await tick();
  expect(played).toEqual(mode === 'exit-drain' ? ['first', 'second'] : ['first']);
  controller.stop();
});

test.each(['startup', 'notification'] as const)('throwing %s callback cannot reject an event handler', async mode => {
  const controller = new SpokenTurnController({
    configManager: { get() { if (mode === 'startup') throw new Error('host read failed'); return ''; } } as never,
    voiceService: { async synthesizeStream() { throw new Error('no audio needed'); } },
    sink: { available: true, label: 'fake', stop() {}, async waitForDrain() {}, async play() {} },
    notify() { throw new Error('host notification failed'); },
    setInterval: (() => 1) as never, clearInterval: (() => {}) as never,
  });
  controller.submitNextTurn('prompt');
  await expect(controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 'throwing', prompt: 'prompt' } as TurnEvent)).resolves.toBeUndefined();
  await expect(controller.handleTurnEvent({ type: 'TURN_CANCEL', turnId: 'throwing' } as TurnEvent)).resolves.toBeUndefined();
  controller.stop();
});

test.each(['latency', 'cap'] as const)('%s demand survives an intervening queued delta behind a held reader', async mode => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = reader(() => true); const ask = fake.port.ask;
  let calls = 0;
  fake.port.ask = async request => { calls++; entered.resolve(); await release.promise; return ask(request); };
  let now = 0;
  const chunker = new TtsTextChunker({ minBoundaryChars: 3, maxChunkChars: 24, maxLatencyMs: 100, now: () => now });
  const first = chunker.push('First fragment');
  await entered.promise;
  const intermediate = chunker.push(' plus');
  now = mode === 'latency' ? 100 : 0;
  // The cap is reached cumulatively: neither queued delta alone plus the
  // currently visible buffer crosses it, so pending-input accounting matters.
  const demand = mode === 'latency' ? chunker.flushDue() : chunker.push(' extra');
  const output = [...await first, ...await intermediate, ...await demand];
  expect(calls).toBe(1);
  output.push(...await chunker.flushAll());
  expect(output.join(' ')).toBe(mode === 'latency' ? 'First fragment plus' : 'First fragment plus extra');
  release.resolve(); await tick();
  expect(await chunker.flushAll()).toEqual([]);
});

test('exit cancels queued retry backoff immediately while audible drain remains blocked', async () => {
  reader(() => true);
  const drained = Promise.withResolvers<void>();
  const timers = new Map<number, () => void>(); let nextTimer = 0, requests = 0;
  const controller = new SpokenTurnController({
    configManager: { get: () => '' } as never,
    voiceService: { async synthesizeStream() { requests++; throw Object.assign(new Error('fixture unavailable'), { status: 503 }); } },
    sink: { available: true, label: 'held-drain', stop() {}, async waitForDrain() { await drained.promise; }, async play() {} },
    setInterval: (() => 1) as never, clearInterval: (() => {}) as never,
    setTimeout: ((callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; }) as never,
    clearTimeout: ((timer: number) => { timers.delete(timer); }) as never,
  });
  controller.submitNextTurn('prompt');
  await controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 'backoff', prompt: 'prompt' } as TurnEvent);
  const pushing = controller.handleTurnEvent({ type: 'STREAM_DELTA', turnId: 'backoff', content: 'Complete response.', accumulated: '' });
  await controller.handleTurnEvent({ type: 'TURN_COMPLETED', turnId: 'backoff' } as TurnEvent);
  await pushing; await tick();
  expect(timers.size).toBe(1); const lateTimer = [...timers.values()][0]!;
  const exiting = controller.stopForExit();
  expect(timers.size).toBe(0);
  lateTimer(); await tick(); expect(requests).toBe(1);
  drained.resolve(); await exiting;
});
