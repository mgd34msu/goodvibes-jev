import type { ProviderRegistry } from './registry.js';
import type { ContextWindowOrigin, ContextWindowProvenance, ModelDefinition } from './registry-types.js';

/** The shared projection used by capacity consumers and the model picker. */
export interface ContextWindowReading {
  /** Numeric budget only; it can be an estimate or an accepted lower bound. */
  readonly contextWindow: number;
  readonly knownContextWindow: number | null;
  readonly contextWindowSource: ContextWindowProvenance | 'openrouter' | 'registry';
  readonly contextWindowOrigin?: ContextWindowOrigin | undefined;
  readonly contextWindowAcceptedFloor?: number | undefined;
}

type WindowRegistry = Pick<ProviderRegistry, 'getContextWindowForModel' | 'getKnownContextWindowForModel'>;

export function readModelContextWindow(model: ModelDefinition, registry: WindowRegistry): ContextWindowReading {
  const contextWindow = registry.getContextWindowForModel(model);
  const knownContextWindow = registry.getKnownContextWindowForModel(model);
  // A different numeric budget can also be a fallback. Only a known resolved
  // window may be attributed to OpenRouter; do not retain a contradictory origin.
  let contextWindowSource: ContextWindowReading['contextWindowSource'];
  if (knownContextWindow !== null && (contextWindow !== model.contextWindow ||
      model.contextWindowProvenance === 'fallback' || model.contextWindowProvenance === 'accepted_floor')) {
    contextWindowSource = 'openrouter';
  } else if (contextWindow !== model.contextWindow) {
    contextWindowSource = 'fallback';
  } else {
    contextWindowSource = model.contextWindowProvenance ?? 'registry';
  }
  return {
    contextWindow,
    knownContextWindow,
    contextWindowSource,
    ...(model.contextWindowAcceptedFloor !== undefined ? { contextWindowAcceptedFloor: model.contextWindowAcceptedFloor } : {}),
    ...(contextWindowSource !== 'openrouter' && contextWindow === model.contextWindow && model.contextWindowOrigin
      ? { contextWindowOrigin: model.contextWindowOrigin } : {}),
  };
}

/** Read the live model on every call; absent/unresolvable model knowledge stays unknown. */
export function readCurrentContextWindow(
  registry: (WindowRegistry & Pick<ProviderRegistry, 'getCurrentModel'>) | undefined,
): ContextWindowReading | null {
  if (!registry) return null;
  let model: ModelDefinition;
  try {
    model = registry.getCurrentModel();
  } catch {
    return null;
  }
  return readModelContextWindow(model, registry);
}
