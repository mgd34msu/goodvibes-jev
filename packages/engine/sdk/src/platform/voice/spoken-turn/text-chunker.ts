import { captureJudgmentPort, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { speechCandidates, snapshotSpeechSeams } from '../../judgment-browser/speech-source.js';
import { speechSeamsBattery } from '../../judgment-browser/batteries/speech-seams.js';
import { StreamingCodeFenceFilter, stripMarkdownForSpeech } from './speech-markdown.js';

/** Streaming speech policy. Meaning comes from the canonical seam battery;
 * length, whitespace, latency and end-of-turn flushing remain mechanical. */
export interface TtsTextChunkerOptions {
  readonly minBoundaryChars?: number | undefined;
  readonly maxChunkChars?: number | undefined;
  readonly maxLatencyMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly owner?: JudgmentPortCapture | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

export class TtsTextChunker {
  private buffer = '';
  // Complete received source, before markdown filtering or candidate selection.
  private raw = '';
  private firstBufferedAt: number | null = null;
  private readonly fenceFilter = new StreamingCodeFenceFilter();
  private readonly minBoundaryChars: number;
  private readonly maxChunkChars: number;
  private readonly maxLatencyMs: number;
  private readonly now: () => number;
  private readonly owner: JudgmentPortCapture | undefined;
  private readonly assertCaller: () => void;
  private readonly cancellation = new AbortController();
  private chain: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  private ending = false;
  private queuedOperations = 0;
  private pendingReader: AbortController | undefined;
  private submittedOperations = 0;
  private activeOperation = 0;
  private skipMeaningThrough = 0;
  private queuedInputChars = 0;

  constructor(options: TtsTextChunkerOptions = {}) {
    this.minBoundaryChars = options.minBoundaryChars ?? 24;
    this.maxChunkChars = options.maxChunkChars ?? 320;
    this.maxLatencyMs = options.maxLatencyMs ?? 1_000;
    this.now = options.now ?? (() => Date.now());
    this.assertCaller = options.assertCurrent ?? (() => {});
    let owner = options.owner;
    if (!owner) {
      try { owner = captureJudgmentPort('voice.spoken-turn.chunking', { signal: this.cancellation.signal, assertCurrent: this.assertCaller }); }
      catch (error) { if (!(error instanceof JudgmentPortMissingError)) this.failure = error; }
    }
    this.owner = owner;
  }

  push(delta: string): Promise<string[]> {
    // Admission is synchronous: even a queued private tail invalidates pending
    // readings before they can publish. Never screen only filtered speech.
    try {
      this.assertCurrent();
      this.raw += delta;
      snapshotJudgmentInput({ text: this.raw });
      this.queuedInputChars += delta.length;
      if (this.buffer.length + this.queuedInputChars >= this.maxChunkChars) this.requestMechanicalProgress();
    } catch (error) { this.failure = error; this.cancellation.abort(); }
    return this.serialize(async () => {
      this.queuedInputChars -= delta.length;
      if (!delta) return [];
      const filtered = this.fenceFilter.push(delta);
      if (!filtered) return [];
      if (this.firstBufferedAt === null) this.firstBufferedAt = this.now();
      this.buffer += filtered;
      return this.drainReady(false);
    });
  }

  flushDue(): Promise<string[]> {
    if (this.firstBufferedAt !== null && this.now() - this.firstBufferedAt >= this.maxLatencyMs) this.requestMechanicalProgress();
    return this.serialize(async () => {
      if (!this.buffer.trim() || this.firstBufferedAt === null || this.now() - this.firstBufferedAt < this.maxLatencyMs) return [];
      return this.drainReady(true);
    });
  }

  flushAll(): Promise<string[]> {
    this.ending = true;
    this.pendingReader?.abort();
    return this.serialize(async () => {
      this.buffer += this.fenceFilter.flush();
      const chunks: string[] = [];
      while (this.buffer.trim()) {
        const end = this.buffer.length > this.maxChunkChars
          ? this.findWordBoundaryBefore(this.maxChunkChars) || this.maxChunkChars : this.buffer.length;
        const chunk = this.takeChunk(end);
        if (chunk) chunks.push(chunk);
      }
      this.buffer = ''; this.firstBufferedAt = null;
      return chunks;
    });
  }

  reset(): void {
    this.cancellation.abort();
    this.buffer = ''; this.raw = ''; this.firstBufferedAt = null;
    this.fenceFilter.reset();
  }

  /** Also fences already queued speech after raw-source admission fails. */
  assertCurrent(): void {
    if (this.failure) throw this.failure;
    this.cancellation.signal.throwIfAborted();
    this.assertCaller();
    this.owner?.assertCurrent();
  }

  private requestMechanicalProgress(): void {
    // Cover the triggering operation AND every already queued delta ahead of
    // it. Aborting only the current read would let an intervening delta start
    // another read before the clock/cap operation can make progress.
    this.skipMeaningThrough = this.submittedOperations + 1;
    this.pendingReader?.abort();
  }

  private serialize(work: () => Promise<string[]>): Promise<string[]> {
    if (this.queuedOperations >= 256) {
      this.failure = new Error('Spoken text backlog exceeded');
      this.cancellation.abort();
      return Promise.reject(this.failure);
    }
    this.queuedOperations++;
    const operation = ++this.submittedOperations;
    const result = this.chain.then(async () => {
      this.assertCurrent();
      this.activeOperation = operation;
      const chunks = await work();
      this.assertCurrent();
      return chunks;
    }).finally(() => { this.queuedOperations--; });
    this.chain = result.catch(() => {});
    return result;
  }

  private async drainReady(forceLatencyFlush: boolean): Promise<string[]> {
    if (this.ending) return [];
    const chunks: string[] = [];
    while (this.buffer.trim()) {
      // The owner clock and hard cap do not wait for semantic availability.
      if (this.firstBufferedAt !== null && this.now() - this.firstBufferedAt >= this.maxLatencyMs) forceLatencyFlush = true;
      const mechanical = forceLatencyFlush || this.buffer.length >= this.maxChunkChars
        || this.activeOperation <= this.skipMeaningThrough;
      const latestSentence = mechanical ? -1 : await this.findLatestSentenceBoundary();
      this.assertCurrent();
      const boundary = latestSentence >= this.minBoundaryChars ? latestSentence
        : this.buffer.length >= this.maxChunkChars ? this.findWordBoundaryBefore(this.maxChunkChars) || this.maxChunkChars
        : forceLatencyFlush ? this.buffer.length : -1;
      if (boundary <= 0) break;
      const chunk = this.takeChunk(boundary);
      if (chunk) chunks.push(chunk);
      forceLatencyFlush = false;
      // Publish this ready prefix now. A remaining sub-cap fragment must not
      // hold already released text behind a second optional semantic request.
      if (this.buffer.length < this.maxChunkChars) break;
    }
    return chunks;
  }

  private async findLatestSentenceBoundary(): Promise<number> {
    if (this.ending || !this.owner || this.buffer.length < this.minBoundaryChars || this.buffer.length > 32768) return -1;
    // Whitespace candidates supply no meaning. Keep the complete buffer as
    // evidence; a bounded candidate set is not a truncated source excerpt.
    const candidates = speechCandidates(this.buffer).filter(end => end >= this.minBoundaryChars && end <= this.maxChunkChars).slice(-64);
    if (!candidates.length) return -1;
    const state = snapshotSpeechSeams({ paragraph: this.buffer, candidates, nextCursor: null });
    const reader = new AbortController();
    this.pendingReader = reader;
    try {
      const run = await speechSeamsBattery.run(this.owner.port, { paragraph: state.paragraph, candidates: [...state.candidates] }, {
        signal: AbortSignal.any([this.cancellation.signal, this.owner.signal, reader.signal]),
        only: candidates.map((_, i) => `seam_${i}`), site: 'voice.spoken-turn.chunking', pattern: 'structure.stitch',
      });
      this.assertCurrent();
      reader.signal.throwIfAborted();
      const readings = candidates.map((_, i) => run.readings[`seam_${i}`]);
      if (readings.some(reading => !reading || reading.outcome !== 'act')) { run.recordAction('unsettled'); return -1; }
      run.recordAction('ready');
      return candidates.filter((_, i) => readings[i]!.verdict === 'yes').at(-1) ?? -1;
    } catch {
      this.assertCurrent();
      // Unavailable meaning never revives punctuation. Only the independent
      // size/latency/end-of-turn rules may release the buffered text.
      return -1;
    } finally { if (this.pendingReader === reader) this.pendingReader = undefined; }
  }

  private findWordBoundaryBefore(index: number): number {
    for (let i = Math.min(index, this.buffer.length); i > 0; i--) if (/\s/.test(this.buffer[i - 1] ?? '')) return i;
    return 0;
  }

  private takeChunk(end: number): string {
    const raw = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end);
    this.firstBufferedAt = this.buffer.trim() ? this.now() : null;
    return normalizeSpeechText(stripMarkdownForSpeech(raw));
  }
}

export function normalizeSpeechText(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
