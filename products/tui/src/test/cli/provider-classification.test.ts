import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { classifyProviderSetup } from '../../providers/provider-classification.ts';

const previous = installJudgmentPort(undefined);
afterEach(() => installJudgmentPort(previous));

describe('provider setup classification shared owner', () => {
  for (const [answer, setupClass] of [
    ['api_key', 'api-key'], ['cloud_account', 'cloud-account'], ['local_runtime', 'local'],
    ['no_key_free', 'no-key-free'], ['self_hosted', 'self-hosted'], ['subscription', 'subscription'],
  ] as const) {
    test(`retains ${setupClass} through the public reading rather than provider-id membership`, async () => {
      const { port, requests } = fakePort((name) => noulAnswer(name === answer ? 0.99 : 0.01));
      installJudgmentPort(port);
      const result = await classifyProviderSetup({ providerId: 'not-in-any-provider-list', runtime: { setup: { description: `Declared fixture for ${setupClass}.` } } });
      expect(result.setupClass).toBe(setupClass);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.context?.battery).toBe('providers.setup-presentation');
    });
  }
  test('id alone never makes a legacy local or subscription promise', async () => {
    expect((await classifyProviderSetup({ providerId: 'synthetic' })).setupClass).toBe('unknown');
    expect((await classifyProviderSetup({ providerId: 'openai-subscriber' })).setupClass).toBe('unknown');
  });
});
