/**
 * The Slack and Discord notifier the agent attaches to its runtime bus names the
 * agent's or workstream's task, and follows behavior.notificationsMetadataOnly
 * (default off), read at send time so a settings change applies without a
 * restart (owner rulings 2026-09-29).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { SlackIntegration } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { createEventEnvelope, RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeNotifier } from '../../runtime/bootstrap-notifier.ts';

const ctx = { sessionId: 's1', traceId: 't', source: 'test' };

describe('the agent Slack/Discord notifier', () => {
  let spy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => { spy?.mockRestore(); spy = null; });

  test('contains legacy event content under both metadata-only settings', async () => {
    const sent: string[] = [];
    spy = spyOn(SlackIntegration.prototype, 'postWebhook').mockImplementation(async (text: string) => { sent.push(text); });
    const settings: Record<string, unknown> = {};
    const registry = { resolveSecret: async (service: string, key: string) => (service === 'slack' && key === 'webhookUrl' ? 'https://hooks.slack.example/x' : null) };
    const notifier = await createRuntimeNotifier(registry as never, (key) => settings[key]);
    const bus = new RuntimeEventBus();
    notifier.attachToRuntimeBus(bus);
    try {
      bus.emit('contracts', createEventEnvelope('CONTRACT_FAILED', { type: 'CONTRACT_FAILED', contractId: 'c1', reason: 'review score 4/10', failureKind: 'other', membersSettled: true }, ctx));
      await new Promise((resolve) => setTimeout(resolve, 10));
      settings['behavior.notificationsMetadataOnly'] = true;
      bus.emit('contracts', createEventEnvelope('CONTRACT_FAILED', { type: 'CONTRACT_FAILED', contractId: 'c2', reason: 'private reason', failureKind: 'other', membersSettled: true }, ctx));
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      notifier.detach();
      await notifier.close();
    }
    expect(sent).toEqual([
      'GoodVibes: notification available',
      'GoodVibes: notification available',
    ]);
  });
});
