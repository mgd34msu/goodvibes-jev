/**
 * request-policy.ts, the bounded spoken-output request policy, client-side.
 *
 * The TUI and agent now ship a spoken-output request policy with three properties, and
 * the browser must behave the same way so a spoken reply sounds identical across
 * surfaces:
 *
 *   1. COALESCE TO THE FEWEST REQUESTS, a reply is split into as few synthesis requests
 *      as possible (only split when a single request would exceed the provider's
 *      comfortable length), so a short or medium reply is one request, not many.
 *   2. CAP CONCURRENCY AT 2, never more than two synthesis requests in flight at once,
 *      so a long reply does not fan out into a burst the provider rate-limits.
 *   3. TRANSIENT-429 RETRY WITH HONEST SKIP-AND-CONTINUE, a request that comes back 429
 *      (rate limited) is retried with backoff; if it still fails after the retries, that
 *      one segment is SKIPPED and the rest of the reply still plays, and the skip is
 *      reported honestly (never silently dropped, never aborting the whole reply).
 *
 * This is the browser's own implementation of that policy, unit-tested against all
 * three properties above, and it stays separate from the SDK on purpose. The installed
 * @pellux/goodvibes-sdk also publishes a shared SpokenTurnController
 * (platform/voice/spoken-turn) that drives the same three properties, but it is a
 * daemon-side engine: it is constructed around a live VoiceService (the provider
 * registry that holds real synthesis credentials and does the actual network call) and
 * driven by the daemon's TurnEvent lifecycle stream, neither of which exists, or
 * should exist, in the browser. The browser only ever calls the daemon's synthesis
 * endpoint over HTTP for text it already has in hand, so this module's segment
 * scheduler (coalesce, cap, retry-then-skip over an injected `synth` function) is the
 * correct browser-side counterpart, not a stand-in awaiting removal.
 */

/** One segment's outcome. `status:'ok'` carries decodable audio bytes; `status:'skipped'`
 * carries the last error that made it give up (transient exhausted, or non-transient). */
export interface TtsSegmentResult {
  readonly index: number;
  readonly text: string;
  readonly status: 'ok' | 'skipped';
  readonly audio?: ArrayBuffer;
  readonly error?: unknown;
  /** How many synth attempts were made (1 = succeeded first try; >1 = retried). */
  readonly attempts: number;
}

export interface TtsScheduleOptions {
  /** Max concurrent synthesis requests. Default 2 (the shipped cap). */
  readonly concurrency?: number;
  /** Retries AFTER the first attempt for a transient failure. Default 2 (=> 3 tries). */
  readonly maxRetries?: number;
  /** Base backoff in ms; attempt n waits retryBaseMs * 2^(n-1). Default 400. */
  readonly retryBaseMs?: number;
  /** Classifies an error as transient (retry) vs terminal (skip now). Default: HTTP 429. */
  readonly isTransient?: (error: unknown) => boolean;
  /** Injectable sleep so tests don't wait real time. Default: real setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Abort the whole run (a deliberate stop). In-flight fetches see this signal too. */
  readonly signal?: AbortSignal;
}

/** A running policy execution. Results are consumed IN ORDER by the player, while the
 * pool fetches up to `concurrency` segments ahead. */
export interface TtsRun {
  readonly total: number;
  /** Resolves the outcome of segment `index` (waits for it if still in flight). */
  resultFor(index: number): Promise<TtsSegmentResult>;
  /** All segment outcomes, in order. */
  results(): Promise<readonly TtsSegmentResult[]>;
  /** Cancel every remaining/in-flight request (a deliberate interrupt). */
  cancel(): void;
}

/** The default transient classifier: an HTTP 429 (rate limited). The error carries a
 * numeric `status` on both the JSON and the raw-stream request paths (goodvibes.ts). */
export function isTransientTtsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown }).status;
  return status === 429;
}

const SENTENCE_BOUNDARY = /(?<=[.!?…])\s+/;

/**
 * coalesceForSpeech, split a reply into the FEWEST synthesis segments each within
 * `maxChars`. A reply that already fits is a single segment (one request). Longer text
 * is split on paragraph, then sentence, then whitespace boundaries, never mid-word, so
 * the seams fall where a human would pause. Returns [] for empty/whitespace-only text.
 */
export function coalesceForSpeech(text: string, maxChars = 1800): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  // Break into atomic pieces (paragraphs, then over-long paragraphs into sentences,
  // then over-long sentences into hard word-boundary slices), then GREEDILY re-join
  // adjacent pieces up to maxChars so we emit as few segments as possible.
  const atoms: string[] = [];
  for (const paragraph of trimmed.split(/\n{2,}/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (p.length <= maxChars) {
      atoms.push(p);
      continue;
    }
    for (const sentence of p.split(SENTENCE_BOUNDARY)) {
      const s = sentence.trim();
      if (!s) continue;
      if (s.length <= maxChars) {
        atoms.push(s);
        continue;
      }
      atoms.push(...hardWrap(s, maxChars));
    }
  }

  const segments: string[] = [];
  let current = '';
  for (const atom of atoms) {
    if (!current) {
      current = atom;
    } else if (current.length + 1 + atom.length <= maxChars) {
      current = `${current} ${atom}`;
    } else {
      segments.push(current);
      current = atom;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/** Split an over-long, boundary-less span on whitespace, never mid-word. */
function hardWrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      out.push(current);
      current = word;
    }
    // A single word longer than maxChars: emit it whole rather than cut a word.
    if (current.length > maxChars && current === word) {
      out.push(current);
      current = '';
    }
  }
  if (current) out.push(current);
  return out;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * scheduleTtsRequests, run `synth` over `segments` under the bounded policy.
 *
 * A pool of `concurrency` workers pulls the next un-started segment, synthesises it with
 * transient-retry, and resolves that segment's slot. The player awaits slots in order via
 * resultFor(), so playback is gapless-in-order while up to `concurrency` requests fetch
 * ahead. A transient failure retries with exponential backoff up to `maxRetries`; if it
 * still fails, or fails non-transiently, that segment resolves as `skipped` and the run
 * continues. cancel()/an aborted signal stops the pool and resolves any unfinished slots
 * as skipped (so a consumer awaiting them never hangs).
 */
export function scheduleTtsRequests(
  segments: readonly string[],
  synth: (text: string, signal: AbortSignal) => Promise<ArrayBuffer>,
  options: TtsScheduleOptions = {},
): TtsRun {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const retryBaseMs = options.retryBaseMs ?? 400;
  const isTransient = options.isTransient ?? isTransientTtsError;
  const sleep = options.sleep ?? defaultSleep;

  const controller = new AbortController();
  const external = options.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const total = segments.length;
  const slots = segments.map(() => deferred<TtsSegmentResult>());
  const settled = new Array<boolean>(total).fill(false);

  function settle(result: TtsSegmentResult): void {
    if (settled[result.index]) return;
    settled[result.index] = true;
    slots[result.index].resolve(result);
  }

  async function attemptSegment(index: number): Promise<void> {
    const text = segments[index];
    let attempts = 0;
    let lastError: unknown;
    while (attempts <= maxRetries) {
      if (controller.signal.aborted) {
        settle({ index, text, status: 'skipped', error: lastError, attempts });
        return;
      }
      attempts += 1;
      try {
        const audio = await synth(text, controller.signal);
        settle({ index, text, status: 'ok', audio, attempts });
        return;
      } catch (error) {
        lastError = error;
        // A deliberate interrupt is not a skip-worthy provider failure, bail quietly.
        if (controller.signal.aborted) {
          settle({ index, text, status: 'skipped', error, attempts });
          return;
        }
        const canRetry = attempts <= maxRetries && isTransient(error);
        if (!canRetry) break;
        await sleep(retryBaseMs * 2 ** (attempts - 1));
      }
    }
    // Retries exhausted or a terminal error: skip this segment, keep the reply going.
    settle({ index, text, status: 'skipped', error: lastError, attempts });
  }

  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (controller.signal.aborted) return;
      const index = nextIndex;
      if (index >= total) return;
      nextIndex += 1;
      await attemptSegment(index);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, total); i += 1) workers.push(worker());

  // On abort, resolve any still-pending slot as skipped so awaiters never hang.
  controller.signal.addEventListener('abort', () => {
    for (let i = 0; i < total; i += 1) {
      if (!settled[i]) settle({ index: i, text: segments[i], status: 'skipped', attempts: 0 });
    }
  }, { once: true });

  const run: TtsRun = {
    total,
    resultFor: (index) => slots[index].promise,
    results: () => Promise.all(slots.map((slot) => slot.promise)),
    cancel: () => controller.abort(),
  };
  // Keep the worker pool referenced so it is not flagged as a floating promise.
  void Promise.all(workers);
  return run;
}
