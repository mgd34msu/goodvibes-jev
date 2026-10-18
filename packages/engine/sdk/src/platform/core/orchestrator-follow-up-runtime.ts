import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { normalizeConversationFollowUpItems, type ConversationFollowUpItem } from './conversation-follow-ups.js';

const FOLLOW_UP_DEDUP_TTL_MS = 60_000;
const FOLLOW_UP_RETRY_DELAY_MS = 250;

export interface OrchestratorFollowUpRuntimeOptions {
  readonly getThinkingState: () => { readonly isThinking: boolean; readonly isCompacting: boolean };
  readonly getQueuedUserMessageCount: () => number;
  /** Resume the original authorized work through the ordinary tool loop and its completion gate. */
  readonly resumeWork: (items: readonly ConversationFollowUpItem[], signal: AbortSignal) => Promise<void>;
  readonly routeLowPriorityMessage: (message: string) => void;
}

export class OrchestratorFollowUpRuntime {
  private queue: ConversationFollowUpItem[] = [];
  private flushScheduled = false;
  private isRunning = false;
  private activeAbortController: AbortController | null = null;
  private activeBatch: ConversationFollowUpItem[] = [];
  private disposed = false;
  private readonly recentKeys = new Map<string, number>();

  public constructor(private readonly options: OrchestratorFollowUpRuntimeOptions) {}

  public enqueue(item: ConversationFollowUpItem): void {
    if (this.disposed) return;
    const summary = item.summary.trim();
    if (summary.length === 0) return;
    const now = Date.now();
    this.pruneRecent(now);
    const lastSeenAt = this.recentKeys.get(item.key);
    if (lastSeenAt !== undefined && now - lastSeenAt < FOLLOW_UP_DEDUP_TTL_MS) return;
    this.recentKeys.set(item.key, now);
    this.queue.push({ ...item, summary });
    this.scheduleFlush();
  }

  public scheduleFlush(): void {
    if (this.disposed || this.flushScheduled || this.queue.length === 0) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush().catch((error: unknown) => {
        logger.warn('Orchestrator follow-up flush failed before provider call', {
          error: summarizeError(error),
        });
      });
    });
  }

  /** Interrupt a pending recovery when a user turn takes priority or the session stops. */
  public cancel(requeue = false): void {
    if (requeue && this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.queue.unshift(...this.activeBatch);
    }
    this.activeAbortController?.abort();
  }

  public dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.cancel();
  }

  private pruneRecent(now: number): void {
    for (const [key, seenAt] of this.recentKeys.entries()) {
      if (now - seenAt >= FOLLOW_UP_DEDUP_TTL_MS) {
        this.recentKeys.delete(key);
      }
    }
  }

  private takeBatch(): ConversationFollowUpItem[] {
    const batch = normalizeConversationFollowUpItems(this.queue);
    if (batch.length === 0) {
      this.queue = [];
      return [];
    }
    const batchKeys = new Set(batch.map((item) => item.key));
    this.queue = this.queue.filter((item) => !batchKeys.has(item.key));
    return batch;
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.queue.length === 0) return;
    const state = this.options.getThinkingState();
    if (state.isThinking || state.isCompacting || this.isRunning || this.options.getQueuedUserMessageCount() > 0) {
      const timer = setTimeout(() => this.scheduleFlush(), FOLLOW_UP_RETRY_DELAY_MS);
      timer.unref?.();
      return;
    }

    const batch = this.takeBatch();
    if (batch.length === 0) return;
    this.isRunning = true;
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.activeBatch = batch;
    const { signal } = controller;
    try {
      signal.throwIfAborted();
      // Neither completed results nor failure notices may publish an unchecked
      // assistant message. Both are evidence for the same checked execution path.
      await this.options.resumeWork(batch, signal);
    } catch (error) {
      if (signal.aborted) return;
      this.queue.unshift(...batch);
      logger.warn('Orchestrator follow-up recovery failed', {
        error: summarizeError(error),
        updates: batch.map((item) => item.summary),
      });
      this.options.routeLowPriorityMessage(`[Follow-up] Recovery remains pending: ${summarizeError(error)}`);
    } finally {
      this.activeAbortController = null;
      this.activeBatch = [];
      this.isRunning = false;
      if (this.queue.length > 0) {
        const timer = setTimeout(() => this.scheduleFlush(), FOLLOW_UP_RETRY_DELAY_MS);
        timer.unref?.();
      }
    }
  }
}
