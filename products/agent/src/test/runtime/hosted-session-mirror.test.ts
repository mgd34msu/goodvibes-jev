/**
 * The gap this closes: a crashed/detached hosted session NEVER landed in
 * sessions/. The conversation existed only as a preview-grade recovery journal
 * plus the daemon-side record, and sessions/last-session.json still pointed at
 * an OLDER local session, so a resume would have opened the wrong
 * conversation.
 *
 * Cause: a local turn is persisted off TURN_COMPLETED, and a hosted turn never
 * fires one locally, so every durable-write path hung off an event hosted
 * conversations do not emit.
 */
import { describe, expect, test } from 'bun:test';
import {
  hostedHistoryToStoreMessages,
  mirrorHostedSessionToStore,
  recoverUnmirroredHostedSessions,
  type HostedHistoryMessage,
} from '../../runtime/client/hosted-session-mirror.ts';

interface PersistCall {
  sessionId: string;
  snapshot: { messages: Array<Record<string, unknown>>; title?: string };
  model: string;
  provider: string;
  title?: string | undefined;
}

const HISTORY: HostedHistoryMessage[] = [
  { role: 'user', content: 'what time should i leave for my trip on the 6th?' },
  { role: 'assistant', content: 'Leave by 5:15 AM.' },
];

function harness(overrides: {
  attach?: unknown;
  attachError?: Error;
  list?: unknown;
  listError?: Error;
} = {}): { deps: Parameters<typeof mirrorHostedSessionToStore>[1] & Record<string, unknown>; persisted: PersistCall[] } {
  const persisted: PersistCall[] = [];
  const deps = {
    verbs: {
      invoke: async <T,>(method: string): Promise<T> => {
        if (method === 'sessions.hosted.attach') {
          if (overrides.attachError) throw overrides.attachError;
          return (overrides.attach ?? {
            session: { id: 'hosted-1', title: 'Trip timing', modelId: 'm1', providerId: 'p1' },
            history: HISTORY,
          }) as T;
        }
        if (method === 'sessions.hosted.list') {
          if (overrides.listError) throw overrides.listError;
          return (overrides.list ?? { sessions: [] }) as T;
        }
        throw new Error(`unexpected verb ${method}`);
      },
    },
    clientId: 'goodvibes-agent:user-local',
    persist: (sessionId: string, snapshot: PersistCall['snapshot'], model: string, provider: string, title?: string) => {
      persisted.push({ sessionId, snapshot, model, provider, title });
    },
    fallbackModel: 'fallback-model',
    fallbackProvider: 'fallback-provider',
    now: () => 1_700_000_000_000,
  };
  return { deps, persisted };
}

describe('mirroring a hosted conversation into the session store', () => {
  test('the daemon transcript is written under the HOSTED session id', async () => {
    const { deps, persisted } = harness();

    const outcome = await mirrorHostedSessionToStore('hosted-1', deps);

    expect(outcome).toEqual({ mirrored: true, sessionId: 'hosted-1', messageCount: 2 });
    expect(persisted).toHaveLength(1);
    // Filed under the hosted id, so a resume of THIS conversation finds it.
    expect(persisted[0]!.sessionId).toBe('hosted-1');
    expect(persisted[0]!.snapshot.messages).toEqual([
      { role: 'user', content: 'what time should i leave for my trip on the 6th?' },
      { role: 'assistant', content: 'Leave by 5:15 AM.' },
    ]);
    // persistConversation is the SDK call that ALSO moves last-session.json;
    // using it is what stops a resume opening the older local session.
    expect(persisted[0]!.title).toBe('Trip timing');
  });

  test('the daemon record supplies model and provider, not this process', async () => {
    const { deps, persisted } = harness();
    await mirrorHostedSessionToStore('hosted-1', deps);
    expect(persisted[0]!.model).toBe('m1');
    expect(persisted[0]!.provider).toBe('p1');
  });

  test('a record without model/provider falls back to this surface\'s current pair', async () => {
    const { deps, persisted } = harness({
      attach: { session: { id: 'hosted-1' }, history: HISTORY },
    });
    await mirrorHostedSessionToStore('hosted-1', deps);
    expect(persisted[0]!.model).toBe('fallback-model');
    expect(persisted[0]!.provider).toBe('fallback-provider');
  });

  test('an empty transcript is NOT written, so the pointer never moves onto nothing', async () => {
    const { deps, persisted } = harness({ attach: { session: { id: 'hosted-1' }, history: [] } });

    const outcome = await mirrorHostedSessionToStore('hosted-1', deps);

    expect(outcome.mirrored).toBe(false);
    expect(persisted).toEqual([]);
  });

  test('an unreachable daemon is reported, never thrown', async () => {
    const { deps, persisted } = harness({ attachError: new Error('connection refused') });

    const outcome = await mirrorHostedSessionToStore('hosted-1', deps);

    expect(outcome.mirrored).toBe(false);
    expect(outcome.mirrored === false && outcome.reason).toContain('hosted-1');
    expect(persisted).toEqual([]);
  });

  test('a failing store write is reported, never thrown', async () => {
    const { deps } = harness();
    const outcome = await mirrorHostedSessionToStore('hosted-1', {
      ...deps,
      persist: () => { throw new Error('disk full'); },
    });
    expect(outcome.mirrored).toBe(false);
  });

  test('tool rows keep their content and say so about the synthesized call id', () => {
    const messages = hostedHistoryToStoreMessages([
      { role: 'user', content: 'run it' },
      { role: 'tool', content: 'exit 0' },
    ]);
    expect(messages[1]).toEqual({ role: 'tool', callId: 'hosted-1', content: 'exit 0' });
  });
});

describe('crash path: completion is never delivered', () => {
  test('a hosted session the store never heard of is recovered at the next boot', async () => {
    // Simulates the crash exactly as the brief describes: no completion ever
    // reaches this surface, so nothing mirrored at turn end. The daemon still
    // holds the transcript.
    const { deps, persisted } = harness({
      list: { sessions: [{ id: 'hosted-1', workspaceRoot: '/proj', messageCount: 2 }] },
    });

    const outcomes = await recoverUnmirroredHostedSessions({
      ...deps,
      workspaceRoot: '/proj',
      knownSessionIds: () => [],
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.mirrored).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.sessionId).toBe('hosted-1');
  });

  test('a session the store already holds is left alone', async () => {
    const { deps, persisted } = harness({
      list: { sessions: [{ id: 'hosted-1', workspaceRoot: '/proj', messageCount: 2 }] },
    });

    await recoverUnmirroredHostedSessions({
      ...deps,
      workspaceRoot: '/proj',
      knownSessionIds: () => ['hosted-1'],
    });

    expect(persisted).toEqual([]);
  });

  test('another workspace\'s hosted sessions are not pulled into this one', async () => {
    const { deps, persisted } = harness({
      list: { sessions: [{ id: 'hosted-elsewhere', workspaceRoot: '/other', messageCount: 9 }] },
    });

    await recoverUnmirroredHostedSessions({
      ...deps,
      workspaceRoot: '/proj',
      knownSessionIds: () => [],
    });

    expect(persisted).toEqual([]);
  });

  test('recovery is bounded, and the NEWEST session is mirrored last', async () => {
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      id: `hosted-${index}`,
      workspaceRoot: '/proj',
      messageCount: 2,
    }));
    const { deps, persisted } = harness({ list: { sessions } });

    await recoverUnmirroredHostedSessions({
      ...deps,
      workspaceRoot: '/proj',
      knownSessionIds: () => [],
      maxRecovered: 3,
    });

    expect(persisted).toHaveLength(3);
    // Last write wins the last-session pointer, so it must be the newest.
    expect(persisted[persisted.length - 1]!.sessionId).toBe('hosted-11');
  });

  test('an unreachable daemon at boot returns nothing and does not throw', async () => {
    const { deps, persisted } = harness({ listError: new Error('daemon down') });

    const outcomes = await recoverUnmirroredHostedSessions({
      ...deps,
      workspaceRoot: '/proj',
      knownSessionIds: () => [],
    });

    expect(outcomes).toEqual([]);
    expect(persisted).toEqual([]);
  });
});
