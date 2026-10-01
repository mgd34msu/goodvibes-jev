import { describe, expect, test } from 'bun:test';
import { TtsEngine, type AudioSink } from './tts-player';
import { scheduleTtsRequests, type TtsRun, type TtsSegmentResult } from './request-policy';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

/** A sink that records what it played and (optionally) gates each enqueue so a test can
 * hold playback mid-reply. */
class FakeSink implements AudioSink {
  enqueued: ArrayBuffer[] = [];
  gates: (() => void)[] = [];
  stopped = false;
  closed = false;
  constructor(private readonly immediate = true) {}
  enqueue(audio: ArrayBuffer): Promise<void> {
    this.enqueued.push(audio);
    if (this.immediate) return Promise.resolve();
    return new Promise<void>((resolve) => this.gates.push(resolve));
  }
  releaseAll(): void {
    while (this.gates.length) this.gates.shift()?.();
  }
  stop(): void {
    this.stopped = true;
    this.releaseAll();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** A scheduler stub that yields fixed results (resultFor resolves immediately), so the
 * player can be driven without any real synthesis. */
function fakeSchedule(results: TtsSegmentResult[]): typeof scheduleTtsRequests {
  const fn = (): TtsRun => ({
    total: results.length,
    resultFor: (i: number) => Promise.resolve(results[i]),
    results: () => Promise.resolve(results),
    cancel: () => undefined,
  });
  return fn as unknown as typeof scheduleTtsRequests;
}

const ok = (index: number, text: string): TtsSegmentResult => ({ index, text, status: 'ok', audio: bytes(text), attempts: 1 });
const skipped = (index: number, text: string): TtsSegmentResult => ({ index, text, status: 'skipped', attempts: 3, error: new Error('429') });
const dummySynth = () => Promise.resolve(bytes('x'));

describe('TtsEngine', () => {
  test('plays segments IN ORDER through one sink, ending idle', async () => {
    const engine = new TtsEngine();
    const sink = new FakeSink();
    const states: (string | null)[] = [];
    engine.subscribe((s) => states.push(s.phase));

    await engine.speak({
      id: 'm1',
      segments: ['a', 'b', 'c'],
      synth: dummySynth,
      createSink: () => sink,
      schedule: fakeSchedule([ok(0, 'a'), ok(1, 'b'), ok(2, 'c')]),
    });

    expect(sink.enqueued.map((b) => new TextDecoder().decode(b))).toEqual(['a', 'b', 'c']);
    expect(engine.getState()).toEqual({ id: null, phase: null, skipped: 0, error: null });
    expect(states).toContain('playing');
    expect(sink.closed).toBe(true);
  });

  test('skipped segments are not played but the reply still finishes (skip-and-continue)', async () => {
    const engine = new TtsEngine();
    const sink = new FakeSink();
    await engine.speak({
      id: 'm1',
      segments: ['a', 'b', 'c'],
      synth: dummySynth,
      createSink: () => sink,
      schedule: fakeSchedule([ok(0, 'a'), skipped(1, 'b'), ok(2, 'c')]),
    });
    expect(sink.enqueued.map((b) => new TextDecoder().decode(b))).toEqual(['a', 'c']);
    expect(engine.getState().error).toBeNull();
  });

  test('an all-skipped reply ends in an honest error state, nothing played', async () => {
    const engine = new TtsEngine();
    const sink = new FakeSink();
    await engine.speak({
      id: 'm1',
      segments: ['a', 'b'],
      synth: dummySynth,
      createSink: () => sink,
      schedule: fakeSchedule([skipped(0, 'a'), skipped(1, 'b')]),
    });
    expect(sink.enqueued).toHaveLength(0);
    expect(engine.getState().id).toBeNull();
    expect(engine.getState().error).toBeTruthy();
  });

  test('empty text is refused honestly without creating a sink', async () => {
    const engine = new TtsEngine();
    let created = false;
    await engine.speak({
      id: 'm1',
      segments: [],
      synth: dummySynth,
      createSink: () => {
        created = true;
        return new FakeSink();
      },
      schedule: fakeSchedule([]),
    });
    expect(created).toBe(false);
    expect(engine.getState().error).toBeTruthy();
  });

  test('stop() interrupts mid-reply instantly: no further segments play', async () => {
    const engine = new TtsEngine();
    const sink = new FakeSink(false); // gated: playback holds after the first enqueue
    const done = engine.speak({
      id: 'm1',
      segments: ['a', 'b', 'c'],
      synth: dummySynth,
      createSink: () => sink,
      schedule: fakeSchedule([ok(0, 'a'), ok(1, 'b'), ok(2, 'c')]),
    });

    await tick();
    expect(engine.getState().phase).toBe('playing');
    expect(sink.enqueued).toHaveLength(1);

    engine.stop();
    await done;

    expect(sink.stopped).toBe(true);
    expect(sink.enqueued).toHaveLength(1); // never advanced to 'b'
    expect(engine.getState()).toEqual({ id: null, phase: null, skipped: 0, error: null });
    expect(engine.isActive('m1')).toBe(false);
  });

  test('speaking a new reply interrupts the one already playing (single voice)', async () => {
    const engine = new TtsEngine();
    const sinkA = new FakeSink(false);
    const first = engine.speak({
      id: 'mA',
      segments: ['a1', 'a2'],
      synth: dummySynth,
      createSink: () => sinkA,
      schedule: fakeSchedule([ok(0, 'a1'), ok(1, 'a2')]),
    });
    await tick();
    expect(engine.isActive('mA')).toBe(true);

    const sinkB = new FakeSink();
    await engine.speak({
      id: 'mB',
      segments: ['b1'],
      synth: dummySynth,
      createSink: () => sinkB,
      schedule: fakeSchedule([ok(0, 'b1')]),
    });
    await first;

    expect(sinkA.stopped).toBe(true); // A was interrupted
    expect(sinkB.enqueued.map((b) => new TextDecoder().decode(b))).toEqual(['b1']);
    expect(engine.getState().id).toBeNull();
  });
});
