import { afterEach, describe, expect, test } from 'bun:test';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ProviderSetupReadings, classifyProviderSetup, providerSetupState } from '../sdk/src/platform/providers/provider-setup.js';
import type { ProviderSetupFacts } from '../sdk/src/platform/providers/provider-setup.js';
import { OpenAICompatProvider } from '../sdk/src/platform/providers/openai-compat.js';
import { createBuiltinCompatProvider } from '../sdk/src/platform/providers/builtin-registry.js';
import { BUILTIN_COMPAT_PROVIDERS } from '../sdk/src/platform/providers/builtin-catalog.js';
import { createDiscoveredProvider } from '../sdk/src/platform/providers/discovered-factory.js';
import type { ProviderRuntimeMetadataDeps } from '../sdk/src/platform/providers/interface.js';
import { OllamaProvider } from '../sdk/src/platform/providers/ollama.js';
import { AmazonBedrockProvider } from '../sdk/src/platform/providers/amazon-bedrock.js';
import { AmazonBedrockMantleProvider } from '../sdk/src/platform/providers/amazon-bedrock-mantle.js';
import { AnthropicVertexProvider } from '../sdk/src/platform/providers/anthropic-vertex.js';
import { SyntheticProvider } from '../sdk/src/platform/providers/synthetic.js';

const previous = installJudgmentPort(undefined);
afterEach(() => installJudgmentPort(previous));
const facts: ProviderSetupFacts = { providerId: 'unlisted', runtime: { auth: { mode: 'anonymous', configured: true }, setup: { endpointOrigin: 'http://127.0.0.1:9300', description: 'Operator-managed gateway with independently billed upstreams.' } } };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const deps: ProviderRuntimeMetadataDeps = {
  secretsManager: { listDetailed: async () => [], get: async () => null },
  serviceRegistry: { getAll: () => ({}), inspect: async () => null },
  subscriptionManager: { get: () => null, getPending: () => null },
};
function answer(className: string) {
  return fakePort((name) => noulAnswer(name === className ? 0.99 : 0.01));
}
function heldPort(className = 'self_hosted') {
  const base = answer(className);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  const port: JudgmentPort = { ...base.port, async ask(request) { signal = request.signal; await gate; return base.port.ask(request); } };
  return { port, release, get signal() { return signal; } };
}

describe('provider setup display owner', () => {
  test('all six classes retain their names and id-independent readings', async () => {
    for (const [key, expected] of Object.entries({ api_key: 'api-key', cloud_account: 'cloud-account', local_runtime: 'local', no_key_free: 'no-key-free', self_hosted: 'self-hosted', subscription: 'subscription' } as const)) {
      const { port, requests } = answer(key); installJudgmentPort(port);
      expect((await classifyProviderSetup(facts)).setupClass).toBe(expected);
      expect(requests[0]?.context?.battery).toBe('providers.setup-presentation');
    }
  });
  test('contradictory, uncertain and entirely negative readings remain unknown', async () => {
    for (const p of [fakePort(() => noulAnswer(0.99)).port, fakePort((name) => noulAnswer(name === 'self_hosted' ? 0.99 : 0.5)).port, fakePort(() => noulAnswer(0.01)).port]) {
      installJudgmentPort(p);
      expect((await classifyProviderSetup(facts)).setupClass).toBe('unknown');
    }
  });
  test('missing runtime facts do not ask Jev or reuse id folklore', async () => {
    const { port, requests } = answer('local_runtime'); installJudgmentPort(port);
    expect((await classifyProviderSetup({ providerId: 'synthetic' })).setupClass).toBe('unknown');
    expect(requests).toHaveLength(0);
  });
  test('anonymous mode, readiness and zero cost are evidence, never an automatic free claim', async () => {
    installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
    expect((await classifyProviderSetup({ providerId: 'free-looking', runtime: { auth: { mode: 'anonymous', configured: true }, models: { models: ['one'] }, usage: { streaming: true, toolCalling: true, parallelTools: false, cost: { source: 'provider', inputPerMillionTokens: 0, outputPerMillionTokens: 0 } } } })).setupClass).toBe('unknown');
  });
  test('unavailable readings are unknown and are retried rather than cached', async () => {
    const owner = new ProviderSetupReadings();
    installJudgmentPort(undefined);
    expect((await owner.read(facts)).setupClass).toBe('unknown');
    const { port, requests } = answer('self_hosted'); installJudgmentPort(port);
    expect((await owner.read(facts)).setupClass).toBe('self-hosted');
    expect(requests).toHaveLength(1);
  });
  test('a successful immutable facts fingerprint caches; endpoint/auth/config changes reread', async () => {
    const owner = new ProviderSetupReadings(); const { port, requests } = answer('self_hosted'); installJudgmentPort(port);
    const mutable = { providerId: 'editable', runtime: { auth: { mode: 'api-key' as const, configured: false, routes: [{ route: 'api-key' as const, label: 'Key', configured: false, usable: false }] }, setup: { endpointOrigin: 'https://a.example', description: 'Operator-managed gateway' } } };
    await owner.read(mutable); await owner.read(mutable); expect(requests).toHaveLength(1);
    mutable.runtime.setup.endpointOrigin = 'https://b.example'; await owner.read(mutable);
    mutable.runtime.auth.configured = true; await owner.read(mutable);
    mutable.runtime.auth.routes[0]!.usable = true; await owner.read(mutable);
    mutable.runtime.setup.description = 'New declared setup'; await owner.read(mutable);
    owner.invalidate(); await owner.read(mutable);
    expect(requests).toHaveLength(6);
    expect(JSON.stringify(requests[0]?.state)).toContain('https://a.example');
    expect(JSON.stringify(requests[0]?.state)).not.toContain('https://b.example');
  });
  test('an old delayed facts generation cannot replace a newer reading', async () => {
    const owner = new ProviderSetupReadings(); const held = heldPort(); installJudgmentPort(held.port);
    const old = owner.read(facts); await tick();
    installJudgmentPort(answer('cloud_account').port);
    const next = { ...facts, runtime: { setup: { description: 'Cloud account workload identity' } } };
    expect((await owner.read(next)).setupClass).toBe('cloud-account');
    held.release(); expect((await old).setupClass).toBe('unknown');
    expect((await owner.read(next)).setupClass).toBe('cloud-account');
  });
  test('invalidation discards an in-flight reading even if the same facts later recur', async () => {
    const owner = new ProviderSetupReadings(); const held = heldPort(); installJudgmentPort(held.port);
    const pending = owner.read(facts); await tick(); owner.invalidate(); held.release();
    expect((await pending).setupClass).toBe('unknown');
    installJudgmentPort(answer('api_key').port);
    expect((await owner.read(facts)).setupClass).toBe('api-key');
  });
  test('cancellation aborts the wire and a late non-cooperative answer cannot cache', async () => {
    const owner = new ProviderSetupReadings(); const held = heldPort(); installJudgmentPort(held.port);
    const controller = new AbortController(); const pending = owner.read(facts, { signal: controller.signal }); await tick(); controller.abort();
    expect((await pending).setupClass).toBe('unknown'); expect(held.signal?.aborted).toBe(true);
    held.release(); await tick();
    const { port, requests } = answer('api_key'); installJudgmentPort(port);
    expect((await owner.read(facts)).setupClass).toBe('api-key'); expect(requests).toHaveLength(1);
  });
  test('a non-cooperative never-settling port is bounded and aborted', async () => {
    const held = heldPort(); installJudgmentPort(held.port);
    expect((await classifyProviderSetup(facts, { timeoutMs: 5 })).setupClass).toBe('unknown');
    expect(held.signal?.aborted).toBe(true); held.release();
  });
  test('pre-cancelled reading cannot return a cache hit', async () => {
    const owner = new ProviderSetupReadings(); installJudgmentPort(answer('self_hosted').port); await owner.read(facts);
    expect((await owner.read(facts, { signal: AbortSignal.abort() })).setupClass).toBe('unknown');
  });
  test('endpoint normalization excludes URL credentials, query, fragment and path', () => {
    const state = providerSetupState({ providerId: 'secret-host', runtime: { setup: { endpointOrigin: 'https://username:password@host.example:8443/secret-path?token=secret-query#secret-fragment' } } });
    expect(state).toContain('https://host.example:8443');
    for (const secret of ['username', 'password', 'secret-path', 'secret-query', 'secret-fragment']) expect(state).not.toContain(secret);
  });
});

describe('actual provider declarations reach presentation evidence', () => {
  test('generic keyed gateway keeps owner setup and sanitized origin independently of auth detail', async () => {
    const provider = new OpenAICompatProvider({ name: 'unknown-gateway', baseURL: 'https://u:p@gateway.example/private-key?token=secret', apiKey: 'secret-api-value', defaultModel: 'm', models: ['m'], setupDescription: 'Operator-managed gateway with separate upstream bills.' });
    const runtime = await provider.describeRuntime(deps);
    expect(runtime.auth?.mode).toBe('api-key');
    expect(runtime.setup).toEqual({ description: 'Operator-managed gateway with separate upstream bills.', endpointOrigin: 'https://gateway.example' });
    expect(providerSetupState({ providerId: provider.name, runtime })).not.toContain('secret-api-value');
  });
  test('the three old self-hosted builtins retain declared setup even with configured keys', async () => {
    for (const id of ['sglang', 'litellm', 'copilot-proxy']) {
      const provider = createBuiltinCompatProvider(BUILTIN_COMPAT_PROVIDERS.find((definition) => definition.id === id)!, 'fixture-key', {});
      const runtime = await provider.describeRuntime!(deps);
      expect(runtime.auth?.mode).toBe('api-key');
      expect(runtime.setup?.description).toMatch(/operator|self-hosted/i);
      installJudgmentPort(answer('self_hosted').port);
      expect((await classifyProviderSetup({ providerId: 'unrecognised-gateway', runtime })).setupClass).toBe('self-hosted');
    }
  });
  test('Foundry carries cloud-account evidence through the actual builtin factory', async () => {
    const provider = createBuiltinCompatProvider(BUILTIN_COMPAT_PROVIDERS.find((definition) => definition.id === 'microsoft-foundry')!, 'not-a-real-key', {});
    expect((await provider.describeRuntime!(deps)).setup?.description).toContain('Azure cloud account');
  });
  test('Bedrock, Mantle and Vertex already supply actual cloud-account evidence without an ID classifier', async () => {
    for (const provider of [new AmazonBedrockProvider(), new AmazonBedrockMantleProvider(), new AnthropicVertexProvider()]) {
      const runtime = await provider.describeRuntime(deps);
      const text = providerSetupState({ providerId: 'renamed-cloud', runtime });
      expect(text).toMatch(/AWS|Google|ADC/);
      installJudgmentPort(answer('cloud_account').port);
      expect((await classifyProviderSetup({ providerId: 'renamed-cloud', runtime })).setupClass).toBe('cloud-account');
    }
  });
  test('discovered custom gateway reaches runtime with discovery provenance and origin', async () => {
    const provider = createDiscoveredProvider({ name: 'new-lab-server', serverType: 'unknown', host: '127.0.0.1', port: 9300, baseURL: 'http://127.0.0.1:9300/v1', models: ['m'] });
    const runtime = await provider.describeRuntime!(deps);
    expect(runtime.setup?.description).toContain('Discovered');
    expect(runtime.setup?.endpointOrigin).toBe('http://127.0.0.1:9300');
  });
  test('remote and local Ollama carry different actual auth/locality facts', async () => {
    for (const [baseURL, local] of [['http://127.0.0.1:11434', true], ['https://ollama.com', false]] as const) {
      const provider = new OllamaProvider({ name: 'ollama', baseURL, apiKey: '', defaultModel: 'm', models: ['m'] });
      const runtime = await provider.describeRuntime(deps);
      expect(runtime.policy?.local).toBe(local);
      expect(runtime.auth?.mode).toBe(local ? 'anonymous' : 'api-key');
      installJudgmentPort(answer(local ? 'local_runtime' : 'api_key').port);
      expect((await classifyProviderSetup({ providerId: provider.name, runtime })).setupClass).toBe(local ? 'local' : 'api-key');
    }
  });
  test('synthetic router has truthful mixed evidence and classification cannot dispatch a backend', async () => {
    let dispatches = 0;
    const provider = new SyntheticProvider({ resolveProvider: () => { dispatches++; throw new Error('must not dispatch'); }, getCatalogModels: () => [], getBenchmarks: () => undefined });
    const runtime = provider.describeRuntime();
    expect(runtime.setup?.description).toContain('Multi-backend router');
    installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
    expect((await classifyProviderSetup({ providerId: 'synthetic', runtime })).setupClass).toBe('unknown');
    expect(dispatches).toBe(0);
  });
});
