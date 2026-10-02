import { describe, expect, spyOn, test } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { Notifier } from '../sdk/src/platform/integrations/notifier.ts';
import { WebhookNotifier } from '../sdk/src/platform/integrations/webhooks.ts';
import { SlackIntegration } from '../sdk/src/platform/integrations/slack.ts';
import { DiscordIntegration } from '../sdk/src/platform/integrations/discord.ts';
import { DeliveryError, type DeliveryQueue } from '../sdk/src/platform/integrations/delivery.ts';
import { buildApprovalNotification, buildBudgetNotification, buildTurnNotification, type NotificationDelivery } from '../sdk/src/platform/runtime/operations.ts';
import { NotificationEnvelope } from '../sdk/src/platform/runtime/notification-envelope.ts';
import { withTestTimeout, waitFor } from './_helpers/test-timeout.ts';
import { logger } from '../sdk/src/platform/utils/logger.ts';
import { structuralDeliveryEvidence } from '../sdk/src/platform/integrations/delivery-diagnostics.ts';

const PRIVATE = 'synthetic-private-notification-marker';
const URL_A = 'https://example.com/notification-a';
const URL_B = 'https://example.com/notification-b';
const turn = (): NotificationDelivery => ({ kind: 'turn', facts: {
  outcome: 'failed', elapsedMs: 42_000, name: PRIVATE, reason: PRIVATE, sessionId: PRIVATE,
  subject: 'turn', toolCalls: 2, filesChanged: 1,
} });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => { resolve = ok; });
  return { promise, resolve };
}
// Keep the real global fetch interception while satisfying Bun's callable-plus-property shape.
function interceptFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, 'fetch').mockImplementation(Object.assign(implementation, { preconnect() {} }));
}

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

describe('notification fact builders', () => {
  test('direct builders reject malformed required facts without echo and read numeric getters only once', () => {
    for (const invalid of [NaN, Infinity, -1, PRIVATE, { toFixed: () => PRIVATE }]) {
      for (const build of [
        () => buildBudgetNotification({ sessionCostUsd: invalid as never, budgetUsd: 1, sessionId: PRIVATE }, { metadataOnly: true }),
        () => buildTurnNotification({ outcome: 'completed', elapsedMs: invalid as never }, { metadataOnly: true }),
        () => buildTurnNotification({ outcome: invalid as never, elapsedMs: 1 }, { metadataOnly: true }),
      ]) {
        try { build(); throw new Error('Invalid facts were accepted'); }
        catch (error) { expect(error).toBeInstanceOf(TypeError); expect(String(error)).not.toContain(PRIVATE); }
      }
    }
    let reads = 0;
    const facts = { outcome: 'completed' as const, elapsedMs: 1, get filesChanged(): number { reads++; return (reads === 1 ? 1 : PRIVATE) as number; } };
    const notice = buildTurnNotification(facts, { metadataOnly: true });
    expect(notice.body).toContain('1 file changed'); expect(reads).toBe(1);
    const throwing = { outcome: 'completed' as const, elapsedMs: 1, get toolCalls(): number { throw new Error(PRIVATE); } };
    expect(() => buildTurnNotification(throwing, { metadataOnly: true })).toThrow('Invalid notification facts');
  });

  test('restricted builders discard arbitrary identifiers and content while preserving actual counts', () => {
    const restricted = { metadataOnly: true };
    const outputs = [
      buildTurnNotification({ outcome: 'failed', elapsedMs: 42000, name: PRIVATE, reason: PRIVATE, subject: PRIVATE, sessionId: PRIVATE, toolCalls: 3 }, restricted),
      buildApprovalNotification({ tool: PRIVATE, category: PRIVATE, target: PRIVATE, turnName: PRIVATE }, restricted),
      buildBudgetNotification({ sessionCostUsd: 2.5, budgetUsd: 1, sessionId: PRIVATE, turnName: PRIVATE }, restricted),
    ];
    expect(JSON.stringify(outputs)).not.toContain(PRIVATE);
    expect(outputs[0]?.body).toContain('3 tool calls');
    expect(outputs[1]?.body).toBe('A tool is waiting for approval');
    expect(outputs[2]?.body).toContain('$2.50');
    expect(buildTurnNotification({ outcome: 'completed', elapsedMs: 0, name: PRIVATE }, { metadataOnly: false }).title).toBe(PRIVATE);
  });

  test('an owned snapshot ignores later caller mutation and serializes only restricted diagnostics', () => {
    const facts = { outcome: 'failed' as const, elapsedMs: 1000, name: PRIVATE, reason: 'original reason' };
    let restricted = false;
    const envelope = NotificationEnvelope.typed({ kind: 'turn', facts }, () => restricted);
    facts.name = 'caller changed the name'; facts.reason = 'caller changed the reason';
    expect(envelope.prepare().text).toContain(PRIVATE);
    expect(envelope.prepare().text).toContain('original reason');
    expect(JSON.stringify(envelope)).not.toContain(PRIVATE);
    restricted = true; const revision = envelope.prepare().revision;
    restricted = false;
    expect(envelope.prepare().text).not.toContain(PRIVATE);
    expect(envelope.prepare().revision).toBe(revision);
  });

  test('restricted admission never reads private content getters', () => {
    const unreadable = () => { throw new Error(PRIVATE); };
    const facts = { outcome: 'completed' as const, elapsedMs: 1000 };
    Object.defineProperties(facts, { name: { get: unreadable }, reason: { get: unreadable }, sessionId: { get: unreadable } });
    const approval = { tool: 'exec', category: 'execute' };
    Object.defineProperties(approval, { target: { get: unreadable }, turnName: { get: unreadable } });
    const budget = { sessionCostUsd: 2, budgetUsd: 1, sessionId: PRIVATE };
    Object.defineProperty(budget, 'turnName', { get: unreadable });
    for (const delivery of [{ kind: 'turn', facts }, { kind: 'approval', facts: approval }, { kind: 'budget', facts: budget }] as const) {
      const envelope = NotificationEnvelope.typed(delivery, () => true);
      expect(envelope.prepare().text).not.toContain(PRIVATE);
    }
  });
});

test('response echoes never enter webhook receipts, notifier DLQ state or notification logs', async () => {
  let restricted = false;
  const logs: unknown[][] = [];
  const warn = spyOn(logger, 'warn').mockImplementation((...args) => { logs.push(args); });
  const errorLog = spyOn(logger, 'error').mockImplementation((...args) => { logs.push(args); });
  const fetchSpy = interceptFetch(async (_input, init) => {
    expect(String(init?.body)).toContain(PRIVATE);
    restricted = true;
    return new Response(PRIVATE, { status: 400 });
  });
  const notifier = new Notifier({ slack: new SlackIntegration(URL_A), metadataOnly: () => restricted });
  try {
    const webhook = new WebhookNotifier([URL_A], { force: true, metadataOnly: () => restricted });
    const receipt = await webhook.sendNotification(turn());
    expect(receipt.results[0]).toMatchObject({ ok: false, error: 'HTTP 400', status: 400 });
    expect(JSON.stringify(receipt)).not.toContain(PRIVATE);
    restricted = false;
    await notifier.notifyNotification(turn());
    const queue = Reflect.get(notifier, '_queue') as DeliveryQueue<NotificationEnvelope>;
    expect(queue.getDlq()[0]).toMatchObject({ finalError: 'HTTP 400', status: 400, basis: 'status', failureClass: 'terminal' });
    expect(inspect(queue.getDlq(), { depth: 8 })).not.toContain(PRIVATE);
    expect(inspect(notifier.getQueueStatus(), { depth: 8 })).not.toContain(PRIVATE);
    expect(inspect(logs, { depth: 8 })).not.toContain(PRIVATE);
    expect(logs.length).toBeGreaterThan(0);
  } finally { await notifier.close(); fetchSpy.mockRestore(); warn.mockRestore(); errorLog.mockRestore(); }
});

test('unknown rejection proxies cannot escape webhook diagnostic inspection', async () => {
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error(PRIVATE); }, get() { throw new Error(PRIVATE); } });
  const fetchSpy = interceptFetch(async () => { throw hostile; });
  const logs: unknown[][] = [];
  const warn = spyOn(logger, 'warn').mockImplementation((...args) => { logs.push(args); });
  try {
    const notifier = new WebhookNotifier([URL_A], { force: true, metadataOnly: () => true });
    const result = await withTestTimeout(notifier.sendNotification(turn()), 5000, 'Proxy failure did not settle');
    expect(result).toMatchObject({ attempted: 1, delivered: 0, failed: 1 });
    expect(result.results[0]?.error).toBe('Delivery failed');
    expect(inspect([result, logs], { depth: 8 })).not.toContain(PRIVATE);
  } finally { fetchSpy.mockRestore(); warn.mockRestore(); }
});

test('approval snapshots and direct builders capture each primitive once without delayed coercion', async () => {
  let restricted = false;
  let toolReads = 0; let categoryReads = 0; let coerced = 0;
  const delayed = { toString() { coerced++; restricted = true; return PRIVATE; } };
  const facts = {
    get tool(): string { return (++toolReads === 1 ? 'exec' : delayed) as string; },
    get category(): string { return (++categoryReads === 1 ? 'execute' : delayed) as string; },
    target: 'synthetic command',
  };
  const sent: string[] = [];
  const fetchSpy = interceptFetch(async (_input, init) => { sent.push(String(init?.body)); return new Response('ok'); });
  const notifier = new Notifier({ slack: new SlackIntegration(URL_A), metadataOnly: () => restricted });
  try {
    await notifier.notifyNotification({ kind: 'approval', facts });
    expect(sent).toHaveLength(1); expect(sent[0]).not.toContain(PRIVATE);
    expect(toolReads).toBe(1); expect(categoryReads).toBe(1); expect(coerced).toBe(0);
    toolReads = 0; categoryReads = 0;
    const direct = buildApprovalNotification(facts, { metadataOnly: false });
    expect(direct.body).toBe('exec is waiting for approval: synthetic command');
    expect(toolReads).toBe(1); expect(categoryReads).toBe(1); expect(coerced).toBe(0);
    expect(() => buildApprovalNotification({ tool: 'exec', category: 'execute', target: delayed as never }, { metadataOnly: false })).toThrow('Invalid notification facts');
    expect(coerced).toBe(0);
  } finally { await notifier.close(); fetchSpy.mockRestore(); }
});

test('an unavailable retry reading receives the original failure but exposes no original error or cause', async () => {
  const original = new Error(PRIVATE);
  const states: unknown[] = [];
  forgetFailureReadings();
  const previous = installJudgmentPort({ model: 'jev-1.13.0', async ask(request) {
    if (request.context?.battery !== 'engine.failure-reading') throw new Error('Unexpected fixture battery');
    states.push(request.state); throw new Error(PRIVATE);
  } });
  const fetchSpy = interceptFetch(async () => { throw original; });
  const notifier = new Notifier({ slack: new SlackIntegration(URL_A), metadataOnly: () => true });
  try {
    const failure = await notifier.notifyNotification(turn()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(states).toHaveLength(1);
    expect(String(states[0])).toContain(PRIVATE);
    expect(inspect(failure, { depth: 8 })).not.toContain(PRIVATE);
    expect((failure as AggregateError).errors).not.toContain(original);
    expect((failure as Error).cause).toBeUndefined();
    expect(notifier.getQueueStatus()[0]?.metrics).toMatchObject({ retrying: 0, deadLettered: 0 });
    expect(structuralDeliveryEvidence({ failureClass: 'terminal', basis: 'reading', detail: PRIVATE })).toEqual({ failureClass: 'terminal', basis: 'reading' });
    expect(structuralDeliveryEvidence({ failureClass: 'terminal', basis: PRIVATE as never, detail: PRIVATE })).toBeUndefined();
  } finally { await notifier.close(); fetchSpy.mockRestore(); installJudgmentPort(previous); forgetFailureReadings(); }
});

test('real Slack/Discord outbound bodies share irreversible restriction across fanout and retry', async () => {
  let restricted = false;
  const sent: Array<{ url: string; body: string }> = [];
  const timers = captureRetries();
  const fetchSpy = interceptFetch(async (input, init) => {
    const url = String(input); const body = String(init?.body); sent.push({ url, body });
    if (sent.length === 1) { restricted = true; return new Response('retry fixture', { status: 503 }); }
    if (url === URL_B) restricted = false;
    return new Response('ok');
  });
  const notifier = new Notifier({ slack: new SlackIntegration(URL_A), discord: new DiscordIntegration(URL_B),
    metadataOnly: () => restricted, delivery: { initialDelayMs: retryDelay, maxDelayMs: retryDelay } });
  try {
    await notifier.notifyNotification(turn());
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body).toContain(PRIVATE);
    expect(sent[1]?.body).not.toContain(PRIVATE);
    expect(timers.callbacks).toHaveLength(1);
    timers.callbacks[0]!();
    await waitFor(() => sent.length === 3);
    expect(sent[2]?.body).not.toContain(PRIVATE);
    expect(JSON.parse(sent[1]!.body).content).toContain('Failed after 42s');
    expect(JSON.parse(sent[2]!.body).text).toContain('2 tool calls');
  } finally { await notifier.close(); fetchSpy.mockRestore(); timers.restore(); }
});

test('DLQ replay reads live privacy and cannot restore rich facts after a restrictive replay', async () => {
  let restricted = false;
  const bodies: string[] = [];
  const fetchSpy = interceptFetch(async (_input, init) => {
    bodies.push(String(init?.body)); return new Response('terminal fixture', { status: 400 });
  });
  const notifier = new Notifier({ slack: new SlackIntegration(URL_A), metadataOnly: () => restricted });
  try {
    await notifier.notifyNotification(turn());
    expect(bodies[0]).toContain(PRIVATE);
    expect(JSON.stringify(notifier.getQueueStatus())).not.toContain(PRIVATE);
    const queue = Reflect.get(notifier, '_queue') as DeliveryQueue<NotificationEnvelope>;
    const serialized = JSON.stringify(queue.getDlq());
    expect(serialized).not.toContain(PRIVATE);
    expect(typeof JSON.parse(serialized)[0].payload).toBe('string');
    restricted = true;
    expect((await notifier.replayDeadLetters())[0]?.outcome).toBe('dead_letter');
    restricted = false;
    await notifier.replayDeadLetters();
    expect(bodies).toHaveLength(3);
    expect(bodies.slice(1).join('\n')).not.toContain(PRIVATE);
    expect(JSON.stringify(notifier.getQueueStatus())).not.toContain(PRIVATE);
  } finally { await notifier.close(); fetchSpy.mockRestore(); }
});

test('legacy string dead letters keep their queue shape but replay only a safe fallback', async () => {
  const bodies: string[] = [];
  const fetchSpy = interceptFetch(async (_input, init) => {
    bodies.push(String(init?.body)); return new Response('ok');
  });
  const notifier = new Notifier({ slack: new SlackIntegration(URL_A), metadataOnly: () => false });
  // Seed the actual queue through its unchanged string-payload API. This is
  // the legacy persisted/replayed format, with no admission provenance.
  const queue = Reflect.get(notifier, '_queue') as DeliveryQueue<string>;
  try {
    await queue.enqueue('slack', 'legacy', PRIVATE, async () => { throw new DeliveryError('fixture', 'terminal'); });
    expect(queue.getDlq()[0]?.payload).toBe(PRIVATE);
    expect(JSON.stringify(notifier.getQueueStatus())).not.toContain(PRIVATE);
    expect((await notifier.replayDeadLetters())[0]?.outcome).toBe('delivered');
    expect(JSON.parse(bodies[0]!).text).toBe('GoodVibes: notification available');
  } finally { await notifier.close(); fetchSpy.mockRestore(); }
});

test('both real fromConfig factories retain the live callback instead of capturing its first value', async () => {
  let restricted = true;
  const bodies: string[] = [];
  const fetchSpy = interceptFetch(async (_input, init) => {
    bodies.push(String(init?.body)); return new Response('ok');
  });
  const notifier = await Notifier.fromConfig({ resolveSecret: async (service, key) => service === 'slack' && key === 'webhookUrl' ? URL_A : '' }, { metadataOnly: () => restricted });
  const webhook = WebhookNotifier.fromConfig([URL_A], { force: true, metadataOnly: () => restricted });
  try {
    await notifier.notifyNotification(turn()); await webhook.sendNotification(turn());
    expect(bodies.join('\n')).not.toContain(PRIVATE);
    restricted = false;
    await notifier.notifyNotification(turn()); await webhook.sendNotification(turn());
    expect(bodies[2]).toContain(PRIVATE); expect(bodies[3]).toContain(PRIVATE);
  } finally { await notifier.close(); fetchSpy.mockRestore(); }
});

test('a restrictive admission survives later permission and missing/malformed/async callbacks remain restrictive', async () => {
  const bodies: string[] = [];
  const fetchSpy = interceptFetch(async (_input, init) => { bodies.push(String(init?.body)); return new Response('ok'); });
  try {
    for (const read of [undefined, () => undefined, () => 'false', () => { throw new Error(PRIVATE); }, async () => false, async () => { throw new Error(PRIVATE); }]) {
      const notifier = new WebhookNotifier([URL_A], { force: true, metadataOnly: read });
      expect((await notifier.sendNotification(turn())).delivered).toBe(1);
      expect((await notifier.send(PRIVATE)).delivered).toBe(1);
    }
    expect(bodies.join('\n')).not.toContain(PRIVATE);
    let restricted = true;
    const envelope = NotificationEnvelope.typed(turn(), () => restricted);
    restricted = false;
    expect(envelope.prepare().text).not.toContain(PRIVATE);
    expect(NotificationEnvelope.restoredLegacy().prepare().text).toBe('GoodVibes: notification available');
    await new Promise((resolve) => setImmediate(resolve));
  } finally { fetchSpy.mockRestore(); }
});

test('cross-recipient restriction invalidates an in-flight rich signature even after the preference loosens', async () => {
  let restricted = false;
  const secret = randomBytes(32);
  const held = deferred();
  const firstSigning = deferred();
  const sent: Array<{ body: string; headers: Headers }> = [];
  const realSign = globalThis.crypto.subtle.sign.bind(globalThis.crypto.subtle);
  let signed = 0;
  const signSpy = spyOn(globalThis.crypto.subtle, 'sign').mockImplementation(async (...args) => {
    signed += 1;
    if (signed === 1) { firstSigning.resolve(); await held.promise; }
    if (signed === 2) restricted = true;
    return realSign(...args);
  });
  const fetchSpy = interceptFetch(async (_input, init) => {
    sent.push({ body: String(init?.body), headers: new Headers(init?.headers) });
    restricted = false;
    return new Response('ok');
  });
  const notifier = new WebhookNotifier([URL_A, URL_B], { force: true, metadataOnly: () => restricted, signingSecret: secret, maxConcurrent: 2 });
  const sending = notifier.sendNotification(turn());
  try {
    await withTestTimeout(firstSigning.promise, 5000, 'Signing did not start');
    await waitFor(() => sent.length === 1);
    held.resolve();
    expect((await withTestTimeout(sending, 5000, 'Signed fanout did not settle')).delivered).toBe(2);
    expect(signed).toBe(4);
    for (const item of sent) {
      expect(item.body).not.toContain(PRIVATE);
      const timestamp = item.headers.get('X-GoodVibes-Webhook-Timestamp');
      const expected = createHmac('sha256', secret).update(`${timestamp}.${item.body}`).digest('hex');
      expect(item.headers.get('X-GoodVibes-Webhook-Signature')).toBe(`v1=${expected}`);
    }
  } finally { held.resolve(); await sending; signSpy.mockRestore(); fetchSpy.mockRestore(); }
});
