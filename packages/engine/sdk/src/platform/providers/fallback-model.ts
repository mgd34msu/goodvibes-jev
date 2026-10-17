/**
 * Register the configured model before its catalog cache loads, using its documented
 * context window and reasoning levels so routing and context accounting agree.
 */
import type { ConfigManager } from '../config/manager.js';
import { knownFallbackContextWindow } from './context-window-fallback.js';
import { findFamilyReasoningEffortSpec } from './reasoning-effort-families.js';
import type { ModelDefinition } from './registry-types.js';
import type { ProviderRegistry } from './registry.js';

/**
 * Build the fallback `ModelDefinition` for a configured `provider:model` that
 * has not yet appeared in the live model catalog. Marked
 * `contextWindowProvenance: 'fallback'` so a later catalog entry for the same
 * `registryKey` is honestly understood to supersede it, never silently merged.
 */
export function buildFallbackModelDefinition(provider: string, modelId: string): ModelDefinition {
  // Nothing about this model is published yet, so nothing is claimed from the
  // provider's name: reasoning and its levels come from the model id's
  // documented family once routing.reasoning-family has read it, image input
  // and the capability tier stay unclaimed until the catalog lists the model.
  const familySpec = findFamilyReasoningEffortSpec(modelId);

  return {
    id: modelId,
    provider,
    registryKey: `${provider}:${modelId}`,
    displayName: modelId,
    description: 'Configured model available before the model catalog cache has loaded.',
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: familySpec !== undefined && familySpec.kind !== 'unavailable',
      multimodal: false,
    },
    contextWindow: knownFallbackContextWindow(provider, modelId),
    contextWindowProvenance: 'fallback',
    selectable: true,
    ...(familySpec ? { reasoningEffort: familySpec } : {}),
  };
}

/**
 * If the configured `provider.model` is provider-qualified, has a registered
 * provider, and is not yet in the live model catalog, register it as a
 * runtime fallback model so it resolves and meters correctly before the
 * catalog cache loads. A no-op when the model is unqualified, already
 * present, or its provider is not (yet) registered.
 */
export function ensureConfiguredModelIsRoutable(providerRegistry: ProviderRegistry, configManager: ConfigManager): void {
  const configuredModel = String(configManager.get('provider.model') ?? '').trim();
  if (!configuredModel.includes(':')) return;
  if (providerRegistry.listModels().some((model) => model.registryKey === configuredModel)) return;

  const [providerId, ...modelParts] = configuredModel.split(':');
  const modelId = modelParts.join(':').trim();
  if (!providerId || !modelId) return;

  const provider = providerRegistry.tryGet(providerId);
  if (!provider) return;

  providerRegistry.registerRuntimeProvider({
    provider,
    replace: true,
    models: [buildFallbackModelDefinition(providerId, modelId)],
  });
}
