/**
 * hosted-handoff.test.ts
 *
 * Handing an inbound channel conversation to the daemon to host: the setting
 * governs it both ways, the first message creates the hosted session and every
 * later one is steered into it, and no refusal ever costs the owner a message,
 * every one of them falls back to answering in this process.
 */
import { describe, expect, test } from 'bun:test';
import type { DaemonReachability, DaemonVerbCaller } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { ConnectedHostVerbError } from '../../runtime/client/daemon-verbs.ts';
import {
  PROMOTION_DISABLED_REASON,
  createHostedConversationHandoff,
  hostedSessionTitle,
  type HostedHandoffRequest,
} from '../../runtime/client/hosted-handoff.ts';

interface Call {
  readonly methodId: string;
  readonly input: unknown;
}

function recorder(options: {
  readonly probe?: DaemonReachability;
  readonly answer?: (methodId: string, input: unknown) => unknown;
}): { readonly verbs: DaemonVerbCaller; readonly calls: Call[] } {
  const calls: Call[] = [];
  const verbs: DaemonVerbCaller = {
    probe: () => options.probe ?? { available: true },
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
      calls.push({ methodId, input });
      const answer = options.answer?.(methodId, input);
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
  return { verbs, calls };
}

function request(overrides: Partial<HostedHandoffRequest> = {}): HostedHandoffRequest {
  return {
    sessionId: 'session-a',
    task: 'Continue the conversation. The owner said: fix the sink',
    body: 'fix the sink',
    surfaceKind: 'telegram',
    surfaceId: 'telegram:home',
    ...overrides,
  };
}

const quietLog = { debug: () => {}, info: () => {}, warn: () => {} };

function handoff(options: {
  readonly enabled: boolean;
  readonly verbs: DaemonVerbCaller;
  readonly workspaceRoot?: string;
}): ReturnType<typeof createHostedConversationHandoff> {
  return createHostedConversationHandoff({
    verbs: options.verbs,
    isEnabled: () => options.enabled,
    workspaceRoot: () => options.workspaceRoot ?? '/home/owner/project',
    clientId: 'agent:1234',
    log: quietLog,
  });
}

describe('hosted handoff: the setting decides, and it works both ways', () => {
  test('off: nothing is asked of the daemon and the caller is told to answer locally', async () => {
    const { verbs, calls } = recorder({});
    const outcome = await handoff({ enabled: false, verbs }).promote(request());

    expect(outcome.promoted).toBe(false);
    expect(outcome).toMatchObject({ disabled: true, reason: PROMOTION_DISABLED_REASON });
    // Off means off: not one round trip was spent finding that out.
    expect(calls).toHaveLength(0);
  });

  test('on: the first message of a conversation creates the hosted session', async () => {
    const { verbs, calls } = recorder({
      answer: (methodId) => (methodId === 'sessions.hosted.create'
        ? { session: { id: 'hosted-1' } }
        : {}),
    });
    const outcome = await handoff({ enabled: true, verbs }).promote(request());

    expect(outcome).toEqual({ promoted: true, hostedSessionId: 'hosted-1', action: 'created' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.methodId).toBe('sessions.hosted.create');
    expect(calls[0]?.input).toMatchObject({
      workspaceRoot: '/home/owner/project',
      // The OWNER's words open the session, not the broker's enriched framing.
      initialPrompt: 'fix the sink',
      clientId: 'agent:1234',
    });
  });

  test('a live toggle takes effect on the next message, not the next restart', async () => {
    let enabled = false;
    const { verbs, calls } = recorder({
      answer: () => ({ session: { id: 'hosted-1' } }),
    });
    const live = createHostedConversationHandoff({
      verbs,
      isEnabled: () => enabled,
      workspaceRoot: () => '/home/owner/project',
      clientId: 'agent:1234',
      log: quietLog,
    });

    expect((await live.promote(request())).promoted).toBe(false);
    enabled = true;
    expect((await live.promote(request())).promoted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('hosted handoff: later messages are steered into the same conversation', () => {
  test('the second message steers rather than creating a second session', async () => {
    const { verbs, calls } = recorder({
      answer: (methodId) => (methodId === 'sessions.hosted.create' ? { session: { id: 'hosted-1' } } : {}),
    });
    const promoter = handoff({ enabled: true, verbs });

    await promoter.promote(request());
    const second = await promoter.promote(request({ body: 'and the tap' }));

    expect(second).toEqual({ promoted: true, hostedSessionId: 'hosted-1', action: 'steered' });
    expect(calls.map((call) => call.methodId)).toEqual(['sessions.hosted.create', 'sessions.steer']);
    expect(calls[1]?.input).toMatchObject({
      sessionId: 'hosted-1',
      body: 'and the tap',
      surfaceKind: 'telegram',
      surfaceId: 'telegram:home',
    });
    expect(promoter.hostedIdFor('session-a')).toBe('hosted-1');
  });

  test('two conversations get two hosted sessions', async () => {
    let minted = 0;
    const { verbs } = recorder({
      answer: (methodId) => (methodId === 'sessions.hosted.create'
        ? { session: { id: `hosted-${++minted}` } }
        : {}),
    });
    const promoter = handoff({ enabled: true, verbs });

    await promoter.promote(request({ sessionId: 'session-a' }));
    await promoter.promote(request({ sessionId: 'session-b' }));

    expect(promoter.entries()).toEqual([
      { sessionId: 'session-a', hostedSessionId: 'hosted-1' },
      { sessionId: 'session-b', hostedSessionId: 'hosted-2' },
    ]);
  });

  test('a hosted session that is gone is started again with the message in hand', async () => {
    let minted = 0;
    const { verbs, calls } = recorder({
      answer: (methodId) => {
        if (methodId === 'sessions.hosted.create') return { session: { id: `hosted-${++minted}` } };
        return new ConnectedHostVerbError("'sessions.steer' failed: no such session", 404);
      },
    });
    const promoter = handoff({ enabled: true, verbs });

    await promoter.promote(request());
    const afterLoss = await promoter.promote(request({ body: 'still there?' }));

    expect(afterLoss).toEqual({ promoted: true, hostedSessionId: 'hosted-2', action: 'recreated' });
    expect(calls.map((call) => call.methodId)).toEqual([
      'sessions.hosted.create',
      'sessions.steer',
      'sessions.hosted.create',
    ]);
    expect(calls[2]?.input).toMatchObject({ initialPrompt: 'still there?' });
  });

  test('a steer the daemon could not serve right now does NOT mint a second session', async () => {
    const { verbs, calls } = recorder({
      answer: (methodId) => {
        if (methodId === 'sessions.hosted.create') return { session: { id: 'hosted-1' } };
        return new ConnectedHostVerbError("'sessions.steer' failed: upstream is unwell", 503);
      },
    });
    const promoter = handoff({ enabled: true, verbs });

    await promoter.promote(request());
    const outcome = await promoter.promote(request({ body: 'again' }));

    expect(outcome.promoted).toBe(false);
    expect(calls.filter((call) => call.methodId === 'sessions.hosted.create')).toHaveLength(1);
    // The mapping is kept: the conversation is still that hosted session's.
    expect(promoter.hostedIdFor('session-a')).toBe('hosted-1');
  });
});

describe('hosted handoff: every refusal is a stated reason, never a lost message', () => {
  test('an unreachable daemon refuses with the reason the verb layer gave', async () => {
    const { verbs, calls } = recorder({
      probe: { available: false, reason: 'the connected host is disabled (daemon.enabled=false).' },
    });
    const outcome = await handoff({ enabled: true, verbs }).promote(request());

    expect(outcome).toEqual({
      promoted: false,
      disabled: false,
      reason: 'the connected host is disabled (daemon.enabled=false).',
    });
    expect(calls).toHaveLength(0);
  });

  test('a relative workspace root is refused here rather than resolved by the daemon', async () => {
    const { verbs, calls } = recorder({});
    const outcome = await handoff({ enabled: true, verbs, workspaceRoot: 'project' }).promote(request());

    expect(outcome.promoted).toBe(false);
    expect(outcome).toMatchObject({ disabled: false });
    if (!outcome.promoted) expect(outcome.reason).toContain('absolute');
    expect(calls).toHaveLength(0);
  });

  test('a host at its hosted-session cap refuses with the daemon\'s own words', async () => {
    const { verbs } = recorder({
      answer: () => new ConnectedHostVerbError(
        "'sessions.hosted.create' failed: 8 hosted sessions are live and hostedSessions.maxSessions is 8",
        429,
      ),
    });
    const outcome = await handoff({ enabled: true, verbs }).promote(request());

    expect(outcome.promoted).toBe(false);
    if (!outcome.promoted) expect(outcome.reason).toContain('hostedSessions.maxSessions');
  });

  test('a reply with no readable session id is reported, not treated as a promotion', async () => {
    const { verbs } = recorder({ answer: () => ({ session: {} }) });
    const promoter = handoff({ enabled: true, verbs });
    const outcome = await promoter.promote(request());

    expect(outcome.promoted).toBe(false);
    expect(promoter.hostedIdFor('session-a')).toBeNull();
  });

  test('a 404 from a host that has not wired the verb is named as such', async () => {
    const { verbs } = recorder({
      answer: () => new ConnectedHostVerbError("'sessions.hosted.create' failed: HTTP 404", 404),
    });
    const outcome = await handoff({ enabled: true, verbs }).promote(request());

    expect(outcome.promoted).toBe(false);
    if (!outcome.promoted) expect(outcome.reason).toContain('not wired');
  });
});

describe('hosted handoff: the session list reads like the conversation', () => {
  test('the title carries the channel and the owner\'s words', () => {
    expect(hostedSessionTitle(request())).toBe('telegram: fix the sink');
    expect(hostedSessionTitle(request({ displayName: 'Mike' }))).toBe('Mike: fix the sink');
  });

  test('a long message is cut rather than pasted whole into a list row', () => {
    const title = hostedSessionTitle(request({ body: 'x'.repeat(200), surfaceKind: undefined }));
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });

  test('an empty message still gets a name', () => {
    expect(hostedSessionTitle(request({ body: '   ', task: '  ', surfaceKind: undefined }))).toBe('Inbound conversation');
  });
});
