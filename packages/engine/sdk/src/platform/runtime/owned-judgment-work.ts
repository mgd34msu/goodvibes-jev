import { captureJudgmentPort, type JudgmentPortCapture, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';

/** A reader may borrow one operation's captured port without recapturing its source. */
export interface OwnedJudgmentOptions extends JudgmentReadingOptions {
  readonly port?: JudgmentPort | undefined;
}

/** One operation's lifetime, with a lazy snapshot for paths that never need a reading. */
export class OwnedJudgmentWork {
  private readonly _controller = new AbortController();
  private readonly _signal: AbortSignal;
  private _capture: JudgmentPortCapture | undefined;

  constructor(private readonly _options: JudgmentReadingOptions = {}) {
    this._signal = _options.signal ? AbortSignal.any([this._controller.signal, _options.signal]) : this._controller.signal;
  }

  get signal(): AbortSignal { return this._capture?.signal ?? this._signal; }

  readonly assertCurrent = (): void => {
    this._signal.throwIfAborted();
    this._options.assertCurrent?.();
    this._capture?.assertCurrent();
    this._signal.throwIfAborted();
  };

  get current(): boolean {
    try { this.assertCurrent(); return true; } catch { return false; }
  }

  retire(): void { this._controller.abort(new Error('Judgment work was retired')); }

  options(site: string): OwnedJudgmentOptions {
    const work = this;
    return {
      get port() {
        work.assertCurrent();
        work._capture ??= captureJudgmentPort(site, { signal: work._signal, assertCurrent: work._options.assertCurrent });
        work.assertCurrent();
        return work._capture.port;
      },
      get signal() { return work.signal; },
      assertCurrent: work.assertCurrent,
    };
  }

  /** Stop waiting for an uncooperative dependency; both late outcomes remain consumed. */
  async wait<T>(execute: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    const signal = this.signal;
    let abort = (): void => {};
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('Judgment work was retired'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const running = Promise.resolve().then(() => { this.assertCurrent(); return execute(); });
    try {
      const result = await Promise.race([running, stopped]);
      this.assertCurrent();
      return result;
    } finally { signal.removeEventListener('abort', abort); }
  }
}
