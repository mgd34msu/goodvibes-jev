import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { wireStreamEventMetrics, createStreamMetrics, type WireStreamEventMetricsOptions } from '../../core/stream-event-wiring.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function reader(options: { wait?: Promise<void>; reject?: boolean; auth?: boolean; sessionEnded?: boolean } = {}) {
  const fake = fakePort((name, question) => question.type === 'choice'
    ? choiceAnswer(question, name === 'failure__category' ? options.auth ? 'authentication' : 'unknown' : 'none', 0.99)
    : noulAnswer(name === 'user__session_ended' && options.sessionEnded ? 0.99 : 0.01));
  installJudgmentPort({ ...fake.port, async ask(request) {
    await options.wait;
    if (options.reject) throw new Error('reading unavailable');
    return fake.port.ask(request);
  } });
  return fake.requests;
}
function bus() {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  return {
    on(type: string, callback: (event: Record<string, unknown>) => void) {
      const set = listeners.get(type) ?? new Set(); set.add(callback); listeners.set(type, set);
      return () => { set.delete(callback); };
    },
    emit(type: string, payload: Record<string, unknown> = {}) {
      for (const callback of [...listeners.get(type) ?? []]) callback({ type, ...payload });
    },
  };
}
function fixture(overrides: Partial<WireStreamEventMetricsOptions> = {}) {
  const turns = bus(); const tools = bus(); const providers = bus(); const messages: string[] = []; const retries: string[] = [];
  let session = 'session-a'; let model = 'first:one'; let renderCount = 0;
  const result = wireStreamEventMetrics({
    events: { turns, tools, providers } as unknown as WireStreamEventMetricsOptions['events'],
    orchestrator: { streamingOutputTokens: 0 },
    providerRegistry: { getCurrentModel: () => ({ provider: model.split(':')[0]!, registryKey: model }), setCurrentModel: key => { model = key; } },
    systemMessageRouter: { high: line => { messages.push(line); }, low() {}, userReceipt: line => { messages.push(line); } },
    metrics: createStreamMetrics(), render: () => { renderCount++; },
    getSessionId: () => session,
    retryTurn: notice => { messages.length = 0; messages.push(notice ?? ''); retries.push(notice ?? ''); return true; },
    ...overrides,
  });
  result.onErrorSurfaced(() => { surfaced++; });
  let surfaced = 0;
  turns.emit('TURN_SUBMITTED', { turnId: 'turn-a' });
  return { turns, messages, retries, result, session: (id: string) => { session = id; }, model: () => model, changeModel: (key: string) => { model = key; providers.emit('MODEL_CHANGED', { registryKey: key, provider: key.split(':')[0], model: key.split(':')[1] }); },
    renders: () => renderCount, surfaced: () => surfaced, close: () => { for (const unsub of result.unsubs) unsub(); } };
}

test('live stream asks the public owner: prose mentioning 401, 429 and timeout is not classified by regex', async () => {
  const requests = reader(); const f = fixture();
  try {
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'Documentation mentions 401, 429 and timeout but the failure is unknown' });
    await flush();
    expect(requests).toHaveLength(1);
    expect(f.messages[0]).toContain('Provider error: Documentation');
    expect(f.messages[0]).not.toContain('Authentication failed');
    expect(f.surfaced()).toBe(1);
  } finally { f.close(); }
});

for (const boundary of ['new-turn', 'cancel', 'completed', 'new-session', 'dispose'] as const) {
  test(`a delayed error cannot cross ${boundary}`, async () => {
    const pending = deferred(); reader({ wait: pending.promise, auth: true }); const f = fixture();
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'first error' }); await flush();
    if (boundary === 'new-turn') { f.result.clearFailoverVisited(); f.turns.emit('TURN_SUBMITTED', { turnId: 'turn-b' }); }
    if (boundary === 'cancel') f.turns.emit('TURN_CANCEL', { turnId: 'turn-a' });
    if (boundary === 'completed') f.turns.emit('TURN_COMPLETED', { turnId: 'turn-a' });
    if (boundary === 'new-session') f.session('session-b');
    if (boundary === 'dispose') f.close();
    const renders = f.renders(); pending.resolve(); await flush();
    expect(f.messages).toEqual([]); expect(f.renders()).toBe(renders); expect(f.surfaced()).toBe(0); f.close();
  });
}

test('subscription wording comes from the public reader', async () => {
  reader({ auth: true, sessionEnded: true }); const f = fixture();
  try { f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'Provider login renewal is necessary' }); await flush();
    expect(f.messages[0]).toContain('subscription session has ended'); expect(f.messages[0]).not.toContain('API key');
  } finally { f.close(); }
});

test('reader failure reports unavailable interpretation without guessing a class', async () => {
  reader({ reject: true }); const f = fixture();
  try { f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: '401 timeout quota' }); await flush();
    expect(f.messages).toHaveLength(1); expect(f.messages[0]).toContain('Error details unavailable');
    expect(f.messages[0]).toContain('401 timeout quota'); expect(f.messages[0]).not.toContain('Authentication failed');
  } finally { f.close(); }
});

test('failover awaits the reading and posts its notice through retry rollback exactly once', async () => {
  const pending = deferred(); reader({ wait: pending.promise, auth: true });
  const f = fixture({ providerOptimizer: { enabled: true, testFallback: () => ({ chain: [{ position: 0, capable: true, providerId: 'second', modelId: 'two' }] }), recordFallbackTransition() {}, fallbackLog: [] } });
  try {
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'opaque auth failure' }); await flush();
    expect(f.retries).toEqual([]); expect(f.model()).toBe('first:one');
    pending.resolve(); await flush();
    expect(f.retries).toHaveLength(1); expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toContain('[Failover] first -> second (Authentication failed:'); expect(f.surfaced()).toBe(0);
  } finally { f.close(); }
});

test('typed HTTP status and errno retain structural authority even when prose says otherwise', async () => {
  const requests = reader(); const f = fixture();
  try {
    for (const [error, expected] of [
      [{ status: 401 }, 'Authentication failed'],
      [{ status: 429, message: 'not a quota issue' }, 'Rate limit reached'],
      [{ code: 'ECONNREFUSED', message: '401 mentioned here' }, 'Network error'],
      [{ cause: { code: 'ENOTFOUND' } }, 'Network error'],
    ] as const) {
      f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error }); await flush();
      expect(f.messages.at(-1)).toContain(expected);
    }
    expect(requests).toHaveLength(0);
  } finally { f.close(); }
});

test('the bounded owner preserves error arrival order when reads resolve backwards', async () => {
  let entered = 0; const first = deferred(); const second = deferred();
  // Both return deliberately unavailable readings. This tests delivery order,
  // not the reader's answer schema, which the structural/semantic tests cover.
  installJudgmentPort({ model: 'jev-1.13.0', async ask() {
    const index = entered++; await (index === 0 ? first.promise : second.promise); throw new Error('unavailable');
  } });
  const f = fixture();
  try {
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'first' });
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'second' });
    second.resolve(); await flush(); expect(f.messages).toEqual([]);
    first.resolve(); await flush(); expect(f.messages.map(line => line.split('Original error: ')[1])).toEqual(['first', 'second']);
  } finally { f.close(); }
});

test('a never-settling reader does not block failover forever or authorize a late result', async () => {
  const pending = deferred(); reader({ wait: pending.promise, auth: true });
  const f = fixture({ errorNoticeTimeoutMs: 5, providerOptimizer: { enabled: true, testFallback: () => ({ chain: [{ position: 0, capable: true, providerId: 'second', modelId: 'two' }] }), recordFallbackTransition() {}, fallbackLog: [] } });
  try {
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'unread failure' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.retries).toHaveLength(1); expect(f.messages[0]).toContain('Error details unavailable');
    pending.resolve(); await flush(); expect(f.retries).toHaveLength(1); expect(f.messages[0]).not.toContain('Authentication failed');
  } finally { f.close(); }
});

for (const boundary of ['cancel', 'new-turn', 'new-session', 'close'] as const) {
  test(`deferred retry submit loses authority on ${boundary} after the notice was delivered`, async () => {
    reader(); let canSubmit: (() => boolean) | undefined;
    const f = fixture({
      providerOptimizer: { enabled: true, testFallback: () => ({ chain: [{ position: 0, capable: true, providerId: 'second', modelId: 'two' }] }), recordFallbackTransition() {}, fallbackLog: [] },
      retryTurn: (_notice, isCurrent) => { canSubmit = isCurrent; return true; },
    });
    try {
      f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'failed' }); await flush();
      expect(canSubmit?.()).toBe(true);
      if (boundary === 'cancel') f.turns.emit('TURN_CANCEL', { turnId: 'turn-a' });
      if (boundary === 'new-turn') { f.result.clearFailoverVisited(); f.turns.emit('TURN_SUBMITTED', { turnId: 'turn-b' }); }
      if (boundary === 'new-session') f.session('session-b');
      if (boundary === 'close') f.close();
      expect(canSubmit?.()).toBe(false);
    } finally { f.close(); }
  });
}

test('a terminal turn rejects late duplicate errors and stale terminal events cannot cancel a newer read', async () => {
  reader(); const f = fixture();
  try {
    f.turns.emit('TURN_COMPLETED', { turnId: 'turn-a' });
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'late' }); await flush(); expect(f.messages).toEqual([]);
    f.turns.emit('TURN_SUBMITTED', { turnId: 'turn-b' });
    const pending = deferred(); reader({ wait: pending.promise });
    f.turns.emit('TURN_ERROR', { turnId: 'turn-b', error: 'current' });
    f.turns.emit('TURN_CANCEL', { turnId: 'turn-a' }); pending.resolve(); await flush();
    expect(f.messages).toHaveLength(1); expect(f.messages[0]).toContain('current');
  } finally { f.close(); }
});


test('an external model change aborts an already-entered native retry admission', async () => {
  const { heldNativeRetry } = await import('../helpers/held-native-retry.ts');
  const native = await heldNativeRetry(); reader();
  let outcome: Promise<unknown> | undefined;
  // A real turn hold signal is needed to own post-entry SDK cancellation.
  const controller = new AbortController(); let live = true;
  const f = fixture({ beginFailoverNotice: () => ({ signal: controller.signal, isCurrent: () => live,
    finish: () => {}, cancel: () => { live = false; controller.abort(); }, cancelTurn: () => { live = false; controller.abort(); } }),
    providerOptimizer: { enabled: true, testFallback: () => ({ chain: [{ position: 0, capable: true, providerId: 'second', modelId: 'two' }] }), recordFallbackTransition() {}, fallbackLog: [] },
    retryTurn: (_notice, isCurrent, signal) => { outcome = native.start(signal, isCurrent); return true; },
  });
  try {
    f.turns.emit('TURN_ERROR', { turnId: 'turn-a', error: 'failed' }); await native.waiting;
    expect(native.orchestrator.isThinking).toBe(false);
    f.changeModel('third:three'); expect(controller.signal.aborted).toBe(true);
    native.release(); expect(await outcome).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' }, signalAborted: true, messageCount: 0 });
    expect(native.conversation.getMessageCount()).toBe(0); expect(f.model()).toBe('third:three');
  } finally { f.close(); native.dispose(); await outcome; }
});
