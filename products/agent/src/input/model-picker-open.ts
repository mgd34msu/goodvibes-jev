/**
 * model-picker-open.ts, opening the model picker without waiting on slow reads.
 *
 * The picker's model and provider lists come from the provider registry's
 * cached catalog, which is synchronous. What used to hold the open back was
 * the read awaited before the modal appeared: one credential store lookup per
 * configured provider (to say which credential source configured it). That
 * only decorates rows, so the picker now opens at once on the cached catalog
 * with a muted "loading catalog…" row, and that read, plus the live re-check
 * of each provider's served models, fills in when it lands. A close or a
 * newer open drops any load still in flight (ModelPickerModal.catalogTicket).
 */

import { modelFamilyReadings } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelPickerModal, ModelPickerTargetInfo } from './model-picker.ts';

type ConfiguredVia = Map<string, 'env' | 'secrets' | 'subscription' | 'anonymous'>;

/** Catalog data that arrives after the picker opened. */
interface CatalogFill {
  readonly models?: ModelDefinition[];
  readonly providers?: string[];
  readonly configuredViaMap?: ConfiguredVia;
}

export interface ModelPickerOpenDeps {
  readonly picker: ModelPickerModal;
  /** Register the picker as the open modal (input focus, modal stack). */
  readonly modalOpened: () => void;
  readonly render: () => void;
  /** The selectable models from the cached catalog (synchronous). */
  readonly listModels: () => ModelDefinition[];
  /** The selectable provider ids from the cached catalog (synchronous). */
  readonly listProviders: () => string[];
  /** The model row to select on open. */
  readonly currentModelId: () => string;
  readonly currentProviderId: () => string;
  readonly configuredProviderIds: () => ReadonlySet<string>;
  /** Which credential source configured each provider, given the providers the credential store holds keys for. */
  readonly buildConfiguredVia: (providerIds: readonly string[], configured: ReadonlySet<string>, secretProviderIds: ReadonlySet<string>) => ConfiguredVia;
  readonly buildTargets: () => ModelPickerTargetInfo[];
  /** Slow: one credential store read per configured provider. */
  readonly resolveSecretProviderIds: () => Promise<ReadonlySet<string>>;
  /** Optional live re-check of each provider's served models; resolves true when a list changed. */
  readonly refreshLiveModels?: () => Promise<boolean>;
  /** Best-effort prefetches (pinned and recent models); failures stay silent. */
  readonly prefetch?: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

/** Mark the catalog as loading; the returned ticket lets fillCatalog drop a load that a close or a newer open overtook. */
function beginCatalogLoad(picker: ModelPickerModal): number {
  picker.catalogLoading = true;
  return ++picker.catalogTicket;
}

function selectedItemId(picker: ModelPickerModal): string | null {
  if (picker.mode === 'model') return picker.getFilteredModels()[picker.selectedIndex]?.id ?? null;
  if (picker.mode === 'provider') return picker.getFilteredProviders()[picker.selectedIndex] ?? null;
  return null;
}

/**
 * Land catalog data that finished loading after the picker opened. The
 * query, filters and the selected row (matched by id) stay as they are.
 * Returns false, changing nothing, when the picker closed or a newer load
 * started since `ticket` was issued. `done` clears the loading row.
 */
function fillCatalog(picker: ModelPickerModal, ticket: number, fill: CatalogFill, done: boolean): boolean {
  if (!picker.active || ticket !== picker.catalogTicket) return false;
  const selectedId = selectedItemId(picker);
  if (fill.models) picker.models = fill.models;
  if (fill.providers) picker.providers = fill.providers;
  if (fill.configuredViaMap) picker.configuredViaMap = fill.configuredViaMap;
  picker.clearFilteredCaches();
  if (selectedId !== null && (picker.mode === 'model' || picker.mode === 'provider')) {
    const ids = picker.mode === 'model' ? picker.getFilteredModels().map((m) => m.id) : picker.getFilteredProviders();
    const idx = ids.indexOf(selectedId);
    picker.selectedIndex = idx >= 0 ? idx : Math.min(picker.selectedIndex, Math.max(0, ids.length - 1));
  }
  if (done) picker.catalogLoading = false;
  return true;
}

/**
 * Open the picker on the cached catalog right now (it is visible when this
 * returns), then fill in the slow parts. `mode` picks the model list (/model)
 * or the provider list (/provider). The returned promise settles when every
 * fill has landed or been dropped; callers do not need to await it.
 */
export function openModelPickerNow(deps: ModelPickerOpenDeps, mode: 'models' | 'providers' = 'models'): Promise<void> {
  const { picker } = deps;
  const configured = new Set(deps.configuredProviderIds());
  const models = deps.listModels();
  const providers = mode === 'providers' ? deps.listProviders() : [...new Set(models.map((m) => m.provider))];
  picker.configuredProviders = configured;
  picker.configuredViaMap = deps.buildConfiguredVia(providers, configured, new Set());
  deps.modalOpened();
  picker.setTargetInfos(deps.buildTargets());
  if (mode === 'providers') picker.openProviders(providers, deps.currentProviderId());
  else picker.openAllModels(models, deps.currentModelId());
  const ticket = beginCatalogLoad(picker);
  deps.render();

  const ownsCatalog = () => picker.active && picker.catalogTicket === ticket;
  const readFamilies = async (catalog: readonly ModelDefinition[]) => {
    try {
      await modelFamilyReadings.read(catalog);
    } catch (error) {
      if (ownsCatalog()) deps.onError(error);
    } finally {
      if (fillCatalog(picker, ticket, {}, false)) deps.render();
    }
  };
  const families = readFamilies(models);

  const prefetch = (deps.prefetch?.() ?? Promise.resolve()).catch(() => {}).then(() => { if (ownsCatalog()) deps.render(); });

  const decorations = (async () => {
    const secretIds = await deps.resolveSecretProviderIds();
    if (fillCatalog(picker, ticket, { configuredViaMap: deps.buildConfiguredVia(providers, configured, secretIds) }, false)) deps.render();
  })();

  const live = (async () => {
    if (!deps.refreshLiveModels) return;
    const changed = await deps.refreshLiveModels().catch(() => false);
    if (!changed) return;
    const fresh = mode === 'providers' ? { providers: deps.listProviders() } : { models: deps.listModels() };
    if (fillCatalog(picker, ticket, fresh, false)) deps.render();
    if (ownsCatalog()) await readFamilies(fresh.models ?? deps.listModels());
  })();

  return Promise.all([decorations, live, families])
    .catch((error: unknown) => deps.onError(error))
    .finally(() => {
      // Loaded or failed, the loading row goes: the picker keeps what it has.
      if (fillCatalog(picker, ticket, {}, true)) deps.render();
      return prefetch;
    })
    .then(() => {});
}
