/**
 * client-seam-conversation-rewind-host.test.ts, the surface holding a
 * conversation is the one that answers for it.
 *
 * ── The failure being closed ──────────────────────────────────────────────
 *
 * Files rewind works from anywhere; the messages do not. Once the surfaces
 * became pure clients, a rewind driven from the web app asked the daemon, the
 * daemon looked in a conversation registry nothing outside it could populate,
 * and answered "0 messages to drop". Not an error, a confident number, and
 * indistinguishable from a real zero.
 *
 * So the assertions that matter are about which answer comes back for which
 * situation: a real count when the surface IS holding the conversation, and
 * `unavailable` with a reason when it is not. Never a zero standing in for
 * "I could not reach it".
 *
 * ── Driven against the real broker ────────────────────────────────────────
 *
 * The daemon side here is the `ConversationRewindHostBroker` behind its own
 * route handlers, so the lease, the take/answer pairing and the refusals are the
 * real ones. Only the transport is local.
 *
 * Ported from the terminal app's suite when this module was hoisted, the same
 * pins now cover every surface that offers a conversation.
 */
import { describe, expect, test } from 'bun:test';
import {
  GatewayMethodCatalog,
  createConversationRewindHostBroker,
  registerRewindConversationHostGatewayMethods,
} from '../sdk/src/platform/control-plane/index.ts';
import { createConversationRewindHost } from '../sdk/src/platform/runtime/client/conversation-rewind-host.ts';
import type { ConversationRewindHostOptions } from '../sdk/src/platform/runtime/client/conversation-rewind-host.ts';
import type { DaemonVerbCaller } from '../sdk/src/platform/runtime/client/daemon-verbs.ts';
import type { RewindConversationPort } from '../sdk/src/platform/rewind/types.ts';

const SESSION = 'session-under-test';

/** A port standing in for a process's conversation, with a known message count. */
function port(counts: { toDrop: number; remaining: number }, options: { throws?: boolean } = {}): RewindConversationPort {
  return {
    preview: async () => {
      if (options.throws) throw new Error('the conversation is mid-compaction');
      return { messagesToDrop: counts.toDrop, messagesRemaining: counts.remaining };
    },
    rewind: async () => ({ droppedMessages: counts.toDrop, undoSnapshotId: 'rwc_test_snapshot' }),
  };
}

function harness(options: {
  hosts?: boolean;
  port?: RewindConversationPort;
  client?: Pick<ConversationRewindHostOptions, 'waitMs' | 'retryBackoffMs' | 'sleep' | 'log'>;
  transport?: (native: DaemonVerbCaller) => DaemonVerbCaller;
} = {}) {
  const broker = createConversationRewindHostBroker();
  const catalog = new GatewayMethodCatalog();
  registerRewindConversationHostGatewayMethods(catalog, broker);
  const verbs: DaemonVerbCaller = {
    probe: () => ({ available: true }),
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> =>
      await catalog.invoke(methodId as never, { context: { admin: true }, body: input ?? {} } as never) as T,
  };
  const host = createConversationRewindHost({
    verbs: options.transport?.(verbs) ?? verbs,
    port: options.port ?? port({ toDrop: 4, remaining: 11 }),
    hosts: () => options.hosts ?? true,
    label: 'a connected surface (test)',
    // Driven by pump() rather than the loop, so nothing here waits on a clock.
    waitMs: 0,
    ...options.client,
  });
  return { broker, host };
}

describe('the surface holding a conversation is the one that answers for it', () => {
  test('a preview the daemon raises is answered with this surface\'s real counts', async () => {
    const { broker, host } = harness();
    // `offer` + `pump` rather than `start`: the cycles are driven by hand here,
    // so nothing races the background loop's own take on the same host id.
    host.offer(SESSION);
    await host.pump();
    expect(host.hostId()).toBeTruthy();

    const preview = broker.preview({ sessionId: SESSION, turnId: 'turn-7' } as never);
    await host.pump();
    const answered = await preview;
    expect(answered).toMatchObject({ messagesToDrop: 4, messagesRemaining: 11 });
    await host.stop();
  });

  test('a rewind is answered with the drop count and an undo id', async () => {
    const { broker, host } = harness();
    host.offer(SESSION);
    await host.pump();
    const applied = broker.rewind({ sessionId: SESSION, turnId: 'turn-7' } as never);
    await host.pump();
    expect(await applied).toMatchObject({ droppedMessages: 4, undoSnapshotId: 'rwc_test_snapshot' });
    await host.stop();
  });

  test('a session this surface is NOT holding is unavailable, never zero', async () => {
    // The registration is live but the conversation has gone (a session swap, a
    // close). A zero here would be a lie a caller cannot detect.
    const { broker, host } = harness({ hosts: false });
    host.offer(SESSION);
    await host.pump();
    const preview = broker.preview({ sessionId: SESSION } as never);
    await host.pump();
    const answered = await preview as unknown as Record<string, unknown>;
    expect(answered['available']).toBe(false);
    expect(String(answered['unavailableReason'])).toContain('no longer holding');
    await host.stop();
  });

  test('a port that throws is reported as unavailable rather than left to time out', async () => {
    const { broker, host } = harness({ port: port({ toDrop: 0, remaining: 0 }, { throws: true }) });
    host.offer(SESSION);
    await host.pump();
    const preview = broker.preview({ sessionId: SESSION } as never);
    await host.pump();
    const answered = await preview as unknown as Record<string, unknown>;
    // A rewind.plan is waiting on this; a reason reaches the person faster and
    // more usefully than a stall does.
    expect(answered['available']).toBe(false);
    expect(answered['unavailableReason']).toBe('the surface hosting this conversation could not answer: the conversation is mid-compaction');
    await host.stop();
  });

  test('a session nobody registered is unavailable with its own reason', async () => {
    const { broker } = harness();
    const answered = await broker.preview({ sessionId: 'nobody-hosts-this' } as never) as unknown as Record<string, unknown>;
    expect(answered['available']).toBe(false);
    expect(String(answered['unavailableReason']).length).toBeGreaterThan(0);
  });

  test('releasing withdraws the offer, so later questions are unavailable', async () => {
    const { broker, host } = harness();
    host.offer(SESSION);
    await host.pump();
    await host.stop();
    expect(host.hostId()).toBeNull();
    const answered = await broker.preview({ sessionId: SESSION } as never) as unknown as Record<string, unknown>;
    expect(answered['available']).toBe(false);
  });

  test('polling is what renews the lease: a live host stays registered across cycles', async () => {
    const { broker, host } = harness();
    host.offer(SESSION);
    await host.pump();
    const registered = host.hostId();
    await host.pump();
    await host.pump();
    // Same registration, not a re-claim: a surface that is polling is a surface
    // that is alive, so there is no separate keepalive to fall out of step.
    expect(host.hostId()).toBe(registered);
    expect(broker.listHosts().map((entry) => entry.hostId)).toEqual([registered!]);
    await host.stop();
  });

  test('stop drains a native pending 20s take without retired diagnostics or backoff', async () => {
    const taking = Promise.withResolvers<void>();
    const taken = Promise.withResolvers<void>();
    const diagnostics: string[] = [];
    let backoffs = 0;
    let takeSettled = false;
    const { broker, host } = harness({
      client: {
        waitMs: 20_000,
        sleep: async () => { backoffs++; },
        log: { info() {}, debug(message) { diagnostics.push(message); }, warn(message) { diagnostics.push(message); } },
      },
      transport: native => ({
        probe: () => native.probe(),
        invoke<T>(methodId: string, input?: unknown): Promise<T> {
          const result = native.invoke<T>(methodId, input);
          if (methodId !== 'rewind.conversation.requests.take') return result;
          taking.resolve();
          return result.finally(() => { takeSettled = true; taken.resolve(); });
        },
      }),
    });
    try {
      host.start(SESSION);
      await taking.promise;
      expect(broker.listHosts()).toHaveLength(1);
      const started = performance.now();
      await host.stop();
      expect(takeSettled).toBe(true);
      await taken.promise;
      await Promise.resolve();
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(broker.listHosts()).toHaveLength(0);
      expect(host.hostId()).toBeNull();
      expect(diagnostics).toEqual([]);
      expect(backoffs).toBe(0);
    } finally { await host.stop(); broker.shutdown(); }
  });

  test('stop waits for late native registration and releases it exactly once', async () => {
    const registered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    const calls: string[] = [];
    const diagnostics: string[] = [];
    const { broker, host } = harness({
      client: { log: { info() {}, debug(message) { diagnostics.push(message); }, warn(message) { diagnostics.push(message); } } },
      transport: native => ({
        probe: () => native.probe(),
        async invoke<T>(methodId: string, input?: unknown): Promise<T> {
          calls.push(methodId);
          const result = await native.invoke<T>(methodId, input);
          if (methodId === 'rewind.conversation.host.register') { registered.resolve(); await response.promise; }
          return result;
        },
      }),
    });
    try {
      host.start(SESSION);
      await registered.promise;
      expect(broker.listHosts()).toHaveLength(1);
      const closing = host.stop();
      expect(host.stop()).toBe(closing);
      let settled = false;
      void closing.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(host.hostId()).toBeNull();
      response.resolve();
      await closing;
      expect(host.stop()).toBe(closing);
      expect(broker.listHosts()).toHaveLength(0);
      expect(calls).toEqual(['rewind.conversation.host.register', 'rewind.conversation.host.release']);
      expect(diagnostics).toEqual([]);
    } finally { response.resolve(); await host.stop(); broker.shutdown(); }
  });

  test('same-session restart waits for its predecessor and never adopts the late old host', async () => {
    const registered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    const taking = Promise.withResolvers<void>();
    let registrations = 0;
    let releases = 0;
    const diagnostics: string[] = [];
    const { broker, host } = harness({
      client: { waitMs: 20_000, log: { info() {}, debug(message) { diagnostics.push(message); }, warn(message) { diagnostics.push(message); } } },
      transport: native => ({
        probe: () => native.probe(),
        async invoke<T>(methodId: string, input?: unknown): Promise<T> {
          if (methodId === 'rewind.conversation.host.register') {
            registrations++;
            const result = await native.invoke<T>(methodId, input);
            if (registrations === 1) { registered.resolve(); await response.promise; }
            return result;
          }
          if (methodId === 'rewind.conversation.host.release') releases++;
          const result = native.invoke<T>(methodId, input);
          if (methodId === 'rewind.conversation.requests.take') taking.resolve();
          return await result;
        },
      }),
    });
    try {
      host.start(SESSION);
      await registered.promise;
      const original = broker.listHosts()[0];
      expect(original).toBeDefined();
      const closing = host.stop();
      host.start(SESSION);
      await Promise.resolve();
      expect(registrations).toBe(1);
      expect(host.hostId()).toBeNull();
      response.resolve();
      await closing;
      await taking.promise;
      expect(registrations).toBe(2);
      expect(releases).toBe(1);
      expect(broker.listHosts()).toHaveLength(1);
      const restarted = broker.listHosts()[0];
      if (!restarted) throw new Error('The restarted native host must exist.');
      expect(host.hostId()).toBe(restarted.hostId);
      expect(host.hostId()).not.toBe(original?.hostId);
      await host.stop();
      expect(releases).toBe(2);
      expect(broker.listHosts()).toHaveLength(0);
      expect(diagnostics).toEqual([]);
    } finally { response.resolve(); await host.stop(); broker.shutdown(); }
  });

  test('stop drains a pending native conversation read without sending an answer or reading the next request', async () => {
    const entered = Promise.withResolvers<void>();
    const preview = Promise.withResolvers<{ messagesToDrop: number; messagesRemaining: number }>();
    const calls: string[] = [];
    let reads = 0;
    const { broker, host } = harness({
      port: {
        async preview() { reads++; entered.resolve(); return await preview.promise; },
        async rewind() { throw new Error('No rewind is part of this preview fixture.'); },
      },
      transport: native => ({
        probe: () => native.probe(),
        invoke<T>(methodId: string, input?: unknown): Promise<T> { calls.push(methodId); return native.invoke<T>(methodId, input); },
      }),
    });
    let pumping: Promise<number> | undefined;
    try {
      host.offer(SESSION); await host.pump();
      const first = broker.preview({ sessionId: SESSION });
      const second = broker.preview({ sessionId: SESSION });
      pumping = host.pump();
      await entered.promise;
      const closing = host.stop();
      let settled = false;
      void closing.then(() => { settled = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false);
      expect(await first).toMatchObject({ available: false });
      expect(await second).toMatchObject({ available: false });
      preview.resolve({ messagesToDrop: 4, messagesRemaining: 11 });
      await closing;
      expect(await pumping).toBe(0);
      expect(reads).toBe(1);
      expect(calls.filter(method => method === 'rewind.conversation.requests.answer')).toHaveLength(0);
      expect(broker.listHosts()).toHaveLength(0);
    } finally { preview.resolve({ messagesToDrop: 4, messagesRemaining: 11 }); await pumping; await host.stop(); broker.shutdown(); }
  });

  test('stop drains an already dispatched native answer and leaves the next request unavailable', async () => {
    const answered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    let answers = 0;
    let reads = 0;
    const { broker, host } = harness({
      port: {
        async preview() { reads++; return { messagesToDrop: 4, messagesRemaining: 11 }; },
        async rewind() { throw new Error('No rewind is part of this preview fixture.'); },
      },
      transport: native => ({
        probe: () => native.probe(),
        async invoke<T>(methodId: string, input?: unknown): Promise<T> {
          const result = await native.invoke<T>(methodId, input);
          if (methodId === 'rewind.conversation.requests.answer') { answers++; answered.resolve(); await response.promise; }
          return result;
        },
      }),
    });
    let pumping: Promise<number> | undefined;
    try {
      host.offer(SESSION); await host.pump();
      const first = broker.preview({ sessionId: SESSION });
      const second = broker.preview({ sessionId: SESSION });
      pumping = host.pump();
      await answered.promise;
      expect(await first).toMatchObject({ messagesToDrop: 4, messagesRemaining: 11 });
      const closing = host.stop();
      let settled = false;
      void closing.then(() => { settled = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false);
      expect(await second).toMatchObject({ available: false });
      response.resolve();
      await closing;
      expect(await pumping).toBe(0);
      expect(answers).toBe(1);
      expect(reads).toBe(1);
      expect(broker.listHosts()).toHaveLength(0);
    } finally { response.resolve(); await pumping; await host.stop(); broker.shutdown(); }
  });

  test('active external host loss is still diagnosed and the next cycle registers a fresh native host', async () => {
    const diagnostics: string[] = [];
    const { broker, host } = harness({ client: {
      log: { info() {}, debug(message) { diagnostics.push(message); }, warn(message) { diagnostics.push(message); } },
    } });
    try {
      host.offer(SESSION); await host.pump();
      const original = broker.listHosts()[0];
      if (!original) throw new Error('The native registration must exist before its external release.');
      broker.releaseHost({ sessionId: SESSION, hostId: original.hostId });
      expect(await host.pump()).toBe(0);
      expect(host.hostId()).toBeNull();
      expect(diagnostics).toEqual(['[rewind] taking conversation-rewind questions failed; will re-offer']);
      await host.pump();
      expect(broker.listHosts()).toHaveLength(1);
      const registered = broker.listHosts()[0];
      if (!registered) throw new Error('The newly registered native host must exist.');
      expect(host.hostId()).toBe(registered.hostId);
      expect(host.hostId()).not.toBe(original.hostId);
    } finally { await host.stop(); broker.shutdown(); }
  });

  test('changing the offered session drains its old native poll before claiming the successor', async () => {
    const taking = Promise.withResolvers<void>();
    const registered = Promise.withResolvers<void>();
    let registrations = 0;
    const diagnostics: string[] = [];
    const { broker, host } = harness({
      client: { waitMs: 20_000, log: { info() {}, debug(message) { diagnostics.push(message); }, warn(message) { diagnostics.push(message); } } },
      transport: native => ({
        probe: () => native.probe(),
        invoke<T>(methodId: string, input?: unknown): Promise<T> {
          if (methodId === 'rewind.conversation.host.register') registrations++;
          const result = native.invoke<T>(methodId, input);
          if (methodId === 'rewind.conversation.host.register' && registrations === 2) registered.resolve();
          if (methodId === 'rewind.conversation.requests.take') taking.resolve();
          return result;
        },
      }),
    });
    let pumping: Promise<number> | undefined;
    try {
      host.offer(SESSION); pumping = host.pump();
      await taking.promise;
      host.offer('successor-session');
      expect(host.hostId()).toBeNull();
      const successor = host.pump();
      expect(await pumping).toBe(0);
      await registered.promise;
      await host.stop();
      expect(await successor).toBe(0);
      expect(broker.listHosts()).toHaveLength(0);
      expect(diagnostics).toEqual([]);
    } finally { await host.stop(); await pumping; broker.shutdown(); }
  });

  test('stop cancels its native retry timer instead of waiting the post-failure backoff', async () => {
    const failed = Promise.withResolvers<void>();
    let registrations = 0;
    const { broker, host } = harness({
      client: { waitMs: 20_000, log: { info() {}, debug() { failed.resolve(); }, warn() {} } },
      transport: native => ({
        probe: () => native.probe(),
        async invoke<T>(methodId: string, input?: unknown): Promise<T> {
          const result = await native.invoke<T>(methodId, input);
          if (methodId === 'rewind.conversation.host.register') {
            registrations++;
            const registered = broker.listHosts()[0];
            if (!registered) throw new Error('Expected an actual registered host before simulating external loss.');
            broker.releaseHost({ sessionId: registered.sessionId, hostId: registered.hostId });
          }
          return result;
        },
      }),
    });
    try {
      host.start(SESSION);
      await failed.promise;
      await Bun.sleep(10);
      const started = performance.now();
      await host.stop();
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(registrations).toBe(1);
      expect(broker.listHosts()).toHaveLength(0);
    } finally { await host.stop(); broker.shutdown(); }
  });
});
