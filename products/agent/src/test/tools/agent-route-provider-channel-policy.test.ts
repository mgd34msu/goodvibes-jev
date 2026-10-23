import { describe, expect, test } from 'bun:test';
import { useRouteAdapterFixture, route, preferredId } from '../helpers/route-adapter-fixture.ts';

useRouteAdapterFixture();

describe("Provider, channel and policy route adapters", () => {

  test('routes channel setup requests to the setup guide', async () => {
    const body = await route('set up Slack notifications');

    expect(preferredId(body)).toBe('channel-setup-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'channels action:"setup" target:"slack" includeParameters:true',
      inspectRoute: 'channels action:"triage" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('routes channel triage requests to channel triage', async () => {
    const body = await route('triage failed Discord delivery retries');

    expect(preferredId(body)).toBe('channel-triage-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'channels action:"triage" includeParameters:true',
      inspectRoute: 'channels action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes delivery receipt requests to channel history', async () => {
    const body = await route('show recent delivery receipts');

    expect(preferredId(body)).toBe('channel-delivery-receipts');
    expect(body.preferred).toMatchObject({
      modelRoute: 'channels action:"deliveries" limit:10 includeParameters:true',
      inspectRoute: 'channels action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes channel sends to a confirmed delivery boundary', async () => {
    const body = await route('send message to Telegram');

    expect(preferredId(body)).toBe('channel-delivery-boundary');
    expect(body.preferred).toMatchObject({
      modelRoute: 'channels action:"channel" target:"telegram" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('routes local model recommendations to the cookbook route', async () => {
    const body = await route('recommend an Ollama model for this laptop');

    expect(preferredId(body)).toBe('local-model-cookbook-route');
    expect(body.preferred).toMatchObject({
      modelRoute: 'models action:"local" query:"recommend an Ollama model for this laptop" includeParameters:true',
      inspectRoute: 'models action:"status" query:"local" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes local model server checks through the confirmed smoke route', async () => {
    const body = await route('check local model servers');

    expect(preferredId(body)).toBe('local-model-smoke-check');
    expect(body.preferred).toMatchObject({
      modelRoute: 'models action:"smoke" query:"check local model servers" includeParameters:true',
      inspectRoute: 'models action:"local" query:"local server health" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('routes provider account setup through provider posture', async () => {
    const body = await route('connect OpenRouter subscription');

    expect(preferredId(body)).toBe('model-provider-account-posture');
    expect(body.preferred).toMatchObject({
      modelRoute: 'models action:"provider" providerId:"openrouter" includeParameters:true',
      inspectRoute: 'models action:"providers" includeParameters:true',
      requiresConfirmation: true,
    });
  });


  test('routes route-fit requests through model route readiness', async () => {
    const body = await route('choose the best model route for long context coding');

    expect(preferredId(body)).toBe('model-route-readiness');
    expect(body.preferred).toMatchObject({
      modelRoute: 'models action:"route" query:"choose the best model route for long context coding" includeParameters:true',
      inspectRoute: 'models action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes permission posture questions to security status', async () => {
    const body = await route('show current permissions and approval mode');

    expect(preferredId(body)).toBe('security-permission-status');
    expect(body.preferred).toMatchObject({
      modelRoute: 'security action:"status" query:"show current permissions and approval mode" includeParameters:true',
      inspectRoute: 'security action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes blocked-action questions to read-only policy explanation', async () => {
    const body = await route('why was that terminal command blocked');

    expect(preferredId(body)).toBe('security-policy-explanation');
    expect(body.preferred).toMatchObject({
      modelRoute: 'security action:"explain" target:"terminal" toolArgs:{...} includeParameters:true',
      inspectRoute: 'security action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });


  test('routes security finding requests to finding inspection', async () => {
    const body = await route('inspect the leaked secret security finding');

    expect(preferredId(body)).toBe('security-finding-inspection');
    expect(body.preferred).toMatchObject({
      modelRoute: 'security action:"finding" target:"inspect the leaked secret security finding" includeParameters:true',
      inspectRoute: 'security action:"status" includeParameters:true',
      requiresConfirmation: false,
    });
  });
});
