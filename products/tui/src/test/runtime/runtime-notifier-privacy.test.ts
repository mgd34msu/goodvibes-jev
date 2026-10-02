import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Notifier, WebhookNotifier, SlackIntegration, DiscordIntegration } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { RuntimeEventBus, createEventEnvelope } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { FocusTracker } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { attachTypedRuntimeNotifications, createRuntimeNotifier } from '../../runtime/bootstrap-notifier-sync.ts';
import { maybeNotifyLongTask } from '../../core/long-task-notifier.ts';
import { wrapRequestPermissionWithAlert } from '../../core/approval-alert.ts';
import { createBudgetBreachNotifier } from '../../core/budget-breach-notifier.ts';
import { waitFor } from '../../../../../packages/engine/test/_helpers/test-timeout.ts';

const PRIVATE = 'synthetic-private-tui-notification';
const URL_A = 'https://example.com/tui-a';
const URL_B = 'https://example.com/tui-b';
const ctx = { sessionId: 'fixture-session', source: 'tui-notification-test' };
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = undefined; });
function transport(send: (url: string, body: string) => Promise<Response>) {
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url !== URL_A && url !== URL_B) throw new Error('Unexpected synthetic destination');
    return send(url, String(init?.body));
  }, { preconnect() {} }));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => { resolve = ok; });
  return { promise, resolve };
}

const producers = ['turn', 'approval', 'budget'] as const;
async function produce(kind: typeof producers[number], webhookNotifier: WebhookNotifier, configGet: (key: string) => unknown, privateRead: () => string) {
  const focusTracker = new FocusTracker();
  const notifyDesktop = () => {};
  if (kind === 'turn') {
    maybeNotifyLongTask({ elapsedMs: 62_000, status: 'fail', outcome: 'cancelled', kind: 'turn', sessionId: PRIVATE,
      thresholdSeconds: 1, configGet, webhookNotifier, notifyDesktop,
      get name() { return privateRead(); }, get reason() { return privateRead(); }, activity: { toolCalls: 2 } });
  } else if (kind === 'approval') {
    const request: PermissionPromptRequest = {
      callId: 'fixture-call', tool: 'exec', category: 'execute',
      get args() { return { command: privateRead() }; },
      analysis: {} as PermissionPromptRequest['analysis'],
    };
    await wrapRequestPermissionWithAlert(async () => ({ approved: true, remember: false }), {
      focusTracker, configGet, webhookNotifier, notifyDesktop,
      conversation: { get title() { return privateRead(); }, getTitleSource: () => 'user', getLastUserMessage: privateRead },
    })(request);
  } else {
    createBudgetBreachNotifier({ focusTracker, configGet, webhookNotifier, notifyDesktop, sessionId: PRIVATE, getTurnName: privateRead })
      .check({ input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-sonnet-4-6', 1);
  }
}

describe('TUI typed producers use actual SDK delivery ownership', () => {
  for (const kind of producers) {
    for (const privacy of [undefined, true, false]) {
      test(`${kind}: privacy=${privacy} admits only permitted getters`, async () => {
        const sent: string[] = [];
        transport(async (_, body) => { sent.push(body); return new Response('ok'); });
        let reads = 0;
        const notifier = new WebhookNotifier([URL_A], { force: true, metadataOnly: () => privacy });
        await produce(kind, notifier, (key) => key === 'behavior.notificationsMetadataOnly' ? privacy : undefined, () => { reads++; if (privacy !== false) throw new Error(PRIVATE); return PRIVATE; });
        await waitFor(() => sent.length === 1);
        expect(sent[0]).toContain(kind === 'turn' ? 'Cancelled after 1m 2s' : kind === 'approval' ? 'waiting for approval' : '$30.00');
        if (privacy === false) { expect(reads).toBeGreaterThan(0); expect(sent[0]).toContain(PRIVATE); }
        else { expect(reads).toBe(0); expect(sent[0]).not.toContain(PRIVATE); }
      });
    }
    test(`${kind}: false to true while the first recipient is pending restricts the next recipient`, async () => {
      let privacy = false;
      const sent: string[] = [];
      const first = deferred();
      transport(async (_, body) => { sent.push(body); if (sent.length === 1) await first.promise; return new Response('ok'); });
      const notifier = new WebhookNotifier([URL_A, URL_B], { force: true, maxConcurrent: 1, metadataOnly: () => privacy });
      try {
        await produce(kind, notifier, (key) => key === 'behavior.notificationsMetadataOnly' ? privacy : undefined, () => PRIVATE);
        await waitFor(() => sent.length === 1);
        expect(sent[0]).toContain(PRIVATE);
        privacy = true;
        first.resolve();
        await waitFor(() => sent.length === 2);
        expect(sent[1]).not.toContain(PRIVATE);
        expect(sent[1]).toContain(kind === 'turn' ? 'Cancelled after 1m 2s' : kind === 'approval' ? 'waiting for approval' : '$30.00');
      } finally { first.resolve(); }
    });
  }
});

describe('TUI contract and agent subscriptions use typed Notifier facts', () => {
  test('factory reads privacy live and actual public contract cancellation remains cancellation', async () => {
    let privacy: unknown = false;
    const sent: string[] = [];
    transport(async (_, body) => { sent.push((JSON.parse(body) as { text: string }).text); return new Response('ok'); });
    const notifier = await createRuntimeNotifier({ resolveSecret: async (service, key) => service === 'slack' && key === 'webhookUrl' ? URL_A : null }, () => privacy);
    const bus = new RuntimeEventBus();
    let now = 10;
    const unsubscribe = attachTypedRuntimeNotifications(notifier, bus, () => now);
    try {
      bus.emit('contracts', createEventEnvelope('CONTRACT_CREATED', { type: 'CONTRACT_CREATED', contractId: 'contract-1', sessionId: 'fixture-session', origin: 'turn', ask: PRIVATE, ownerAgentId: 'owner' }, ctx));
      await Promise.resolve(); // RuntimeEventBus dispatches each subscriber in a microtask.
      now += 2000;
      bus.emit('contracts', createEventEnvelope('CONTRACT_CANCELLED', { type: 'CONTRACT_CANCELLED', contractId: 'contract-1', reason: 'failed checks; owner cancelled', filesModified: 2 }, ctx));
      await waitFor(() => sent.length === 1);
      expect(sent[0]).toBe(`${PRIVATE}\nCancelled after 2s, 2 files changed: failed checks; owner cancelled`);
      privacy = true;
      let reads = 0;
      bus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED', agentId: 'agent-1', durationMs: 42_000, toolCallsMade: 3, get output() { reads++; throw new Error(PRIVATE); } }, ctx));
      await waitFor(() => sent.length === 2);
      expect(reads).toBe(0);
      expect(sent[1]).toBe('GoodVibes: agent done\nDone in 42s, 3 tool calls');
      unsubscribe();
      bus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED', agentId: 'agent-2', durationMs: 0 }, ctx));
      await notifier.close();
      expect(sent).toHaveLength(2);
    } finally { unsubscribe(); await notifier.close(); }
  });
  test('a blocked Slack recipient cannot leak rich facts into the later Discord recipient or queue diagnostics', async () => {
    let privacy = false;
    const first = deferred();
    const sent: string[] = [];
    transport(async (url, body) => {
      const data = JSON.parse(body) as { text?: string; content?: string };
      sent.push(data.text ?? data.content ?? '');
      if (url === URL_A) await first.promise;
      return new Response('ok');
    });
    const notifier = new Notifier({ slack: new SlackIntegration(URL_A), discord: new DiscordIntegration(URL_B), metadataOnly: () => privacy });
    const bus = new RuntimeEventBus();
    const unsubscribe = attachTypedRuntimeNotifications(notifier, bus);
    try {
      bus.emit('agents', createEventEnvelope('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'agent-1', durationMs: 12_000, error: PRIVATE }, ctx));
      await waitFor(() => sent.length === 1);
      expect(sent[0]).toContain(PRIVATE);
      privacy = true;
      expect(JSON.stringify(notifier.getQueueStatus())).not.toContain(PRIVATE);
      first.resolve();
      await waitFor(() => sent.length === 2);
      expect(sent[1]).toBe('GoodVibes: agent failed\nFailed after 12s');
    } finally { first.resolve(); unsubscribe(); await notifier.close(); }
  });
});

test('a typed runtime delivery queued in the dead-letter store restricts replay after a privacy change', async () => {
  let privacy = false;
  let failing = true;
  const sent: string[] = [];
  transport(async (_, body) => {
    sent.push((JSON.parse(body) as { text: string }).text);
    return new Response(failing ? PRIVATE : 'ok', { status: failing ? 400 : 200 });
  });
  const notifier = new Notifier({ slack: new SlackIntegration(URL_A), metadataOnly: () => privacy, delivery: { maxRetries: 0 } });
  const bus = new RuntimeEventBus();
  const unsubscribe = attachTypedRuntimeNotifications(notifier, bus);
  try {
    bus.emit('agents', createEventEnvelope('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'agent-1', durationMs: 12_000, error: PRIVATE }, ctx));
    await waitFor(() => notifier.getQueueStatus()[0]?.metrics.deadLettered === 1);
    expect(sent[0]).toContain(PRIVATE);
    expect(JSON.stringify(notifier.getQueueStatus())).not.toContain(PRIVATE);
    privacy = true;
    failing = false;
    const replayed = await notifier.replayDeadLetters();
    expect(replayed).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe('GoodVibes: agent failed\nFailed after 12s');
  } finally { unsubscribe(); await notifier.close(); }
});

test('a cached explicit false cannot override the current restrictive privacy reader', () => {
  let reads = 0;
  const sent: string[] = [];
  transport(async (_, body) => { sent.push(body); return new Response('ok'); });
  maybeNotifyLongTask({ elapsedMs: 60_000, status: 'fail', kind: 'turn', sessionId: PRIVATE, thresholdSeconds: 1,
    metadataOnly: false, configGet: (key) => key === 'behavior.notificationsMetadataOnly' ? true : undefined,
    webhookNotifier: new WebhookNotifier([URL_A], { force: true, metadataOnly: () => true }),
    notifyDesktop: (title, body) => { expect(`${title} ${body}`).not.toContain(PRIVATE); },
    get name() { reads++; throw new Error(PRIVATE); }, get reason() { reads++; throw new Error(PRIVATE); },
  });
  expect(reads).toBe(0);
  expect(sent).toEqual(['GoodVibes: turn failed\nFailed after 1m']);
});

test('terminal events without a public duration or an observed start do not invent zero elapsed time', async () => {
  const sent: string[] = [];
  transport(async (_, body) => { sent.push(body); return new Response('ok'); });
  const notifier = new Notifier({ slack: new SlackIntegration(URL_A), metadataOnly: () => false });
  const bus = new RuntimeEventBus();
  const unsubscribe = attachTypedRuntimeNotifications(notifier, bus);
  try {
    bus.emit('contracts', createEventEnvelope('CONTRACT_FAILED', { type: 'CONTRACT_FAILED', contractId: 'unseen', reason: 'Synthetic failure', failureKind: 'other', membersSettled: true }, ctx));
    bus.emit('agents', createEventEnvelope('AGENT_CANCELLED', { type: 'AGENT_CANCELLED', agentId: 'unseen', reason: 'Synthetic cancellation' }, ctx));
    await Promise.resolve();
    await notifier.close();
    expect(sent).toEqual([]);
  } finally { unsubscribe(); await notifier.close(); }
});
