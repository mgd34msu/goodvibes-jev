/**
 * client-seams.test.ts, proof that the seams this agent adopted actually carry
 * work across the process boundary.
 *
 * Each block below covers one thing the agent used to do to itself and now does
 * to the daemon. The assertions are about what LEAVES this process, because the
 * failure mode this round fixed is not a crash, it is a surface answering its
 * own question, confidently, from a store nobody else can see.
 *
 * The daemon is a stub verb caller: it records every call and answers from a
 * scripted table, so the tests observe the exact wire shape without a port, a
 * token file, or a running host.
 */
import { describe, expect, test } from 'bun:test';
import {
  createConversationRewindHost,
  createWireSessionDispatch,
} from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import type { DaemonReachability, DaemonVerbCaller } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import type { RewindAnchor } from '@goodvibes-jev/engine/sdk/platform/rewind';
import { createHostedSessionRegistry } from '../../runtime/client/hosted-sessions.ts';
import { createAgentSessionInputsClient } from '../../runtime/client/session-inputs.ts';

interface RecordedCall {
  readonly methodId: string;
  readonly input: unknown;
}

function stubVerbs(options: {
  readonly reachable?: boolean;
  readonly reason?: string;
  readonly calls: RecordedCall[];
  readonly answer?: (methodId: string, input: unknown) => unknown;
}): DaemonVerbCaller {
  const reachable = options.reachable !== false;
  const reason = options.reason ?? 'no connected host is configured on this machine.';
  return {
    probe(): DaemonReachability {
      return reachable ? { available: true } : { available: false, reason };
    },
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
      options.calls.push({ methodId, input });
      if (!reachable) throw new Error(`cannot invoke '${methodId}': ${reason}`);
      return (options.answer?.(methodId, input) ?? {}) as T;
    },
  };
}

describe('inbound work reaches the loop', () => {
  test('a queued submit for a hosted session runs the bound runner and is acknowledged once', async () => {
    const hosted = createHostedSessionRegistry();
    hosted.adopt('session-a');
    const dispatch = createWireSessionDispatch({
      hostedSessionIds: () => hosted.ids(),
      intervalMs: 10,
    });
    const ran: string[] = [];
    dispatch.setContinuationRunner(async ({ task }) => {
      ran.push(task);
      return { agentId: 'agent-1' };
    });

    const delivered: Array<{ sessionId: string; inputId: string }> = [];
    let served = false;
    dispatch.activate({
      async listInputs(sessionId) {
        if (sessionId !== 'session-a' || served) return { inputs: [] };
        served = true;
        return {
          inputs: [
            // A `steer` belongs to the live-turn path, not to this one. It must
            // not start a second run.
            { id: 'input-steer', sessionId, intent: 'steer', body: 'nudge', state: 'queued' },
            { id: 'input-1', sessionId, intent: 'submit', body: 'Build the thing', state: 'queued' },
          ] as never,
        };
      },
      async deliverInput(sessionId, inputId) {
        delivered.push({ sessionId, inputId });
        return {};
      },
    });

    const deadline = Date.now() + 3_000;
    while (delivered.length === 0 && Date.now() < deadline) await Bun.sleep(5);
    dispatch.stop();

    expect(ran).toEqual(['Build the thing']);
    expect(delivered).toEqual([{ sessionId: 'session-a', inputId: 'input-1' }]);
  });

  test('a session this process does NOT host is never polled', async () => {
    const hosted = createHostedSessionRegistry();
    const dispatch = createWireSessionDispatch({ hostedSessionIds: () => hosted.ids(), intervalMs: 10 });
    dispatch.setContinuationRunner(async () => null);
    const polled: string[] = [];
    dispatch.activate({
      async listInputs(sessionId) {
        polled.push(sessionId);
        return { inputs: [] };
      },
      async deliverInput() { return {}; },
    });

    await Bun.sleep(60);
    dispatch.stop();

    expect(polled).toEqual([]);
  });

  test('the inputs wire client speaks sessions.inputs.list and .deliver', async () => {
    const calls: RecordedCall[] = [];
    const client = createAgentSessionInputsClient(stubVerbs({
      calls,
      answer: (methodId) => (methodId === 'sessions.inputs.list' ? { inputs: [{ id: 'input-1' }] } : {}),
    }));

    const listed = await client.listInputs('session-a', { state: 'queued', limit: 20 });
    await client.deliverInput('session-a', 'input-1', { consumed: true });

    expect(listed.inputs).toHaveLength(1);
    expect(calls).toEqual([
      { methodId: 'sessions.inputs.list', input: { sessionId: 'session-a', state: 'queued', limit: 20 } },
      { methodId: 'sessions.inputs.deliver', input: { sessionId: 'session-a', inputId: 'input-1', consumed: true } },
    ]);
  });
});

describe('the daemon can ask this process about a conversation only it holds', () => {
  test('a question about a hosted session is answered from the live port', async () => {
    const calls: RecordedCall[] = [];
    const hosted = createHostedSessionRegistry();
    hosted.adopt('session-a');
    const host = createConversationRewindHost({
      verbs: stubVerbs({
        calls,
        answer: (methodId) => {
          if (methodId === 'rewind.conversation.host.register') return { host: { hostId: 'host-1' } };
          if (methodId === 'rewind.conversation.requests.take') {
            return { requests: [{ requestId: 'req-1', sessionId: 'session-a', turnId: null, kind: 'preview', expiresAt: Date.now() + 1000 }] };
          }
          return {};
        },
      }),
      port: {
        async preview(anchor: RewindAnchor) {
          expect(anchor.sessionId).toBe('session-a');
          return { messagesToDrop: 4, messagesRemaining: 9 };
        },
        async rewind() {
          return { droppedMessages: 4, undoSnapshotId: 'undo-1' };
        },
      },
      hosts: (sessionId) => hosted.hosts(sessionId),
      label: 'GoodVibes Agent test',
      waitMs: 0,
    });

    host.offer('session-a');
    const handled = await host.pump();

    expect(handled).toBe(1);
    const answer = calls.find((call) => call.methodId === 'rewind.conversation.requests.answer');
    expect(answer).toBeTruthy();
    expect(answer!.input).toMatchObject({ requestId: 'req-1', messagesToDrop: 4, messagesRemaining: 9 });
  });

  test('a question about a session this process is NOT holding is unavailable, never zero', async () => {
    const calls: RecordedCall[] = [];
    const hosted = createHostedSessionRegistry();
    const host = createConversationRewindHost({
      verbs: stubVerbs({
        calls,
        answer: (methodId) => {
          if (methodId === 'rewind.conversation.host.register') return { host: { hostId: 'host-1' } };
          if (methodId === 'rewind.conversation.requests.take') {
            return { requests: [{ requestId: 'req-1', sessionId: 'session-gone', turnId: null, kind: 'preview', expiresAt: Date.now() + 1000 }] };
          }
          return {};
        },
      }),
      port: {
        async preview() { throw new Error('the port must not be consulted for a session this process is not holding'); },
        async rewind() { throw new Error('the port must not be consulted for a session this process is not holding'); },
      },
      hosts: (sessionId) => hosted.hosts(sessionId),
      waitMs: 0,
    });

    host.offer('session-a');
    await host.pump();

    // A real zero and an unreachable conversation are indistinguishable as a
    // number. Reporting the second as the first is what made the old behaviour
    // a lie rather than a gap.
    const answer = calls.find((call) => call.methodId === 'rewind.conversation.requests.answer');
    const payload = answer!.input as Record<string, unknown>;
    expect(String(payload['unavailableReason'])).toContain('session-gone');
    expect(payload['messagesToDrop']).toBeUndefined();
  });
});

describe('the hosted-session registry answers about THIS process', () => {
  test('nothing is busy until a turn opens, and it closes on error and cancel too', () => {
    const listeners = new Map<string, (envelope: { sessionId?: string }) => void>();
    const bus = {
      on<T>(type: string, callback: (envelope: never) => void): () => void {
        listeners.set(type, callback as (envelope: { sessionId?: string }) => void);
        return () => listeners.delete(type);
      },
    } as never;
    const hosted = createHostedSessionRegistry(bus);
    hosted.adopt('session-a');

    expect(hosted.countBusySessions()).toBe(0);
    listeners.get('TURN_SUBMITTED')!({ sessionId: 'session-a' });
    expect(hosted.countBusySessions()).toBe(1);

    // A cancelled or failed turn releases the flag. Otherwise a single
    // provider error would pin the agent "busy" for the process lifetime and
    // memory consolidation would never run again.
    listeners.get('TURN_ERROR')!({ sessionId: 'session-a' });
    expect(hosted.countBusySessions()).toBe(0);

    listeners.get('TURN_SUBMITTED')!({ sessionId: 'session-a' });
    listeners.get('TURN_CANCEL')!({ sessionId: 'session-a' });
    expect(hosted.countBusySessions()).toBe(0);
  });

  test('a turn on a session this process released stops counting', () => {
    const listeners = new Map<string, (envelope: { sessionId?: string }) => void>();
    const bus = {
      on<T>(type: string, callback: (envelope: never) => void): () => void {
        listeners.set(type, callback as (envelope: { sessionId?: string }) => void);
        return () => listeners.delete(type);
      },
    } as never;
    const hosted = createHostedSessionRegistry(bus);
    hosted.adopt('session-a');
    listeners.get('TURN_SUBMITTED')!({ sessionId: 'session-a' });
    expect(hosted.countBusySessions()).toBe(1);

    hosted.release('session-a');

    expect(hosted.hosts('session-a')).toBe(false);
    expect(hosted.ids()).toEqual([]);
    expect(hosted.countBusySessions()).toBe(0);
  });
});
