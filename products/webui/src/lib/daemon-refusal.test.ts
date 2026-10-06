import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BrowserJudgmentRequest, BrowserJudgmentValueMap } from '@goodvibes-jev/engine/daemon-sdk';
import { daemonRefusalValue, readDaemonRefusalResponse, resolveDaemonRefusal } from './daemon-refusal';
import { getClientLifetime, isClientLifetimeCurrent, tokenStore, WEBUI_TOKEN_STORE_KEY } from './client-lifetime';
import { isMethodUnavailableError, isSessionActiveError, isSessionClosedError, isSessionNotFoundError, isSessionNotLocalError } from './errors';
import { runBrowserJudgment, sdk } from './goodvibes';

type Request = BrowserJudgmentRequest<'webui.errors.daemon-refusal'>;
type Refusal = BrowserJudgmentValueMap['webui.errors.daemon-refusal'];
type Name = keyof Refusal;
const names = ['session_not_found', 'session_closed', 'session_active', 'session_not_local', 'method_unknown'] as const;
const originalFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const request = (): Request => ({ protocolVersion: 1, batteryVersion: 1, battery: 'webui.errors.daemon-refusal', requestId: crypto.randomUUID(), input: { errorRef: 'synthetic-issued-ref' } });
const failure = (status = 404) => Object.assign(new Error('Synthetic original transport failure'), {
  status, body: { errorRef: 'synthetic-issued-ref', error: 'Browser-visible prose is not source authority.' },
});
function wire(input: Request, status = 404, yes: Name = 'session_closed') {
  return {
    protocolVersion: 1, batteryVersion: 1, battery: input.battery, requestId: input.requestId,
    status: 'settled', outcome: 'act',
    value: { session_not_found: yes === 'session_not_found', session_closed: yes === 'session_closed',
      session_active: yes === 'session_active', session_not_local: yes === 'session_not_local', method_unknown: yes === 'method_unknown' },
    readings: Object.fromEntries(names.filter((name) => name !== 'method_unknown' || status === 404).map((name) => [name, {
      kind: 'yes-no', probability: name === yes ? 0.99 : 0.01, verdict: name === yes ? 'yes' : 'no', outcome: 'act',
    }])),
    evidence: [{ decisionId: 'synthetic-decision', model: 'synthetic-model-v1', requestedModel: 'synthetic-model',
      usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 }],
    ...(status === 404 ? {} : { structuralBasis: { method_unknown: 'http-status-not-404' } }),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
const capturedFailure = async (pending: Promise<unknown>): Promise<unknown> => {
  try { await pending; } catch (error) { return error; }
  throw new Error('Expected the synthetic request to fail');
};
const current = () => ({ isCurrent: () => true });
const classify = {
  session_not_found: isSessionNotFoundError,
  session_closed: isSessionClosedError,
  session_active: isSessionActiveError,
  session_not_local: isSessionNotLocalError,
  method_unknown: isMethodUnavailableError,
} satisfies Record<Name, (error: unknown) => boolean>;

beforeEach(async () => { await tokenStore.setToken('synthetic-account-a'); });
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await tokenStore.clearToken();
});

describe('complete refusal response contract', () => {
  test('accepts exact settled readings for each daemon refusal kind', () => {
    for (const name of names) {
      const input = request(); const result = wire(input, 404, name);
      const value = readDaemonRefusalResponse(input, 404, result);
      expect(value).toEqual(result.value);
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  test('404 requires a genuine method reading; other statuses require its structural false basis', () => {
    const input = request(); const ordinary = wire(input, 409);
    expect(readDaemonRefusalResponse(input, 409, ordinary)).toEqual(ordinary.value);
    expect(ordinary.readings).not.toHaveProperty('method_unknown');
    expect(readDaemonRefusalResponse(input, 404, ordinary)).toBeUndefined();
    expect(readDaemonRefusalResponse(input, 409, wire(input))).toBeUndefined();
    expect(readDaemonRefusalResponse(input, 409, { ...ordinary, structuralBasis: { method_unknown: 'model-said-no' } })).toBeUndefined();
    expect(readDaemonRefusalResponse(input, 409, { ...ordinary, value: { ...ordinary.value, method_unknown: true } })).toBeUndefined();
    expect(readDaemonRefusalResponse(input, 409, { ...ordinary, readings: { ...ordinary.readings, method_unknown: wire(input).readings.method_unknown } })).toBeUndefined();
  });

  test('rejects incomplete, weakened, cross-request and conflicting readings', () => {
    const input = request(); const valid = wire(input); const item = valid.readings.session_closed;
    const invalid: unknown[] = [
      null, [], 'settled',
      { ...valid, protocolVersion: 2 }, { ...valid, batteryVersion: 2 },
      { ...valid, requestId: crypto.randomUUID() }, { ...valid, battery: 'webui.status.badge-tone' },
      { ...valid, status: 'held' }, { ...valid, outcome: 'confirm' }, { ...valid, extra: 'untrusted' },
      { ...valid, value: { ...valid.value, session_closed: 'yes' } },
      { ...valid, value: { ...valid.value, extra: true } },
      { ...valid, value: { session_closed: true } },
      { ...valid, readings: { session_closed: item } },
      { ...valid, readings: { ...valid.readings, extra: item } },
      ...[
        { ...item, kind: 'label' }, { ...item, probability: Number.NaN }, { ...item, probability: Infinity },
        { ...item, probability: -0.01 }, { ...item, probability: 1.01 }, { ...item, verdict: 'maybe' },
        { ...item, verdict: 'no' }, { ...item, outcome: 'confirm' }, { ...item, outcome: 'escalate' },
        { ...item, extra: true }, { kind: 'yes-no', verdict: 'yes', outcome: 'act' },
      ].map((reading) => ({ ...valid, readings: { ...valid.readings, session_closed: reading } })),
      ...['session_not_found', 'session_active', 'method_unknown'].map((name) => ({
        ...valid, value: { ...valid.value, [name]: true },
        readings: { ...valid.readings, [name]: { ...valid.readings[name], verdict: 'yes' } },
      })),
    ];
    for (const value of invalid) expect(readDaemonRefusalResponse(input, 404, value)).toBeUndefined();
  });

  test('refuses settlement without complete genuine evidence metadata', () => {
    const input = request(); const valid = wire(input); const evidence = valid.evidence[0]!;
    const invalid: unknown[] = [
      [], [evidence, evidence], [{ ...evidence, decisionId: '' }], [{ ...evidence, model: ' ' }],
      [{ ...evidence, requestedModel: '' }], [{ ...evidence, latencyMs: -1 }],
      [{ ...evidence, latencyMs: Infinity }], [{ ...evidence, extra: true }],
      [{ ...evidence, usage: { inputTokens: 1 } }],
      [{ ...evidence, usage: { inputTokens: -1, outputTokens: 1 } }],
      [{ ...evidence, usage: { inputTokens: 1, outputTokens: Number.NaN } }],
      [{ ...evidence, usage: { inputTokens: 1, outputTokens: 1, extra: 0 } }],
    ];
    for (const value of invalid) expect(readDaemonRefusalResponse(input, 404, { ...valid, evidence: value })).toBeUndefined();
  });
});

describe('awaited reference-only adoption', () => {
  test('only the original failure object gains classifications; payload and error stay unchanged', async () => {
    for (const name of names) {
      const error = failure(); const body = error.body; const before = Object.keys(error);
      let sent: Request | undefined;
      await resolveDaemonRefusal(error, async (input) => { sent = input; return wire(input, 404, name); }, current());
      expect(sent).toMatchObject({ protocolVersion: 1, batteryVersion: 1, battery: 'webui.errors.daemon-refusal', input: { errorRef: body.errorRef } });
      expect(Object.keys(sent!)).toEqual(['protocolVersion', 'requestId', 'battery', 'batteryVersion', 'input']);
      expect(Object.keys(sent!.input)).toEqual(['errorRef']);
      expect(sent!.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(classify[name](error)).toBe(true);
      expect(Object.keys(error)).toEqual(before);
      expect(error.body).toBe(body);
      expect(daemonRefusalValue({ ...error })).toBeUndefined();
      expect(daemonRefusalValue({ ...error, daemonRefusal: wire(sent!).value })).toBeUndefined();
    }
  });

  test('SDK transport envelopes adopt without serializing message, input or credentials', async () => {
    const error = Object.assign(new Error('Synthetic private browser text'), {
      transport: { status: 404, body: { errorRef: 'synthetic-issued-ref', error: 'Synthetic daemon-private detail' } },
      request: { body: 'Synthetic typed chat', authorization: 'Synthetic credential decoy' },
    });
    let sent = '';
    await resolveDaemonRefusal(error, async (input) => { sent = JSON.stringify(input); return wire(input); }, current());
    expect(isSessionClosedError(error)).toBe(true);
    expect(sent).not.toContain('Synthetic private browser text');
    expect(sent).not.toContain('Synthetic daemon-private detail');
    expect(sent).not.toContain('Synthetic typed chat');
    expect(sent).not.toContain('Synthetic credential decoy');
    expect(sent).not.toContain('synthetic-account-a');
  });

  test('unissued, malformed, auth and stale failures never call interpretation', async () => {
    let calls = 0;
    const run = async (input: Request) => { calls++; return wire(input); };
    for (const error of [undefined, 'Session not found', new Error('Session is closed'),
      { status: 404, body: {} }, { status: 404, body: { errorRef: '' } },
      { status: 404, body: { errorRef: ' ' } }, { status: 404, body: { errorRef: 'x'.repeat(257) } },
      ...[0, 200, 399, 401, 600, 404.5, Number.NaN].map((status) => failure(status)),
    ]) await resolveDaemonRefusal(error, run, current());
    await resolveDaemonRefusal(failure(), run, { isCurrent: () => false });
    const abort = new AbortController(); abort.abort();
    await resolveDaemonRefusal(failure(), run, { ...current(), signal: abort.signal });
    expect(calls).toBe(0);
  });

  test('held, refused, invalid and failed interpretations leave no usable classification', async () => {
    const inputs: ((input: Request) => unknown)[] = [
      (input) => ({ ...wire(input), status: 'held', reason: 'uncertain', outcome: 'confirm' }),
      (input) => ({ ...wire(input), status: 'held', reason: 'uncertain', outcome: 'escalate' }),
      () => ({ protocolVersion: 1, status: 'held', error: { code: 'JUDGMENT_UNRECORDED' } }),
      () => ({ protocolVersion: 1, status: 'held', error: { code: 'JUDGMENT_REFERENCE_HELD' } }),
      (input) => ({ ...wire(input), evidence: [] }),
      () => { throw new Error('Synthetic judgment transport failure'); },
    ];
    for (const result of inputs) {
      const error = failure();
      await resolveDaemonRefusal(error, async (input) => result(input), current());
      expect(daemonRefusalValue(error)).toBeUndefined();
      for (const matches of Object.values(classify)) expect(matches(error)).toBe(false);
    }
  });

  for (const change of ['abort', 'auth-switch', 'auth-ABA', 'storage-switch', 'caller-stale'] as const) {
    test(`pending and settled readings are unusable after ${change}`, async () => {
      for (const pendingChange of [true, false]) {
        await tokenStore.setToken('synthetic-account-a');
        const error = failure(); const abort = new AbortController(); let latest = true;
        const gate = deferred<unknown>(); const started = deferred<undefined>(); let input!: Request; let signal!: AbortSignal;
        const result = resolveDaemonRefusal(error, (request, ownedSignal) => {
          input = request; signal = ownedSignal; started.resolve(undefined); return gate.promise;
        }, { signal: abort.signal, isCurrent: () => latest });
        await started.promise;
        if (!pendingChange) { gate.resolve(wire(input)); await result; expect(isSessionClosedError(error)).toBe(true); }
        if (change === 'abort') abort.abort();
        else if (change === 'caller-stale') latest = false;
        else if (change === 'storage-switch') window.localStorage.setItem(WEBUI_TOKEN_STORE_KEY, 'synthetic-account-b');
        else {
          await tokenStore.setToken('synthetic-account-b');
          if (change === 'auth-ABA') await tokenStore.setToken('synthetic-account-a');
        }
        if (pendingChange) { gate.resolve(wire(input)); await result; }
        expect(daemonRefusalValue(error)).toBeUndefined();
        expect(isSessionClosedError(error)).toBe(false);
        if (pendingChange && change !== 'caller-stale') expect(signal.aborted).toBe(true);
      }
    });
  }

  test('clock-only credential expiry invalidates pending and settled readings', async () => {
    let now = Date.now(); const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (const pendingChange of [true, false]) {
        await tokenStore.setTokenEntry('synthetic-account-a', now + 60_000);
        const error = failure(); const gate = deferred<unknown>(); const started = deferred<undefined>(); let input!: Request;
        const result = resolveDaemonRefusal(error, (request) => { input = request; started.resolve(undefined); return gate.promise; }, current());
        await started.promise;
        if (!pendingChange) { gate.resolve(wire(input)); await result; expect(isSessionClosedError(error)).toBe(true); }
        now += 60_000;
        if (pendingChange) { gate.resolve(wire(input)); await result; }
        expect(daemonRefusalValue(error)).toBeUndefined();
      }
    } finally { clock.mockRestore(); }
  });
});

describe('real HTTP callers await refusal settlement', () => {
  test('requestJson keeps the original HTTP error pending until the genuine reading is available', async () => {
    const gate = deferred<Response>(); const started = deferred<undefined>(); let input!: Request;
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/api/judgment/batteries/run')) {
        input = JSON.parse(String(init?.body)) as Request; started.resolve(undefined); return gate.promise;
      }
      return json({ errorRef: 'synthetic-issued-ref', error: 'Synthetic session detail' }, 409);
    }) as typeof fetch;
    let caught = false;
    const result = capturedFailure(sdk.operator.sessions.close('synthetic-session')).then((error) => { caught = true; return error; });
    await started.promise;
    expect(caught).toBe(false);
    expect(input.input).toEqual({ errorRef: 'synthetic-issued-ref' });
    expect(JSON.stringify(input)).not.toContain('Synthetic session detail');
    expect(JSON.stringify(input)).not.toContain('synthetic-account-a');
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[1]!.init?.headers).get('Authorization')).toBe('Bearer synthetic-account-a');
    gate.resolve(json(wire(input, 409)));
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status: 409, method: 'POST', body: { errorRef: 'synthetic-issued-ref', error: 'Synthetic session detail' } });
    expect((error as Error).message).toContain('/api/sessions/synthetic-session/close failed: 409');
    expect(isSessionClosedError(error)).toBe(true);
  });

  test('judgment transport refusals never recurse and preserve the original HTTP failure', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return String(url).endsWith('/api/judgment/batteries/run')
        ? json({ errorRef: 'synthetic-ref-that-must-not-recurse', error: { code: 'JUDGMENT_REFERENCE_HELD' } }, 422)
        : json({ errorRef: 'synthetic-issued-ref', error: 'Synthetic original detail' }, 409);
    }) as typeof fetch;
    const error = await capturedFailure(sdk.operator.sessions.close('synthetic-session'));
    expect(calls).toHaveLength(2);
    expect(error).toMatchObject({ status: 409, body: { error: 'Synthetic original detail' } });
    expect(daemonRefusalValue(error)).toBeUndefined();
  });

  for (const change of ['abort', 'auth-switch'] as const) {
    test(`requestJson preserves the original HTTP failure after ${change} during interpretation`, async () => {
      const gate = deferred<Response>(); const started = deferred<undefined>(); let input!: Request; let signal!: AbortSignal;
      const abort = new AbortController();
      globalThis.fetch = (async (url, init) => {
        if (!String(url).endsWith('/api/judgment/batteries/run')) return json({ errorRef: 'synthetic-issued-ref', error: 'Synthetic original detail' }, 409);
        input = JSON.parse(String(init?.body)) as Request; signal = init!.signal!; started.resolve(undefined); return gate.promise;
      }) as typeof fetch;
      const result = capturedFailure(sdk.operator.sessions.close('synthetic-session', abort.signal));
      await started.promise;
      if (change === 'abort') abort.abort(); else await tokenStore.setToken('synthetic-account-b');
      expect(signal.aborted).toBe(true);
      gate.resolve(json(wire(input, 409)));
      const error = await result;
      expect(error).toMatchObject({ status: 409, body: { error: 'Synthetic original detail' } });
      expect(daemonRefusalValue(error)).toBeUndefined();
    });
  }

  const callers: [string, () => Promise<unknown>][] = [
    ['sessions.get', () => sdk.operator.sessions.get('synthetic-session')],
    ['sessions.steer', () => sdk.operator.sessions.steer('synthetic-session', { body: 'synthetic message' })],
    ['sessions.followUp', () => sdk.operator.sessions.followUp('synthetic-session', { body: 'synthetic message' })],
    ['sessions.inputs.list', () => sdk.operator.sessions.inputs.list('synthetic-session')],
    ['chat.sessions.create', () => sdk.chat.sessions.create({ title: 'synthetic chat' })],
    ['chat.sessions.get', () => sdk.chat.sessions.get('synthetic-session')],
    ['chat.sessions.list', () => sdk.chat.sessions.list()],
    ['chat.sessions.update', () => sdk.chat.sessions.update('synthetic-session', { title: 'synthetic chat' })],
    ['chat.messages.create', () => sdk.chat.messages.create('synthetic-session', { content: 'synthetic message' })],
    ['chat.messages.list', () => sdk.chat.messages.list('synthetic-session')],
    ['chat.messages.steer', () => sdk.chat.messages.steer('synthetic-session', { content: 'synthetic message' })],
    ['chat.turns.cancel', () => sdk.chat.turns.cancel('synthetic-session')],
  ];
  for (const [name, call] of callers) test(`${name} awaits the actual SDK failure reference`, async () => {
    const gate = deferred<Response>(); const started = deferred<undefined>(); let input!: Request; let count = 0;
    globalThis.fetch = (async (url, init) => {
      count++;
      if (!String(url).endsWith('/api/judgment/batteries/run')) return json({ errorRef: 'synthetic-issued-ref', error: 'Synthetic original detail' }, 404);
      input = JSON.parse(String(init?.body)) as Request; started.resolve(undefined); return gate.promise;
    }) as typeof fetch;
    let settled = false;
    const result = capturedFailure(call()).then((error) => { settled = true; return error; });
    await started.promise;
    expect(settled).toBe(false);
    expect(input.input).toEqual({ errorRef: 'synthetic-issued-ref' });
    gate.resolve(json(wire(input)));
    const error = await result;
    expect(count).toBe(2);
    expect(isSessionClosedError(error)).toBe(true);
    expect(error).toMatchObject({ transport: { status: 404, body: { error: 'Synthetic original detail' } } });
  });

  test('the direct judgment route stays cancellable and never enriches its own refusal', async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(async () => { calls++; return json({ errorRef: 'synthetic-unusable-ref' }, 503); }, { preconnect: originalFetch.preconnect });
    const error = await capturedFailure(runBrowserJudgment(request(), new AbortController().signal));
    expect(error).toMatchObject({ status: 503 });
    expect(calls).toBe(1);
    expect(daemonRefusalValue(error)).toBeUndefined();
  });

  test('an original failure from a stale account is not interpreted under the replacement account', async () => {
    const gate = deferred<Response>(); const started = deferred<undefined>(); let calls = 0;
    const lifetime = getClientLifetime();
    globalThis.fetch = Object.assign(() => { calls++; started.resolve(undefined); return gate.promise; }, { preconnect: originalFetch.preconnect });
    const result = capturedFailure(sdk.operator.sessions.close('synthetic-session'));
    await started.promise; await tokenStore.setToken('synthetic-account-b');
    expect(isClientLifetimeCurrent(lifetime)).toBe(false);
    gate.resolve(json({ errorRef: 'synthetic-issued-ref', error: 'Synthetic original detail' }, 409));
    const error = await result;
    expect(calls).toBe(1);
    expect(error).toMatchObject({ status: 409 });
    expect(daemonRefusalValue(error)).toBeUndefined();
  });
});
