import { afterEach, describe, expect, test } from 'bun:test';
import { buildAdapters, clearAdapterRegistry, POLL_CADENCE_MS, registerAdapterFactory, registeredProviderIds, type AdapterContext, type InboundProviderAdapter } from '../sdk/src/platform/intake/provider-adapter.ts';

const context: AdapterContext = {
  credentials: { resolveRef: async () => null, resolveConfigSecret: async () => null },
  logger: { info() {}, warn() {}, error() {} },
};
function adapter(id: string): InboundProviderAdapter {
  return { id, pollIntervalMs: POLL_CADENCE_MS.default, poll: async () => ({ state: 'empty', items: [], configured: true }) };
}
afterEach(() => clearAdapterRegistry());

describe('inbound adapter registry contract', () => {
  test('registers factories lazily and passes the exact reader context', () => {
    let built = 0;
    registerAdapterFactory('fixture', (ctx) => { built += 1; expect(ctx).toBe(context); return adapter('fixture'); });
    expect(built).toBe(0);
    expect(registeredProviderIds()).toEqual(['fixture']);
    expect([...buildAdapters(context).keys()]).toEqual(['fixture']);
    expect(built).toBe(1);
  });

  test('preserves insertion order, replacement and explicit requested-provider filtering', () => {
    registerAdapterFactory('first', () => adapter('old'));
    registerAdapterFactory('second', () => adapter('second'));
    registerAdapterFactory('first', () => adapter('replacement'));
    expect(registeredProviderIds()).toEqual(['first', 'second']);
    expect(buildAdapters(context).get('first')?.id).toBe('replacement');
    expect([...buildAdapters(context, ['unknown', 'second']).keys()]).toEqual(['second']);
    expect([...buildAdapters(context, []).keys()]).toEqual(['first', 'second']);
    expect(buildAdapters(context, ['unknown']).size).toBe(0);
  });

  test('keeps unconfigured, unavailable and configured-empty states distinct', async () => {
    const empty = await adapter('fixture').poll({ limit: 10 });
    expect(empty).toEqual({ state: 'empty', items: [], configured: true });
    registerAdapterFactory('missing', () => ({ id: 'missing', pollIntervalMs: POLL_CADENCE_MS.email, poll: async () => ({ state: 'unavailable', items: [], configured: false, error: 'fixture missing credential' }) }));
    expect(await buildAdapters(context).get('missing')!.poll({ limit: 10 })).toMatchObject({ state: 'unavailable', configured: false });
    expect(POLL_CADENCE_MS).toEqual({ realtime: 30_000, email: 60_000, default: 120_000 });
  });

  test('clearing removes factories without executing them', () => {
    registerAdapterFactory('fixture', () => { throw new Error('must not build'); });
    clearAdapterRegistry();
    expect(registeredProviderIds()).toEqual([]);
    expect(buildAdapters(context).size).toBe(0);
  });
});
