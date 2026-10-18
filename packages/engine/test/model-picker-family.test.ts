import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ModelFamilyReadings } from '../sdk/src/platform/providers/model-family.ts';
import { installCatalogModelFacts } from '../sdk/src/platform/providers/model-catalog-facts.ts';
import type { CatalogModel } from '../sdk/src/platform/providers/model-catalog.ts';

const model = (id: string, provider = 'gateway') => ({ registryKey: `${provider}:${id}`, id, displayName: id, provider });
const catalog = (id: string, family?: string, providerId = 'gateway'): CatalogModel => ({
  id, family, canonicalModelId: `lab/${id}`, name: id, providerId, provider: providerId, providerEnvVars: [], pricing: null, tier: 'paid',
});
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); installCatalogModelFacts([]); });
afterEach(() => { installJudgmentPort(previous); installCatalogModelFacts([]); });

test('picker groups published families locally even when IDs and display names are opaque', async () => {
  installCatalogModelFacts([catalog('one', 'claude-sonnet'), catalog('two', 'qwen3.8-max'), catalog('three', 'muse')]);
  let calls = 0;
  installJudgmentPort({ model: 'synthetic', async ask() { calls++; throw new Error('Unexpected model metadata judgment'); } });
  const families = new ModelFamilyReadings();
  expect(families.known(model('one'))).toBe('Claude');
  expect(families.known(model('two'))).toBe('Qwen');
  expect(families.known(model('three'))).toBe('Other');
  expect(await families.read([model('one'), model('two')])).toBe(true);
  expect(await families.read([model('one'), model('two')])).toBe(false);
  expect(calls).toBe(0);
});

test('missing metadata stays ungrouped and display-name keywords cannot establish family', () => {
  const families = new ModelFamilyReadings();
  installCatalogModelFacts([catalog('known-without-family')]);
  expect(families.known(model('gpt-claude-alias'))).toBeUndefined();
  expect(families.known(model('known-without-family'))).toBeUndefined();
  expect(families.known(model('one', 'other-provider'))).toBeUndefined();
});

test('catalog refresh changes the group immediately without retaining stale results', async () => {
  const families = new ModelFamilyReadings(), evidence = model('alias');
  installCatalogModelFacts([catalog('alias', 'gpt-sol')]);
  expect(families.known(evidence)).toBe('GPT');
  await families.read([evidence]);
  installCatalogModelFacts([catalog('alias', 'llama')]);
  expect(families.known(evidence)).toBe('Llama');
  expect(await families.read([evidence])).toBe(true);
  installCatalogModelFacts([]);
  expect(families.known(evidence)).toBeUndefined();
});

test('provider aliases and canonical IDs join only published offerings on that provider', () => {
  installCatalogModelFacts([catalog('alias', 'gpt', 'openai')]);
  const families = new ModelFamilyReadings();
  expect(families.known(model('alias', 'openai-subscriber'))).toBe('GPT');
  expect(families.known(model('lab/alias', 'openai'))).toBe('GPT');
  expect(families.known(model('lab/alias', 'gateway'))).toBeUndefined();
});
