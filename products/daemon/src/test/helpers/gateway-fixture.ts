/** Reconstructed actual product fixture. Only discovery and external adapters are synthetic. */
import { beforeAll, afterAll, spyOn } from 'bun:test';
import { ProviderRegistry, BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { startDaemonFixture, type DaemonFixture, type DaemonFixtureOptions } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from './owned-temp.js';
export function useGatewayFixture(options: Partial<DaemonFixtureOptions> = {}): () => DaemonFixture {
  let fixture: DaemonFixture;
  const restores: (() => void)[] = [];
  beforeAll(async () => {
    const keep = <T extends { mockRestore(): void }>(spy: T) => { restores.push(() => spy.mockRestore()); return spy; };
    keep(spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]));
    keep(spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined));
    keep(spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined));
    fixture = await startDaemonFixture({ root: makeOwnedTempDir('daemon-gateway'),
      inboxFactory: (context, _routing, opts) => registerInboxSurface(context, { ...opts, adapters: new Map() }),
      ...options,
    });
  });
  afterAll(async () => { try { await fixture?.stop(); } finally { for (const restore of restores.reverse()) restore(); } });
  return () => fixture;
}
