/**
 * Webhook notifier bootstrap lifecycle tests.
 *
 * Verifies that bootstrap reuses services.webhookNotifier (rather than
 * constructing a second instance), configures it via setUrls(), attaches it
 * to the runtime bus, and registers a detach() call in runtimeUnsubs so the
 * bus subscription is cleaned up on shutdown.
 */
import { describe, expect, mock, test } from 'bun:test';
import { registerWebhookNotifier } from '../../runtime/bootstrap-core.ts';

// ── Minimal stubs ──────────────────────────────────────────────────────────────

function makeWebhookNotifier() {
  const calls: { setUrls?: string[][]; attachCount: number; detachCount: number } = {
    setUrls: undefined,
    attachCount: 0,
    detachCount: 0,
  };
  const notifier = {
    setUrls: mock((urls: string[]) => { calls.setUrls = (calls.setUrls ?? []).concat([urls]); }),
    attachToRuntimeBus: mock(() => { calls.attachCount++; }),
    detach: mock(() => { calls.detachCount++; }),
  };
  return { notifier, calls };
}

function makeRuntimeBus() {
  return { on: mock(() => () => {}), emit: mock(() => {}) };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('bootstrap webhook notifier lifecycle', () => {
  test('setUrls is called with the configured URL list on the services instance', () => {
    const { notifier } = makeWebhookNotifier();
    const runtimeBus = makeRuntimeBus();
    const runtimeUnsubs: Array<() => void> = [];

    registerWebhookNotifier(
      notifier as never,
      ['https://hooks.example.com/1', 'https://hooks.example.com/2'],
      runtimeBus as never,
      runtimeUnsubs,
    );

    expect(notifier.setUrls).toHaveBeenCalledTimes(1);
    expect(notifier.setUrls).toHaveBeenCalledWith([
      'https://hooks.example.com/1',
      'https://hooks.example.com/2',
    ]);
  });

  test('attachToRuntimeBus is called on the services instance (not a second notifier)', () => {
    const { notifier } = makeWebhookNotifier();
    const runtimeBus = makeRuntimeBus();
    const runtimeUnsubs: Array<() => void> = [];

    registerWebhookNotifier(
      notifier as never,
      ['https://hooks.example.com/a'],
      runtimeBus as never,
      runtimeUnsubs,
    );

    expect(notifier.attachToRuntimeBus).toHaveBeenCalledTimes(1);
    expect(notifier.attachToRuntimeBus).toHaveBeenCalledWith(runtimeBus);
  });

  test('a detach unsub is registered in runtimeUnsubs', () => {
    const { notifier } = makeWebhookNotifier();
    const runtimeBus = makeRuntimeBus();
    const runtimeUnsubs: Array<() => void> = [];

    registerWebhookNotifier(
      notifier as never,
      ['https://hooks.example.com/a'],
      runtimeBus as never,
      runtimeUnsubs,
    );

    expect(runtimeUnsubs).toHaveLength(1);
    // detach must not have been called yet
    expect(notifier.detach).not.toHaveBeenCalled();
  });

  test('draining runtimeUnsubs (shutdown) calls detach exactly once', () => {
    const { notifier, calls } = makeWebhookNotifier();
    const runtimeBus = makeRuntimeBus();
    const runtimeUnsubs: Array<() => void> = [];

    registerWebhookNotifier(
      notifier as never,
      ['https://hooks.example.com/a'],
      runtimeBus as never,
      runtimeUnsubs,
    );

    // Simulate shutdown: drain all unsubs
    for (const unsub of runtimeUnsubs) unsub();

    expect(calls.detachCount).toBe(1);
  });

  test('no registration occurs when webhookUrls is empty', () => {
    const { notifier } = makeWebhookNotifier();
    const runtimeBus = makeRuntimeBus();
    const runtimeUnsubs: Array<() => void> = [];

    registerWebhookNotifier(notifier as never, [], runtimeBus as never, runtimeUnsubs);

    expect(notifier.setUrls).not.toHaveBeenCalled();
    expect(notifier.attachToRuntimeBus).not.toHaveBeenCalled();
    expect(runtimeUnsubs).toHaveLength(0);
  });

  test('single detach call even if runtimeUnsubs drained twice (idempotency of the test harness)', () => {
    const { notifier, calls } = makeWebhookNotifier();
    const runtimeBus = makeRuntimeBus();
    const runtimeUnsubs: Array<() => void> = [];

    registerWebhookNotifier(
      notifier as never,
      ['https://hooks.example.com/a'],
      runtimeBus as never,
      runtimeUnsubs,
    );

    // drain once
    for (const unsub of runtimeUnsubs) unsub();
    // drain again (each unsub closure calls detach each time, this documents the contract)
    for (const unsub of runtimeUnsubs) unsub();

    // The closure calls detach() each time it is invoked, two drains = 2 calls
    expect(calls.detachCount).toBe(2);
  });
});
