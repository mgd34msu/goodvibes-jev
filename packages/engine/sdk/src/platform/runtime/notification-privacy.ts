import type { ConfigGet } from './alert-gating.js';

/** Host-owned preference read by notification producers at delivery time. */
export const NOTIFICATIONS_METADATA_ONLY_KEY = 'behavior.notificationsMetadataOnly';

/**
 * Read notification privacy live. Only an explicit boolean false permits
 * content-bearing notifications; absent, malformed or unreadable preferences
 * require metadata-only output. This also fails closed on an older config
 * schema, rather than treating an unavailable setting as permission to disclose.
 * Async/thenable results never authorize content; their rejection is consumed
 * without awaiting them or exposing private failure details.
 *
 * This reader does not install a schema/default or redact notification text.
 * Callers must enforce its result on every delivery, without caching it.
 */
export function readNotificationsMetadataOnly(configGet: ConfigGet): boolean {
  try {
    const value = configGet(NOTIFICATIONS_METADATA_ONLY_KEY);
    if (value === false) return false;
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      // ConfigGet returns unknown, so an async host callback is structurally
      // allowed. Observe it through an owned promise without trusting its value.
      void new Promise<unknown>((resolve) => resolve(value)).then(
        () => undefined,
        () => undefined,
      );
    }
    return true;
  } catch {
    // An error can contain private persisted data; do not echo it in a notice.
    return true;
  }
}
