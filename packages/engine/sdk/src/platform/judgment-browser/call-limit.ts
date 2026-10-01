import { BrowserJudgmentError } from '@goodvibes-jev/engine/daemon-sdk';

interface Waiting {
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly start: () => void;
}
/** Internal bounded fan-out, separate from logical HTTP admission. Cancellation removes queued work. */
export class BrowserJudgmentCallLimit {
  #active = 0;
  readonly #waiting: Waiting[] = [];
  constructor(private readonly concurrent: number, private readonly waiting: number) {}
  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try { if (signal.aborted) throw signal.reason; return await work(); }
    finally { release(); }
  }
  private acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#active >= this.concurrent && this.#waiting.length >= this.waiting) return Promise.reject(new BrowserJudgmentError('JUDGMENT_BUSY'));
    return new Promise((resolve, reject) => {
      const item: Waiting = {
        signal,
        abort: () => {
          const index = this.#waiting.indexOf(item);
          if (index >= 0) this.#waiting.splice(index, 1);
          reject(signal.reason);
        },
        start: () => {
          signal.removeEventListener('abort', item.abort);
          if (signal.aborted) { reject(signal.reason); this.next(); return; }
          this.#active++;
          let released = false;
          resolve(() => { if (released) return; released = true; this.#active--; this.next(); });
        },
      };
      if (this.#active < this.concurrent) item.start();
      else { this.#waiting.push(item); signal.addEventListener('abort', item.abort, { once: true }); }
    });
  }
  private next(): void {
    if (this.#active < this.concurrent) this.#waiting.shift()?.start();
  }
}
