import { defineBattery, mapLimit, STAKES_BANDS, yesNo, type CallOptions, type JudgmentPort } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { ModelDefinition } from '../providers/registry-types.js';
import { sameProviderCatalog } from '../providers/provider-aliases.js';

export const sameFamily = defineBattery({
  name: 'routing.same-model-family',
  version: 1,
  description: 'Whether an agent candidate belongs to the selected model family and generation.',
  accuracyFloor: 0.9,
  items: {
    same_family: yesNo('Do selected and candidate belong to the same model family and major generation? Minor releases and capability variants within that generation count: GPT-6 and GPT-6.1, including sol/astra/luna variants, are the same family; GPT-5, Claude, Gemini and GPT-OSS are not members of GPT-6. Claude Opus/Sonnet/Haiku of the same major generation count together. Sharing a serving provider alone is insufficient. Use the model IDs and names, not guesses about their capabilities.', STAKES_BANDS.low.yesNo),
  },
  fixtures: [
    { name: 'minor release', state: { selected: { id: 'gpt-6.1-sol' }, candidate: { id: 'gpt-6-astra' } }, expect: { same_family: 'yes' } },
    { name: 'different maker', state: { selected: { id: 'gpt-6.1-sol' }, candidate: { id: 'claude-opus-4.5' } }, expect: { same_family: 'no' } },
    { name: 'different generation', state: { selected: { id: 'gpt-6.1-sol' }, candidate: { id: 'gpt-5-mini' } }, expect: { same_family: 'no' } },
  ],
});

const remembered = new WeakMap<JudgmentPort, Map<string, boolean>>();
type SelectedModel = Pick<ModelDefinition, 'id' | 'provider' | 'registryKey' | 'displayName'>;
const identity = (model: SelectedModel) => ({ id: model.id, name: model.displayName, provider: model.provider });

/** Provider is an exact connection boundary. Jev reads family membership within it. */
export async function withinSelectedFamily(models: readonly ModelDefinition[], selected: SelectedModel, options: CallOptions): Promise<ModelDefinition[]> {
  const byModel = new Map<string, ModelDefinition>();
  for (const model of models) {
    if (!sameProviderCatalog(model.provider, selected.provider)) continue;
    // Both catalog spellings describe the same model. Keep one candidate and
    // the selected connection on every route, including its fallbacks.
    if (!byModel.has(model.id) || model.registryKey === selected.registryKey) {
      byModel.set(model.id, model.provider === selected.provider ? model : { ...model, provider: selected.provider });
    }
  }
  const candidates = [...byModel.values()];
  const port = judgmentPort('routing.same-model-family');
  const version = port.model;
  const cache = remembered.get(port) ?? new Map<string, boolean>();
  remembered.set(port, cache);
  const allowed = await mapLimit(candidates, 8, async (candidate) => {
    options.signal?.throwIfAborted();
    options.beforeAttempt?.();
    if (candidate.id === selected.id) return true;
    const state = { selected: identity(selected), candidate: identity(candidate) };
    const key = `${version}:${JSON.stringify(state)}`;
    if (cache.has(key)) return cache.get(key)!;
    const run = await sameFamily.run(port, state, { ...options, site: 'routing.same-model-family' });
    options.signal?.throwIfAborted();
    options.beforeAttempt?.();
    if (judgmentPort('routing.same-model-family') !== port || port.model !== version) throw new Error('Model family judgment configuration changed.');
    // An uncertain alternative does not broaden the user's family boundary.
    // The selected model itself always remains available in the candidate set.
    const accepted = run.readings.same_family.verdict === 'yes';
    run.recordAction(accepted ? `include:${candidate.registryKey}` : `exclude:${candidate.registryKey}`);
    cache.set(key, accepted);
    return accepted;
  });
  return candidates.filter((_, index) => allowed[index]);
}
