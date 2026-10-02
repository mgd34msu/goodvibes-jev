/** Explicit production boot operations. The executable opts in separately. */
import type { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { Notifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { synchronizeConfiguredServices } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { foldLegacyProjectMemory, NOTIFICATIONS_METADATA_ONLY_KEY, readNotificationsMetadataOnly } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { DaemonBootOperations } from './boot-tasks.js';
import { createDaemonPluginLoaderDeps } from './plugin-composition.js';
import type { RuntimeServices } from './runtime-services-types.js';


/**
 * SDK factories use fail-fast joins. Keep every admitted credential/inspection
 * read owned after a sibling rejects, without mutating the shared registry.
 * The borrowed view delegates to the real methods and persisted configuration.
 */
async function withServiceReadDrain<T>(source: ServiceRegistry, action: (registry: ServiceRegistry) => Promise<T>): Promise<T> {
  const pending = new Set<Promise<void>>();
  const track = <R>(read: () => Promise<R>): Promise<R> => {
    const result = Promise.resolve().then(read);
    const settled = result.then(() => {}, () => {});
    pending.add(settled);
    void settled.then(() => { pending.delete(settled); });
    return result;
  };
  const registry: ServiceRegistry = new Proxy(source, {
    get(target, key, receiver): unknown {
      if (key === 'resolveSecret') return (...args: Parameters<ServiceRegistry['resolveSecret']>) =>
        track(() => target.resolveSecret.apply(registry, args));
      if (key === 'inspect') return (...args: Parameters<ServiceRegistry['inspect']>) =>
        track(() => target.inspect.apply(registry, args));
      return Reflect.get(target, key, receiver);
    },
  });
  try { return await action(registry); }
  finally { while (pending.size > 0) await Promise.all([...pending]); }
}

/** Pass through RuntimeServicesOptions.createBootOperations; start after server init. */
export function createDaemonBootOperations(runtime: RuntimeServices): DaemonBootOperations {
  const notificationRows = new Set<string>();
  const metadataOnly = (): boolean => readNotificationsMetadataOnly(
    () => runtime.configManager.get(NOTIFICATIONS_METADATA_ONLY_KEY as never),
  );
  return {
    async foldMemory() {
      const report = await foldLegacyProjectMemory(runtime.memoryStore, runtime.memoryEmbeddingRegistry, runtime.workingDirectory);
      if (report.failedSources.length > 0) throw new Error('Daemon legacy memory fold failed');
    },
    startProviderWatch: () => runtime.providerRegistry.startWatching(runtime.runtimeBus),
    stopProviderWatch: () => runtime.providerRegistry.closeWatching(),
    createWebhooks() {
      // Boot uses the same graph owner as memory-pressure delivery, even with no URLs.
      // Acquire before configuration/attachment so failures still retire it.
      return {
        attach() {
          const urls = runtime.configManager.getCategory('notifications').webhookUrls;
          if (urls.length > 0) {
            runtime.webhookNotifier.setUrls(urls);
            notificationRows.add('webhooks');
            runtime.runtimeDispatch.syncIntegration({
              id: 'webhooks', displayName: 'Webhooks', category: 'communication',
              status: 'healthy', enabled: true, successCount: 0, errorCount: 0,
              meta: { urlCount: urls.length },
            }, 'boot.webhooks');
          }
          runtime.webhookNotifier.attachToRuntimeBus(runtime.runtimeBus);
        },
        close: () => runtime.webhookNotifier.close(),
      };
    },
    async createNotifier() {
      const notifier = await withServiceReadDrain(runtime.serviceRegistry, (registry) =>
        Notifier.fromConfig(registry, { featureFlags: runtime.featureFlags, metadataOnly }));
      return {
        attach() {
          const queues = notifier.getQueueStatus();
          if (queues.length === 0) return;
          notifier.attachToRuntimeBus(runtime.runtimeBus);
          for (const queue of queues) {
            notificationRows.add(queue.channel);
            runtime.runtimeDispatch.syncIntegration({
              id: queue.channel, displayName: queue.channel[0]!.toUpperCase() + queue.channel.slice(1),
              category: 'communication', status: queue.metrics.deadLettered > 0 ? 'degraded' : 'healthy',
              enabled: true, successCount: queue.metrics.delivered, errorCount: queue.metrics.deadLettered,
              ...(queue.dlqEntries[0]?.deadAt ? { lastErrorAt: queue.dlqEntries[0].deadAt } : {}),
              ...(queue.dlqEntries[0]?.finalError ? { lastError: queue.dlqEntries[0].finalError } : {}),
              meta: { attempts: queue.metrics.totalAttempts, retrying: queue.metrics.retrying,
                deadLetters: queue.metrics.deadLettered, dlqSize: queue.metrics.dlqSize, sloEnforced: queue.sloEnforced },
            }, 'boot.notifier');
          }
        },
        close: () => notifier.close(),
      };
    },
    synchronizeServices: () => withServiceReadDrain(runtime.serviceRegistry, (registry) =>
      synchronizeConfiguredServices((record, source) => {
        // A webhook-only configured Slack/Discord service has no primary token.
        // Preserve the real notification owner's health and queue facts while
        // adding service inspection facts, rather than relabeling it unconfigured.
        const notification = notificationRows.has(record.id)
          ? runtime.runtimeStore.getState().integrations.integrations.get(record.id) : undefined;
        runtime.runtimeDispatch.syncIntegration(notification
          ? { ...record, ...notification, meta: { ...record.meta, ...notification.meta } }
          : record, source);
      }, registry)),
    initializePlugins: () => runtime.pluginManager.init(createDaemonPluginLoaderDeps(runtime)),
    closePlugins: () => runtime.pluginManager.close(),
    reportFailure(step) { logger.warn('Daemon boot step failed', { step }); },
  };
}
