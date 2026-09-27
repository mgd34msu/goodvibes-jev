/**
 * The routing readings the provider registry keeps: model capability tiers
 * (routing.model-tier) and cross-provider model identity for failover groups
 * (routing.model-identity), both remembered under the registry's persistence
 * root. Kept beside registry.ts so the registry stays a thin owner.
 */
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { ModelTierStore } from '../routing/model-tiers.js';
import type { CatalogModel } from './model-catalog.js';
import { SyntheticIdentities } from './model-catalog-synthetic.js';
import type { ModelDefinition } from './registry-types.js';
import type { CanonicalModel } from './synthetic.js';

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
