import { describe, expect, test } from 'bun:test';
import { ModelIdentityResolver, type IdentityCandidate } from '../../sdk/src/platform/routing/model-identity.js';
import { buildSyntheticCanonicalModels, SyntheticIdentities } from '../../sdk/src/platform/providers/model-catalog-synthetic.js';
import type { CatalogModel } from '../../sdk/src/platform/providers/model-catalog.js';

describe('published model identity', () => {
  test('resolves exact IDs, declared aliases and canonical IDs locally', async () => {
    const resolver = new ModelIdentityResolver({ candidates: () => [
      { key: 'remote:served-id', id: 'served-id', provider: 'remote', canonicalModelId: 'lab/model-v2', aliases: ['configured-alias'] },
    ] });
    for (const id of ['served-id', 'configured-alias', 'lab/model-v2']) {
      expect(resolver.lookup({ id, provider: 'remote' }, 'test')).toBe('remote:served-id');
      expect(await resolver.resolve({ id, provider: 'remote' }, 'test')).toBe('remote:served-id');
    }
  });

  test('does not erase meaningful variants, snapshots, prefixes or punctuation', () => {
    const resolver = new ModelIdentityResolver({ candidates: () => [{ key: 'model-v2', id: 'model-v2' }] });
    for (const id of ['vendor/model-v2', 'model-v2-mini', 'model-v2-latest', 'model-v2-20261017', 'model-v3', 'model.v2'])
      expect(resolver.known({ id })).toBeNull();
  });

  test('provider-specific records stay separate and an ambiguous identity remains unknown', () => {
    const resolver = new ModelIdentityResolver({ candidates: () => [
      { key: 'a:served', id: 'served', provider: 'a', canonicalModelId: 'lab/model' },
      { key: 'b:alias', id: 'alias', provider: 'b', canonicalModelId: 'lab/model' },
    ] });
    expect(resolver.known({ id: 'lab/model' })).toBeNull();
    expect(resolver.known({ id: 'lab/model', provider: 'b' })).toBe('b:alias');
    expect(resolver.known({ id: 'served', canonicalModelId: 'lab/different' })).toBeNull();
  });

  test('refreshes identities when the source snapshot changes', () => {
    let source: readonly IdentityCandidate[] = [{ key: 'first', id: 'first', aliases: ['alias'] }];
    const resolver = new ModelIdentityResolver({ candidates: () => source });
    expect(resolver.known({ id: 'alias' })).toBe('first');
    source = [{ key: 'second', id: 'second', aliases: ['alias'] }];
    expect(resolver.known({ id: 'alias' })).toBe('second');
    expect(resolver.known({ id: 'first' })).toBeNull();
  });

  test('a cancelled caller cannot resolve a model', async () => {
    const resolver = new ModelIdentityResolver({ candidates: () => [{ key: 'model', id: 'model' }] });
    const abort = new AbortController(); abort.abort();
    await expect(resolver.resolve({ id: 'model' }, 'test', abort.signal)).rejects.toThrow();
  });
});

test('failover joins published identities without merging same-family variants or providers prices', () => {
  const model = (providerId: string, id: string, canonicalModelId: string, input: number): CatalogModel => ({
    id, canonicalModelId, name: 'Same display name', family: 'same-family', provider: providerId, providerId,
    providerEnvVars: [], pricing: { input, output: 2 * input }, tier: 'paid', contextWindow: input * 16000,
  });
  const models = [model('a', 'first', 'lab/model-v2', 1), model('b', 'second', 'lab/model-v2', 3), model('b', 'mini', 'lab/model-v2-mini', 2)];
  const groups = buildSyntheticCanonicalModels(models, new SyntheticIdentities({ models: () => models }));
  expect(groups).toHaveLength(1);
  expect(groups[0]!.backends.map(backend => backend.registryKey)).toEqual(['a:first', 'b:second']);
  expect(groups[0]!.backends.map(backend => backend.contextWindow)).toEqual([16000, 48000]);
  expect(models.map(model => model.pricing?.input)).toEqual([1, 3, 2]);
});
