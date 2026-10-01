/**
 * tts-player.ts, the Web Audio playback engine for spoken replies.
 *
 * ONE SINK, DRAIN-NOT-ABORT. The TUI's diagnosed spoken-output defects were head-clip
 * and truncation caused by tearing down and rebuilding the audio path per chunk. This
 * player avoids that class by design: a single long-lived sink per spoken reply schedules
 * each segment's decoded buffer back-to-back at a running start time, so segments play
 * gaplessly with no per-chunk restart, and a natural finish DRAINS (lets the last buffer
 * play out) rather than aborting. Only a deliberate Stop aborts, instantly.
 *
 * The engine is a small observable singleton (`ttsEngine`): starting a new reply
 * interrupts any reply already playing, so at most one voice is ever heard. It is
 * UI-agnostic and fully injectable, the AudioSink and the request scheduler are passed
 * in, so tests drive it with a fake sink and never touch real audio hardware.
 */

import { scheduleTtsRequests, type TtsRun, type TtsScheduleOptions } from './request-policy';

/**
 * A gapless audio sink. `enqueue` plays `audio` after everything enqueued before it and
 * resolves when THIS buffer finishes (or when the sink is stopped). The Web Audio
 * implementation schedules at a running start time so there are no seams. `stop` is an
 * instant, deliberate interrupt; `close` releases the underlying context.
 */
export interface AudioSink {
  enqueue(audio: ArrayBuffer): Promise<void>;
  stop(): void;
  close(): Promise<void>;
}

/** Minimal shape of the parts of AudioContext this player uses, declared locally so the
 * module type-checks without DOM `lib` assumptions and so tests can substitute it. */
interface MinimalAudioContext {
  readonly currentTime: number;
  readonly destination: unknown;
  decodeAudioData(data: ArrayBuffer): Promise<{ duration: number }>;
  createBufferSource(): {
    buffer: unknown;
    connect(destination: unknown): void;
    start(when?: number): void;
    stop(when?: number): void;
    onended: (() => void) | null;
  };
  resume(): Promise<void>;
  close(): Promise<void>;
}

type AudioContextCtor = new () => MinimalAudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** True when this browser can actually play synthesised audio (has an AudioContext). */
export function canPlayAudio(): boolean {
  return resolveAudioContextCtor() !== null;
}

/**
 * WebAudioSink, the real gapless sink. Decodes each buffer and schedules it at
 * max(now, nextStart), advancing nextStart by the decoded duration so consecutive
 * segments abut with no gap and no re-init. Requires a user gesture to have created the
 * context (browser autoplay policy), the caller creates it inside the click handler.
 */
export class WebAudioSink implements AudioSink {
  private readonly ctx: MinimalAudioContext;
  private nextStart = 0;
  private stopped = false;
  private readonly sources = new Set<ReturnType<MinimalAudioContext['createBufferSource']>>();
  private readonly pending = new Set<() => void>();

  constructor(ctx?: MinimalAudioContext) {
    if (ctx) {
      this.ctx = ctx;
    } else {
      const Ctor = resolveAudioContextCtor();
      if (!Ctor) throw new Error('Web Audio is not available in this browser');
      this.ctx = new Ctor();
    }
  }

  async enqueue(audio: ArrayBuffer): Promise<void> {
    if (this.stopped) return;
    // Some browsers start the context suspended until a gesture resumes it.
    await this.ctx.resume().catch(() => undefined);
    const buffer = await this.ctx.decodeAudioData(audio);
    if (this.stopped) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime, this.nextStart);
    this.nextStart = startAt + buffer.duration;
    this.sources.add(source);
    return new Promise<void>((resolve) => {
      this.pending.add(resolve);
      source.onended = () => {
        this.sources.delete(source);
        this.pending.delete(resolve);
        resolve();
      };
      source.start(startAt);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* a source that never started throws on stop, ignore */
      }
    }
    this.sources.clear();
    // Resolve any in-flight enqueue() so a caller awaiting it unwinds instead of hanging
    // (a stopped source's onended never fires).
    for (const resolve of this.pending) resolve();
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.stop();
    await this.ctx.close().catch(() => undefined);
  }
}

export type TtsPhase = 'loading' | 'playing';

export interface TtsPlaybackState {
  /** The message id currently being spoken, or null when idle. */
  readonly id: string | null;
  readonly phase: TtsPhase | null;
  /** Segments the request policy had to skip (honest partial playback). */
  readonly skipped: number;
  /** An honest failure message when nothing could be played, else null. */
  readonly error: string | null;
}

export interface TtsSpeakRequest {
  /** The message id, used so the UI knows which message is speaking. */
  readonly id: string;
  /** The coalesced segments (from coalesceForSpeech). */
  readonly segments: readonly string[];
  /** Synthesise one segment to decodable audio bytes (the voice.tts.stream call). */
  readonly synth: (text: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  /** Build the sink (default WebAudioSink). Tests inject a fake. */
  readonly createSink?: () => AudioSink;
  /** Inject the scheduler (default scheduleTtsRequests). */
  readonly schedule?: typeof scheduleTtsRequests;
  /** Extra request-policy options (concurrency/retry), merged over the defaults. */
  readonly scheduleOptions?: TtsScheduleOptions;
}

const IDLE: TtsPlaybackState = { id: null, phase: null, skipped: 0, error: null };

export class TtsEngine {
  private state: TtsPlaybackState = IDLE;
  private readonly listeners = new Set<(state: TtsPlaybackState) => void>();
  private current: { run: TtsRun; sink: AudioSink; token: number } | null = null;
  private token = 0;

  getState(): TtsPlaybackState {
    return this.state;
  }

  isActive(id: string): boolean {
    return this.state.id === id;
  }

  subscribe(listener: (state: TtsPlaybackState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(next: TtsPlaybackState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  /** Stop the current reply immediately (deliberate interrupt). Bumping the token makes
   * any in-flight speak() loop bail at its next token check. */
  stop(): void {
    this.token += 1;
    this.teardown();
    this.set(IDLE);
  }

  private teardown(): void {
    const active = this.current;
    this.current = null;
    if (!active) return;
    active.run.cancel();
    active.sink.stop();
    void active.sink.close();
  }

  /**
   * Speak a reply. Interrupts any reply already playing (single-voice guarantee), then
   * fetches segments under the bounded request policy and plays them in order through one
   * sink. Resolves when playback finishes, is interrupted, or fails.
   */
  async speak(request: TtsSpeakRequest): Promise<void> {
    // Interrupt whatever is playing first.
    this.teardown();
    const token = (this.token += 1);
    const schedule = request.schedule ?? scheduleTtsRequests;

    if (request.segments.length === 0) {
      this.set({ id: null, phase: null, skipped: 0, error: 'There is nothing to read aloud.' });
      return;
    }

    let sink: AudioSink;
    try {
      sink = (request.createSink ?? (() => new WebAudioSink()))();
    } catch {
      this.set({ id: null, phase: null, skipped: 0, error: 'Audio playback is not available in this browser.' });
      return;
    }

    const run = schedule(request.segments, request.synth, request.scheduleOptions);
    this.current = { run, sink, token };
    this.set({ id: request.id, phase: 'loading', skipped: 0, error: null });

    let skipped = 0;
    let played = 0;
    try {
      for (let i = 0; i < run.total; i += 1) {
        if (this.token !== token) return; // interrupted by a newer speak()/stop()
        const result = await run.resultFor(i);
        if (this.token !== token) return;
        if (result.status !== 'ok' || !result.audio) {
          skipped += 1;
          if (this.state.id === request.id) this.set({ ...this.state, skipped });
          continue;
        }
        this.set({ id: request.id, phase: 'playing', skipped, error: null });
        await sink.enqueue(result.audio);
        played += 1;
        if (this.token !== token) return;
      }
    } finally {
      if (this.token === token) {
        void sink.close();
        this.current = null;
      }
    }

    if (this.token !== token) return;
    if (played === 0) {
      this.set({ id: null, phase: null, skipped, error: 'The voice provider could not read this reply aloud.' });
    } else {
      // Finished (possibly with some segments honestly skipped). Return to idle; a
      // consumer that wants to surface the skip count can read it before the reset.
      this.set(IDLE);
    }
  }
}

/** The process-wide engine: one voice at a time across every Speak control. */
export const ttsEngine = new TtsEngine();
