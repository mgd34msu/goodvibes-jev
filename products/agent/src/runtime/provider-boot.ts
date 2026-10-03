/**
 * provider-boot.ts, boot-time custom-provider readiness.
 *
 * Custom providers register asynchronously (services.ts fires
 * initCustomProviders() without awaiting), while the boot path, including
 * the first render frame, resolves the current model synchronously. Without
 * waiting here, a saved provider.model that points at a custom provider
 * throws "not in registry" before the first frame.
 */
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ensureConfiguredModelIsRoutable } from '@goodvibes-jev/engine/sdk/platform/providers';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';

/**
 * Await the initial custom-provider load, re-run the routability guard (its
 * services-composition pass bails when the provider itself isn't registered
 * yet, exactly the custom-provider case), and as a last resort switch to a
 * real selectable model instead of dying before the UI exists.
 */
export async function ensureBootModelResolvable(
  providerRegistry: ProviderRegistry,
  configManager: ConfigManager,
): Promise<void> {
  await providerRegistry.ready();
  ensureConfiguredModelIsRoutable(providerRegistry, configManager);
  try {
    providerRegistry.getCurrentModel();
  } catch (err) {
    // The configured provider no longer exists at all (e.g. its provider file
    // was deleted). Booting on a real selectable model with a warning beats
    // dying before the UI exists.
    const configured = String(configManager.get('provider.model') ?? '');
    const replacement = providerRegistry.getSelectableModels()[0]?.registryKey;
    if (!replacement) throw err;
    providerRegistry.setCurrentModel(replacement);
    configManager.set('provider.model', replacement);
    logger.warn(`[bootstrap] Configured model '${configured}' is not resolvable (its provider is not registered); switched to '${replacement}'.`);
  }
}
