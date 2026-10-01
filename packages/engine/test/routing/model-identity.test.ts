import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { identityShortlist, identityTokens, ModelIdentityResolver, type IdentityCandidate } from '../../sdk/src/platform/routing/model-identity.js';
import { buildSyntheticCanonicalModels, SyntheticIdentities } from '../../sdk/src/platform/providers/model-catalog-synthetic.js';
import type { CatalogModel } from '../../sdk/src/platform/providers/model-catalog.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

/** A port whose identity pick is `pick(state)`, with every fit a yes. */
function identityPort(pick: (state: EntryType) => string, confidence = 0.95) {
  return fakePort((name: string, question: Question, state: EntryType) =>
    name === 'pick' ? choiceAnswer(question, pick(state), confidence) : noulAnswer(0.95));
}

const candidates: IdentityCandidate[] = [
  { key: 'anthropic/claude-sonnet-4.5', id: 'anthropic/claude-sonnet-4.5' },
  { key: 'anthropic/claude-sonnet-4', id: 'anthropic/claude-sonnet-4' },
  { key: 'openai/gpt-4o', id: 'openai/gpt-4o' },
  { key: 'mistral/mistral-small', id: 'mistral/mistral-small' },
];

describe('shortlist', () => {
  test('tokens split on punctuation and where letters meet digits', () => {
    expect(identityTokens('gpt4o-mini')).toEqual(['gpt', '4', 'o', 'mini']);
  });

  test('offers only candidates sharing a token, best first, each key once', () => {
    const index = [...candidates, { key: 'openai/gpt-4o', id: 'openai/gpt-4o' }].map((candidate) => ({
      candidate,
      tokens: new Set(identityTokens(candidate.id)),
      length: candidate.id.length,
    }));
    const shortlist = identityShortlist({ id: 'claude-sonnet-4-5-20250929' }, index).map((c) => c.key);
    expect(shortlist[0]).toBe('anthropic/claude-sonnet-4.5');
    expect(shortlist).not.toContain('mistral/mistral-small');
    expect(identityShortlist({ id: 'gpt-4o' }, index).filter((c) => c.key === 'openai/gpt-4o')).toHaveLength(1);
  });
});

describe('resolver', () => {
  test('lookup answers null while the reading is requested, then the read match; a later lookup asks nothing', async () => {
    const { port, requests } = identityPort(() => 'anthropic/claude-sonnet-4.5');
    installJudgmentPort(port);
    const resolver = new ModelIdentityResolver({ universe: 'test', candidates: () => candidates });
    expect(resolver.lookup({ id: 'claude-sonnet-4-5-20250929' }, 'test')).toBeNull();
    await Bun.sleep(0);
    expect(resolver.lookup({ id: 'claude-sonnet-4-5-20250929' }, 'test')).toBe('anthropic/claude-sonnet-4.5');
    expect(requests).toHaveLength(1);
  });

  test('a query sharing no token with any candidate asks nothing and matches nothing', async () => {
    const { port, requests } = identityPort(() => 'none');
    installJudgmentPort(port);
    const resolver = new ModelIdentityResolver({ universe: 'test', candidates: () => candidates });
    expect(await resolver.resolve({ id: 'zzz' }, 'test')).toBeNull();
    expect(requests).toHaveLength(0);
  });

  test('an escalated reading leaves the model unmatched', async () => {
    const { port } = identityPort(() => 'anthropic/claude-sonnet-4', 0.3);
    installJudgmentPort(port);
    const resolver = new ModelIdentityResolver({ universe: 'test', candidates: () => candidates });
    expect(await resolver.resolve({ id: 'claude-sonnet-4-latest' }, 'test')).toBeNull();
  });

  test('readings persist across resolvers sharing a path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-identity-'));
    try {
      const { port, requests } = identityPort(() => 'openai/gpt-4o');
      installJudgmentPort(port);
      const path = join(dir, 'ids.json');
      await new ModelIdentityResolver({ universe: 'test', candidates: () => candidates, path }).resolve({ id: 'gpt-4o-2024-08-06' }, 'test');
      const again = new ModelIdentityResolver({ universe: 'test', candidates: () => candidates, path });
      expect(again.known({ id: 'gpt-4o-2024-08-06' })).toBe('openai/gpt-4o');
      expect(requests).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a lookup with no port installed logs the failure and stays unmatched', () => {
    const resolver = new ModelIdentityResolver({ universe: 'test', candidates: () => candidates });
    expect(resolver.lookup({ id: 'claude-sonnet-4-5' }, 'test')).toBeNull();
  });
});

function catalogModel(providerId: string, id: string, family: string, name = id): CatalogModel {
  return { id, name, family, provider: providerId, providerId, providerEnvVars: [], pricing: { input: 1, output: 2 }, tier: 'paid', contextWindow: 128_000 };
}

describe('failover groups', () => {
  const models = [
    catalogModel('alpha', 'opus-5', 'opus', 'Opus 5'),
    catalogModel('beta', 'vendor/opus-5', 'opus', 'Opus 5'),
    catalogModel('beta', 'vendor/opus-4', 'opus', 'Opus 4'),
    catalogModel('alpha', 'solo', 'solo'),
  ];

  test('entries are grouped only after the identity readings say they are the same model', async () => {
    const matches: Readonly<Record<string, string>> = { 'opus-5': 'beta:vendor/opus-5', 'vendor/opus-5': 'alpha:opus-5' };
    // Read the queried model, not an id that merely occurs among its candidates.
    const pick = (state: EntryType): string => matches[(state as { context: { model: { id: string } } }).context.model.id] ?? 'none';
    const { port, requests } = identityPort(pick);
    installJudgmentPort(port);
    const identities = new SyntheticIdentities({ models: () => models });
    expect(buildSyntheticCanonicalModels(models, identities)).toEqual([]);
    const asked = await identities.readAll(models);
    expect(asked).toBe(3);
    for (const request of requests) {
      const question = request.questions['pick']!;
      expect(question.type).toBe('choice');
      if (question.type !== 'choice') throw new Error('expected the identity Choice question');
      expect(Object.hasOwn(question.criteria, pick(request.state))).toBe(true);
    }
    const groups = buildSyntheticCanonicalModels(models, identities);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.backends.map((backend) => backend.registryKey)).toEqual(['alpha:opus-5', 'beta:vendor/opus-5']);
    expect(groups[0]!.keyedBackendCount).toBe(2);
    expect(await identities.readAll(models)).toBe(0);
  });
});
