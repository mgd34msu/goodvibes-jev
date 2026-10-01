import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  applyCatalogContextWindow, buildCatalogContextWindowIndex, CatalogContextWindowResolver,
  isLocalBaseUrl, matchCatalogProviderId, resolveCatalogContextWindow,
} from '../sdk/src/platform/providers/context-window-catalog.js';
import { ContextWindowOverrideStore } from '../sdk/src/platform/providers/context-window-overrides.js';
import { ModelLimitsService } from '../sdk/src/platform/providers/model-limits.js';
import type { CatalogModel } from '../sdk/src/platform/providers/model-catalog.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';

function catalog(providerId: string, id: string, tokens: number): CatalogModel {
  return { id, name: id, provider: providerId, providerId, providerEnvVars: [], pricing: null, tier: 'paid', contextWindow: tokens };
}
function model(extra: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'model-one', provider: 'remote', registryKey: 'remote:model-one', displayName: 'Model one', description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 8192, contextWindowProvenance: 'configured_cap', contextWindowOrigin: { kind: 'provider_file' }, selectable: true,
    ...extra,
  };
}
const limits = new ModelLimitsService({ cachePath: '/unused/context-window-test.json' });
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
function identityPort(pick: string, confidence = 0.95) {
  const fake = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, pick, confidence) : noulAnswer(0.95));
  const previous = installJudgmentPort(fake.port);
  restore = () => { installJudgmentPort(previous); };
  return fake;
}

describe('catalog windows preserve evidence and identity authority', () => {
  test('an own-provider exact entry outranks cross-provider consensus and remains known', () => {
    const { requests } = identityPort('none');
    const index = buildCatalogContextWindowIndex([catalog('remote', 'model-one', 16000), catalog('other', 'model-one', 256000)]);
    const resolved = applyCatalogContextWindow(model(), false, index);
    expect(resolved.contextWindow).toBe(16000);
    expect(resolved.contextWindowOrigin).toEqual({ kind: 'catalog', catalogProviderId: 'remote' });
    expect(limits.getKnownContextWindowForModel(resolved)).toBe(16000);
    expect(requests).toHaveLength(0);
  });

  test('provider identity uses only exact IDs and explicit aliases, never squashing or ai suffixes', () => {
    const index = buildCatalogContextWindowIndex([catalog('abacus', 'model-one', 32768)]);
    expect(matchCatalogProviderId('abacusai', index)).toBeNull();
    expect(matchCatalogProviderId('ABACUS', index)).toBeNull();
    expect(matchCatalogProviderId('abacusai', index, { abacusai: 'abacus' })).toBe('abacus');
    expect(resolveCatalogContextWindow('abacusai', 'model-one', index).origin.kind).toBe('consensus');
    expect(resolveCatalogContextWindow('abacusai', 'model-one', index, { abacusai: 'abacus' }).origin.kind).toBe('catalog');
  });

  test('consensus is an estimate, one vote per provider, majority first with ties smaller', () => {
    const index = buildCatalogContextWindowIndex([
      catalog('a', 'model-one', 16000), catalog('a', 'model-one', 16000),
      catalog('b', 'model-one', 32000), catalog('c', 'model-one', 32000),
    ]);
    const resolved = applyCatalogContextWindow(model(), false, index);
    expect(resolved.contextWindow).toBe(32000);
    expect(resolved.contextWindowOrigin).toEqual({ kind: 'consensus', providers: 3, agreeing: 2 });
    expect(limits.getContextWindowForModel(resolved)).toBe(32000);
    expect(limits.getKnownContextWindowForModel(resolved)).toBeNull();
    const tie = buildCatalogContextWindowIndex([catalog('a', 'model-one', 64000), catalog('b', 'model-one', 16000)]);
    expect(resolveCatalogContextWindow('remote', 'model-one', tie).tokens).toBe(16000);
  });

  test('non-exact model identity stays a guess until Jev reads it, then invalidates the owner', async () => {
    const { requests } = identityPort('vendor/model-one');
    let invalidations = 0;
    const resolver = new CatalogContextWindowResolver(
      () => rows, () => false, () => undefined, {}, () => { invalidations++; },
    );
    const rows = [catalog('remote', 'vendor/model-one', 64000)];
    const pending = resolver.apply(model());
    expect(pending.contextWindowProvenance).toBe('fallback');
    expect(limits.getKnownContextWindowForModel(pending)).toBeNull();
    resolver.apply(model()); // coalesced while reading
    await Bun.sleep(0);
    expect(invalidations).toBe(1);
    expect(requests).toHaveLength(1);
    expect(resolver.apply(model()).contextWindowOrigin).toEqual({ kind: 'catalog', catalogProviderId: 'remote' });
    expect(limits.getKnownContextWindowForModel(resolver.apply(model()))).toBe(64000);
  });

  test.each([['none', 0.95], ['vendor/model-one', 0.3]] as const)('a denied or weak identity (%s) is never promoted', async (pick, confidence) => {
    identityPort(pick, confidence);
    const index = buildCatalogContextWindowIndex([catalog('remote', 'vendor/model-one', 64000)]);
    expect(resolveCatalogContextWindow('remote', 'model-one', index).provenance).toBe('fallback');
    await Bun.sleep(0);
    expect(resolveCatalogContextWindow('remote', 'model-one', index).provenance).toBe('fallback');
  });

  test('an exact ID is not silently merged with prefixed or differently cased IDs', () => {
    const { requests } = identityPort('vendor/model-one');
    const index = buildCatalogContextWindowIndex([
      catalog('a', 'model-one', 16000), catalog('b', 'vendor/model-one', 64000), catalog('c', 'MODEL-ONE', 64000),
    ]);
    expect(resolveCatalogContextWindow('remote', 'model-one', index)).toEqual({
      tokens: 16000, provenance: 'catalog', origin: { kind: 'consensus', providers: 1, agreeing: 1 },
    });
    expect(requests).toHaveLength(0);
  });

  test('refreshing the catalog replaces the index and does not reuse an obsolete identity', async () => {
    identityPort('vendor/model-one');
    let rows = [catalog('remote', 'vendor/model-one', 64000)];
    const resolver = new CatalogContextWindowResolver(() => rows, () => false, () => undefined);
    resolver.apply(model()); await Bun.sleep(0);
    expect(resolver.apply(model()).contextWindow).toBe(64000);
    rows = [catalog('remote', 'unrelated', 32000)];
    const refreshed = resolver.apply(model());
    expect(refreshed.contextWindowProvenance).toBe('fallback');
    expect(limits.getKnownContextWindowForModel(refreshed)).toBeNull();
  });

  test('invalid catalog numbers are never evidence', () => {
    const index = buildCatalogContextWindowIndex([catalog('remote', 'model-one', Number.POSITIVE_INFINITY), catalog('other', 'model-one', Number.NaN), catalog('third', 'model-one', 0)]);
    const resolved = applyCatalogContextWindow(model(), false, index);
    expect(resolved.contextWindowProvenance).toBe('fallback');
    expect(limits.getKnownContextWindowForModel(resolved)).toBeNull();
  });

  test('catalog estimates never replace local observations, explicit user overrides or accepted floors', () => {
    const index = buildCatalogContextWindowIndex([catalog('remote', 'model-one', 64000)]);
    const local = model();
    expect(applyCatalogContextWindow(local, true, index)).toBe(local);
    for (const definition of [
      model({ contextWindowProvenance: 'provider_api' }),
      model({ contextWindowProvenance: 'accepted_floor' }),
      model({ contextWindowProvenance: 'observed_limit' }),
      model({ contextWindowOrigin: { kind: 'user_override' } }),
      model({ contextWindow: 12000 }),
    ]) expect(applyCatalogContextWindow(definition, false, index)).toBe(definition);
  });

  test('learned rejection above a consensus/family estimate supplies a genuine ceiling', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-catalog-observation-'));
    try {
      const store = new ContextWindowOverrideStore(join(root, 'overrides.json'));
      const guessed = model({ contextWindow: 8192, contextWindowProvenance: 'fallback' });
      store.recordRejection(guessed.registryKey, 16000);
      const observed = store.apply(guessed);
      expect(limits.getKnownContextWindowForModel(observed)).toBe(16000);
      expect(observed.contextWindowOrigin).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('local endpoint preservation', () => {
  test.each(['http://localhost:1234', 'http://127.0.0.1:1234', 'http://192.168.1.2', 'http://[::1]', 'http://[fd00::1]', 'http://server.home.arpa'])('%s is local', (url) => { expect(isLocalBaseUrl(url)).toBe(true); });
  test.each(['https://example.com', 'https://10.example.com', 'https://localhost.example.com', 'nonsense'])('%s is not local', (url) => { expect(isLocalBaseUrl(url)).toBe(false); });
});
