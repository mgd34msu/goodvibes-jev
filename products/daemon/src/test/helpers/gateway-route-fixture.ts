/** Actual product graph. Discovery and external adapter/model transports stay synthetic. */
import { beforeAll, afterAll, spyOn } from 'bun:test';
import { ProviderRegistry, BenchmarkStore, type ModelDefinition, type LLMProvider } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { startDaemonFixture, type DaemonFixture, type DaemonFixtureOptions } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from './owned-temp.js';
import { installProviderPricingFixture } from './provider-pricing-fixture.js';
export function fixtureModel(provider = 'mock', id = 'mock-model'): ModelDefinition {
  return { provider, id, registryKey: `${provider}:${id}`, displayName: id, description: 'Synthetic fixture transport',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false }, contextWindow: 100000, selectable: true,
    pricing: { input: 0, output: 0 } };
}
export async function startGatewayFixture(options: Partial<DaemonFixtureOptions> = {}): Promise<DaemonFixture> {
  const restores: (() => void)[] = [];
  const keep = <T extends { mockRestore(): void }>(spy: T) => { restores.push(() => spy.mockRestore()); return spy; };
  keep(spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]));
  keep(spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined));
  keep(spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined));
  restores.push(installProviderPricingFixture());
  try {
    const fixture = await startDaemonFixture({ root: makeOwnedTempDir('daemon-gateway'),
      inboxFactory: (context, _routing, opts) => registerInboxSurface(context, { ...opts, adapters: new Map() }), ...options,
    });
    const provider: LLMProvider = { name: 'mock', models: ['mock-model'], credentialAuthority: 'anonymous', modelSource: { kind: 'dated-static', asOf: '2026-10-09' },
      isConfigured: () => true, async chat() { return { content: 'Synthetic provider content; semantic decisions belong to the recorded judgment runtime.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' }; } };
    fixture.services.providerRegistry.registerRuntimeProvider({ provider, models: [fixtureModel()], replace: true });
    let closing: Promise<void> | undefined;
    return { ...fixture, stop() { return closing ??= fixture.stop().finally(() => { for (const restore of restores.reverse()) restore(); }); } };
  } catch (error) { for (const restore of restores.reverse()) restore(); throw error; }
}
export function useGatewayFixture(options: Partial<DaemonFixtureOptions> = {}): () => DaemonFixture {
  let fixture: DaemonFixture;
  beforeAll(async () => { fixture = await startGatewayFixture(options); });
  afterAll(async () => { await fixture?.stop(); });
  return () => fixture;
}
