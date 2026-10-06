/**
 * ui-live-run-9 item 2 in the agent: every delegated agent event is one
 * notification-history entry under a plain title, never a raw
 * "[Delegated task] …" system line. Drives the real producer
 * (registerAgentRuntimeEvents) so the lines and the matcher cannot drift.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitAgentCompleted, emitAgentFailed } from '@goodvibes-jev/engine/sdk/platform/runtime/emitters';
import { runtimeEventKey } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { AgentEvent } from '@goodvibes-jev/engine/sdk/events';
import type { RuntimeEventEnvelope } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import type { ConversationMessageSnapshot } from '../../core/conversation.ts';
import { SystemMessageRouter } from '../../core/system-message-router.ts';
import { ActivityFeed } from '../../core/activity-feed.ts';
import { bridgeNotificationFeedToToasts, ToastCenter } from '../../renderer/toast-center.ts';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { registerAgentRuntimeEvents } from '../../runtime/agent-runtime-events.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { publishNotice } from '../../core/notices.ts';
import { NotificationFeed } from '../../core/notifications-feed.ts';
import { delegatedTaskEventOfNotice } from '../../core/delegated-task-notices.ts';

const ctx = { sessionId: 's', traceId: 't', source: 'test' };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function wired(execute: () => Promise<{ success: boolean; output: string }> = async () => ({ success: false, output: '' })) {
  const bus = new RuntimeEventBus();
  const feed = new NotificationFeed();
  const conversation = new ConversationManager(() => 100);
  conversation.setNoticeSink((content, options) => publishNotice(feed, content, { ...options, now: () => 1_000 }));
  const router = new SystemMessageRouter(conversation, new ActivityFeed(), () => 'both');
  const toasts = new ToastCenter(() => 0, () => {});
  const stopToasts = bridgeNotificationFeedToToasts(feed, toasts);
  const events: RuntimeEventEnvelope<AgentEvent['type'], AgentEvent>[] = [];
  const stopEvents = bus.onDomain('agents', (env) => events.push(env));
  const records: Record<string, unknown> = {
    'agent-aaaa1111': { id: 'agent-aaaa1111', template: 'engineer', task: 'Cap the retry delay', status: 'completed', startedAt: 0, completedAt: 12_000, toolCallCount: 4 },
    'agent-bbbb2222': { id: 'agent-bbbb2222', template: 'reviewer', task: 'Review the retry change', status: 'failed', startedAt: 0, completedAt: 9_000, toolCallCount: 2 },
    'agent-cccc3333': { id: 'agent-cccc3333', template: 'engineer', task: 'Long refactor', status: 'failed', startedAt: 0, completedAt: 90_000, toolCallCount: 40, failureReason: 'max_turns', turnBudget: { limit: 40, source: 'default' } },
  };
  const { unsubs, agentStatusIntervalRef } = registerAgentRuntimeEvents({
    runtimeBus: bus,
    contractRunner: { get: () => null, list: () => [] },
    domainDispatch: new Proxy({}, { get: () => () => {} }) as never,
    getSystemMessageRouter: () => router,
    requestRender: () => {},
    configManager: { get: () => undefined } as never,
    agentManager: { getStatus: (id: string) => records[id], list: () => [] } as never,
    toolRegistry: { execute } as never,
  });
  const stop = () => { stopToasts(); stopEvents(); for (const unsub of unsubs) unsub(); if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value); };
  return { bus, feed, conversation, events, toasts, stop };
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


for (const outcome of ['completed', 'failed', 'budget'] as const) {
  test(`${outcome} occurrence survives the Agent router and JSONL replay without duplicate history or toast`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-occurrence-'));
    const live = wired();
    const restored = wired();
    const emit = (bus: RuntimeEventBus) => outcome === 'completed'
      ? emitAgentCompleted(bus, ctx, { agentId: 'agent-aaaa1111', durationMs: 12000, output: 'Same output', usage: { inputTokens: 10, outputTokens: 2 } })
      : emitAgentFailed(bus, ctx, { agentId: outcome === 'budget' ? 'agent-cccc3333' : 'agent-bbbb2222', durationMs: 9000, error: 'Same failure' });
    try {
      emit(live.bus);
      await flush();
      expect(live.feed.list()).toHaveLength(1);
      expect(live.toasts.visible()).toHaveLength(1);
      const envelope = JSON.parse(JSON.stringify(live.events[0])) as RuntimeEventEnvelope<AgentEvent['type'], AgentEvent>;
      live.bus.emit('agents', envelope);
      await flush();
      expect(live.feed.list()).toHaveLength(1);
      expect(live.toasts.visible()).toHaveLength(1);
      const sessions = new SessionManager('/unused', { sessionsDir: root });
      sessions.save('notice', live.conversation.getMessageSnapshot(), { title: 'Notices', model: 'test', provider: 'test', timestamp: 1 });
      const data = { messages: sessions.load('notice').messages as ConversationMessageSnapshot[] };
      restored.conversation.fromJSON(data);
      restored.conversation.fromJSON(data);
      expect(restored.feed.list()).toHaveLength(1);
      expect(restored.feed.unreadCount()).toBe(0);
      restored.bus.emit('agents', envelope);
      await flush();
      expect(restored.feed.list()).toHaveLength(1);
      expect(restored.toasts.visible()).toHaveLength(0);
      emit(restored.bus);
      await flush();
      expect(restored.feed.list()).toHaveLength(2);
      expect(restored.feed.list().every((entry) => entry.collapsedCount === 1)).toBe(true);
      expect(restored.toasts.visible()).toHaveLength(1);
    } finally { live.stop(); restored.stop(); rmSync(root, { recursive: true, force: true }); }
  });
}


for (const noticeFirst of [true, false]) {
  test(`long Agent diagnostics survive folding with ${noticeFirst ? 'notice' : 'bus'} first`, async () => {
    const h = wired();
    const reason = 'x'.repeat(80) + ' DIAGNOSTIC_TAIL\nSecond diagnostic line.';
    try {
      emitAgentFailed(h.bus, ctx, { agentId: 'agent-bbbb2222', durationMs: 9000, error: reason });
      await flush();
      const message = h.conversation.getMessageSnapshot().find((item) => item.role === 'system');
      expect(message?.role).toBe('system');
      if (!message || message.role !== 'system') throw new Error('Missing emitted system notice');
      const feed = new NotificationFeed();
      const notice = () => publishNotice(feed, message.content, { runtimeEvent: message.runtimeEvent });
      if (noticeFirst) notice();
      feed.record({ id: 'bus', domain: 'agents', level: 'warning', title: 'Agent failed', body: reason, timestamp: 1000 },
        { target: 'panel_only', reasonCode: 'allowed' }, runtimeEventKey('AGENT_FAILED', message.runtimeEvent));
      notice();
      expect(feed.list()).toHaveLength(1);
      expect(feed.list()[0]?.body).toContain(reason);
    } finally { h.stop(); }
  });
}


for (const replayFailure of ['unavailable', 'malformed', 'throws'] as const) {
  test(`failed ${replayFailure} enrichment cannot erase an earlier diagnostic through live or saved replay`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-enriched-occurrence-'));
    let lookups = 0;
    const live = wired(async () => {
      if (++lookups === 1) return {
        success: true,
        output: JSON.stringify({ failure: {
          reason: { code: 'provider_authentication' },
          phase: 'running',
          partialOutputs: { turnsCompleted: 3, note: 'Check the provider connection before retrying.' },
        } }),
      };
      if (replayFailure === 'throws') throw new Error('Status lookup unavailable');
      return { success: replayFailure === 'malformed', output: replayFailure === 'malformed' ? '{' : '' };
    });
    const restored = wired();
    try {
      emitAgentFailed(live.bus, ctx, { agentId: 'agent-bbbb2222', durationMs: 9000, error: 'The provider refused the request.' });
      await flush();
      const diagnostic = live.feed.list()[0]?.body;
      expect(diagnostic).toContain('reason: provider_authentication');
      expect(diagnostic).toContain('phase: running, 3 turns completed, Check the provider connection before retrying.');
      const envelope = JSON.parse(JSON.stringify(live.events[0])) as RuntimeEventEnvelope<AgentEvent['type'], AgentEvent>;
      live.bus.emit('agents', envelope);
      await flush();
      expect(lookups).toBe(2);
      expect(live.feed.list()).toHaveLength(1);
      expect(live.feed.list()[0]?.body).toBe(diagnostic);
      expect(live.feed.list()[0]?.collapsedCount).toBe(1);
      expect(live.toasts.visible()).toHaveLength(1);

      // The saved conversation contains both the enriched first delivery and
      // the poorer retry. Restoring them in order must not regress its detail.
      const sessions = new SessionManager('/unused', { sessionsDir: root });
      sessions.save('enriched-notice', live.conversation.getMessageSnapshot(), { title: 'Enriched notice', model: 'test', provider: 'test', timestamp: 1 });
      const data = { messages: sessions.load('enriched-notice').messages as ConversationMessageSnapshot[] };
      restored.conversation.fromJSON(data);
      restored.conversation.fromJSON(data);
      restored.bus.emit('agents', envelope);
      await flush();
      expect(restored.feed.list()).toHaveLength(1);
      expect(restored.feed.list()[0]?.body).toBe(diagnostic);
      expect(restored.feed.list()[0]?.collapsedCount).toBe(1);
      expect(restored.feed.unreadCount()).toBe(0);
      expect(restored.toasts.visible()).toHaveLength(0);
    } finally { live.stop(); restored.stop(); rmSync(root, { recursive: true, force: true }); }
  });
}
