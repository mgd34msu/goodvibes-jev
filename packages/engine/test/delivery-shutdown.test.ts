import { describe, expect, spyOn, test } from 'bun:test';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DeliveryError, DeliveryQueue } from '../sdk/src/platform/integrations/delivery.ts';
import { Notifier } from '../sdk/src/platform/integrations/notifier.ts';
import { SlackIntegration } from '../sdk/src/platform/integrations/slack.ts';
import { DiscordIntegration } from '../sdk/src/platform/integrations/discord.ts';
import { RuntimeEventBus, createEventEnvelope } from '../sdk/src/platform/runtime/events/index.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const retryDelay = 123456;
function captureRetries() {
  const native = globalThis.setTimeout;
  const callbacks: Array<() => void> = [];
  const handles: Array<ReturnType<typeof setTimeout>> = [];
  globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay !== retryDelay) return native(callback, delay, ...args);
    callbacks.push(callback);
    const handle = native(() => {}, delay); handle.unref?.(); handles.push(handle); return handle;
  }) as typeof setTimeout;
  return { callbacks, restore() { globalThis.setTimeout = native; for (const handle of handles) clearTimeout(handle); } };
}
function queue() { return new DeliveryQueue({ initialDelayMs: retryDelay, maxDelayMs: retryDelay }); }
const transient = () => new DeliveryError('synthetic transient failure', 'retryable');

describe('DeliveryQueue shutdown', () => {
  test('a late transport failure cannot schedule or send after dispose', async () => {
    const q = queue(); const held = deferred(); const timers = captureRetries(); let calls = 0;
    const attempt = q.enqueue('fixture', 'held', 'synthetic', () => { calls++; return held.promise; });
    const rejected = attempt.catch((error: unknown) => error);
    try {
      q.dispose(); held.reject(transient()); expect(await rejected).toBeInstanceOf(DeliveryError);
      for (const callback of timers.callbacks) callback();
      await q.close();
      expect(calls).toBe(1); expect(timers.callbacks).toHaveLength(0);
      expect(q.getMetrics()).toMatchObject({ retrying: 0, deadLettered: 0 });
    } finally { held.resolve(); q.dispose(); timers.restore(); }
  });

  test('close drains the admitted transport and preserves a completed delivery outcome', async () => {
    const q = queue(); const held = deferred(); let closed = false;
    const attempt = q.enqueue('fixture', 'held', 'synthetic', () => held.promise);
    const closing = q.close(); void closing.then(() => { closed = true; });
    try {
      expect(q.close()).toBe(closing); await nextTurn(); expect(closed).toBe(false);
      await expect(q.enqueue('fixture', 'late', 'synthetic', async () => {})).rejects.toThrow('closed');
      held.resolve(); expect(await attempt).toBe('delivered'); await closing;
      expect(closed).toBe(true); expect(q.getMetrics().delivered).toBe(1);
    } finally { held.resolve(); await closing; }
  });

  test('a transport that requests close synchronously is already owned', async () => {
    const q = queue(); const held = deferred(); let closing: Promise<void> | undefined; let closed = false;
    const attempt = q.enqueue('fixture', 'reentrant', 'synthetic', () => {
      closing = q.close(); void closing.then(() => { closed = true; }); return held.promise;
    });
    try {
      expect(closing).toBeDefined(); await nextTurn(); expect(closed).toBe(false);
      held.resolve(); await attempt; await closing; expect(closed).toBe(true);
    } finally { held.resolve(); await q.close(); }
  });

  test('closed timers cannot reenter transport and retry metrics are cleared', async () => {
    const q = queue(); const timers = captureRetries(); let calls = 0;
    try {
      expect(await q.enqueue('fixture', 'retry', 'synthetic', async () => { calls++; throw transient(); })).toBe('retrying');
      expect(timers.callbacks).toHaveLength(1); expect(q.getMetrics().retrying).toBe(1);
      await q.close(); timers.callbacks[0]!(); await nextTurn();
      expect(calls).toBe(1); expect(q.getMetrics().retrying).toBe(0);
    } finally { q.dispose(); timers.restore(); }
  });

  test('closed replay refuses without discarding retained dead letters', async () => {
    const q = queue(); let replayed = 0;
    await q.enqueue('fixture', 'terminal', 'synthetic', async () => { throw new DeliveryError('synthetic terminal failure', 'terminal'); });
    const retained = q.getDlq(); await q.close();
    await expect(q.replay(async () => { replayed++; })).rejects.toThrow('closed');
    expect(q.getDlq()).toEqual(retained); expect(replayed).toBe(0);
  });

  test('close also drains a held failure reading without scheduling a retry', async () => {
    const q = queue(); const entered = deferred(); const held = deferred(); const timers = captureRetries();
    const fixture = fakePort((name, question) => name === 'category' ? choiceAnswer(question, 'network') : noulAnswer(0.05));
    const previous = installJudgmentPort({ ...fixture.port, async ask(request) { entered.resolve(); await held.promise; return fixture.port.ask(request); } });
    forgetFailureReadings(); let closed = false;
    const attempt = q.enqueue('fixture', 'reading', 'synthetic', async () => { throw new Error('synthetic unclassified fixture failure'); });
    const rejected = attempt.catch((error: unknown) => error);
    try {
      await entered.promise; const closing = q.close(); void closing.then(() => { closed = true; });
      await nextTurn(); expect(closed).toBe(false);
      held.resolve(); expect(await rejected).toBeInstanceOf(DeliveryError); await closing;
      expect(closed).toBe(true); expect(timers.callbacks).toHaveLength(0);
    } finally { held.resolve(); await q.close(); installJudgmentPort(previous); forgetFailureReadings(); timers.restore(); }
  });
});

function completed(bus: RuntimeEventBus) {
  bus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED', agentId: 'fixture', durationMs: 0 }, { sessionId: 'fixture', traceId: 'fixture', source: 'fixture' }));
}

describe('Notifier ownership', () => {
  test('close drains a held notification, prevents its next channel, and removes subscriptions', async () => {
    const slack = new SlackIntegration(); const discord = new DiscordIntegration(); const held = deferred();
    const slackSend = spyOn(slack, 'postWebhook').mockImplementation(() => held.promise);
    const discordSend = spyOn(discord, 'postWebhook').mockResolvedValue(undefined);
    const notifier = new Notifier({ slack, discord }); const bus = new RuntimeEventBus();
    notifier.attachToRuntimeBus(bus); let closed = false;
    const sending = notifier.notify('fixture', {}); const rejected = sending.catch((error: unknown) => error);
    const closing = notifier.close(); void closing.then(() => { closed = true; });
    try {
      expect(notifier.close()).toBe(closing); await nextTurn(); expect(closed).toBe(false);
      completed(bus); await nextTurn(); expect(slackSend).toHaveBeenCalledTimes(1);
      held.resolve(); expect(await rejected).toBeInstanceOf(DeliveryError); await closing;
      expect(closed).toBe(true); expect(discordSend).not.toHaveBeenCalled();
      await expect(notifier.notify('late', {})).rejects.toThrow('closed');
      expect(() => notifier.attachToRuntimeBus(bus)).toThrow('closed');
    } finally { held.resolve(); await closing; slackSend.mockRestore(); discordSend.mockRestore(); }
  });

  test('legacy dispose detaches subscriptions, including a queued bus callback', async () => {
    const slack = new SlackIntegration(); const send = spyOn(slack, 'postWebhook').mockResolvedValue(undefined);
    const notifier = new Notifier({ slack }); const bus = new RuntimeEventBus();
    try {
      notifier.attachToRuntimeBus(bus); completed(bus); notifier.dispose(); completed(bus);
      await nextTurn(); await notifier.close(); expect(send).not.toHaveBeenCalled();
    } finally { notifier.dispose(); send.mockRestore(); }
  });
});

test('closing one notifier preserves another subscriber and waits for its own public notification', async () => {
  const firstSlack = new SlackIntegration(); const secondSlack = new SlackIntegration(); const held = deferred();
  const firstSend = spyOn(firstSlack, 'postWebhook').mockImplementation(() => held.promise);
  const secondSend = spyOn(secondSlack, 'postWebhook').mockResolvedValue(undefined);
  const first = new Notifier({ slack: firstSlack }); const second = new Notifier({ slack: secondSlack });
  const bus = new RuntimeEventBus(); const order: string[] = [];
  first.attachToRuntimeBus(bus); second.attachToRuntimeBus(bus);
  const sending = first.notify('fixture', {}).then(() => { order.push('notification settled'); });
  const closing = first.close().then(() => { order.push('owner closed'); });
  try {
    completed(bus); await nextTurn();
    expect(firstSend).toHaveBeenCalledTimes(1); expect(secondSend).toHaveBeenCalledTimes(1);
    held.resolve(); await Promise.all([sending, closing]);
    expect(order).toEqual(['notification settled', 'owner closed']);
  } finally {
    held.resolve(); await Promise.all([first.close(), second.close()]); firstSend.mockRestore(); secondSend.mockRestore();
  }
});
