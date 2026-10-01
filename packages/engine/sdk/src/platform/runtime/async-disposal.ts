import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export interface AsyncDisposalRegistry {
  /** Late registration immediately starts cleanup; it never reopens the scope. */
  add(label: string, dispose: () => void | Promise<void>): void;
}

export interface AsyncDisposalScope {
  readonly registry: AsyncDisposalRegistry;
  /** Compatibility wrapper. Failures are logged and remain observable through close(). */
  dispose(): void;
  /** Drain owned cleanup newest-first. Wait before transferring runtime ownership. */
  close(): Promise<void>;
}

interface Failure { readonly label: string; readonly error: unknown; }
interface Entry { readonly label: string; readonly dispose: () => void | Promise<void>; }

export class AsyncDisposalError extends Error {
  readonly code = 'DISPOSAL_FAILED';
  readonly failures: readonly Failure[];
  constructor(scopeName: string, failures: readonly Failure[]) {
    super(`${scopeName}: ${failures.length} cleanup operation(s) failed.`);
    this.name = 'AsyncDisposalError';
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
  }
}

/**
 * Awaitable counterpart of createDisposalScope. The original synchronous API
 * remains unchanged. Synchronous callbacks still run immediately; asynchronous
 * children finish before older dependencies are torn down. Cleanup continues
 * after failure, then close rejects with all recorded failures.
 *
 * Registration after shutdown starts immediately cleans the late resource.
 * A close already in progress includes that work. Registration after a close
 * settles is cleaned immediately too; a subsequent close drains it. A settled
 * promise cannot promise to cover resources registered in the future.
 *
 * A callback may request dispose again, but must not await its own scope's
 * close promise. Resource cleanup is responsible for its own cancellation.
 */
export function createAsyncDisposalScope(scopeName: string): AsyncDisposalScope {
  const entries: Entry[] = [];
  const pendingLate = new Set<Promise<void>>();
  const failures: Failure[] = [];
  let started = false;
  let active = false;
  let revision = 0;
  let closedRevision = -1;
  let closing: Promise<void> | undefined;

  function failed(entry: Entry, error: unknown): void {
    failures.push({ label: entry.label, error });
    try { logger.warn(`${scopeName}: teardown failed`, { subsystem: entry.label, error: summarizeError(error) }); }
    catch { /* Reporting cannot interrupt cleanup or erase the recorded failure. */ }
  }
  function run(entry: Entry): Promise<void> | undefined {
    try {
      const result = entry.dispose();
      if (result === closing && result !== undefined) throw new Error('A cleanup callback cannot await its own scope close.');
      if (result && typeof result.then === 'function') return Promise.resolve(result).then(() => {}, (error: unknown) => failed(entry, error));
    } catch (error) { failed(entry, error); }
    return undefined;
  }
  function waitLate(): Promise<void> | undefined {
    return pendingLate.size > 0 ? Promise.all([...pendingLate]).then(() => {}) : undefined;
  }
  async function drain(): Promise<void> {
    while (entries.length > 0) {
      for (;;) {
        const late = waitLate(); if (!late) break;
        await late;
      }
      const entry = entries.pop()!;
      const pending = run(entry); if (pending) await pending;
    }
  }
  function close(): Promise<void> {
    if (closing && (active || closedRevision === revision)) return closing;
    started = true; active = true;
    let resolve!: () => void;
    let reject!: (error: AsyncDisposalError) => void;
    closing = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
    const result = closing;
    const finish = (): void => {
      const late = waitLate();
      if (late) { void late.then(finish); return; }
      active = false; closedRevision = revision;
      if (failures.length > 0) reject(new AsyncDisposalError(scopeName, failures));
      else resolve();
    };
    // run() handles each callback's failure, keeping drain itself non-rejecting.
    void drain().then(finish);
    return result;
  }
  return {
    registry: {
      add(label, dispose) {
        const entry = { label, dispose };
        if (!started) { entries.push(entry); return; }
        revision++;
        const pending = run(entry);
        if (pending) {
          pendingLate.add(pending);
          void pending.then(() => pendingLate.delete(pending));
        }
      },
    },
    close,
    dispose() { void close().catch(() => {}); },
  };
}
