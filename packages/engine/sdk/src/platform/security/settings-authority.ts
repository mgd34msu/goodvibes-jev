/** Deterministic SETTINGS current-auth protection. This is never a Jev grant. */
export class SettingsAuthorityUnavailableError extends Error {
  readonly code = 'SETTINGS_AUTHORITY_UNAVAILABLE';
  constructor() {
    super('Current SETTINGS authentication authority is unavailable');
    this.name = 'SettingsAuthorityUnavailableError';
  }
}

const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(async () => undefined);

/**
 * The final owner boundary is synchronous. Reject known async functions before
 * entering them, and reject any returned thenable rather than releasing owner
 * protection around an allegedly completed asynchronous operation. The caller
 * retires its assertCurrent closure on every exit, including this refusal.
 */
export function runSynchronousSettingsOperation<T>(operation: (assertCurrent: () => void) => T,
  assertCurrent: () => void): T {
  if (Object.getPrototypeOf(operation) === ASYNC_FUNCTION_PROTOTYPE) {
    throw new Error('SETTINGS authority requires a synchronous operation');
  }
  const result = operation(assertCurrent);
  if (result !== null && (typeof result === 'object' || typeof result === 'function')
    && typeof (result as { then?: unknown }).then === 'function') {
    // A rejected native Promise must not become an unhandled rejection after
    // the synchronous refusal; no continuation gets a live currentness check.
    if (result instanceof Promise) void result.catch(() => undefined);
    throw new Error('SETTINGS authority requires a synchronous operation');
  }
  return result;
}
