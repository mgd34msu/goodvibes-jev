import type { ConfigGet } from './alert-gating.js';

/** Host-owned preference read by notification producers at delivery time. */
export const NOTIFICATIONS_METADATA_ONLY_KEY = 'behavior.notificationsMetadataOnly';

/**
 * Read notification privacy live. Only an explicit boolean false permits
 * content-bearing notifications; absent, malformed or unreadable preferences
 * require metadata-only output. This also fails closed on an older config
 * schema, rather than treating an unavailable setting as permission to disclose.
 *
 * This reader does not install a schema/default or redact notification text.
 * Callers must enforce its result on every delivery, without caching it.
 */
export function readNotificationsMetadataOnly(configGet: ConfigGet): boolean {
  try {
    return configGet(NOTIFICATIONS_METADATA_ONLY_KEY) !== false;
  } catch {
    // An error can contain private persisted data; do not echo it in a notice.
    return true;
  }
}
