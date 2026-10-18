/** Provider routing tiers and deterministic cross-provider identity indexes. */
import { join } from 'node:path';
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

  /** Published canonical identities for failover groups. */
  get synthetic(): SyntheticIdentities {
    this.#synthetic ??= new SyntheticIdentities({ models: this.#models });
    return this.#synthetic;
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
