/**
 * ui-live-run-9 item 2 in the agent: every delegated agent event is one
 * notification-history entry under a plain title, never a raw
 * "[Delegated task] …" system line. Drives the real producer
 * (registerAgentRuntimeEvents) so the lines and the matcher cannot drift.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { registerAgentRuntimeEvents } from '../../runtime/agent-runtime-events.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { publishNotice } from '../../core/notices.ts';
import { NotificationFeed } from '../../core/notifications-feed.ts';
import { delegatedTaskEventOfNotice } from '../../core/delegated-task-notices.ts';

const ctx = { sessionId: 's', traceId: 't', source: 'test' };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function wired() {
  const bus = new RuntimeEventBus();
  const feed = new NotificationFeed();
  const conversation = new ConversationManager(() => 100);
  conversation.setNoticeSink((content, { restored }) => publishNotice(feed, content, { restored, now: () => 1_000 }));
  const records: Record<string, unknown> = {
    'agent-aaaa1111': { id: 'agent-aaaa1111', template: 'engineer', task: 'Cap the retry delay', status: 'completed', startedAt: 0, completedAt: 12_000, toolCallCount: 4 },
    'agent-bbbb2222': { id: 'agent-bbbb2222', template: 'reviewer', task: 'Review the retry change', status: 'failed', startedAt: 0, completedAt: 9_000, toolCallCount: 2 },
    'agent-cccc3333': { id: 'agent-cccc3333', template: 'engineer', task: 'Long refactor', status: 'failed', startedAt: 0, completedAt: 90_000, toolCallCount: 40, failureReason: 'max_turns', turnBudget: { limit: 40, source: 'default' } },
  };
  const { unsubs, agentStatusIntervalRef } = registerAgentRuntimeEvents({
    runtimeBus: bus,
    domainDispatch: new Proxy({}, { get: () => () => {} }) as never,
    getSystemMessageRouter: () => ({ low: (m) => conversation.addSystemMessage(m), high: (m) => conversation.addSystemMessage(m) }),
    requestRender: () => {},
    configManager: { get: () => undefined } as never,
    agentManager: { getStatus: (id: string) => records[id], list: () => [] } as never,
    toolRegistry: { execute: async () => ({ success: false, output: '' }) } as never,
  });
  const stop = () => { for (const unsub of unsubs) unsub(); if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value); };
  return { bus, feed, stop };
}

describe('delegated-task events in the notification history', () => {
  test('each event is one entry under its plain title, with the line as the body', async () => {
    const { bus, feed, stop } = wired();
    bus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED', agentId: 'agent-aaaa1111', durationMs: 12_000 } as never, ctx));
    bus.emit('agents', createEventEnvelope('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'agent-bbbb2222', error: 'the provider refused the request', durationMs: 9_000 } as never, ctx));
    bus.emit('agents', createEventEnvelope('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'agent-cccc3333', error: 'max turns', durationMs: 90_000 } as never, ctx));
    await flush();
    stop();
    const entries = [...feed.list()].reverse();
    expect(entries.map((entry) => entry.title).sort()).toEqual(['Delegated task failed', 'Delegated task finished', 'Delegated task ran out of turns']);
    for (const entry of entries) expect(entry.title.startsWith('[')).toBe(false);
    expect(entries.find((entry) => entry.title === 'Delegated task finished')!.body).toBe('engineer aaaa1111 completed in 12s "Cap the retry delay"');
    expect(entries.find((entry) => entry.title === 'Delegated task failed')!.body).toContain('the provider refused the request');
    expect(entries.find((entry) => entry.title === 'Delegated task failed')!.level).toBe('warning');
  });

  test('other delegated-task lines are left as they are', () => {
    expect(delegatedTaskEventOfNotice('[Delegated task] 2 running\n  aaaa1111 working')).toBeUndefined();
    expect(delegatedTaskEventOfNotice('[Compaction] applied')).toBeUndefined();
  });
});
