/**
 * Error meaning and wording belong to the public routing reader. The product
 * owns only delivery: a bounded ordered queue that cannot outlive its caller.
 */
import { readUserFacingError, type UserFacingError } from '@goodvibes-jev/engine/sdk/platform/routing';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

export { readUserFacingError, readUserFacingErrorLine } from '@goodvibes-jev/engine/sdk/platform/routing';
export type { ErrorClass, UserFacingError } from '@goodvibes-jev/engine/sdk/platform/routing';

/** A deadline limits narration latency, never decides what an error means. */
export const ERROR_NOTICE_TIMEOUT_MS = 1500;
export function unavailableErrorLine(error: unknown): string {
  return `Error details unavailable. Original error: ${summarizeError(error)}`;
}
export function userErrorLine(reading: UserFacingError): string {
  return `${reading.message} ${reading.action}`;
}

interface NoticeDelivery {
  readonly isCurrent: () => boolean;
  readonly deliver: (reading: UserFacingError | null) => void;
  readonly discard?: () => void;
  /** Related narration joins this same queue/deadline; it never runs after delivery. */
  readonly prepare?: (signal: AbortSignal) => Promise<void>;
}
interface PendingNotice {
  delivery: NoticeDelivery | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  ready: boolean;
  errorReady: boolean;
  preparationReady: boolean;
  readonly controller: AbortController;
  reading: UserFacingError | null;
}

/**
 * Start reads together, deliver in arrival order. Cancel/close clears timers
 * and releases delivery closures immediately, including a reader that never
 * settles (the shared public reader has no AbortSignal parameter). Both reader
 * and delivery failures are contained here, never unhandled rejections.
 * `null` explicitly means unavailable interpretation; there is no classifier
 * fallback and no fabricated generic reading.
 */
export function createErrorNoticeOwner(timeoutMs = ERROR_NOTICE_TIMEOUT_MS) {
  const pending: PendingNotice[] = [];
  let closed = false;
  const safely = (work: () => void): void => {
    try { work(); } catch (error) {
      try { logger.debug('Error notice delivery failed', { error: summarizeError(error) }); } catch { /* diagnostics cannot recurse */ }
    }
  };
  const release = (item: PendingNotice): NoticeDelivery | undefined => {
    if (item.timer !== undefined) clearTimeout(item.timer);
    item.controller.abort();
    const delivery = item.delivery;
    item.delivery = undefined;
    item.timer = undefined;
    return delivery;
  };
  const flush = (): void => {
    while (pending[0]?.ready) {
      const item = pending.shift()!;
      const delivery = release(item);
      if (delivery) safely(() => {
        if (!closed && delivery.isCurrent()) delivery.deliver(item.reading);
        else delivery.discard?.();
      });
    }
  };
  const cancel = (): void => {
    for (const item of pending.splice(0)) {
      const delivery = release(item);
      if (delivery?.discard) safely(delivery.discard);
    }
  };
  return {
    enqueue(error: unknown, site: string, delivery: NoticeDelivery): void {
      if (closed) { if (delivery.discard) safely(delivery.discard); return; }
      const item: PendingNotice = {
        delivery, timer: undefined, ready: false, reading: null,
        errorReady: false, preparationReady: delivery.prepare === undefined,
        controller: new AbortController(),
      };
      pending.push(item);
      const update = (): void => {
        if (!item.delivery || item.ready) return;
        if (!item.errorReady || !item.preparationReady) return;
        item.ready = true;
        if (item.timer !== undefined) clearTimeout(item.timer);
        flush();
      };
      const settleError = (reading: UserFacingError | null): void => {
        if (!item.delivery || item.ready) return;
        item.reading = reading; item.errorReady = true; update();
      };
      const settlePreparation = (): void => {
        if (!item.delivery || item.ready) return;
        item.preparationReady = true; update();
      };
      item.timer = setTimeout(() => {
        if (!item.delivery || item.ready) return;
        // Preserve an error already read successfully if only setup facts stalled.
        item.controller.abort(); item.ready = true; flush();
      }, timeoutMs);
      item.timer.unref?.();
      void readUserFacingError(error, site).then(settleError, () => settleError(null));
      if (delivery.prepare) void Promise.resolve().then(() => {
        if (!item.controller.signal.aborted) return item.delivery?.prepare?.(item.controller.signal);
      }).then(settlePreparation, settlePreparation);
    },
    cancel,
    dispose(): void { closed = true; cancel(); },
  };
}
