import { expect, test } from 'bun:test';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
import type { NativeHostedTurnSnapshot } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client';
import type { NativeConversationIntakeActions, NativeConversationIntakeState } from '../../runtime/native-conversation-intake.ts';
import { createRemoteConversationRouter } from '../../runtime/client/remote-conversation.ts';
import { installRemoteConversationRouting } from '../../shell/remote-conversation-wiring.ts';

const snapshot: NativeHostedTurnSnapshot = { projectId: 'owned-project', requestId: 'original-request', inputId: 'original-input', sourceRevision: 'source-revision', state: 'running', sessionId: 'native-session', brokerInputId: 'native-broker-input', correlationId: 'native-correlation' };
const original = '  Explain the original\r\n界 e\u0301 😀  ';
const source = { text: original, unsupportedSources: [] };
const state = (): NativeConversationIntakeState => ({ status: 'recorded', message: 'Native turn admitted.', request: { requestId: snapshot.requestId, inputId: snapshot.inputId },
  result: { kind: 'turn', projectId: snapshot.projectId, requestId: snapshot.requestId, sourceRef: { version: 1, inputId: snapshot.inputId, sourceId: 'source', sourceRevision: snapshot.sourceRevision, sessionId: 'native-project' }, route: 'answer', text: original },
  hostedTurn: snapshot, hostedCurrent: () => true });

function fixture(onRender: () => void = () => {}) {
  const posts: string[] = [], transcript: string[] = [], notices: string[] = [], positions: (string | null)[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let event = 0, connected = true, selectionIdentity = 'selected-private-record';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    fetch(request) {
      if (request.method !== 'GET') { posts.push(new URL(request.url).pathname); return new Response('unexpected mutation', { status: 500 }); }
      positions.push(request.headers.get('Last-Event-ID'));
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(': ready\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const connection = () => connected ? { baseUrl: server.url.origin, token: 'synthetic-native-observer-token', selectionIdentity, expectedPrincipalId: 'pairing:synthetic-native' } : { reason: 'changed' };
  const verbs = { probe: () => ({ available: true as const }), async invoke<T>(method: string): Promise<T> { posts.push(method); return { sessions: [], session: { id: snapshot.sessionId }, history: [] } as T; } };
  const conversation = { addUserMessage(text: string) { transcript.push(`user:${text}`); }, addAssistantMessage(text: string) { transcript.push(`assistant:${text}`); }, addToolResults() {}, addSystemMessage(text: string) { notices.push(text); }, startStreamingBlock() {}, updateStreamingBlock() {}, finalizeStreamingBlock() {} };
  const configManager = { get: (() => true) as never };
  const router = createRemoteConversationRouter({ verbs, configManager, resolveConnection: connection, conversation, requestRender() {}, workspaceRoot: '/synthetic-owned', clientId: 'agent-native-test', reconnect: { enabled: false }, onCancellationNotice: text => notices.push(text) });
  const ctx = { conversation, orchestrator: { isThinking: false, thinkingFrame: 0, streamingInputTokens: 0, streamingOutputTokens: 0 }, runtime: { sessionId: 'local', model: 'fixture', provider: 'fixture' }, runtimeBus: { emit() {} }, services: { daemonVerbs: verbs, configManager, workingDirectory: '/synthetic-owned', resolveConnectedHost: connection, sessionManager: { list: () => [] } } } as unknown as BootstrapContext;
  const wiring = installRemoteConversationRouting(ctx, { render: onRender, notify: text => notices.push(text) });
  function frame(type: string, turnId = 'owned-turn', correlationId = snapshot.correlationId, text = '') {
    if (!stream) throw new Error('Missing stream');
    const payload = { type, turnId, ...(type === 'TURN_SUBMITTED' ? { origin: { metadata: { correlationId } } } : {}), ...(type === 'STREAM_DELTA' ? { accumulated: text } : {}), ...(type === 'TURN_COMPLETED' ? { stopReason: 'completed' } : {}) };
    stream.enqueue(new TextEncoder().encode(`id: event-${++event}\nevent: turn\ndata: ${JSON.stringify({ type, sessionId: snapshot.sessionId, payload })}\n\n`));
  }
  return { router, wiring, posts, transcript, notices, positions, frame, ctx, heartbeat() { stream?.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n')); }, endStream() { stream?.close(); }, replaceSelection() { selectionIdentity = 'replacement-private-record'; }, replaceHost() { connected = false; }, async close() { wiring.dispose(); router.dispose(); await server.stop(true); } };
}
async function until(predicate: () => boolean) { const end = Date.now() + 3_000; while (!predicate()) { if (Date.now() > end) throw new Error('Fixture timed out'); await Bun.sleep(5); } }
function intake(overrides: Partial<NativeConversationIntakeActions> = {}): NativeConversationIntakeActions {
  return { stop: async () => overrides.cancel ? overrides.cancel() : ({ status: 'recorded', message: 'Stopped.' }), submit: async () => state(), status: async () => state(), retry: async () => state(), resume: async () => state(), cancel: async () => ({ ...state(), hostedTurn: { ...snapshot, state: 'cancelled' } }), close() {}, ...overrides };
}

test('native observation uses host correlation and never creates, steers or cancels by a body', async () => {
  const f = fixture(); let cancelled = 0;
  try {
    const turn = await f.router.observeNative(snapshot, async () => { cancelled++; });
    expect(turn.routed).toBe(true); if (!turn.routed) return;
    f.frame('TURN_SUBMITTED', 'foreign-turn', 'foreign-correlation'); f.frame('STREAM_DELTA', 'foreign-turn', 'foreign-correlation', 'wrong'); f.frame('TURN_COMPLETED', 'foreign-turn');
    expect(f.router.cancelTurn()).toBe(true); await until(() => cancelled === 1);
    f.frame('TURN_SUBMITTED'); f.frame('STREAM_DELTA', undefined, undefined, 'actual answer'); f.frame('TURN_COMPLETED');
    expect((await turn.completion).response).toBe('actual answer');
    expect(f.transcript).toEqual(['assistant:actual answer']);
    expect(f.posts.filter(method => method !== 'sessions.hosted.list')).toEqual([]);
    const again = await f.router.observeNative(snapshot, async () => { cancelled++; });
    expect(again).toBe(turn); expect(f.positions).toHaveLength(1); expect(cancelled).toBe(1);
  } finally { await f.close(); }
});

test('native wiring sends exact original and unsupported references before hosted observation', async () => {
  const f = fixture(); const submissions: unknown[] = []; const cancellations: unknown[] = [];
  try {
    const turn = await f.wiring.routeNativeOrExplain(source, intake({ submit: async (...args) => { submissions.push(args); return state(); }, cancel: async expected => { cancellations.push(expected); return { ...state(), hostedTurn: { ...snapshot, state: 'cancelling' } }; } }));
    expect(submissions).toEqual([[source, { delivery: 'hosted' }]]);
    expect(f.transcript).toEqual([`user:${original}`]);
    f.wiring.cancelHostedTurn(); await until(() => cancellations.length === 1);
    expect(cancellations).toEqual([{ inputId: snapshot.inputId, requestId: snapshot.requestId }]);
    f.frame('TURN_SUBMITTED'); f.frame('STREAM_DELTA', undefined, undefined, 'reply'); f.frame('TURN_COMPLETED');
    await turn?.completion;
    expect(f.transcript).toEqual([`user:${original}`, 'assistant:reply']);
    expect(f.posts).not.toContain('sessions.hosted.create'); expect(f.posts).not.toContain('sessions.steer');
  } finally { await f.close(); }
});

test('unknown admission and unsupported source never fall back or allocate a hosted session', async () => {
  const f = fixture();
  try {
    const unknown = await f.wiring.routeNativeOrExplain({ ...source, unsupportedSources: [{ kind: 'context', label: 'model-derived' }] }, intake({ submit: async captured => { expect(captured.unsupportedSources).toEqual([{ kind: 'context', label: 'model-derived' }]); return { status: 'unknown', message: 'Original outcome unknown.' }; } }));
    expect(unknown).not.toBeNull(); expect(f.positions).toHaveLength(0); expect(f.transcript).toEqual([]);
    expect(f.posts.filter(method => method !== 'sessions.hosted.list')).toEqual([]);
    expect(f.ctx.orchestrator.isThinking).toBe(false);
  } finally { await f.close(); }
});

test('host change while observing fences frames and Stop without touching a newer connection', async () => {
  const f = fixture(); let cancels = 0;
  try {
    const turn = await f.router.observeNative(snapshot, async () => { cancels++; });
    expect(turn.routed).toBe(true); if (!turn.routed) return;
    f.replaceHost(); f.frame('TURN_SUBMITTED'); f.frame('STREAM_DELTA', undefined, undefined, 'stale');
    expect(f.router.cancelTurn()).toBe(false);
    expect((await turn.completion).status).toBe('abandoned'); expect(cancels).toBe(0); expect(f.transcript).toEqual([]);
  } finally { await f.close(); }
});

test('Stop during native admission owns cancellation and fences its late reply', async () => {
  const f = fixture(); let resolve!: (value: NativeConversationIntakeState) => void; let cancels = 0;
  try {
    const pending = f.wiring.routeNativeOrExplain(source, intake({ submit: async () => new Promise(done => { resolve = done; }), cancel: async () => { cancels++; return { status: 'recorded', message: 'Original intake cancelled.' }; } }));
    expect(f.wiring.cancelHostedTurn()).toBe(true); await until(() => cancels === 1);
    resolve(state()); await pending;
    expect(f.positions).toHaveLength(0); expect(f.transcript).toEqual([]); expect(f.ctx.orchestrator.isThinking).toBe(false);
  } finally { await f.close(); }
});


test('explicit native observation recovery retains proven turn identity after its resume cursor', async () => {
  const f = fixture();
  try {
    const first = await f.router.observeNative(snapshot, async () => {});
    if (!first.routed) throw new Error(first.reason);
    f.frame('TURN_SUBMITTED'); f.frame('STREAM_DELTA', undefined, undefined, 'partial');
    f.endStream(); expect((await first.completion).status).toBe('abandoned');
    const recovered = await f.router.observeNative(snapshot, async () => {});
    if (!recovered.routed) throw new Error(recovered.reason);
    expect(f.positions).toEqual([null, 'event-2']);
    // The daemon resumes after TURN_SUBMITTED; proven ownership must survive.
    f.frame('TURN_COMPLETED', 'other-turn');
    f.frame('STREAM_DELTA', undefined, undefined, 'complete recovered answer'); f.frame('TURN_COMPLETED');
    expect(await recovered.completion).toMatchObject({ status: 'completed', response: 'complete recovered answer' });
    expect(f.posts.filter(method => method !== 'sessions.hosted.list')).toEqual([]);
  } finally { await f.close(); }
});


test('reentrant render cannot steal pending admission or make Stop miss its owner', async () => {
  let reentered = false, submits = 0, cancels = 0;
  let resolve!: (value: NativeConversationIntakeState) => void;
  const controls = intake({ submit: async () => { submits++; return new Promise(done => { resolve = done; }); }, cancel: async () => { cancels++; return { status: 'recorded', message: 'Cancelled before delivery.' }; } });
  const f = fixture(() => { if (!reentered) { reentered = true; void f.wiring.routeNativeOrExplain(source, controls); } });
  try {
    const pending = f.wiring.routeNativeOrExplain(source, controls);
    expect(submits).toBe(1); expect(f.wiring.cancelHostedTurn()).toBe(true);
    await until(() => cancels === 1);
    resolve(state()); await pending;
    expect(f.positions).toHaveLength(0); expect(f.transcript).toEqual([]);
  } finally { await f.close(); }
});

test('Stop from the initial render prevents the native submission itself', async () => {
  let stopped = false, submits = 0, cancels = 0;
  const f = fixture(() => { if (!stopped) { stopped = true; f.wiring.cancelHostedTurn(); } });
  try {
    await f.wiring.routeNativeOrExplain(source, intake({ submit: async () => { submits++; return state(); }, cancel: async () => { cancels++; return { status: 'unavailable', message: 'No original exists.' }; } }));
    expect(submits).toBe(0); expect(cancels).toBe(1); expect(f.positions).toHaveLength(0);
  } finally { await f.close(); }
});


test('explicit same-source recovery replaces a revoked observer before its timer fires', async () => {
  const f = fixture(); let oldCurrent = true;
  try {
    const first = await f.router.observeNative(snapshot, async () => {}, () => oldCurrent);
    if (!first.routed) throw new Error(first.reason);
    oldCurrent = false;
    const reopened = await f.router.observeNative(snapshot, async () => {}, () => true);
    if (!reopened.routed) throw new Error(reopened.reason);
    expect(reopened).not.toBe(first); expect(f.positions).toHaveLength(2);
    expect((await first.completion).status).toBe('abandoned');
    f.frame('TURN_SUBMITTED'); f.frame('STREAM_DELTA', undefined, undefined, 'current observer'); f.frame('TURN_COMPLETED');
    expect(await reopened.completion).toMatchObject({ status: 'completed', response: 'current observer' });
  } finally { await f.close(); }
});


test('evicted terminal replay reports missing transcript instead of inventing identity or waiting forever', async () => {
  const f = fixture();
  try {
    const observed = await f.router.observeNative({ ...snapshot, state: 'completed' }, async () => {});
    if (!observed.routed) throw new Error(observed.reason);
    f.frame('STREAM_DELTA', 'unproven-turn', undefined, 'unowned replay'); f.frame('TURN_COMPLETED', 'unproven-turn');
    f.heartbeat();
    const result = await observed.completion;
    expect(result.status).toBe('abandoned'); expect(result.error).toContain('host reports this native turn completed');
    expect(f.transcript).toEqual([]); expect(f.router.cancelTurn()).toBe(false);
  } finally { await f.close(); }
});


test('a terminal status upgrades the existing uncorrelated watcher without replaying or waiting forever', async () => {
  const f = fixture();
  try {
    const running = await f.router.observeNative(snapshot, async () => {});
    if (!running.routed) throw new Error(running.reason);
    f.heartbeat();
    const completed = await f.router.observeNative({ ...snapshot, state: 'completed' }, async () => {});
    expect(completed).toBe(running); expect(f.positions).toHaveLength(1);
    f.heartbeat(); expect((await running.completion).status).toBe('abandoned');
  } finally { await f.close(); }
});

test('same-source recovery refuses a changed session, broker or correlation identity', async () => {
  for (const change of [{ sessionId: 'different-session' }, { brokerInputId: 'different-broker' }, { correlationId: 'different-correlation' }]) {
    const f = fixture();
    try {
      const running = await f.router.observeNative(snapshot, async () => {});
      if (!running.routed) throw new Error(running.reason);
      expect((await f.router.observeNative({ ...snapshot, ...change }, async () => {})).routed).toBe(false);
      expect((await running.completion).status).toBe('abandoned'); expect(f.positions).toHaveLength(1);
    } finally { await f.close(); }
  }
});


test('same-token private selection replacement revokes observation and starts recovery with a fresh cursor', async () => {
  const f = fixture(); let cancelled = 0;
  try {
    const first = await f.router.observeNative(snapshot, async () => { cancelled++; });
    if (!first.routed) throw new Error(first.reason);
    f.frame('TURN_SUBMITTED'); f.frame('STREAM_DELTA', undefined, undefined, 'old partial');
    // Closing drains the real consumed correlation/cursor before the record changes.
    f.endStream(); await first.completion;
    f.replaceSelection();
    const recovered = await f.router.observeNative(snapshot, async () => { cancelled++; });
    if (!recovered.routed) throw new Error(recovered.reason);
    expect(f.positions).toEqual([null, null]);
    f.frame('TURN_SUBMITTED', 'fresh-owned-turn'); f.frame('STREAM_DELTA', 'fresh-owned-turn', undefined, 'fresh record response'); f.frame('TURN_COMPLETED', 'fresh-owned-turn');
    expect((await recovered.completion).response).toBe('fresh record response'); expect(cancelled).toBe(0);
  } finally { await f.close(); }
});

test('metadata-only credential changes stop rendering and cancellation despite an unchanged token', async () => {
  const f = fixture(); let cancelled = 0;
  try {
    const observed = await f.router.observeNative(snapshot, async () => { cancelled++; });
    if (!observed.routed) throw new Error(observed.reason);
    f.replaceSelection();
    f.frame('TURN_SUBMITTED'); f.frame('STREAM_DELTA', undefined, undefined, 'stale private selection');
    expect(f.router.cancelTurn()).toBe(false);
    expect((await observed.completion).status).toBe('abandoned'); expect(cancelled).toBe(0); expect(f.transcript).toEqual([]);
  } finally { await f.close(); }
});
