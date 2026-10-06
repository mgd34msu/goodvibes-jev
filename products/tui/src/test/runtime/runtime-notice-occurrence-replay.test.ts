/** Real typed producers, message router, JSONL session and notification history share one occurrence. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeEventBus, type RuntimeEventEnvelope } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import type { AgentEvent, ContractEvent } from '@goodvibes-jev/engine/sdk/events';
import { registerHostRuntimeEvents } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { emitAgentCompleted, emitAgentFailed, emitContractPassed, emitContractFailed, emitContractCancelled, emitContractCommitted, type EmitterContext } from '@goodvibes-jev/engine/sdk/platform/runtime/emitters';
import { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { ConversationManager, type ConversationMessageSnapshot } from '../../core/conversation.ts';
import { SystemMessageRouter } from '../../core/system-message-router.ts';
import { createNotificationDispatcher, createShellNoticeSink, wireRuntimeNotificationBridge } from '../../runtime/notification-dispatch.ts';
import { NotificationFeed } from '../../views/notifications-feed.ts';
import { bridgeNotificationFeedToToasts, ToastCenter } from '../../renderer/toast-center.ts';
import { configGetStub } from '../helpers/config-manager-stub.ts';
import { SAMPLES } from '../helpers/contract-event-samples.ts';

const context: EmitterContext = { sessionId: 'one-session', traceId: 'shared-trace', source: 'notice-replay-test' };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
type NoticeEvent = AgentEvent | ContractEvent;
type Envelope = RuntimeEventEnvelope<NoticeEvent['type'], NoticeEvent>;
function harness(delayNotices = false) {
  const bus = new RuntimeEventBus();
  const feed = new NotificationFeed();
  const toasts = new ToastCenter(() => 0, () => {});
  const stopToasts = bridgeNotificationFeedToToasts(feed, toasts);
  const conversation = new ConversationManager(() => 100);
  conversation.setNoticeSink(createShellNoticeSink(feed));
  const router = new SystemMessageRouter(conversation);
  const delayed: Array<() => void> = [];
  const hostRouter = delayNotices ? {
    low: (...args: Parameters<SystemMessageRouter['low']>) => { delayed.push(() => router.low(...args)); },
    high: (...args: Parameters<SystemMessageRouter['high']>) => { delayed.push(() => router.high(...args)); },
    contract: (...args: Parameters<SystemMessageRouter['contract']>) => { delayed.push(() => router.contract(...args)); },
  } : router;
  const dispatcher = createNotificationDispatcher({ get: configGetStub() }, feed);
  const stopNotifications = wireRuntimeNotificationBridge(bus, dispatcher);
  const events: Envelope[] = [];
  const stops = [bus.onDomain('agents', (env) => events.push(env)), bus.onDomain('contracts', (env) => events.push(env))];
  const host = registerHostRuntimeEvents({
    runtimeBus: bus, domainDispatch: new Proxy({}, { get: () => () => {} }) as never,
    getSystemMessageRouter: () => hostRouter, requestRender: () => {},
    agentManager: { getStatus: () => ({ id: 'same-agent', template: 'engineer', task: 'Same task', status: 'completed', startedAt: 0, completedAt: 1000, toolCallCount: 2 }), list: () => [], listByCohort: () => [] } as never,
    contractRunner: { get: () => null, list: () => [] },
  });
  return { bus, feed, toasts, conversation, events, dispatcher, deliverNotices() { for (const deliver of delayed.splice(0)) deliver(); }, stop() {
    for (const stop of [...host.unsubs, ...stops, stopToasts, stopNotifications]) stop();
    if (host.agentStatusIntervalRef.value) clearInterval(host.agentStatusIntervalRef.value);
  } };
}

const cases: Array<{ name: string; domain: 'agents' | 'contracts'; emit: (bus: RuntimeEventBus) => void }> = [
  { name: 'agent completed', domain: 'agents', emit: (bus) => emitAgentCompleted(bus, context, { agentId: 'same-agent', durationMs: 1000, output: 'Same output', toolCallsMade: 2, usage: { inputTokens: 10, outputTokens: 2 } }) },
  { name: 'agent failed', domain: 'agents', emit: (bus) => emitAgentFailed(bus, context, { agentId: 'same-agent', durationMs: 1000, error: 'Same failure' }) },
  { name: 'contract passed', domain: 'contracts', emit: (bus) => emitContractPassed(bus, context, SAMPLES.CONTRACT_PASSED) },
  { name: 'contract failed', domain: 'contracts', emit: (bus) => emitContractFailed(bus, context, SAMPLES.CONTRACT_FAILED) },
  { name: 'contract cancelled', domain: 'contracts', emit: (bus) => emitContractCancelled(bus, context, SAMPLES.CONTRACT_CANCELLED) },
  ...(['committed', 'applied', 'skipped', 'failed'] as const).map((status) => ({ name: `contract commit ${status}`, domain: 'contracts' as const, emit: (bus: RuntimeEventBus) => emitContractCommitted(bus, context, { ...SAMPLES.CONTRACT_COMMITTED, status }) })),
];
for (const fixture of cases) {
  test(`${fixture.name}: bus, notice, persisted restore and replay keep one entry; a new identical outcome survives`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tui-occurrence-'));
    const live = harness();
    const restored = harness();
    try {
      fixture.emit(live.bus);
      await flush();
      expect(live.feed.list()).toHaveLength(1);
      expect(live.toasts.visible()).toHaveLength(1);
      const envelope = JSON.parse(JSON.stringify(live.events[0])) as Envelope;
      live.bus.emit(fixture.domain, envelope);
      await flush();
      expect(live.feed.list()).toHaveLength(1);
      expect(live.feed.list()[0]?.collapsedCount).toBe(1);
      expect(live.toasts.visible()).toHaveLength(1);
      const sessions = new SessionManager('/unused', { sessionsDir: root });
      sessions.save('notice', live.conversation.getMessageSnapshot(), { title: 'Notices', model: 'test', provider: 'test', timestamp: 1 });
      const data = { messages: sessions.load('notice').messages as ConversationMessageSnapshot[] };
      restored.conversation.fromJSON(data);
      restored.conversation.fromJSON(data);
      expect(restored.feed.list()).toHaveLength(1);
      expect(restored.toasts.visible()).toHaveLength(0);
      expect(restored.feed.unreadCount()).toBe(0);
      restored.bus.emit(fixture.domain, envelope);
      await flush();
      expect(restored.feed.list()).toHaveLength(1);
      expect(restored.toasts.visible()).toHaveLength(0);
      restored.dispatcher.router.setBatchWindowMs(1);
      fixture.emit(restored.bus);
      await flush();
      expect(restored.feed.list()).toHaveLength(2);
      expect(restored.feed.list().every((entry) => entry.collapsedCount === 1)).toBe(true);
      expect(restored.toasts.visible()).toHaveLength(1);
      expect(restored.events.at(-1)?.payload).not.toEqual(envelope.payload);
    } finally { live.stop(); restored.stop(); rmSync(root, { recursive: true, force: true }); }
  });
}


for (const busFirst of [true, false]) {
  for (const kind of ['agent failure', 'contract failure', 'contract cancellation'] as const) {
    test(`${kind} keeps complete diagnostic detail with ${busFirst ? 'bus' : 'notice'} arriving first`, async () => {
      const h = harness(busFirst);
      const reason = 'x'.repeat(80) + ' DIAGNOSTIC_TAIL\nSecond diagnostic line.';
      try {
        if (kind === 'agent failure') emitAgentFailed(h.bus, context, { agentId: 'same-agent', durationMs: 1000, error: reason });
        else if (kind === 'contract failure') emitContractFailed(h.bus, context, { ...SAMPLES.CONTRACT_FAILED, reason });
        else emitContractCancelled(h.bus, context, { ...SAMPLES.CONTRACT_CANCELLED, reason });
        await flush();
        h.deliverNotices();
        expect(h.feed.list()).toHaveLength(1);
        expect(h.feed.list()[0]?.body).toContain(reason);
      } finally { h.stop(); }
    });
  }
}
