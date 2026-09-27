import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryType } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ProviderAccessReadings, providerAccessFrom } from '../../sdk/src/platform/routing/catalog-access.js';
import { transformModelsDevResponse } from '../../sdk/src/platform/providers/model-catalog-cache.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

const yes = { kind: 'yes-no' as const, probability: 0.95, verdict: 'yes' as const, outcome: 'act' as const };
const no = { kind: 'yes-no' as const, probability: 0.05, verdict: 'no' as const, outcome: 'act' as const };
const unsure = { kind: 'yes-no' as const, probability: 0.5, verdict: 'uncertain' as const, outcome: 'escalate' as const };

describe('provider access composition', () => {
  test('local, plan, metered and unsettled', () => {
    expect(providerAccessFrom({ local: yes, plan: no })).toBe('local');
    expect(providerAccessFrom({ local: no, plan: yes })).toBe('subscription');
    expect(providerAccessFrom({ local: no, plan: no })).toBe('metered');
    expect(providerAccessFrom({ local: unsure, plan: no })).toBeUndefined();
  });
});

describe('catalog tiers', () => {
  const feed = {
    metered: { id: 'metered', name: 'Metered', env: ['M_KEY'], models: { a: { id: 'a', cost: { input: 0, output: 0 } }, b: { id: 'b', cost: { input: 1, output: 2 } } } },
    plan: { id: 'plan', name: 'Plan', env: ['P_KEY'], models: { c: { id: 'c', cost: { input: 0, output: 0 } } } },
    unsettled: { id: 'unsettled', name: 'Unsettled', env: [], models: { d: { id: 'd', cost: { input: 0, output: 0 } } } },
  };

  test('zero cost is free only for a provider read as metered', () => {
    const access = new Map([['metered', 'metered' as const], ['plan', 'subscription' as const], ['unsettled', undefined]]);
    const tiers = Object.fromEntries(transformModelsDevResponse(feed, access).map((model) => [model.id, model.tier]));
    expect(tiers).toEqual({ a: 'free', b: 'paid', c: 'subscription', d: 'paid' });
  });
});

describe('access readings', () => {
  test('each provider is read once per set of facts and remembered on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-access-'));
    try {
      const { port, requests } = fakePort((name: string, _question, state: EntryType) =>
        noulAnswer(name === 'plan' && JSON.stringify(state).includes('Coding Plan') ? 0.95 : 0.05));
      installJudgmentPort(port);
      const path = join(dir, 'provider-access.json');
      const providers = [
        { id: 'x', name: 'X Coding Plan', envVars: ['X'], sampleModels: ['m'] },
        { id: 'y', name: 'Y Cloud', envVars: ['Y'], sampleModels: ['n'] },
      ];
      const first = await new ProviderAccessReadings({ path }).readAll(providers);
      expect(first.get('x')).toBe('subscription');
      expect(first.get('y')).toBe('metered');
      expect(requests).toHaveLength(2);
      const again = await new ProviderAccessReadings({ path }).readAll([...providers, { id: 'z', name: 'Z', envVars: [], sampleModels: [] }]);
      expect(again.get('x')).toBe('subscription');
      expect(requests).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
