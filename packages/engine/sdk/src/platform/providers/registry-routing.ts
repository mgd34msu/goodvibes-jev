/**
 * The routing readings the provider registry keeps: model capability tiers
 * (routing.model-tier) and cross-provider model identity for failover groups
 * (routing.model-identity), both remembered under the registry's persistence
 * root, and the context-window row of each model nothing else sizes
 * (routing.context-window-family), remembered per process. Kept beside
 * registry.ts so the registry stays a thin owner.
 */
import { join } from 'node:path';
import { mapLimit } from '@goodvibes-jev/judgment';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { ModelTierStore } from '../routing/model-tiers.js';
import type { CatalogModel } from './model-catalog.js';
import { SyntheticIdentities } from './model-catalog-synthetic.js';
import type { ModelDefinition } from './registry-types.js';
import type { CanonicalModel } from './synthetic.js';
import { knownFallbackContextWindow, readFallbackContextWindow } from './context-window-fallback.js';

const CONTEXT_WINDOW_SITE = 'providers.registry.context-window-family';
/** How many unsized models have their window row read at once. */
const CONTEXT_WINDOW_CONCURRENCY = 8;

/** Provider-listed definitions with each unsized window set to its row as read so far. */
function resizeUnsizedModels(models: readonly ModelDefinition[]): ModelDefinition[] {
  return models.map((model) => model.contextWindowProvenance === 'fallback'
    ? { ...model, contextWindow: knownFallbackContextWindow(model.provider, model.id) }
    : model);
}

export class RegistryRoutingReadings {
  readonly #root: () => string;
  readonly #models: () => readonly CatalogModel[];
  #tiers: ModelTierStore | undefined;
  #synthetic: SyntheticIdentities | undefined;

  constructor(options: { readonly root: () => string; readonly models: () => readonly CatalogModel[] }) {
    this.#root = options.root;
    this.#models = options.models;
  }

  /** Model tier readings, persisted as model-tiers.json. */
  get tiers(): ModelTierStore {
    this.#tiers ??= new ModelTierStore({ path: join(this.#root(), 'model-tiers.json') });
    return this.#tiers;
  }

  /** Cross-provider identity readings for failover groups, persisted as synthetic-identities.json. */
  get synthetic(): SyntheticIdentities {
    this.#synthetic ??= new SyntheticIdentities({ path: join(this.#root(), 'synthetic-identities.json'), models: this.#models });
    return this.#synthetic;
  }

  /**
   * Reads the failover identities not yet read, then calls `rebuild` when any
   * were asked, so the registry's groups pick them up. Runs in the background
   * after a catalog is applied; a failure is logged and retried on the next
   * catalog load.
   */
  readInBackground(rebuild: () => void): void {
    void this.synthetic.readAll(this.#models())
      .then((asked) => { if (asked > 0) rebuild(); })
      .catch((error: unknown) => logger.warn('[routing] Failover identity readings failed', { error: summarizeError(error) }));
  }

  /**
   * Reads the documented window row (routing.context-window-family) of every
   * model built without a window: catalog and failover-group definitions,
   * and provider-listed ones the catalog does not cover, each only when
   * `reported` finds no configured, provider or OpenRouter window for it.
   * When a read changes any window, `rebuild` gets the resize for the stored
   * provider-listed definitions (the catalog and group ones are rebuilt from
   * the readings). Runs in the background; a failure is logged and retried on
   * the next catalog load or listing refresh.
   */
  readContextWindowsInBackground(
    built: readonly ModelDefinition[],
    native: readonly ModelDefinition[],
    reported: (model: ModelDefinition) => number | undefined,
    rebuild: (resize: typeof resizeUnsizedModels) => void,
  ): void {
    const builtKeys = new Set(built.map((model) => model.registryKey));
    const unsized = [...built, ...native.filter((model) => !builtKeys.has(model.registryKey))]
      .filter((model) => model.contextWindowProvenance === 'fallback' && reported(model) === undefined);
    if (unsized.length === 0) return;
    void mapLimit(unsized, CONTEXT_WINDOW_CONCURRENCY, async (model) =>
      (await readFallbackContextWindow(model.provider, model.id, CONTEXT_WINDOW_SITE)) !== model.contextWindow)
      .then((changed) => { if (changed.some(Boolean)) rebuild(resizeUnsizedModels); })
      .catch((error: unknown) => logger.warn('[routing] Context window readings failed', { error: summarizeError(error) }));
  }
}

/**
 * An alternative when the current model's provider fails non-transiently:
 * the failover group the model belongs to (exact group membership), else a
 * selectable model of the same tier on another provider.
 */
export function findAlternativeModel(
  current: ModelDefinition | undefined,
  registry: readonly ModelDefinition[],
  groups: readonly CanonicalModel[],
): ModelDefinition | null {
  if (!current || current.provider === 'synthetic') return null;
  const group = groups.find((canonical) => canonical.backends.some((backend) => backend.registryKey === current.registryKey));
  const groupModel = group ? registry.find((model) => model.provider === 'synthetic' && model.id === group.id) : undefined;
  if (groupModel) return groupModel;
  return registry.find((model) => model.registryKey !== current.registryKey && model.provider !== current.provider && model.tier === current.tier && model.selectable) ?? null;
}
