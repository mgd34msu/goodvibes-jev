/**
 * bootstrap-notifier.ts, the Slack and Discord notifier the agent attaches to
 * its runtime bus. Extracted from bootstrap-core so the privacy wiring has a
 * test of its own.
 */
import { Notifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { readNotificationsMetadataOnly } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

/**
 * The Slack and Discord notifier, built from the configured services. Its
 * runtime-bus notices use the public legacy-envelope adapter. The current SDK
 * permits captured event details only when the live setting is literal false;
 * absent, malformed, or revoked preferences keep subsequent deliveries
 * metadata-only. The SDK owns admission and delivery-time privacy checks.
 */
export function createRuntimeNotifier(
  serviceRegistry: Parameters<typeof Notifier.fromConfig>[0],
  configGet: (key: string) => unknown,
): Promise<Notifier> {
  return Notifier.fromConfig(serviceRegistry, {
    metadataOnly: () => readNotificationsMetadataOnly(configGet),
  });
}
