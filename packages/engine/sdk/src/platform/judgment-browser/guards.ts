import { BrowserJudgmentError, type BrowserJudgmentErrorCode } from '@goodvibes-jev/engine/daemon-sdk';

/** A refused asynchronous hook must not leave a private rejection unhandled. */
export function consumeRejectedHook(value: unknown): void {
  try { void Promise.resolve(value).catch(() => {}); }
  catch { /* A hostile then/constructor getter is still only a refused hook. */ }
}
export function requireSynchronousAssertion(check: () => void, code: BrowserJudgmentErrorCode): void {
  const result: unknown = check();
  if (result !== undefined) { consumeRejectedHook(result); throw new BrowserJudgmentError(code); }
}
export function granted(value: unknown): boolean {
  if (value === true) return true;
  consumeRejectedHook(value);
  return false;
}
