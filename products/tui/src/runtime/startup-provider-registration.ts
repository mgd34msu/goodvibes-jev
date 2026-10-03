import { autoRegisterProviders } from '@goodvibes-jev/engine/sdk/platform/providers';
import { loadPersistedProviders } from '@goodvibes-jev/engine/sdk/platform/discovery';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { BackgroundProviderDiscoveryOptions } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';

/**
 * Restore providers without probing this machine or its network. Discovery is
 * an explicit /scan action in the TUI; the shared background discovery helper
 * also scans every local subnet and belongs behind the calling surface's consent.
 * Cached servers remain available until the user asks to discover changes.
 */
export function registerStartupProviders(options: BackgroundProviderDiscoveryOptions): void {
  const { configManager, providerRegistry, runtime, requestRender, restoreRuntimeModel, systemMessageRouter, shellPaths, surfaceRoot } = options;
  autoRegisterProviders(providerRegistry);
  const persisted = loadPersistedProviders({ ...shellPaths, surfaceRoot });
  if (persisted.length === 0) return;
  try {
    providerRegistry.registerDiscoveredProviders(persisted);
    restoreRuntimeModel(providerRegistry, configManager.get('provider.model') as string, runtime);
    for (const server of persisted) {
      systemMessageRouter.low(
        `[Local] ${server.name} at ${server.host}:${server.port} (${server.models.length} model${server.models.length !== 1 ? 's' : ''}), from last session`,
      );
    }
    requestRender();
  } catch (error) {
    logger.warn('[bootstrap] Persisted provider registration failed', { error: summarizeError(error) });
  }
}
