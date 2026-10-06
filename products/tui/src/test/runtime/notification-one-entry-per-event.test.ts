/** Occurrence identity comes only from a proven shared key, never correlation metadata. */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { runtimeEventKey, registerHostRuntimeEvents } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { createNotificationDispatcher, createShellNoticeSink, wireRuntimeNotificationBridge, wireMemoryPressureNotice } from '../../runtime/notification-dispatch.ts';
import { emitContractPassed } from '@goodvibes-jev/engine/sdk/platform/runtime/emitters';
import { NotificationFeed } from '../../views/notifications-feed.ts';
import { configGetStub } from '../helpers/config-manager-stub.ts';
import { SAMPLES } from '../helpers/contract-event-samples.ts';

const config = { get: configGetStub() };
const context = { sessionId: 'fixture-session', traceId: 'shared-trace', source: 'notification-identity-test' };

for (const traceId of ['shared-trace', undefined]) {
  test(`two keyless occurrences at the same timestamp survive (traceId=${traceId})`, async () => {
    const feed = new NotificationFeed();
    const dispatcher = createNotificationDispatcher(config, feed);
    const bus = new RuntimeEventBus();
    const stop = wireRuntimeNotificationBridge(bus, dispatcher);
    try {
      for (let occurrence = 0; occurrence < 2; occurrence++) {
        // Reset batching through its actual API, so this checks identity rather
        // than a batch group accidentally masking an overwritten singleton.
        dispatcher.router.setBatchWindowMs(1);
        const payload = { type: 'AGENT_COMPLETED' as const, agentId: 'reused-agent', durationMs: 1000 };
        expect(runtimeEventKey(payload.type, payload)).toBeUndefined();
        bus.emit('agents', { ...createEventEnvelope(payload.type, payload, { ...context, traceId }), ts: 1000 });
        await Promise.resolve();
      }
      const entries = feed.list();
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((entry) => entry.key)).size).toBe(2);
      expect(entries.every((entry) => entry.timestamp === 1000 && entry.collapsedCount === 1)).toBe(true);
    } finally { stop(); }
  });
}

test('different domains can share one trace and timestamp without overwriting each other', async () => {
  const feed = new NotificationFeed();
  const dispatcher = createNotificationDispatcher(config, feed);
  const bus = new RuntimeEventBus();
  const stop = wireRuntimeNotificationBridge(bus, dispatcher);
  try {
    bus.emit('agents', { ...createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED', agentId: 'fixture-agent', durationMs: 1000 }, context), ts: 1000 });
    bus.emit('contracts', { ...createEventEnvelope('CONTRACT_PASSED', SAMPLES.CONTRACT_PASSED, context), ts: 1000 });
    await Promise.resolve();
    expect(feed.list().map((entry) => entry.title).sort()).toEqual(['Agent finished', 'Workstream passed']);
  } finally { stop(); }
});

for (const lineFirst of [true, false]) {
  test(`a caller with a proven occurrence key deduplicates repeated delivery (${lineFirst ? 'notice' : 'routed'} first)`, () => {
    const feed = new NotificationFeed();
    const dispatcher = createNotificationDispatcher(config, feed);
    // Explicit proven-key seam also covers either arrival order before batching.
    const occurrenceKey = 'fixture-authoritative-occurrence-1';
    const notice = () => feed.recordNotice({ domain: 'agents', level: 'info', title: 'Agent finished', body: 'Complete detail', timestamp: 1000, eventKey: occurrenceKey });
    const routed = (id: string) => dispatcher.dispatch({ id, domain: 'agents', level: 'info', title: 'Agent finished', timestamp: 1000 }, occurrenceKey);
    if (lineFirst) notice();
    routed('delivery-1');
    routed('delivery-2');
    notice();
    expect(feed.list()).toHaveLength(1);
    expect(feed.list()[0]).toMatchObject({ collapsedCount: 1, body: 'Complete detail' });
  });
}

for (const bridgeFirst of [true, false]) {
  test(`actual SDK operator lines and bus events share one occurrence (${bridgeFirst ? 'bridge' : 'line'} first)`, async () => {
    const feed = new NotificationFeed();
    const dispatcher = createNotificationDispatcher(config, feed);
    const bus = new RuntimeEventBus();
    const sink = createShellNoticeSink(feed);
    const stopBridge = bridgeFirst ? wireRuntimeNotificationBridge(bus, dispatcher) : undefined;
    const host = registerHostRuntimeEvents({
      runtimeBus: bus,
      domainDispatch: new Proxy({}, { get: () => () => {} }) as never,
      getSystemMessageRouter: () => ({ low: (line, runtimeEvent) => sink(line, { restored: false, runtimeEvent }), high: (line) => sink(line, { restored: false }), contract: (line, _priority, runtimeEvent) => sink(line, { restored: false, runtimeEvent }) }),
      requestRender: () => {},
      agentManager: { getStatus: () => undefined, list: () => [], listByCohort: () => [] } as never,
      contractRunner: { get: () => null, list: () => [] },
    });
    const stopAfter = bridgeFirst ? undefined : wireRuntimeNotificationBridge(bus, dispatcher);
    try {
      emitContractPassed(bus, context, SAMPLES.CONTRACT_PASSED);
      await Promise.resolve();
      expect(feed.list()).toHaveLength(1);
      expect(feed.list().every((entry) => entry.title === 'Workstream passed')).toBe(true);
    } finally {
      stopBridge?.(); stopAfter?.();
      for (const unsubscribe of host.unsubs) unsubscribe();
      if (host.agentStatusIntervalRef.value) clearInterval(host.agentStatusIntervalRef.value);
    }
  });
}

test('unknown legacy operator lines retain their original text as independent notices', () => {
  const feed = new NotificationFeed();
  const sink = createShellNoticeSink(feed);
  const text = '[Legacy] synthetic unrecognized lifecycle text';
  sink(text, { restored: true });
  sink(text, { restored: true });
  expect(feed.list().map((entry) => entry.title)).toEqual([text, text]);
  expect(feed.unreadCount()).toBe(0);
});

test('keyless memory-pressure deliveries also receive unique notification identities', async () => {
  const received: string[] = [];
  const bus = new RuntimeEventBus();
  const stop = wireMemoryPressureNotice(bus, { dispatch: (notice) => { received.push(notice.id); return { target: 'status_bar', reasonCode: 'allowed' }; } });
  try {
    const payload = { type: 'OPS_MEMORY_PRESSURE' as const, tier: 'high' as const, previousTier: 'elevated' as const, rssMb: 90, heapMb: 50, budgetMb: 100, usedPct: 90 };
    const event = { ...createEventEnvelope(payload.type, payload, context), ts: 1000 };
    bus.emit('ops', event); bus.emit('ops', event);
    await Promise.resolve();
    expect(received).toHaveLength(2);
    expect(new Set(received).size).toBe(2);
  } finally { stop(); }
});
