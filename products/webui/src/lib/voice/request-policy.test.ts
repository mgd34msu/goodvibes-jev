import { describe, expect, test } from 'bun:test';
import {
  coalesceForSpeech,
  isTransientTtsError,
  scheduleTtsRequests,
  type TtsSegmentResult,
} from './request-policy';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const immediateSleep = () => Promise.resolve();
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('coalesceForSpeech: fewest requests', async () => {
  test('empty / whitespace text yields no segments', async () => {
    expect(await coalesceForSpeech('')).toEqual([]);
    expect(await coalesceForSpeech('   \n  ')).toEqual([]);
  });

  test('a reply within the budget is ONE segment (one request)', async () => {
    const reply = 'A short assistant reply that easily fits in a single synthesis request.';
    expect(await coalesceForSpeech(reply, 1800)).toEqual([reply]);
  });

  test('a long reply splits into the FEWEST segments, each within the budget, never mid-word', async () => {
    // Ten sentences of ~40 chars; budget 100 should greedily pack ~2 sentences/segment.
    const sentences = Array.from({ length: 10 }, (_, i) => `This is sentence number ${i} here.`);
    const reply = sentences.join(' ');
    const segments = await coalesceForSpeech(reply, 100, async () => sentences.map((_, i) => sentences.slice(0, i + 1).join(" ").length));
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) expect(segment.length).toBeLessThanOrEqual(100);
    // Greedy packing => far fewer segments than sentences (fewest-requests property).
    expect(segments.length).toBeLessThan(sentences.length);
    // No word is cut: rejoining segments reproduces the words in order.
    expect(segments.join(' ').split(/\s+/)).toEqual(reply.split(/\s+/));
  });

  test('a single word longer than the budget is emitted whole rather than cut', async () => {
    const word = 'x'.repeat(50);
    expect(await coalesceForSpeech(word, 20, async () => [])).toEqual([word]);
  });
});

describe('isTransientTtsError', () => {
  test('429 is transient; other statuses and non-errors are not', () => {
    expect(isTransientTtsError({ status: 429 })).toBe(true);
    expect(isTransientTtsError({ status: 500 })).toBe(false);
    expect(isTransientTtsError({ status: 401 })).toBe(false);
    expect(isTransientTtsError(undefined)).toBe(false);
    expect(isTransientTtsError(new Error('x'))).toBe(false);
  });
});

describe('scheduleTtsRequests: bounded policy', () => {
  test('all segments succeed and resolve IN ORDER with audio', async () => {
    const segments = ['a', 'b', 'c'];
    const run = scheduleTtsRequests(segments, (text) => Promise.resolve(bytes(text)), {
      sleep: immediateSleep,
    });
    const results = await run.results();
    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(results.every((r) => r.status === 'ok' && r.audio)).toBe(true);
    expect(results.every((r) => r.attempts === 1)).toBe(true);
  });

  test('caps concurrency at 2: never more than two synth calls in flight', async () => {
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const synth = async (text: string): Promise<ArrayBuffer> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return bytes(text);
    };
    const run = scheduleTtsRequests(['a', 'b', 'c', 'd', 'e'], synth, { concurrency: 2, sleep: immediateSleep });

    await tick();
    // With a pool of 2, exactly two calls are in flight; the other three wait.
    expect(active).toBe(2);
    expect(peak).toBe(2);

    // Drain: release one at a time; the pool refills but never exceeds 2.
    while (releases.length) {
      releases.shift()?.();
      await tick();
      expect(active).toBeLessThanOrEqual(2);
    }
    const results = await run.results();
    expect(peak).toBe(2);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  });

  test('a transient 429 is retried with backoff, then succeeds', async () => {
    let calls = 0;
    const synth = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(Object.assign(new Error('rate limited'), { status: 429 }));
      return Promise.resolve(bytes('ok'));
    };
    const run = scheduleTtsRequests(['only'], synth, { sleep: immediateSleep, maxRetries: 2 });
    const result = await run.resultFor(0);
    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(2);
  });

  test('a persistently-429 segment is SKIPPED after its retries, and the rest still play', async () => {
    const synth = (text: string) => {
      if (text === 'bad') return Promise.reject(Object.assign(new Error('429'), { status: 429 }));
      return Promise.resolve(bytes(text));
    };
    const run = scheduleTtsRequests(['good1', 'bad', 'good2'], synth, { sleep: immediateSleep, maxRetries: 2 });
    const results = await run.results();
    const byIndex = (i: number): TtsSegmentResult => results[i];
    expect(byIndex(0).status).toBe('ok');
    expect(byIndex(1).status).toBe('skipped');
    expect(byIndex(1).attempts).toBe(3); // first try + 2 retries
    expect(byIndex(1).error).toBeDefined();
    expect(byIndex(2).status).toBe('ok'); // skip-and-continue: the reply keeps going
  });

  test('a non-transient error is skipped immediately (no wasted retries)', async () => {
    const synth = () => Promise.reject(Object.assign(new Error('server error'), { status: 500 }));
    const run = scheduleTtsRequests(['x'], synth, { sleep: immediateSleep, maxRetries: 2 });
    const result = await run.resultFor(0);
    expect(result.status).toBe('skipped');
    expect(result.attempts).toBe(1);
  });

  test('cancel() resolves every unfinished segment as skipped (no hang)', async () => {
    const synth = () => new Promise<ArrayBuffer>(() => {}); // never resolves
    const run = scheduleTtsRequests(['a', 'b', 'c'], synth, { concurrency: 2, sleep: immediateSleep });
    await tick();
    run.cancel();
    const results = await run.results();
    expect(results.every((r) => r.status === 'skipped')).toBe(true);
  });
});

describe('semantic seam ownership', () => {
  test('contrary offsets preserve abbreviations and closing quotes', async () => {
    const text = 'Dr. Rivera left. “Next.” Final words.';
    const seen: unknown[] = [];
    expect(await coalesceForSpeech(text, 17, async (p, start, end) => { seen.push({ p, start, end }); return [16, 24, text.length]; })).toEqual(['Dr. Rivera left.', '“Next.”', 'Final words.']);
    expect(seen).toEqual([{ p: text, start: 0, end: text.length }]);
  });
  test('missing, malformed and cancelled readings never become word-only fallback', async () => {
    await expect(coalesceForSpeech('many words here', 5)).rejects.toBeDefined();
    await expect(coalesceForSpeech('many words here', 5, async () => [2])).rejects.toBeDefined();
    const abort = new AbortController();
    await expect(coalesceForSpeech('many words here', 5, async () => { abort.abort(); return []; }, abort.signal)).rejects.toBeDefined();
  });
  test('complete paragraph offsets bind to untrimmed message', async () => {
    const seen: unknown[] = [];
    await coalesceForSpeech('  many words here\n\nother words here  ', 8, async (p, start, end) => { seen.push([p, start, end]); return []; });
    expect(seen).toEqual([['many words here', 2, 17], ['other words here', 19, 35]]);
  });
});
