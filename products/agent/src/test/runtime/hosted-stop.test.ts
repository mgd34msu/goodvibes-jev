/**
 * Hosted Stop is a request against an observed execution identity. Exercise
 * the public operator client over real loopback HTTP and SSE: accepting that
 * request must not masquerade as the daemon finishing the turn.
 *
 * These are caller acceptance tests. The fixture deliberately does not model
 * backend execution admission, and cannot establish that admission is safe.
 */
import { describe, expect, test } from 'bun:test';
import type { OperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
import {
  createRemoteConversationRouter,
  type RemoteTurnOutcome,
} from '../../runtime/client/remote-conversation.ts';
import { ConnectedHostVerbError } from '../../runtime/client/daemon-verbs.ts';
import type {
  HostedFrameConversation,
  HostedSessionFrame,
  HostedTurnCompletion,
} from '../../runtime/client/hosted-frame-render.ts';
import {
  cancelConversationGeneration,
  installRemoteConversationRouting,
} from '../../shell/remote-conversation-wiring.ts';

// Derive the fixture's receipt from the actual exported SDK contract.
type CancelReceipt = Awaited<ReturnType<OperatorSdk['sessions']['turns']['cancel']>>;
type CancelStatus = CancelReceipt['status'];
const SESSION = 'hosted-stop-fixture';
const TOKEN = 'synthetic-loopback-stop-token';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Bounded observation of a condition, never a sleep chosen to win a race. */
async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(5);
  }
}

function observe(completion: Promise<HostedTurnCompletion>) {
  const state: { value?: HostedTurnCompletion } = {};
  void completion.then((value) => { state.value = value; });
  return state;
}

function routed(outcome: RemoteTurnOutcome): Extract<RemoteTurnOutcome, { routed: true }> {
  expect(outcome.routed).toBe(true);
  if (!outcome.routed) throw new Error(outcome.reason);
  return outcome;
}

interface CancelCall {
  readonly pathname: string;
  readonly body: Record<string, unknown>;
  readonly authorization: string | null;
}

interface EventStream {
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  readonly position: string | null;
  detached: boolean;
  closedByServer: boolean;
}

function fixture(options: { readonly reconnect?: boolean; readonly routeTurns?: boolean } = {}) {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const cancellations: CancelCall[] = [];
  const unexpected: string[] = [];
  const streams: EventStream[] = [];
  const frames: HostedSessionFrame[] = [];
  const cancelAttempts: string[] = [];
  const notices: string[] = [];
  const users: string[] = [];
  const assistant: string[] = [];
  const system: string[] = [];
  const encoder = new TextEncoder();
  const gates: { resolve: (value: void) => void }[] = [];
  let sequence = 0;
  let probeSequence = 0;
  const behavior = {
    create: async (): Promise<Response> => Response.json({ session: { id: SESSION } }),
    steer: async (): Promise<Response> => Response.json({}),
    cancel: async (call: CancelCall): Promise<Response> => receipt(call, 'cancellation-requested'),
    notice: (_message: string): void => {},
    frame: (_frame: HostedSessionFrame): void => {},
    stream: (): void => {},
  };

  function receipt(call: CancelCall, status: CancelStatus, activeTurnId?: string): Response {
    const result: CancelReceipt = {
      sessionId: SESSION,
      expectedTurnId: String(call.body.expectedTurnId),
      status,
      ...(activeTurnId ? { activeTurnId } : {}),
    };
    return Response.json(result);
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === `/api/sessions/${SESSION}/events`) {
        let active: EventStream | undefined;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const stream: EventStream = {
              controller,
              position: request.headers.get('Last-Event-ID'),
              detached: false,
              closedByServer: false,
            };
            active = stream;
            streams.push(stream);
            request.signal.addEventListener('abort', () => { stream.detached = true; });
            controller.enqueue(encoder.encode(': fixture connected\n\n'));
            behavior.stream();
          },
          cancel() {
            if (active) active.detached = true;
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (request.method === 'POST' && path === `/api/sessions/${SESSION}/turns/cancel`) {
        const call: CancelCall = {
          pathname: path,
          body: await request.json() as Record<string, unknown>,
          authorization: request.headers.get('Authorization'),
        };
        cancellations.push(call);
        return behavior.cancel(call);
      }
      if (request.method === 'POST' && path === '/fixture/verbs') {
        const call = await request.json() as { method: string; input: Record<string, unknown> };
        calls.push(call);
        if (call.method === 'sessions.hosted.create') return behavior.create();
        if (call.method === 'sessions.steer') return behavior.steer();
        if (call.method === 'sessions.hosted.list') return Response.json({ sessions: [] });
        if (call.method === 'sessions.hosted.attach') {
          // No persistence side effects are needed to test Stop.
          return Response.json({ session: { id: SESSION }, history: [] });
        }
        unexpected.push(call.method);
        return new Response('unexpected fixture verb', { status: 404 });
      }
      unexpected.push(`${request.method} ${path}`);
      return new Response('unexpected fixture route', { status: 404 });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  let connection = { baseUrl, token: TOKEN };
  const conversation: HostedFrameConversation & { addUserMessage(text: string): void } = {
    addUserMessage: (text) => { users.push(text); },
    addAssistantMessage: (text) => { assistant.push(text); },
    addSystemMessage: (text) => { system.push(text); },
    addToolResults() {},
    startStreamingBlock() {},
    updateStreamingBlock() {},
    finalizeStreamingBlock() {},
  };
  const verbs = {
    probe: () => ({ available: true as const }),
    invoke: async <T,>(method: string, input: unknown = {}): Promise<T> => {
      const response = await fetch(`${baseUrl}/fixture/verbs`, {
        method: 'POST', body: JSON.stringify({ method, input }),
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) throw new ConnectedHostVerbError(await response.text(), response.status);
      return response.json() as Promise<T>;
    },
  };
  const configManager = { get: (() => options.routeTurns ?? true) as never };
  const router = createRemoteConversationRouter({
    verbs, configManager, resolveConnection: () => connection,
    conversation, requestRender() {}, workspaceRoot: '/synthetic/hosted-stop',
    clientId: 'goodvibes-agent:hosted-stop-test',
    fetchImpl: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/turns/cancel')) cancelAttempts.push(url.pathname);
      return fetch(input, init);
    }, { preconnect: fetch.preconnect }),
    onFrame: (frame) => { frames.push(frame); behavior.frame(frame); },
    onCancellationNotice: (message) => { notices.push(message); behavior.notice(message); },
    reconnect: { enabled: options.reconnect ?? false },
  });
  const disposers = [() => router.dispose()];

  function send(type: string, turnId?: string, fields: Record<string, unknown> = {}, sessionId: string | null = SESSION) {
    const stream = streams.at(-1);
    if (!stream || stream.detached || stream.closedByServer) throw new Error('No live fixture SSE stream');
    sequence += 1;
    const frame: HostedSessionFrame = {
      type,
      ...(sessionId === null ? {} : { sessionId }),
      payload: { type, ...(turnId ? { turnId } : {}),
        ...(type === 'TURN_SUBMITTED' && !('origin' in fields) ? {
          origin: { source: 'hosted-session', surface: 'service', metadata: calls.findLast(call => call.method === 'sessions.steer')?.input.metadata },
        } : {}), ...fields },
    };
    stream.controller.enqueue(encoder.encode(`id: evt-${sequence}\nevent: turn\ndata: ${JSON.stringify(frame)}\n\n`));
    return `evt-${sequence}`;
  }

  async function barrier(): Promise<void> {
    const probe = ++probeSequence;
    send('FIXTURE_BARRIER', undefined, { probe });
    await until(() => frames.some((frame) => frame.payload?.probe === probe), 'SSE processing barrier');
  }

  function wiring() {
    const state = { isThinking: false, thinkingFrame: 0, streamingInputTokens: 0, streamingOutputTokens: 0 };
    let aborts = 0;
    let renders = 0;
    const context = {
      orchestrator: { ...state, abort: () => { aborts += 1; } },
      runtime: { sessionId: 'local-fixture', model: 'fixture', provider: 'fixture' },
      runtimeBus: { emit() {} },
      conversation,
      services: {
        configManager, workingDirectory: '/synthetic/hosted-stop',
        sessionManager: { list: () => [] },
        resolveConnectedHost: () => connection, daemonVerbs: verbs,
      },
    } as unknown as BootstrapContext;
    const installed = installRemoteConversationRouting(context, {
      render: () => { renders += 1; }, notify: (message) => { notices.push(message); },
      onFrame: (frame) => { frames.push(frame); behavior.frame(frame); },
    });
    disposers.push(() => installed.dispose());
    return { installed, state: context.orchestrator, aborts: () => aborts, renders: () => renders };
  }

  return {
    router, wiring, calls, cancellations, cancelAttempts, unexpected, streams, frames, notices,
    users, assistant, system, behavior, receipt, send, barrier,
    changeConnection: (next: typeof connection) => { connection = next; },
    correlationId: () => (calls.findLast(call => call.method === 'sessions.steer')?.input.metadata as { correlationId?: string } | undefined)?.correlationId,
    hold() {
      const gate = deferred<void>();
      gates.push(gate);
      return gate;
    },
    async start(turnId = 'turn-1') {
      const outcome = routed(await router.submit('fixture work'));
      send('TURN_SUBMITTED', turnId, { prompt: 'fixture work' });
      await barrier();
      return { outcome, completion: observe(outcome.completion) };
    },
    closeStream() {
      const stream = streams.at(-1);
      if (!stream) throw new Error('No fixture stream to close');
      stream.closedByServer = true;
      stream.controller.close();
    },
    dispose() {
      for (const gate of gates) gate.resolve();
      for (const dispose of disposers) dispose();
      server.stop(true);
      expect(unexpected).toEqual([]);
    },
  };
}

describe('hosted Stop over the native operator REST contract', () => {
  test('keeps the stream and partial answer pending until the exact turn is cancelled, then reuses the session', async () => {
    const f = fixture();
    try {
      const { outcome, completion } = await f.start();
      f.send('STREAM_DELTA', 'turn-1', { accumulated: 'partial answer' });
      await f.barrier();
      expect(f.router.cancelTurn()).toBe(true);
      await until(() => f.cancellations.length === 1, 'cancellation request');
      await until(() => f.notices.some((notice) => /accepted/i.test(notice)), 'accepted but pending notice');
      await f.barrier();
      expect(f.cancellations[0]).toEqual({
        pathname: `/api/sessions/${SESSION}/turns/cancel`,
        body: { expectedTurnId: 'turn-1' }, authorization: `Bearer ${TOKEN}`,
      });
      expect(completion.value).toBeUndefined();
      expect(f.streams[0]?.detached).toBe(false);
      f.send('TURN_CANCEL', 'other-turn', { reason: 'unrelated cancellation' });
      f.send('TURN_CANCEL', 'turn-1', {}, 'another-session');
      f.send('TURN_CANCEL', undefined, { reason: 'unidentified cancellation' });
      await f.barrier();
      expect(completion.value).toBeUndefined();
      f.send('TURN_CANCEL', 'turn-1', { reason: 'user stopped', stopReason: 'cancelled' });
      expect(await outcome.completion).toMatchObject({ status: 'cancelled', response: 'partial answer' });
      expect(f.assistant).toContain('partial answer');
      expect(f.router.cancelTurn()).toBe(false);
      expect(f.router.hostedSessionId()).toBe(SESSION);
      const next = routed(await f.router.submit('next message'));
      expect(next.action).toBe('steered');
      expect(f.calls.filter((call) => call.method === 'sessions.hosted.create')).toHaveLength(1);
      f.send('TURN_SUBMITTED', 'turn-2', { prompt: 'next message' });
      f.send('TURN_COMPLETED', 'turn-2', { stopReason: 'completed' });
      expect((await next.completion).status).toBe('completed');
    } finally { f.dispose(); }
  });

  test('coalesces repeated Stop while the request is held and after acceptance', async () => {
    const f = fixture();
    const held = f.hold();
    f.behavior.cancel = async (call) => { await held.promise; return f.receipt(call, 'cancellation-requested'); };
    try {
      const { completion } = await f.start();
      expect(f.router.cancelTurn()).toBe(true);
      await until(() => f.cancellations.length === 1, 'held cancellation request');
      expect(f.router.cancelTurn()).toBe(true);
      expect(f.router.cancelTurn()).toBe(true);
      await f.barrier();
      expect(f.cancellations).toHaveLength(1);
      expect(completion.value).toBeUndefined();
      held.resolve();
      await until(() => f.notices.some((notice) => /requested|accepted/i.test(notice)), 'accepted cancellation notice');
      expect(f.router.cancelTurn()).toBe(true);
      await f.barrier();
      expect(f.cancellations).toHaveLength(1);
      expect(completion.value).toBeUndefined();
    } finally { f.dispose(); }
  });

  test('coalesces Stop called synchronously by the requesting and accepted notice observers', async () => {
    const f = fixture();
    const reentrantStops: boolean[] = [];
    f.behavior.notice = () => {
      reentrantStops.push(f.router.cancelTurn());
    };
    try {
      const { completion } = await f.start();
      expect(f.router.cancelTurn()).toBe(true);
      await until(() => reentrantStops.length >= 2, 'requesting and accepted observers');
      await f.barrier();
      expect(reentrantStops).toEqual([true, true]);
      expect(f.cancellations).toHaveLength(1);
      expect(completion.value).toBeUndefined();
    } finally { f.dispose(); }
  });

  for (const action of ['dispose', 'replace'] as const) {
    test(`an observer that synchronously ${action}s the router cannot launch the old cancellation afterward`, async () => {
      const f = fixture();
      let replacement: Promise<RemoteTurnOutcome> | undefined;
      f.behavior.notice = () => {
        if (action === 'dispose') f.router.dispose();
        else replacement = f.router.submit('replacement from notice');
      };
      try {
        const { outcome } = await f.start();
        expect(f.router.cancelTurn()).toBe(true);
        expect((await outcome.completion).status).toBe('abandoned');
        if (action === 'replace') {
          expect(replacement).toBeDefined();
          const next = routed(await replacement!);
          const completion = observe(next.completion);
          f.send('TURN_SUBMITTED', 'replacement-execution', { prompt: 'replacement from notice' });
          await f.barrier();
          expect(completion.value).toBeUndefined();
        } else {
          await until(() => f.streams[0]?.detached === true, 'observer-disposed stream disconnects');
          expect(f.router.cancelTurn()).toBe(false);
        }
        expect(f.cancellations).toHaveLength(0);
      } finally { f.dispose(); }
    });
  }

  test('captures identity only from an explicitly scoped TURN_SUBMITTED, not tools or a foreign session', async () => {
    const f = fixture();
    try {
      const outcome = routed(await f.router.submit('waiting for identity'));
      const completion = observe(outcome.completion);
      f.send('TOOL_EXECUTING', 'tool-or-ui-id', { callId: 'call-1', tool: 'synthetic' });
      f.send('TURN_SUBMITTED', 'foreign-turn', {}, 'foreign-session');
      f.send('TURN_SUBMITTED', 'unscoped-turn', {}, null);
      await f.barrier();
      expect(f.router.cancelTurn()).toBe(true);
      await f.barrier();
      expect(f.cancellations).toHaveLength(0);
      expect(f.notices.join('\n')).toMatch(/identity|turn id|submission|submitted/i);
      f.send('TURN_SUBMITTED', 'actual-execution', { prompt: 'waiting for identity' });
      await until(() => f.cancellations.length === 1, 'identity-bound cancellation');
      expect(f.cancellations[0]?.body).toEqual({ expectedTurnId: 'actual-execution' });
      expect(completion.value).toBeUndefined();
    } finally { f.dispose(); }
  });

  for (const status of ['already-ended', 'stale-turn', 'turn-not-found'] as const) {
    test(`reports ${status} truthfully without inventing a terminal event or retargeting`, async () => {
      const f = fixture();
      f.behavior.cancel = async (call) => f.receipt(call, status, status === 'stale-turn' ? 'newer-turn' : undefined);
      try {
        const { completion } = await f.start();
        expect(f.router.cancelTurn()).toBe(true);
        const message = status === 'already-ended' ? /already.*end|ended/i
          : status === 'stale-turn' ? /stale|different.*turn|another.*turn/i : /not.found|unknown|could not.*find/i;
        await until(() => f.notices.some((notice) => message.test(notice)), `${status} notice`);
        await f.barrier();
        expect(completion.value).toBeUndefined();
        expect(f.streams[0]?.detached).toBe(false);
        expect(f.cancellations.map((call) => call.body)).toEqual([{ expectedTurnId: 'turn-1' }]);
      } finally { f.dispose(); }
    });
  }

  for (const failure of ['refusal', 'lost reply'] as const) {
    test(`makes ${failure} visible and retries only the same captured identity on a later Stop`, async () => {
      const f = fixture();
      f.behavior.cancel = async (call) => f.cancellations.length === 1
        ? failure === 'refusal'
          ? Response.json({ error: { code: 'FORBIDDEN', message: 'fixture policy refused cancellation' } }, { status: 403 })
          // A response cut off before valid JSON is a lost/unusable receipt.
          : new Response('{"sessionId":', { headers: { 'content-type': 'application/json' } })
        : f.receipt(call, 'cancellation-requested');
      try {
        const { completion } = await f.start();
        expect(f.router.cancelTurn()).toBe(true);
        await until(() => f.notices.some((notice) => /could not|unable|failed|unconfirmed|not confirmed|refused/i.test(notice)), `${failure} notice`);
        await f.barrier();
        expect(f.cancellations).toHaveLength(1);
        expect(completion.value).toBeUndefined();
        expect(f.streams[0]?.detached).toBe(false);
        // Later traffic and changing connection resolution cannot change the
        // identity or credentials of this already-owned turn's retry.
        f.send('TURN_SUBMITTED', 'newer-unowned-turn', { prompt: 'not ours' });
        await f.barrier();
        f.changeConnection({ baseUrl: 'http://127.0.0.1:1', token: 'must-not-be-used' });
        expect(f.router.cancelTurn()).toBe(true);
        await until(() => f.cancellations.length === 2, 'explicit retry against original target');
        expect(f.cancellations.map((call) => call.body)).toEqual([
          { expectedTurnId: 'turn-1' }, { expectedTurnId: 'turn-1' },
        ]);
        expect(f.cancellations.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
      } finally { f.dispose(); }
    });
  }

  test('a structurally valid receipt for a different identity cannot acknowledge this cancellation', async () => {
    const f = fixture();
    f.behavior.cancel = async (call) => f.cancellations.length === 1
      ? Response.json({ sessionId: SESSION, expectedTurnId: 'another-turn', status: 'cancellation-requested' } satisfies CancelReceipt)
      : f.receipt(call, 'cancellation-requested');
    try {
      const { completion } = await f.start();
      f.router.cancelTurn();
      await until(() => f.notices.some((notice) => /not.*match|mismatch/i.test(notice)), 'mismatched receipt warning');
      expect(completion.value).toBeUndefined();
      expect(f.streams[0]?.detached).toBe(false);
      expect(f.router.cancelTurn()).toBe(true);
      await until(() => f.cancellations.length === 2, 'explicit retry after mismatched receipt');
      expect(f.cancellations.map((call) => call.body.expectedTurnId)).toEqual(['turn-1', 'turn-1']);
    } finally { f.dispose(); }
  });

  for (const terminal of ['PREFLIGHT_FAIL', 'TURN_ERROR'] as const) {
    test(`${terminal} settles the matching turn as an error even when Stop was requested`, async () => {
      const f = fixture();
      try {
        const { outcome, completion } = await f.start();
        f.router.cancelTurn();
        await until(() => f.cancellations.length === 1, 'cancellation before failure');
        f.send(terminal, 'unrelated-turn', terminal === 'PREFLIGHT_FAIL'
          ? { reason: 'not this execution' } : { error: 'not this execution' });
        await f.barrier();
        expect(completion.value).toBeUndefined();
        const error = terminal === 'PREFLIGHT_FAIL' ? 'fixture preflight refused' : 'fixture execution failed';
        f.send(terminal, 'turn-1', terminal === 'PREFLIGHT_FAIL'
          ? { reason: error, stopReason: 'preflight_failed' }
          : { error, stopReason: 'provider_error' });
        expect(await outcome.completion).toMatchObject({ status: 'error', error });
        expect(f.system.some((message) => message.includes(error))).toBe(true);
        expect(f.router.cancelTurn()).toBe(false);
      } finally { f.dispose(); }
    });
  }

  test('natural completion wins a race with a delayed cancellation receipt', async () => {
    const f = fixture();
    const held = f.hold();
    f.behavior.cancel = async (call) => { await held.promise; return f.receipt(call, 'cancellation-requested'); };
    try {
      const { outcome } = await f.start();
      f.router.cancelTurn();
      await until(() => f.cancellations.length === 1, 'held cancellation');
      f.send('TURN_COMPLETED', 'turn-1', { stopReason: 'completed' });
      expect((await outcome.completion).status).toBe('completed');
      const noticesAtCompletion = [...f.notices];
      held.resolve();
      const next = routed(await f.router.submit('second turn'));
      f.send('TURN_SUBMITTED', 'turn-2', { prompt: 'second turn' });
      await f.barrier();
      expect(f.notices).toEqual(noticesAtCompletion);
      const completion = observe(next.completion);
      expect(completion.value).toBeUndefined();
      expect(f.router.cancelTurn()).toBe(true);
      await until(() => f.cancellations.length === 2, 'new turn cancellation');
      expect(f.cancellations[1]?.body).toEqual({ expectedTurnId: 'turn-2' });
    } finally { f.dispose(); }
  });

  test('abandons a replaced watcher honestly and ignores its late receipt while a new turn stays pending', async () => {
    const f = fixture();
    const held = f.hold();
    f.behavior.cancel = async (call) => { await held.promise; return f.receipt(call, 'already-ended'); };
    try {
      const first = await f.start();
      f.router.cancelTurn();
      await until(() => f.cancellations.length === 1, 'old turn cancellation');
      const second = routed(await f.router.submit('replacement turn'));
      expect((await first.outcome.completion).status).toBe('abandoned');
      f.send('TURN_SUBMITTED', 'turn-2', { prompt: 'replacement turn' });
      await f.barrier();
      const noticeCount = f.notices.length;
      const completion = observe(second.completion);
      held.resolve();
      await f.barrier();
      expect(completion.value).toBeUndefined();
      expect(f.notices).toHaveLength(noticeCount);
      expect(f.cancellations).toHaveLength(1);
    } finally { f.dispose(); }
  });

  test('closing a pending stream without reconnect settles abandonment, never cancellation', async () => {
    const f = fixture();
    try {
      const { outcome } = await f.start();
      f.router.cancelTurn();
      await until(() => f.cancellations.length === 1, 'cancellation before close');
      f.closeStream();
      const completion = await outcome.completion;
      expect(completion.status).toBe('abandoned');
      expect(completion.error).toMatch(/connection|stream/i);
      expect(f.router.cancelTurn()).toBe(false);
      expect(f.router.hostedSessionId()).toBe(SESSION);
    } finally { f.dispose(); }
  });

  test('reconnect resumes the pending target and waits for its matching terminal frame', async () => {
    const f = fixture({ reconnect: true });
    try {
      const { outcome, completion } = await f.start();
      f.router.cancelTurn();
      await until(() => f.cancellations.length === 1, 'cancellation before reconnect');
      const lastId = f.send('STREAM_DELTA', 'turn-1', { accumulated: 'before reconnect' });
      await until(() => f.frames.some((frame) => frame.payload?.accumulated === 'before reconnect'), 'last frame before reconnect');
      f.closeStream();
      await until(() => f.streams.length === 2, 'SSE reconnect');
      expect(f.streams[1]?.position).toBe(lastId);
      expect(completion.value).toBeUndefined();
      expect(f.cancellations).toHaveLength(1);
      f.send('TURN_CANCEL', 'other-turn');
      await f.barrier();
      expect(completion.value).toBeUndefined();
      f.send('TURN_CANCEL', 'turn-1', { reason: 'stopped after reconnect' });
      expect(await outcome.completion).toMatchObject({ status: 'cancelled', response: 'before reconnect' });
    } finally { f.dispose(); }
  });

  test('dispose detaches and settles its observer without sending Stop or killing the session', async () => {
    const f = fixture();
    try {
      const { outcome } = await f.start();
      f.router.dispose();
      expect((await outcome.completion).status).toBe('abandoned');
      await until(() => f.streams[0]?.detached === true, 'disposed SSE observer disconnects');
      expect(f.router.cancelTurn()).toBe(false);
      expect(f.cancellations).toHaveLength(0);
      expect(f.calls.map((call) => call.method)).toEqual(['sessions.hosted.create', 'sessions.steer']);
    } finally { f.dispose(); }
  });
});

describe('Stop during hosted admission and shell activity', () => {
  test('Stop during create suppresses steer and explicitly prevents a local fallback', async () => {
    const f = fixture();
    const held = f.hold();
    f.behavior.create = async () => { await held.promise; return Response.json({ session: { id: SESSION } }); };
    try {
      const submitting = f.router.submit('stop before admission');
      await until(() => f.calls.some((call) => call.method === 'sessions.hosted.create'), 'held create');
      expect(f.router.cancelTurn()).toBe(true);
      expect(f.cancellations).toHaveLength(0);
      held.resolve();
      expect(await submitting).toMatchObject({ routed: false, chosen: true, cancelled: true });
      expect(f.calls.filter((call) => call.method === 'sessions.steer')).toHaveLength(0);
      expect(f.router.cancelTurn()).toBe(false);
    } finally { f.dispose(); }
  });

  test('Stop during a held steer waits for the admitted identity and keeps the routed completion pending', async () => {
    const f = fixture();
    const held = f.hold();
    f.behavior.steer = async () => { await held.promise; return Response.json({}); };
    try {
      const submitting = f.router.submit('steer pending');
      await until(() => f.calls.some((call) => call.method === 'sessions.steer'), 'held steer');
      expect(f.router.cancelTurn()).toBe(true);
      await f.barrier();
      expect(f.cancellations).toHaveLength(0);
      f.send('TURN_SUBMITTED', 'admitted-during-steer', { prompt: 'steer pending' });
      await until(() => f.cancellations.length === 1, 'cancel after admitted identity');
      expect(f.cancellations[0]?.body).toEqual({ expectedTurnId: 'admitted-during-steer' });
      held.resolve();
      const outcome = routed(await submitting);
      const completion = observe(outcome.completion);
      await f.barrier();
      expect(completion.value).toBeUndefined();
      f.send('TURN_CANCEL', 'admitted-during-steer', { reason: 'stopped' });
      expect((await outcome.completion).status).toBe('cancelled');
    } finally { f.dispose(); }
  });

  test('a refused steer after Stop cannot start a fresh local or recreated turn', async () => {
    const f = fixture();
    const held = f.hold();
    f.behavior.steer = async () => { await held.promise; return new Response('fixture refused admission', { status: 409 }); };
    try {
      const submitting = f.router.submit('stopped then refused');
      await until(() => f.calls.some((call) => call.method === 'sessions.steer'), 'held refused steer');
      expect(f.router.cancelTurn()).toBe(true);
      held.resolve();
      // Steer was attempted, so even a refused/lost reply cannot prove the
      // message never ran. A handled, abandoned result prevents local replay
      // without claiming cancellation or absence of remote side effects.
      const outcome = routed(await submitting);
      expect(await outcome.completion).toMatchObject({ status: 'abandoned' });
      expect((await outcome.completion).error).toMatch(/unconfirmed/i);
      expect(f.calls.filter((call) => call.method === 'sessions.hosted.create')).toHaveLength(1);
      expect(f.cancellations).toHaveLength(0);
    } finally { f.dispose(); }
  });

  test('wired hosted Stop keeps busy visible and does not abort the local orchestrator', async () => {
    const f = fixture();
    const wired = f.wiring();
    try {
      const handle = await wired.installed.routeOrExplain('wired work', false);
      expect(handle).not.toBeNull();
      f.send('TURN_SUBMITTED', 'wired-turn', { prompt: 'wired work' });
      await f.barrier();
      expect(wired.state.isThinking).toBe(true);
      expect(wired.installed.cancelHostedTurn()).toBe(true);
      await until(() => f.cancellations.length === 1, 'wired cancellation request');
      await until(() => f.notices.some((notice) => /accepted/i.test(notice)), 'wired acceptance notice');
      await f.barrier();
      expect(wired.state.isThinking).toBe(true);
      expect(wired.aborts()).toBe(0);
      expect(f.notices.join('\n')).toMatch(/pending|waiting|requested/i);
      f.send('TURN_CANCEL', 'wired-turn', { reason: 'user stop' });
      expect((await handle!.completion).status).toBe('cancelled');
      await until(() => !wired.state.isThinking, 'terminal clears busy state');
      expect(wired.installed.cancelHostedTurn()).toBe(false);
    } finally { f.dispose(); }
  });

  test('a pre-admission wired Stop returns a handled cancellation instead of permission to run locally', async () => {
    const f = fixture();
    const held = f.hold();
    const wired = f.wiring();
    f.behavior.create = async () => { await held.promise; return Response.json({ session: { id: SESSION } }); };
    try {
      const submitting = wired.installed.routeOrExplain('never admitted', false);
      await until(() => f.calls.some((call) => call.method === 'sessions.hosted.create'), 'wired held create');
      expect(wired.state.isThinking).toBe(true);
      expect(wired.installed.cancelHostedTurn()).toBe(true);
      held.resolve();
      const handle = await submitting;
      expect(handle).not.toBeNull();
      expect(await handle!.completion).toMatchObject({ status: 'cancelled', stopReason: 'cancelled_before_submission' });
      await until(() => !wired.state.isThinking, 'cancelled admission clears busy state');
      expect(wired.aborts()).toBe(0);
      expect(f.calls.filter((call) => call.method === 'sessions.steer')).toHaveLength(0);
    } finally { f.dispose(); }
  });

  test('disposing wiring during create handles the late reply without UI mutation or local fallback', async () => {
    const f = fixture();
    const held = f.hold();
    const wired = f.wiring();
    f.behavior.create = async () => { await held.promise; return Response.json({ session: { id: SESSION } }); };
    try {
      const submitting = wired.installed.routeOrExplain('disposed before create replied', false);
      await until(() => f.calls.some((call) => call.method === 'sessions.hosted.create'), 'create before wiring disposal');
      wired.installed.dispose();
      const renderCount = wired.renders();
      const notices = [...f.notices];
      const users = [...f.users];
      held.resolve();
      const handle = await submitting;
      expect(handle).not.toBeNull();
      expect(await handle!.completion).toMatchObject({ status: 'abandoned', stopReason: 'observer_detached' });
      expect(wired.renders()).toBe(renderCount);
      expect(f.notices).toEqual(notices);
      expect(f.users).toEqual(users);
      expect(wired.state.isThinking).toBe(false);
      expect(wired.aborts()).toBe(0);
      expect(f.calls.filter((call) => call.method === 'sessions.steer')).toHaveLength(0);
      expect(f.cancellations).toHaveLength(0);
      expect(f.streams).toHaveLength(0);
    } finally { f.dispose(); }
  });

  test('an older wired completion or cancellation receipt cannot clear a newer turn\'s busy state', async () => {
    const f = fixture();
    const held = f.hold();
    const wired = f.wiring();
    f.behavior.cancel = async (call) => { await held.promise; return f.receipt(call, 'already-ended'); };
    try {
      const first = await wired.installed.routeOrExplain('first wired turn', false);
      f.send('TURN_SUBMITTED', 'first-wired', { prompt: 'first wired turn' });
      await f.barrier();
      wired.installed.cancelHostedTurn();
      await until(() => f.cancellations.length === 1, 'held first wired cancellation');
      const second = await wired.installed.routeOrExplain('second wired turn', false);
      expect((await first!.completion).status).toBe('abandoned');
      f.send('TURN_SUBMITTED', 'second-wired', { prompt: 'second wired turn' });
      await f.barrier();
      const noticeCount = f.notices.length;
      held.resolve();
      await f.barrier();
      expect(wired.state.isThinking).toBe(true);
      expect(f.notices).toHaveLength(noticeCount);
      f.send('TURN_COMPLETED', 'second-wired', { stopReason: 'completed' });
      expect((await second!.completion).status).toBe('completed');
      await until(() => !wired.state.isThinking, 'new wired turn terminal clears busy state');
    } finally { f.dispose(); }
  });

  test('hosted ownership is false for a local turn and does not clear its busy state', async () => {
    const f = fixture({ routeTurns: false });
    const wired = f.wiring();
    try {
      expect(await wired.installed.routeOrExplain('local work', false)).toBeNull();
      wired.state.isThinking = true;
      expect(wired.installed.cancelHostedTurn()).toBe(false);
      expect(wired.state.isThinking).toBe(true);
      expect(wired.aborts()).toBe(0);
      expect(f.cancellations).toHaveLength(0);
    } finally { f.dispose(); }
  });

  test('the interactive cancellation handler gives hosted ownership priority and still aborts local generation', () => {
    let localAborts = 0;
    let hostedStops = 0;
    let hostedOwnsTurn = true;
    const local = { isThinking: true, abort: () => { localAborts += 1; } };
    const remote = { cancelHostedTurn: () => { hostedStops += 1; return hostedOwnsTurn; } };
    cancelConversationGeneration(local, remote);
    expect(hostedStops).toBe(1);
    expect(localAborts).toBe(0);
    hostedOwnsTurn = false;
    cancelConversationGeneration(local, remote);
    expect(localAborts).toBe(1);
    local.isThinking = false;
    cancelConversationGeneration(local, remote);
    expect(hostedStops).toBe(3);
    expect(localAborts).toBe(1);
  });
});

describe('hosted ownership handoff regressions', () => {
  test('a new attachment/local turn relinquishes the previous hosted Escape owner', async () => {
    const f = fixture();
    const wired = f.wiring();
    try {
      const first = await wired.installed.routeOrExplain('hosted task', false);
      f.send('TURN_SUBMITTED', 'older-hosted-turn', { prompt: 'hosted task' });
      await f.barrier();
      expect(await wired.installed.routeOrExplain('new local attachment task', true)).toBeNull();
      // This is the local orchestrator beginning the explicitly local fallback.
      wired.state.isThinking = true;
      cancelConversationGeneration(wired.state, wired.installed);
      await until(() => wired.aborts() > 0 || f.cancellations.length > 0, 'Stop ownership verdict');
      expect({ localAborts: wired.aborts(), cancelTargets: f.cancellations.map((c) => c.body.expectedTurnId) }).toEqual({ localAborts: 1, cancelTargets: [] });
    } finally { f.dispose(); }
  });

  test('STREAM_END is not a hosted turn terminal', async () => {
    const f = fixture();
    try {
      const { outcome, completion } = await f.start();
      f.router.cancelTurn();
      await until(() => f.cancellations.length === 1, 'cancellation request');
      f.send('STREAM_END', 'turn-1');
      await f.barrier();
      expect(completion.value).toBeUndefined();
      expect(f.streams[0]?.detached).toBe(false);
      f.send('TURN_CANCEL', 'turn-1');
      expect((await outcome.completion).status).toBe('cancelled');
    } finally { f.dispose(); }
  });
});


test('a terminal-frame observer microtask retains hosted Escape ownership until activity clears', async () => {
  const f = fixture();
  const wired = f.wiring();
  let abortsAtEscape: number | undefined;
  try {
    const handle = await wired.installed.routeOrExplain('hosted terminal race', false);
    f.send('TURN_SUBMITTED', 'terminal-race', { prompt: 'hosted terminal race' });
    await f.barrier();
    f.behavior.frame = (frame) => {
      if (frame.type === 'TURN_COMPLETED') queueMicrotask(() => {
        cancelConversationGeneration(wired.state, wired.installed);
        abortsAtEscape = wired.aborts();
      });
    };
    f.send('TURN_COMPLETED', 'terminal-race', { response: 'done' });
    expect((await handle!.completion).status).toBe('completed');
    await until(() => abortsAtEscape !== undefined, 'terminal observer Escape');
    expect(abortsAtEscape).toBe(0);
  } finally { f.dispose(); }
});

test('a completed hosted turn with a held steer response still owns its shell activity', async () => {
  const f = fixture();
  const wired = f.wiring();
  const held = f.hold();
  f.behavior.steer = async () => { await held.promise; return Response.json({}); };
  try {
    const submitting = wired.installed.routeOrExplain('terminal before steer reply', false);
    await until(() => f.calls.some((c) => c.method === 'sessions.steer'), 'held steer');
    f.send('TURN_SUBMITTED', 'held-steer-turn', { prompt: 'terminal before steer reply' });
    f.send('TURN_COMPLETED', 'held-steer-turn', { response: 'finished remotely' });
    await until(() => f.frames.some((frame) => frame.type === 'TURN_COMPLETED'), 'observed terminal');
    expect(wired.state.isThinking).toBe(true);
    cancelConversationGeneration(wired.state, wired.installed);
    expect(wired.aborts()).toBe(0);
    held.resolve();
    const handle = await submitting;
    expect((await handle!.completion).status).toBe('completed');
  } finally { f.dispose(); }
});

test('a superseded hosted reply still mirrors its terminal outcome without ending the newer activity', async () => {
  const f = fixture();
  const wired = f.wiring();
  const held = f.hold();
  f.behavior.steer = async () => { await held.promise; return Response.json({}); };
  try {
    const first = wired.installed.routeOrExplain('older pending reply', false);
    await until(() => f.calls.some((call) => call.method === 'sessions.steer'), 'first steer');
    f.send('TURN_SUBMITTED', 'older-turn');
    await f.barrier();
    f.behavior.steer = async () => Response.json({});
    const second = await wired.installed.routeOrExplain('newer turn', false);
    f.send('TURN_SUBMITTED', 'newer-turn');
    await f.barrier();
    held.resolve();
    expect((await (await first)!.completion).status).toBe('abandoned');
    await until(() => f.calls.some((call) => call.method === 'sessions.hosted.attach'), 'superseded outcome mirror');
    expect(wired.state.isThinking).toBe(true);
    f.send('TURN_COMPLETED', 'newer-turn', { response: 'new answer' });
    expect((await second!.completion).status).toBe('completed');
  } finally { f.dispose(); }
});


test('Stop during stream preparation never sends cancellation for a replayed pre-steer turn', async () => {
  const f = fixture();
  f.behavior.stream = () => {
    f.send('TURN_SUBMITTED', 'preexisting-replayed-turn', { origin: undefined });
    expect(f.router.cancelTurn()).toBe(true);
  };
  try {
    const outcome = await f.router.submit('do not submit this message');
    expect(outcome).toMatchObject({ routed: false, chosen: true, cancelled: true });
    expect(f.calls.filter((call) => call.method === 'sessions.steer')).toEqual([]);
    expect(f.cancelAttempts).toEqual([]);
    expect(f.cancellations).toEqual([]);
  } finally { f.dispose(); }
});


test('a newer local generation prevents the prior catch-up watcher from submitting its message', async () => {
  const f = fixture();
  let replacement: Promise<RemoteTurnOutcome> | undefined;
  f.behavior.stream = () => {
    f.send('TURN_SUBMITTED', 'replayed-turn', { origin: undefined });
    f.send('TURN_COMPLETED', 'replayed-turn', { response: 'previous answer' });
    queueMicrotask(() => { replacement = f.router.submit('new local input', { hasAttachments: true }); });
  };
  try {
    const first = await f.router.submit('older pending input');
    await until(() => replacement !== undefined, 'new local generation');
    expect(await replacement).toMatchObject({ routed: false });
    expect(first).toMatchObject({ routed: false, chosen: true, cancelled: true });
    expect(f.calls.filter((call) => call.method === 'sessions.steer')).toEqual([]);
    expect(f.cancelAttempts).toEqual([]);
  } finally { f.dispose(); }
});

describe('submission correlation is required before hosted ownership', () => {
  for (const precedingTurns of [0, 1, 3]) {
    test(`pending Stop ignores ${precedingTurns} unrelated queued starts and terminals, then cancels only its own execution`, async () => {
      const f = fixture(); const wired = f.wiring();
      try {
        const handle = await wired.installed.routeOrExplain('identical input', false);
        const completion = observe(handle!.completion);
        const correlationId = f.correlationId();
        expect(typeof correlationId).toBe('string'); expect(correlationId).not.toBe('');
        cancelConversationGeneration(wired.state, wired.installed);
        for (let i = 0; i < precedingTurns; i++) {
          const id = `earlier-queued-${i}`;
          f.send('TURN_SUBMITTED', id, { prompt: 'identical input', origin: { metadata: { correlationId: `another-submission-${i}` } } });
          f.send('STREAM_DELTA', id, { accumulated: 'somebody else answered' });
          f.send('TURN_COMPLETED', id, { response: 'somebody else answered' });
        }
        await f.barrier();
        expect(f.cancellations).toEqual([]); expect(f.assistant).toEqual([]);
        expect(completion.value).toBeUndefined(); expect(wired.state.isThinking).toBe(true); expect(wired.aborts()).toBe(0);
        f.send('TURN_SUBMITTED', 'own-execution', { prompt: 'identical input' });
        await until(() => f.cancellations.length === 1, 'positively correlated cancellation');
        expect(f.cancellations[0]?.body.expectedTurnId).toBe('own-execution');
        f.send('TURN_COMPLETED', 'earlier-queued-0', { response: 'late prior terminal' });
        await f.barrier(); expect(completion.value).toBeUndefined(); expect(wired.state.isThinking).toBe(true);
        f.send('TURN_CANCEL', 'own-execution');
        expect((await handle!.completion).status).toBe('cancelled');
      } finally { f.dispose(); }
    });
  }

  test('legacy or malformed correlation never confers ownership or settles the pending submission', async () => {
    const f = fixture();
    try {
      const outcome = routed(await f.router.submit('new work')); const completion = observe(outcome.completion);
      f.router.cancelTurn();
      for (const origin of [undefined, null, {}, { metadata: null }, { metadata: { correlationId: 7 } }, { metadata: { correlationId: 'old-submission' } }]) {
        f.send('TURN_SUBMITTED', 'unowned-turn', { origin });
        f.send('TURN_COMPLETED', 'unowned-turn', { response: 'not our answer' });
      }
      f.send('TURN_COMPLETED', undefined, { response: 'legacy terminal' });
      await f.barrier();
      expect(f.cancellations).toEqual([]); expect(completion.value).toBeUndefined(); expect(f.assistant).toEqual([]);
      expect(f.notices.some(message => message.includes('has not identified this submission'))).toBe(true);
      f.send('TURN_SUBMITTED', 'the-correlated-turn');
      await until(() => f.cancellations.length === 1, 'owned start after unrelated replay');
      expect(f.cancellations[0]?.body.expectedTurnId).toBe('the-correlated-turn');
    } finally { f.dispose(); }
  });

  test('each submission has a fresh correlation while stale-session recreation retains its original correlation', async () => {
    const f = fixture(); let steers = 0;
    f.behavior.steer = async () => ++steers === 2 ? new Response('stale session', { status: 404 }) : Response.json({});
    try {
      const first = await f.start(); const firstCorrelation = f.correlationId();
      if (!firstCorrelation) throw new Error('Expected the first hosted submission to have a nonempty correlation');
      f.send('TURN_COMPLETED', 'turn-1'); await first.outcome.completion;
      const second = routed(await f.router.submit('identical input'));
      expect(second.action).toBe('recreated');
      const ids = f.calls.filter(call => call.method === 'sessions.steer').map(call => (call.input.metadata as { correlationId: string }).correlationId);
      expect(ids).toHaveLength(3); expect(ids[0]).toBe(firstCorrelation); expect(ids[1]).not.toBe(ids[0]); expect(ids[2]).toBe(ids[1]);
      f.router.cancelTurn();
      f.send('TURN_SUBMITTED', 'old-turn-replayed', { origin: { metadata: { correlationId: firstCorrelation } } });
      await f.barrier(); expect(f.cancellations).toEqual([]);
      f.send('TURN_SUBMITTED', 'new-execution');
      await until(() => f.cancellations.length === 1, 'recreated submission start');
      expect(f.cancellations[0]?.body.expectedTurnId).toBe('new-execution');
    } finally { f.dispose(); }
  });

  for (const action of ['replace', 'dispose'] as const) for (const microtask of [false, true]) {
    test(`a correlated start observer that ${action}s ${microtask ? 'in a microtask' : 'synchronously'} cannot dispatch the superseded pending Stop`, async () => {
      const f = fixture(); let ran = false; let replacement: Promise<RemoteTurnOutcome> | undefined;
      try {
        const outcome = routed(await f.router.submit('older submission'));
        f.router.cancelTurn();
        f.behavior.frame = frame => {
          if (frame.type !== 'TURN_SUBMITTED') return;
          const supersede = () => {
            ran = true;
            if (action === 'dispose') f.router.dispose();
            else replacement = f.router.submit('new local submission', { hasAttachments: true });
          };
          if (microtask) queueMicrotask(supersede); else supersede();
        };
        f.send('TURN_SUBMITTED', 'positively-correlated-old-turn');
        await until(() => ran, 'correlated observer replacement');
        if (replacement) expect(await replacement).toMatchObject({ routed: false });
        expect((await outcome.completion).status).toBe('abandoned');
        expect(f.cancelAttempts).toEqual([]); expect(f.cancellations).toEqual([]);
      } finally { f.dispose(); }
    });
  }
});
