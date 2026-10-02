/**
 * remote-conversation.test.ts
 *
 * The owner's ruling is that this surface should be passing its LLM turns
 * through the connected daemon. These tests cover the decision that implements
 * it: which verb a submission becomes, what happens when the daemon will not
 * take it, and, the part that must never regress, that a turn which ends up
 * running locally SAYS so, naming the reason.
 */

import { describe, expect, test } from 'bun:test';
import {
  createRemoteConversationRouter,
  hostedSessionEventStreamUrl,
  ROUTING_DISABLED_REASON,
  type ConnectedHostResolution,
} from '../../runtime/client/remote-conversation.ts';
import { ConnectedHostVerbError } from '../../runtime/client/daemon-verbs.ts';
import type { HostedFrameConversation } from '../../runtime/client/hosted-frame-render.ts';

const HOSTED_ID = 'hosted-1111';
const LIVE_HOST: ConnectedHostResolution = { baseUrl: 'http://127.0.0.1:3421', token: 'operator-token' };

/** A conversation that ignores everything, these tests are about routing. */
function inertConversation(): HostedFrameConversation {
  return {
    addAssistantMessage: () => {},
    addToolResults: () => {},
    addSystemMessage: () => {},
    startStreamingBlock: () => {},
    updateStreamingBlock: () => {},
    finalizeStreamingBlock: () => {},
  };
}

/** A fetch that answers an SSE open with an empty, immediately-ended stream. */
function stubStreamFetch(): typeof fetch {
  return (async () => new Response(new ReadableStream<Uint8Array>({
    start: (controller) => { controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
}

interface Call { readonly methodId: string; readonly input: Record<string, unknown> }

function harness(input: {
  readonly invoke: (methodId: string, input: unknown, call: number) => unknown;
  readonly connection?: ConnectedHostResolution;
  readonly routeTurns?: boolean;
  readonly workspaceRoot?: string;
}): { router: ReturnType<typeof createRemoteConversationRouter>; calls: Call[] } {
  const calls: Call[] = [];
  const router = createRemoteConversationRouter({
    verbs: {
      probe: () => ({ available: true }),
      invoke: async <T,>(methodId: string, payload?: unknown): Promise<T> => {
        calls.push({ methodId, input: (payload ?? {}) as Record<string, unknown> });
        const result = input.invoke(methodId, payload, calls.length);
        if (result instanceof Error) throw result;
        return result as T;
      },
    },
    configManager: {
      get: ((key: string) => (
        key === 'hostedSessions.routeConversationTurns' ? input.routeTurns ?? true : undefined
      )) as never,
    },
    resolveConnection: () => input.connection ?? LIVE_HOST,
    conversation: inertConversation(),
    requestRender: () => {},
    workspaceRoot: input.workspaceRoot ?? '/home/someone/project',
    clientId: 'goodvibes-agent:test',
    fetchImpl: stubStreamFetch(),
  });
  return { router, calls };
}

describe('routing a conversation turn to the connected daemon', () => {
  test('the first message creates a hosted session rooted at this working directory', async () => {
    const { router, calls } = harness({
      invoke: () => ({ session: { id: HOSTED_ID } }),
      workspaceRoot: '/home/someone/project',
    });

    const outcome = await router.submit('hello');

    expect(outcome).toMatchObject({ routed: true, hostedSessionId: HOSTED_ID, action: 'created' });
    // Create carries NO prompt: `initialPrompt` would start the turn inside the
    // create call, before the event stream this surface renders from exists, and
    // those frames are live traffic that cannot be replayed. So the first
    // message takes the same create-then-steer path every later one takes.
    expect(calls.map((call) => call.methodId)).toEqual(['sessions.hosted.create', 'sessions.steer']);
    expect(calls[0]?.input.workspaceRoot).toBe('/home/someone/project');
    expect(calls[0]?.input.initialPrompt).toBeUndefined();
    expect(calls[1]?.input.body).toBe('hello');
    expect(router.hostedSessionId()).toBe(HOSTED_ID);
  });

  test('the second message steers the session the first one opened: it does not create another', async () => {
    const { router, calls } = harness({
      invoke: (methodId) => (methodId === 'sessions.hosted.create' ? { session: { id: HOSTED_ID } } : {}),
    });

    await router.submit('first');
    const second = await router.submit('second');

    expect(second).toMatchObject({ routed: true, hostedSessionId: HOSTED_ID, action: 'steered' });
    expect(calls.map((call) => call.methodId))
      .toEqual(['sessions.hosted.create', 'sessions.steer', 'sessions.steer']);
    expect(calls[2]?.input.sessionId).toBe(HOSTED_ID);
    expect(calls[2]?.input.body).toBe('second');
  });

  test('a steer into a session the daemon no longer has opens a new one and carries the message', async () => {
    // The daemon restarted, or the session was killed. Recoverable: the person
    // should not have to notice, and their message must not be dropped.
    let steers = 0;
    const { router, calls } = harness({
      invoke: (methodId, _payload, call) => {
        if (methodId === 'sessions.hosted.create') return { session: { id: `${HOSTED_ID}-${call}` } };
        steers += 1;
        // The first message's steer lands; the second finds the session gone.
        return steers === 2 ? new ConnectedHostVerbError('gone', 404) : {};
      },
    });

    await router.submit('first');
    const second = await router.submit('second');

    expect(second).toMatchObject({ routed: true, action: 'recreated' });
    expect(calls.map((call) => call.methodId)).toEqual([
      'sessions.hosted.create', 'sessions.steer',
      'sessions.steer',
      'sessions.hosted.create', 'sessions.steer',
    ]);
    // The message is carried into the freshly opened session, not dropped.
    expect(calls[4]?.input.body).toBe('second');
  });

  test('a refusal that is NOT a stale session does not open a second one', async () => {
    // A session cap or a 5xx is a real refusal. Retrying into it turns one
    // failure into two, and the second one counts against the same cap.
    let steers = 0;
    const { router, calls } = harness({
      invoke: (methodId) => {
        if (methodId === 'sessions.hosted.create') return { session: { id: HOSTED_ID } };
        steers += 1;
        return steers === 2 ? new ConnectedHostVerbError('at capacity', 429) : {};
      },
    });

    await router.submit('first');
    const second = await router.submit('second');

    expect(second.routed).toBe(false);
    if (second.routed) throw new Error('unreachable');
    expect(second.reason).toContain('429');
    // One create, not two: the refusal was not a recoverable stale session.
    expect(calls.filter((call) => call.methodId === 'sessions.hosted.create')).toHaveLength(1);
  });
});

describe('a turn that runs locally always says so, and why', () => {
  test('no connected host: the reason names what could not be resolved', async () => {
    const { router, calls } = harness({
      invoke: () => ({ session: { id: HOSTED_ID } }),
      connection: { reason: 'no operator token has been written yet.' },
    });

    const outcome = await router.submit('hello');

    expect(outcome.routed).toBe(false);
    if (outcome.routed) throw new Error('unreachable');
    expect(outcome.reason).toContain('no operator token has been written yet.');
    expect(outcome.chosen).toBe(false);
    // Nothing was attempted against a host that is not there.
    expect(calls).toHaveLength(0);
  });

  test('the create failing: the reason names the daemon\'s own refusal', async () => {
    const { router } = harness({
      invoke: () => new ConnectedHostVerbError('hostedSessions.maxSessions reached', 429),
    });

    const outcome = await router.submit('hello');

    expect(outcome.routed).toBe(false);
    if (outcome.routed) throw new Error('unreachable');
    expect(outcome.reason).toContain('429');
    expect(outcome.chosen).toBe(false);
  });

  test('a host that answers with no session id is reported, not treated as success', async () => {
    const { router } = harness({ invoke: () => ({ session: {} }) });
    const outcome = await router.submit('hello');
    expect(outcome.routed).toBe(false);
    if (outcome.routed) throw new Error('unreachable');
    expect(outcome.reason).toContain('no session id');
  });

  test('a relative workspace path is refused here rather than sent to be misresolved', async () => {
    // The daemon would resolve a relative path against ITS own directory, which
    // is never the directory the person is working in.
    const { router, calls } = harness({
      invoke: () => ({ session: { id: HOSTED_ID } }),
      workspaceRoot: 'project',
    });
    const outcome = await router.submit('hello');
    expect(outcome.routed).toBe(false);
    if (outcome.routed) throw new Error('unreachable');
    expect(outcome.reason).toContain('absolute');
    expect(calls).toHaveLength(0);
  });

  test('attachments keep the turn local rather than being silently dropped', async () => {
    const { router, calls } = harness({ invoke: () => ({ session: { id: HOSTED_ID } }) });
    const outcome = await router.submit('look at this', { hasAttachments: true });
    expect(outcome.routed).toBe(false);
    if (outcome.routed) throw new Error('unreachable');
    expect(outcome.reason).toContain('attachments');
    expect(calls).toHaveLength(0);
  });
});

describe('the setting that forces every turn to run locally', () => {
  test('routeConversationTurns off routes nothing and dials nothing', async () => {
    const { router, calls } = harness({
      invoke: () => ({ session: { id: HOSTED_ID } }),
      routeTurns: false,
    });

    const outcome = await router.submit('hello');

    expect(outcome.routed).toBe(false);
    if (outcome.routed) throw new Error('unreachable');
    expect(outcome.reason).toBe(ROUTING_DISABLED_REASON);
    // `chosen` is what stops the surface warning about a state the person asked for.
    expect(outcome.chosen).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('routing is on when the setting is absent: on by default, per the ruling', async () => {
    const router = createRemoteConversationRouter({
      verbs: {
        probe: () => ({ available: true }),
        invoke: async <T,>(): Promise<T> => ({ session: { id: HOSTED_ID } } as T),
      },
      // A config that answers `undefined` for everything: nothing configured.
      configManager: { get: (() => undefined) as never },
      resolveConnection: () => LIVE_HOST,
      conversation: inertConversation(),
      requestRender: () => {},
      workspaceRoot: '/home/someone/project',
      clientId: 'goodvibes-agent:test',
      fetchImpl: stubStreamFetch(),
    });

    expect((await router.submit('hello')).routed).toBe(true);
  });
});

describe('the hosted session event stream address', () => {
  test('is the per-session events route on the connected host', () => {
    expect(hostedSessionEventStreamUrl('http://127.0.0.1:3421', 'hosted-abc'))
      .toBe('http://127.0.0.1:3421/api/sessions/hosted-abc/events');
  });

  test('escapes a session id rather than letting it shape the path', () => {
    expect(hostedSessionEventStreamUrl('http://127.0.0.1:3421', 'a/b'))
      .toBe('http://127.0.0.1:3421/api/sessions/a%2Fb/events');
  });
});
