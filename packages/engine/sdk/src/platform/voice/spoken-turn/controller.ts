import { captureJudgmentPort, httpStatusOf, JudgmentPortMissingError, readFailureTransience, structuredTransience, type FailureReadOptions, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { ConfigKey, ConfigManager } from '../../config/index.js';
import type { TurnEvent } from '../../../events/turn.js';
import type { VoiceService } from '../service.js';
import type { VoiceAudioChunk, VoiceSynthesisStreamResult } from '../types.js';
import { summarizeError } from '../../utils/error-display.js';
import { captureFailureSnapshot, captureJudgmentFailureInput } from '../../gate/failure-input-snapshot.js';
import { JudgmentInputError } from '../../gate/judgment-input.js';
import { TtsTextChunker } from './text-chunker.js';
import type { AudioSink } from './audio-sink.js';

/**
 * How many synthesis requests may sit in the pipeline at once (synthesizing,
 * waiting to play, or playing). 2 = the chunk being played plus ONE prefetch,
 * so the next audio is ready the moment the current sink drains. Bounding
 * this is what keeps a streaming answer from bursting N concurrent requests
 * at the voice provider, ElevenLabs plans allow as few as 3 concurrent, and
 * an unbounded burst 429s the whole turn. The SDK config schema has no tts.*
 * key for pipeline tuning, so this is a constant by design.
 */
const SYNTHESIS_PIPELINE_WINDOW = 2;

/**
 * Upper bound for one merged synthesis request's text. The ElevenLabs
 * provider passes request text through verbatim (no cap of its own); the API
 * caps text per request by plan, 2,500 chars on the lowest tiers, 5,000 on
 * most others. 1,500 stays safely under every plan while still folding a
 * multi-paragraph answer into one or two requests.
 */
const SYNTHESIS_MERGE_MAX_CHARS = 1500;

/**
 * Backoff schedule for transient synthesis failures (429 rate/concurrency
 * limits, transient 5xx, network drops): first retry after 1s, second after
 * 2.5s, then the chunk is skipped honestly and the turn continues. The SDK's
 * provider errors are plain Error strings with the HTTP status embedded, no
 * Retry-After header is exposed, so the schedule is fixed, not server-driven.
 */
const SYNTHESIS_RETRY_DELAYS_MS = [1000, 2500] as const;

/**
 * Source label attached to every synthesis request's metadata. Consumers may
 * override it so provider-side telemetry attributes requests to the right
 * surface (TUI, agent, webui).
 */
const DEFAULT_SYNTHESIS_SOURCE = 'goodvibes-sdk';

export interface SpokenTurnControllerOptions {
  readonly voiceService: Pick<VoiceService, 'synthesizeStream'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  /** The injectable I/O boundary. See {@link AudioSink}. */
  readonly sink: AudioSink;
  readonly notify?: ((message: string) => void) | undefined;
  /**
   * Attribution label recorded in each synthesis request's metadata.source
   * (e.g. 'goodvibes-tui', 'goodvibes-agent', 'goodvibes-webui'). Defaults to
   * 'goodvibes-sdk'.
   */
  readonly source?: string | undefined;
  /** Optional host hardening (Node hosts reject proxies before descriptor inspection). */
  readonly rejectFailureObject?: ((value: object) => boolean) | undefined;
  readonly now?: (() => number) | undefined;
  readonly setInterval?: typeof setInterval | undefined;
  readonly clearInterval?: typeof clearInterval | undefined;
  /** Injectable clock for retry backoff timers (tests use fakes). */
  readonly setTimeout?: typeof setTimeout | undefined;
  readonly clearTimeout?: typeof clearTimeout | undefined;
}

/**
 * SpokenTurnController, the shared spoken-output policy engine. It watches a
 * turn's lifecycle events, chunks the streamed answer into speech-sized pieces,
 * merges and dispatches synthesis requests through a bounded 2-slot window with
 * retry/backoff, and drives an injected {@link AudioSink} with honest
 * drain-vs-interrupt semantics. All I/O is the sink's; this class is pure
 * policy and runs unchanged in the terminal, the agent, and the browser.
 */
export class SpokenTurnController {
  private pendingPrompt: string | null = null;
  private activeTurnId: string | null = null;
  private chunker: TtsTextChunker | null = null;
  private chunkSequence = 0;
  private turnOwner: JudgmentPortCapture | undefined;
  private turnCancellation: AbortController | undefined;
  private turnConfig: { provider: string | undefined; voice: string | undefined; speed: number | undefined } | undefined;
  private retireListener: (() => void) | undefined;
  private timerPending = false;
  private exitDrainGeneration: number | null = null;
  private assertTurnFunctions: (() => void) | undefined;
  private playbackChain: Promise<void> = Promise.resolve();
  private readonly abortControllers = new Set<AbortController>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private errorReportedForTurn = false;
  private noSinkNoticed = false;
  /** Chunker output waiting to be merged into a synthesis request. */
  private pendingTexts: string[] = [];
  /** Requests currently in the pipeline (synthesizing / waiting / playing). */
  private pipelineDepth = 0;
  /** Bumped on every teardown so stale pipeline releases are ignored. */
  private pipelineGeneration = 0;
  private pumpScheduled = false;
  /** Set when TURN_COMPLETED arrives; the turn releases once the pipeline drains. */
  private completedTurnId: string | null = null;
  private readonly voiceService: Pick<VoiceService, 'synthesizeStream'>;
  private readonly configManager: Pick<ConfigManager, 'get'>;
  private readonly sink: AudioSink;
  private readonly notify?: ((message: string) => void) | undefined;
  private readonly source: string;
  private readonly rejectFailureObject: ((value: object) => boolean) | undefined;
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;

  constructor(options: SpokenTurnControllerOptions) {
    this.voiceService = options.voiceService;
    this.configManager = options.configManager;
    this.sink = options.sink;
    this.notify = options.notify;
    this.source = options.source ?? DEFAULT_SYNTHESIS_SOURCE;
    this.rejectFailureObject = options.rejectFailureObject;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalImpl = options.setInterval ?? setInterval;
    this.clearIntervalImpl = options.clearInterval ?? clearInterval;
    this.setTimeoutImpl = options.setTimeout ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
  }

  submitNextTurn(prompt: string): boolean {
    const normalized = prompt.trim();
    if (!normalized) return false;
    this.stop();
    if (!this.sink.available) {
      if (!this.noSinkNoticed) {
        this.noSinkNoticed = true;
        this.notice('[TTS] Text response will continue, but live audio is unavailable. Install mpv or ffplay.');
      }
      return false;
    }
    // Reset the no-sink notice if the sink becomes available again.
    this.noSinkNoticed = false;
    this.pendingPrompt = normalized;
    return true;
  }

  /**
   * Returns whether speech was actually ACTIVE when stopped. The notice only
   * prints in that case, stop() on an idle controller used to notify anyway,
   * spamming "[TTS] Spoken output stopped." on every Ctrl+C (an earlier replay
   * fix); callers use the return to decide whether the press "did a
   * job" (see handleCtrlC's consume-on-speech-stop).
   */
  stop(message?: string): boolean {
    this.exitDrainGeneration = null;
    const wasActive = this.pendingPrompt !== null || this.activeTurnId !== null
      || this.chunker !== null || this.abortControllers.size > 0;
    this.releaseOwner();
    this.pendingPrompt = null;
    this.activeTurnId = null;
    this.chunker?.reset();
    this.chunker = null;
    this.stopTimer();
    this.resetPipeline();
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
    this.sink.stop();
    this.playbackChain = Promise.resolve();
    this.errorReportedForTurn = false;
    if (message && wasActive) this.notice(`[TTS] ${message}`);
    return wasActive;
  }

  /**
   * Exit-path teardown: drops everything not yet audible (pending arm,
   * buffered text, queued chunks) but lets the audio the user is already
   * hearing finish naturally, capped at `drainTimeoutMs`, before the hard
   * stop. Deliberate interrupts (Ctrl+C, /tts stop, turn cancel) keep their
   * instant path through stop(); this is only for exiting the app while the
   * final audio of a completed response is still draining.
   */
  async stopForExit(drainTimeoutMs = 2000): Promise<void> {
    const generation = this.pipelineGeneration;
    this.exitDrainGeneration = generation;
    this.pendingPrompt = null;
    this.activeTurnId = null;
    this.chunker?.reset();
    this.chunker = null;
    this.stopTimer();
    this.resetPipeline();
    // Cancel chunks that have not started playing; the chunk currently in the
    // sink is not in this set (its controller is released before playback).
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
    await this.sink.waitForDrain(drainTimeoutMs);
    // A replacement turn must not be stopped by an older drain completion.
    if (this.exitDrainGeneration === generation) this.stop();
  }

  async handleTurnEvent(event: TurnEvent): Promise<void> {
    try {
      if (event.type === 'TURN_SUBMITTED') {
        this.maybeStartTurn(event.turnId, event.prompt);
        return;
      }
      if (!this.activeTurnId || event.turnId !== this.activeTurnId) return;

      if (event.type === 'STREAM_DELTA') {
        await this.acceptChunks(this.chunker?.push(event.content), event.turnId);
        return;
      }
      if (event.type === 'STREAM_END') {
        return;
      }
      if (event.type === 'TURN_COMPLETED') {
        await this.finishTurn(event.turnId);
        return;
      }
      if (event.type === 'TURN_CANCEL' || event.type === 'TURN_ERROR' || event.type === 'PREFLIGHT_FAIL') {
        this.stop(event.type === 'TURN_CANCEL' ? 'Spoken output stopped.' : 'Spoken output stopped because the turn did not complete.');
      }
    } catch {
      // Event buses deliberately do not await us. Host callbacks must never
      // turn a speech-only failure into an unhandled rejected promise.
      try { this.stop(); } catch { /* Host teardown can fail too; text continues. */ }
    }
  }

  private maybeStartTurn(turnId: string, prompt: string): void {
    if (!this.pendingPrompt) return;
    if (prompt.trim() !== this.pendingPrompt) return;
    this.pendingPrompt = null;
    this.activeTurnId = turnId;
    this.chunkSequence = 0;
    this.errorReportedForTurn = false;
    this.playbackChain = Promise.resolve();
    this.resetPipeline();
    const generation = this.pipelineGeneration;
    const synthesize = this.voiceService.synthesizeStream, play = this.sink.play, get = this.configManager.get;
    this.assertTurnFunctions = () => {
      if (this.voiceService.synthesizeStream !== synthesize || this.sink.play !== play || this.configManager.get !== get) {
        throw new Error('Spoken turn caller changed');
      }
    };
    this.turnConfig = this.readTurnConfig();
    const config = this.turnConfig;
    const assertCurrent = () => {
      this.assertTurnFunctions?.();
      const current = this.readTurnConfig();
      if ((this.exitDrainGeneration !== generation && (this.activeTurnId !== turnId || this.pipelineGeneration !== generation))
        || current.provider !== config.provider || current.voice !== config.voice || current.speed !== config.speed) {
        throw new Error('Spoken turn source or configuration changed');
      }
    };
    this.turnCancellation = new AbortController();
    try { this.turnOwner = captureJudgmentPort('voice.spoken-turn.chunking', { signal: this.turnCancellation.signal, assertCurrent }); }
    catch (error) {
      if (!(error instanceof JudgmentPortMissingError)) { this.stop(); return; }
    }
    this.chunker = new TtsTextChunker({ now: this.now, owner: this.turnOwner, assertCurrent });
    const owner = this.turnOwner;
    if (owner) {
      const retire = () => { if (this.turnOwner === owner) this.stop(); };
      owner.signal.addEventListener('abort', retire, { once: true });
      this.retireListener = () => owner.signal.removeEventListener('abort', retire);
    }
    this.startTimer();
    this.notice(`[TTS] Live playback queued through ${this.sink.label}.`);
  }

  private async finishTurn(turnId: string): Promise<void> {
    if (turnId !== this.activeTurnId) return;
    await this.acceptChunks(this.chunker?.flushAll(), turnId);
    if (turnId !== this.activeTurnId) return;
    this.stopTimer();
    this.completedTurnId = turnId;
    // Nothing pending and nothing in flight releases immediately; otherwise
    // the last pipeline slot to free performs the release.
    this.maybeReleaseTurn();
  }

  private readTurnConfig() {
    return { provider: readOptionalConfigString(this.configManager, 'tts.provider'),
      voice: readOptionalConfigString(this.configManager, 'tts.voice'),
      speed: readOptionalConfigNumber(this.configManager, 'tts.speed') };
  }

  private releaseOwner(): void {
    this.retireListener?.(); this.retireListener = undefined;
    this.turnCancellation?.abort(); this.turnCancellation = undefined;
    this.turnOwner = undefined; this.turnConfig = undefined; this.assertTurnFunctions = undefined;
  }

  private assertSpeechCurrent(): void {
    this.chunker?.assertCurrent();
    this.assertTurnFunctions?.();
    const config = this.turnConfig;
    const current = this.readTurnConfig();
    if (!config || config.provider !== current.provider || config.voice !== current.voice || config.speed !== current.speed) {
      throw new Error('Spoken turn configuration changed');
    }
    this.turnOwner?.assertCurrent();
  }

  private async acceptChunks(work: Promise<string[]> | undefined, turnId: string): Promise<void> {
    const generation = this.pipelineGeneration;
    try {
      const chunks = await work ?? [];
      if (turnId !== this.activeTurnId || generation !== this.pipelineGeneration) return;
      this.assertSpeechCurrent();
      this.queueTexts(chunks);
    } catch {
      if (turnId === this.activeTurnId && generation === this.pipelineGeneration) {
        try { this.stop(); } catch { /* Host teardown is best effort. */ }
      }
    }
  }

  private resetPipeline(): void {
    this.pendingTexts = [];
    this.pipelineDepth = 0;
    this.pipelineGeneration++;
    this.completedTurnId = null;
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = this.setIntervalImpl(() => {
      if (!this.activeTurnId || !this.chunker || this.timerPending) return;
      this.timerPending = true;
      void this.acceptChunks(this.chunker.flushDue(), this.activeTurnId).finally(() => { this.timerPending = false; });
    }, 250);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    this.clearIntervalImpl(this.timer);
    this.timer = null;
  }

  /**
   * Chunker output does NOT map 1:1 to synthesis requests. Text queues here
   * and the pump merges everything pending into one request whenever a
   * pipeline slot is free, so the request count tracks how often the model
   * out-paces the audio, not how many sentences it wrote. A short answer that
   * arrives before the first pump tick is exactly one request.
   */
  private queueTexts(chunks: readonly string[]): void {
    // Bounded backlog. A slow sink must not retain an unlimited response.
    if (this.pendingTexts.reduce((total, text) => total + text.length, 0)
      + chunks.reduce((total, text) => total + text.length, 0) > 65_536) { this.stop(); return; }
    for (const chunk of chunks) {
      if (chunk.trim()) this.pendingTexts.push(chunk);
    }
    if (this.pendingTexts.length > 0) this.schedulePump();
  }

  /**
   * Deferred one tick so text delivered in the same synchronous burst (fast
   * deltas, or a turn that completes instantly) coalesces into a single
   * request instead of firing per sentence boundary.
   */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.activeTurnId) {
      try { this.assertSpeechCurrent(); } catch { this.stop(); return; }
    }
    while (this.activeTurnId && this.pendingTexts.length > 0 && this.pipelineDepth < SYNTHESIS_PIPELINE_WINDOW) {
      this.dispatchChunk(this.takeMergedText());
    }
    this.maybeReleaseTurn();
  }

  /** Merge everything pending into one request, capped at the per-request text limit. */
  private takeMergedText(): string {
    let merged = '';
    while (this.pendingTexts.length > 0) {
      const next = this.pendingTexts[0]!;
      if (!merged && next.length > SYNTHESIS_MERGE_MAX_CHARS) {
        // A single oversized entry (e.g. a large end-of-turn flush): split at
        // a word boundary under the per-request cap; the rest stays queued.
        const cut = findSplitIndex(next, SYNTHESIS_MERGE_MAX_CHARS);
        this.pendingTexts[0] = next.slice(cut).trim();
        return next.slice(0, cut).trim();
      }
      if (merged && merged.length + 1 + next.length > SYNTHESIS_MERGE_MAX_CHARS) break;
      merged = merged ? `${merged} ${next}` : next;
      this.pendingTexts.shift();
    }
    return merged;
  }

  private dispatchChunk(text: string): void {
    const turnId = this.activeTurnId;
    if (!turnId || !text.trim()) return;
    const sequence = ++this.chunkSequence;
    const generation = this.pipelineGeneration;
    this.pipelineDepth++;
    const abortController = new AbortController();
    this.abortControllers.add(abortController);
    // Snapshot the canonical composition before synthesis can yield. A retry
    // must never borrow a replacement owner's authority. Missing readers do
    // not block structured facts, but stay unavailable for this chunk.
    const owner = this.turnOwner;
    const readingUnavailable = new JudgmentPortMissingError('voice.spoken-turn.synthesis');
    const assertTurnCurrent = () => {
      abortController.signal.throwIfAborted();
      if (this.activeTurnId !== turnId || this.pipelineGeneration !== generation) {
        throw new Error('Spoken synthesis turn is no longer current');
      }
      this.assertSpeechCurrent();
    };
    const assertCurrent = () => {
      assertTurnCurrent();
      if (!owner && !(readingUnavailable instanceof JudgmentPortMissingError)) throw readingUnavailable;
      owner?.assertCurrent();
    };
    const isCurrent = () => {
      try { assertCurrent(); return true; } catch { return false; }
    };
    const reading: FailureReadOptions = {
      get port() {
        assertCurrent();
        if (!owner) throw readingUnavailable;
        return owner.port;
      },
      signal: abortController.signal,
      beforeAttempt: assertCurrent,
    };
    const retrySignal = () => owner
      ? AbortSignal.any([owner.signal, abortController.signal]) : abortController.signal;
    const resultPromise = this.synthesizeWithRetry(text, turnId, sequence, abortController.signal, reading, assertCurrent, retrySignal)
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    this.playbackChain = this.playbackChain.then(async () => {
      try {
        if (!isCurrent()) {
          this.abortControllers.delete(abortController);
          return;
        }
        const result = await resultPromise;
        this.abortControllers.delete(abortController);
        // Re-check after the await: an abort that landed while synthesis was
        // in flight (deliberate stop or exit) makes the rejection expected,
        // it must not be reported, and it must not hard-stop a sink that may
        // still be draining the previous chunk.
        if (!isCurrent()) return;
        if (!result.ok) {
          // Retries are exhausted (or the failure was not transient). Skip
          // just this chunk and keep speaking the rest of the turn, a gap in
          // speech beats losing the whole response.
          this.reportSkippedChunk(result.error);
          return;
        }
        const assertPlaybackCurrent = () => {
          abortController.signal.throwIfAborted();
          if (this.exitDrainGeneration !== generation) assertTurnCurrent();
          else this.assertSpeechCurrent();
          owner?.assertCurrent();
        };
        await this.sink.play(guardAudio(result.result.chunks, assertPlaybackCurrent), {
          format: String(result.result.format ?? 'mp3'),
          signal: abortController.signal,
        });
      } catch (error) {
        this.abortControllers.delete(abortController);
        if (isCurrent()) this.reportError(error);
      } finally {
        this.releasePipelineSlot(generation);
      }
    });
  }

  private releasePipelineSlot(generation: number): void {
    if (generation !== this.pipelineGeneration) return;
    this.pipelineDepth = Math.max(0, this.pipelineDepth - 1);
    if (this.pendingTexts.length > 0) {
      this.schedulePump();
      return;
    }
    this.maybeReleaseTurn();
  }

  private maybeReleaseTurn(): void {
    if (!this.completedTurnId || this.completedTurnId !== this.activeTurnId) return;
    if (this.pendingTexts.length > 0 || this.pipelineDepth > 0 || this.pumpScheduled) return;
    this.releaseOwner();
    this.activeTurnId = null;
    this.completedTurnId = null;
    this.chunker = null;
    this.abortControllers.clear();
  }

  private async synthesizeWithRetry(
    text: string, turnId: string, sequence: number, signal: AbortSignal,
    reading: FailureReadOptions, assertCurrent: () => void, retrySignal: () => AbortSignal,
  ): Promise<VoiceSynthesisStreamResult> {
    for (let attempt = 0; ; attempt++) {
      assertCurrent();
      try {
        const result = await this.synthesize(text, turnId, sequence, signal);
        assertCurrent();
        return result;
      } catch (error) {
        assertCurrent();
        const captured = captureFailureSnapshot(error, this.rejectFailureObject);
        const structured = structuredTransience(captured);
        // Canonical structure can decide locally. Wording (including provider
        // 429 billing) must pass complete-source privacy admission BEFORE the
        // canonical reader's bounded projection. Never interpret just a prefix.
        const needsWording = !structured || (structured.basis === 'status' && httpStatusOf(captured) === 429);
        const admitted = needsWording ? captureJudgmentFailureInput(captured, this.rejectFailureObject) : captured;
        if (needsWording) assertCompleteFailureWording(admitted);
        if (attempt >= SYNTHESIS_RETRY_DELAYS_MS.length) throw admitted;
        const transience = await readFailureTransience(admitted, 'voice.spoken-turn.synthesis', {
          fromProvider: true, reading,
        });
        assertCurrent();
        if (transience.failureClass !== 'retryable') throw admitted;
        await this.delay(SYNTHESIS_RETRY_DELAYS_MS[attempt]!, retrySignal());
        assertCurrent();
      }
    }
  }

  /** Abortable backoff sleep, an abort clears the timer and rejects, so a stop mid-backoff leaves nothing running. */
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Synthesis retry cancelled'));
        return;
      }
      const timer = this.setTimeoutImpl(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        this.clearTimeoutImpl(timer);
        reject(new Error('Synthesis retry cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private synthesize(text: string, turnId: string, sequence: number, signal: AbortSignal): Promise<VoiceSynthesisStreamResult> {
    this.assertSpeechCurrent();
    const config = this.turnConfig!;
    return this.voiceService.synthesizeStream(config.provider, {
      text,
      voiceId: config.voice,
      format: 'mp3',
      speed: config.speed,
      signal,
      metadata: {
        source: this.source,
        feature: 'live-tts',
        turnId,
        sequence,
      },
    });
  }

  /**
   * One synthesis request failed after its retries. Report once per turn and
   * keep going, the rest of the response still plays.
   */
  private notice(message: string): void {
    try { this.notify?.(message); } catch { /* A broken notifier cannot reject background speech work. */ }
  }

  private reportSkippedChunk(error: unknown): void {
    if (this.errorReportedForTurn) return;
    this.errorReportedForTurn = true;
    this.notice(`[TTS] Skipping part of the spoken response, synthesis kept failing (${summarizeError(error)}). Playback continues with the rest.`);
  }

  private reportError(error: unknown): void {
    if (this.errorReportedForTurn) return;
    this.errorReportedForTurn = true;
    this.releaseOwner();
    this.activeTurnId = null;
    this.chunker = null;
    this.stopTimer();
    this.resetPipeline();
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
    this.sink.stop();
    this.playbackChain = Promise.resolve();
    this.notice(`[TTS] Live playback stopped: ${summarizeError(error)}`);
  }
}

/**
 * Admission only, never classification. The canonical failure reader preserves
 * 2,000 message characters. Refuse a larger complete message rather than let a
 * late correction disappear. Inputs here are already owned, screened snapshots.
 */
function assertCompleteFailureWording(error: unknown): void {
  const messageOf = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const message: unknown = (value as { readonly message?: unknown }).message;
    return typeof message === 'string' && message.length > 0 ? message : undefined;
  };
  let wording: string;
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : messageOf(error.cause);
    wording = cause !== undefined && cause !== error.message ? `${error.message}\nCaused by: ${cause}` : error.message;
  } else {
    wording = typeof error === 'string' ? error : messageOf(error) ?? JSON.stringify(error) ?? String(error);
  }
  if (wording.length > 2_000) throw new JudgmentInputError('unsupported-input');
}

/** Split point at or under `limit`, preferring the last word boundary. */
function findSplitIndex(text: string, limit: number): number {
  const space = text.lastIndexOf(' ', limit);
  return space > 0 ? space : limit;
}

function readOptionalConfigString(configManager: Pick<ConfigManager, 'get'>, key: ConfigKey): string | undefined {
  const value = String(configManager.get(key) ?? '').trim();
  return value || undefined;
}

/**
 * readOptionalConfigNumber, reads a numeric config value by key.
 *
 * Accepts a string key and casts it, returning undefined when the value is
 * absent, zero, or not a finite positive number.
 */
function readOptionalConfigNumber(configManager: Pick<ConfigManager, 'get'>, key: string): number | undefined {
  const raw = configManager.get(key as ConfigKey);
  const value = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  return isFinite(value) && value > 0 ? value : undefined;
}

/** Fence every awaited provider chunk, including after logical turn completion. */
async function* guardAudio(chunks: AsyncIterable<VoiceAudioChunk>, assertCurrent: () => void): AsyncIterable<VoiceAudioChunk> {
  assertCurrent();
  for await (const chunk of chunks) {
    assertCurrent();
    yield chunk;
    assertCurrent();
  }
  assertCurrent();
}
