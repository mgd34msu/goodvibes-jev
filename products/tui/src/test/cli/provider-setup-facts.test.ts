import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { classifyProviderSetup } from '../../providers/provider-classification.ts';

const previous = installJudgmentPort(undefined);
afterEach(() => installJudgmentPort(previous));

describe('provider setup facts adoption', () => {
  test('an uncatalogued operator gateway uses declared evidence, not its id or model count', async () => {
    const { port } = fakePort((name) => noulAnswer(name === 'self_hosted' ? 0.99 : 0.01));
    installJudgmentPort(port);
    const facts = {
      providerId: 'new-lab-gateway', authMode: 'anonymous', configured: true, modelCount: 3,
      runtime: { auth: { mode: 'anonymous' as const, configured: true }, setup: { description: 'Operator-managed gateway forwarding requests to independently billed upstreams.' } },
    };
    expect((await classifyProviderSetup(facts)).setupClass).toBe('self-hosted');
  });
  test('an old local id with remote API-key runtime facts is not declared local', async () => {
    const { port } = fakePort((name) => noulAnswer(name === 'api_key' ? 0.99 : 0.01));
    installJudgmentPort(port);
    const facts = { providerId: 'ollama', authMode: 'api-key', runtime: { auth: { mode: 'api-key' as const, configured: true, detail: 'Remote cloud API bills per token.' }, policy: { local: false } } };
    expect((await classifyProviderSetup(facts)).setupClass).toBe('api-key');
  });
  test('anonymous access and a model list never assert free access without billing evidence', async () => {
    const { port } = fakePort(() => noulAnswer(0.01));
    installJudgmentPort(port);
    expect((await classifyProviderSetup({ providerId: 'unknown-runtime', runtime: { auth: { mode: 'anonymous', configured: true }, models: { models: ['a', 'b', 'c'] } } })).setupClass).toBe('unknown');
  });
});
