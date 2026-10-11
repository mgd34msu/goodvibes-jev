/** Guarded-delivery opt-in is captured explicitly without bypassing plugin lifetime ownership. */
import { describe, expect, test } from 'bun:test';
import { ChannelDeliveryRouter } from '../sdk/src/platform/channels/delivery-router.js';
import type { ChannelDeliveryRequest, ChannelDeliveryStrategy } from '../sdk/src/platform/channels/delivery/types.js';
import { createOwnedPluginCapabilities } from '../sdk/src/platform/plugins/owned-capabilities.js';
import { PluginClosedError, PluginInFlightTracker } from '../sdk/src/platform/plugins/in-flight.js';
import { assertDeliveryCurrent, runDeliveryPublication } from '../sdk/src/platform/utils/delivery-lifetime.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const request: ChannelDeliveryRequest = {
  target: { kind: 'surface', surfaceKind: 'slack', address: 'owned-channel' },
  title: 'Owned delivery', body: 'Owned body', jobId: 'owned-job', runId: 'owned-run', includeLinks: false,
};
function ownership() {
  const tracker = new PluginInFlightTracker();
  const owned = createOwnedPluginCapabilities((call) => tracker.track('owned-delivery', call));
  return { tracker, owned, close: () => tracker.close('owned-delivery') };
}

for (const shape of ['absent', 'own-accessor', 'inherited-accessor', 'inherited-value'] as const) {
  test(`${shape} cannot grant guarded-delivery support`, async () => {
    let getterReads = 0;
    let delivered = 0;
    const source: ChannelDeliveryStrategy = {
      id: 'owned-strategy', canHandle: () => true,
      async deliver() { delivered++; return { responseId: 'owned-response' }; },
    };
    if (shape === 'own-accessor') {
      Object.defineProperty(source, 'supportsGuardedDelivery', { get() { getterReads++; return true; } });
    } else if (shape === 'inherited-accessor') {
      Object.setPrototypeOf(source, { get supportsGuardedDelivery() { getterReads++; return true; } });
    } else if (shape === 'inherited-value') {
      Object.setPrototypeOf(source, { supportsGuardedDelivery: true });
    }
    const fx = ownership();
    const strategy = fx.owned.delivery(source);
    expect(strategy.supportsGuardedDelivery).toBe(false);
    expect(getterReads).toBe(0);
    const router = new ChannelDeliveryRouter({ strategies: [strategy] });
    await expect(router.deliver({ ...request, assertCurrent() {} })).rejects.toThrow('does not support guarded delivery');
    expect(delivered).toBe(0);
    expect(getterReads).toBe(0);
    await expect(router.deliver(request)).resolves.toBe('owned-response');
    expect(delivered).toBe(1);
    await fx.close();
  });
}

test('later source flag mutation cannot grant a previously absent contract', async () => {
  const source = { id: 'owned-strategy', supportsGuardedDelivery: false, canHandle: () => true, async deliver() { return {}; } };
  const fx = ownership();
  const strategy = fx.owned.delivery(source);
  source.supportsGuardedDelivery = true;
  expect(strategy.supportsGuardedDelivery).toBe(false);
  await fx.close();
});

for (const shape of ['absent', 'own-accessor', 'inherited-accessor', 'inherited-value'] as const) {
  test(`${shape} cannot grant native publication support or execute a capability getter`, async () => {
    let getterReads = 0, delivered = 0;
    const source: ChannelDeliveryStrategy = { id: 'owned-publication', supportsGuardedDelivery: true, canHandle: () => true,
      async deliver() { delivered++; return {}; } };
    if (shape === 'own-accessor') Object.defineProperty(source, 'supportsPublication', { get() { getterReads++; return true; } });
    if (shape === 'inherited-accessor') Object.setPrototypeOf(source, { get supportsPublication() { getterReads++; return true; } });
    if (shape === 'inherited-value') Object.setPrototypeOf(source, { supportsPublication: true });
    const fx = ownership(), strategy = fx.owned.delivery(source);
    expect(strategy.supportsPublication).toBe(false); expect(getterReads).toBe(0);
    const router = new ChannelDeliveryRouter({ strategies: [strategy] });
    await expect(router.deliver({ ...request, withPublication: async operation => operation(() => {}) })).rejects.toThrow('does not support publication');
    expect(delivered).toBe(0); expect(getterReads).toBe(0);
    await expect(router.deliver({ ...request, assertCurrent() {} })).resolves.toBeUndefined();
    expect(delivered).toBe(1); await fx.close();
  });
}

test('late publication flag cannot upgrade a captured unsupported plugin', async () => {
  const source = { id: 'owned-publication', supportsGuardedDelivery: true, supportsPublication: false, canHandle: () => true, async deliver() { return {}; } };
  const fx = ownership(), strategy = fx.owned.delivery(source);
  source.supportsPublication = true;
  expect(strategy.supportsPublication).toBe(false);
  await expect(new ChannelDeliveryRouter({ strategies: [strategy] }).deliver({ ...request,
    withPublication: async operation => operation(() => {}) })).rejects.toThrow('does not support publication');
  await fx.close();
});

test('captured plugin publication forwards the original keeper with its class receiver and in-flight ownership', async () => {
  const fx = ownership(), entered = gate(), prepared = gate(); let delivered = 0, publications = 0;
  const withPublication: NonNullable<ChannelDeliveryRequest['withPublication']> = async operation => {
    publications++; expect(delivered).toBe(0); return operation(() => {});
  };
  class Strategy implements ChannelDeliveryStrategy {
    #receiver = 'owned-original'; readonly id = 'owned-publication';
    readonly supportsGuardedDelivery = true; readonly supportsPublication = true;
    canHandle() { return this.#receiver === 'owned-original'; }
    async deliver(input: ChannelDeliveryRequest) {
      expect(input.withPublication).toBe(withPublication); entered.release(); await prepared.promise;
      return runDeliveryPublication(input, current => {
        current(); expect(this.#receiver).toBe('owned-original'); delivered++; return { responseId: 'actual-owned-result' };
      });
    }
  }
  const strategy = fx.owned.delivery(Object.freeze(new Strategy()));
  const descriptor = Object.getOwnPropertyDescriptor(strategy, 'supportsPublication');
  expect(descriptor?.value).toBe(true); expect(descriptor?.get).toBeUndefined(); expect(descriptor?.writable).toBe(false);
  const pending = new ChannelDeliveryRouter({ strategies: [strategy] }).deliver({ ...request, withPublication });
  await entered.promise; expect(publications).toBe(0); expect(fx.tracker.inFlight('owned-delivery')).toBe(1);
  prepared.release(); await expect(pending).resolves.toBe('actual-owned-result');
  expect(publications).toBe(1); expect(delivered).toBe(1); await fx.close();
});

test('a replaced plugin deliver cannot inherit captured publication support or run a new getter', async () => {
  let delivered = 0, getterReads = 0;
  const source: ChannelDeliveryStrategy = { id: 'owned-publication', supportsGuardedDelivery: true, supportsPublication: true,
    canHandle: () => true, async deliver(input) { return runDeliveryPublication(input, () => { delivered++; return {}; }); } };
  const fx = ownership(), strategy = fx.owned.delivery(source), captured = strategy.deliver;
  Object.defineProperty(source, 'deliver', { get() { getterReads++; return async () => { delivered++; return {}; }; } });
  await expect(captured({ ...request, withPublication: async operation => operation(() => {}) })).rejects.toThrow('owner changed');
  await expect(new ChannelDeliveryRouter({ strategies: [strategy] }).deliver({ ...request,
    withPublication: async operation => operation(() => {}) })).rejects.toThrow('owner changed');
  expect(delivered).toBe(0); expect(getterReads).toBe(0); await fx.close();
});

describe('captured delivery contract ownership', () => {
  test('frozen class own capability keeps receiver, guard and in-flight shutdown tracking', async () => {
    const entered = gate();
    const held = gate();
    const controller = new AbortController();
    let delivered = 0;
    class Strategy implements ChannelDeliveryStrategy {
      #receiver = 'owned-receiver';
      readonly id = 'owned-strategy';
      readonly supportsGuardedDelivery = true;
      canHandle() { return this.#receiver === 'owned-receiver'; }
      async deliver(request: ChannelDeliveryRequest) {
        expect(this.#receiver).toBe('owned-receiver');
        expect(request.signal).toBe(controller.signal);
        entered.release();
        await held.promise;
        assertDeliveryCurrent(request);
        delivered++;
        return { responseId: 'owned-response' };
      }
    }
    const fx = ownership();
    const strategy = fx.owned.delivery(Object.freeze(new Strategy()));
    expect(strategy.supportsGuardedDelivery).toBe(true);
    const router = new ChannelDeliveryRouter({ strategies: [strategy] });
    const pending = router.deliver({ ...request, signal: controller.signal, assertCurrent() {} });
    await entered.promise;
    let closed = false;
    const closing = fx.close().then(() => { closed = true; });
    try {
      expect(fx.tracker.inFlight('owned-delivery')).toBe(1);
      await expect(strategy.deliver(request)).rejects.toThrow(PluginClosedError);
      expect(() => strategy.canHandle(request)).toThrow(PluginClosedError);
      expect(closed).toBe(false);
    } finally { held.release(); }
    await expect(pending).resolves.toBe('owned-response');
    await closing;
    expect(delivered).toBe(1);
    expect(fx.tracker.inFlight('owned-delivery')).toBe(0);
  });

  test('registration revoked during a tracked send drains safely with no delivery', async () => {
    const entered = gate();
    const held = gate();
    let delivered = 0;
    const fx = ownership();
    const strategy = fx.owned.delivery({
      id: 'owned-strategy', supportsGuardedDelivery: true, canHandle: () => true,
      async deliver(request) {
        entered.release();
        await held.promise;
        assertDeliveryCurrent(request);
        delivered++;
        return {};
      },
    });
    const router = new ChannelDeliveryRouter({ strategies: [strategy] });
    const pending = router.deliver({ ...request, assertCurrent() {} });
    await entered.promise;
    router.unregisterStrategy(strategy.id);
    router.registerStrategy(strategy);
    const closing = fx.close();
    held.release();
    await expect(pending).rejects.toThrow('registration is no longer current');
    await closing;
    expect(delivered).toBe(0);
    expect(fx.tracker.inFlight('owned-delivery')).toBe(0);
  });
});
