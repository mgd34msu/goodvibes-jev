import { expect, test } from 'bun:test';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { emitAgentCompleted } from '@goodvibes-jev/engine/sdk/platform/runtime/emitters';
import { runtimeEventKey, type RuntimeEventProvenance } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { NotificationFeed } from '../../core/notifications-feed.ts';
import { publishNotice } from '../../core/notices.ts';

const line = '[Agents] ✓ engineer same-agent: "Same task" — completed in 1s (2 tool calls)';
for (const noticeFirst of [true, false]) {
  test(`Agent history folds bus and notice delivery (${noticeFirst ? 'notice' : 'bus'} first)`, async () => {
    const bus = new RuntimeEventBus();
    const feed = new NotificationFeed();
    let event: RuntimeEventProvenance | undefined;
    const stop = bus.on('AGENT_COMPLETED', ({ payload }) => { event = payload; });
    try {
      emitAgentCompleted(bus, { sessionId: 's', traceId: 'same-trace', source: 'test' }, { agentId: 'same-agent', durationMs: 1000 });
      await Promise.resolve();
      const key = runtimeEventKey('AGENT_COMPLETED', event);
      expect(key).toBeDefined();
      const notice = () => publishNotice(feed, line, { runtimeEvent: event, now: () => 1000 });
      const routed = (id: string) => feed.record({ id, domain: 'agents', level: 'info', title: 'Agent finished', timestamp: 1000 }, { target: 'panel_only', reasonCode: 'allowed' }, key);
      if (noticeFirst) notice();
      routed('one');
      notice();
      routed('two');
      expect(feed.list()).toHaveLength(1);
      expect(feed.list()[0]).toMatchObject({ title: 'Agent finished', collapsedCount: 1, body: 'engineer same-agent: "Same task" — completed in 1s (2 tool calls)' });
      const entry = feed.list()[0]!;
      expect(feed.dismiss(entry.key)).toBe(true);
      notice();
      expect(feed.list()).toHaveLength(1);
      feed.clear();
      routed('three');
      notice();
      expect(feed.list()).toHaveLength(1);
    } finally { stop(); }
  });
}

for (const runtimeEvent of [undefined, { type: 'AGENT_COMPLETED' }, { type: 'AGENT_COMPLETED', occurrenceId: '' }, { type: 'AGENT_FAILED', occurrenceId: 'same-id' }]) {
  test(`legacy or incomplete Agent notice provenance stays keyless: ${JSON.stringify(runtimeEvent)}`, () => {
    const feed = new NotificationFeed();
    publishNotice(feed, line, { runtimeEvent, restored: true });
    publishNotice(feed, line, { runtimeEvent, restored: true });
    expect(feed.list()).toHaveLength(2);
    expect(feed.list().every((entry) => entry.toast === 'never')).toBe(true);
    expect(feed.unreadCount()).toBe(0);
  });
}
