import { describe, expect, test } from 'bun:test';
import {
  BROWSER_JUDGMENT_LIMITS as LIMIT,
  BROWSER_JUDGMENT_PATH,
  BrowserJudgmentError,
  browserJudgmentRefusal,
  type BrowserJudgmentErrorCode,
} from '../daemon-sdk/src/browser-judgment-contract.js';
import {
  createBrowserJudgmentHttpHandler,
  dispatchBrowserJudgmentRoutes,
  type BrowserJudgmentCapability,
  type BrowserJudgmentHttpContext,
} from '../daemon-sdk/src/browser-judgment-routes.js';
import type { AuthenticatedPrincipal } from '../daemon-sdk/src/http-policy.js';

// In-process Request/Response fixtures only. No server, provider, or real auth token.
const ORIGIN = 'https://daemon.fixture.invalid';
const CORS_ORIGIN = 'https://client.fixture.invalid';
const PRINCIPAL: AuthenticatedPrincipal = {
  principalId: 'fixture-operator', principalKind: 'user', admin: false, scopes: ['write:judgment'],
};
const REQUEST = {
  protocolVersion: 1, requestId: '12345678-1234-4234-9234-123456789abc',
  battery: 'webui.errors.daemon-refusal', batteryVersion: 1, input: { errorRef: 'fixture-error' },
};
// A service-spy marker, deliberately not represented as a real judgment receipt.
const SERVICE_RESULT = { fixture: 'borrowed-capability-result' };

function request(options: {
  body?: BodyInit | null;
  method?: string;
  path?: string;
  origin?: string | null;
  contentType?: string | null;
  headers?: HeadersInit;
  signal?: AbortSignal;
} = {}): Request {
  const headers = new Headers(options.headers);
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  if (options.contentType !== null) headers.set('content-type', options.contentType ?? 'application/json');
  const method = options.method ?? 'POST';
  return new Request(`${ORIGIN}${options.path ?? BROWSER_JUDGMENT_PATH}`, {
    method, headers, ...(options.signal ? { signal: options.signal } : {}),
    ...(method !== 'GET' && method !== 'HEAD' ? { body: options.body === undefined ? JSON.stringify(REQUEST) : options.body } : {}),
  });
}

function fixture(overrides: Partial<BrowserJudgmentHttpContext> = {}) {
  const calls: { input: unknown; principal: AuthenticatedPrincipal; signal: AbortSignal }[] = [];
  const service: BrowserJudgmentCapability = {
    async execute(input, principal, signal) { calls.push({ input, principal, signal }); return SERVICE_RESULT; },
  };
  const context: BrowserJudgmentHttpContext = {
    authenticate: () => PRINCIPAL,
    sameOrigins: () => [ORIGIN],
    cors: () => ({ enabled: false, allowedOrigins: [] }),
    service,
    ...overrides,
  };
  return { handler: createBrowserJudgmentHttpHandler(context), calls, context };
}

async function expectHeld(response: Response, code: BrowserJudgmentErrorCode): Promise<void> {
  const expected = browserJudgmentRefusal(new BrowserJudgmentError(code));
  expect(response.status).toBe(expected.status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual(expected.body);
}

function streamedBody(chunks: readonly Uint8Array[], onCancel?: () => void | Promise<void>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!onCancel) controller.close();
    },
    ...(onCancel === undefined ? {} : { cancel: onCancel }),
  });
}

describe('browser judgment HTTP authentication and origin admission', () => {
  test('authenticates before inspecting the body or invoking a capability', async () => {
    let bodyReads = 0;
    let originReads = 0;
    const req = request({ body: 'not JSON' });
    Object.defineProperty(req, 'body', { get() { bodyReads++; throw new Error('must not read denied body'); } });
    const { handler, calls } = fixture({
      authenticate: () => null,
      sameOrigins: () => { originReads++; return [ORIGIN]; },
      cors: () => { originReads++; return { enabled: false, allowedOrigins: [] }; },
    });
    await expectHeld(await handler(req), 'JUDGMENT_AUTH_REQUIRED');
    expect(bodyReads).toBe(0);
    expect(originReads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('requires judgment write scope before reading the body', async () => {
    for (const scopes of [[], ['read:judgment'], ['write:sessions'], ['write:judgments']]) {
      const { handler, calls } = fixture({ authenticate: () => ({ ...PRINCIPAL, scopes }) });
      const req = request({ body: 'not JSON' });
      await expectHeld(await handler(req), 'JUDGMENT_ACCESS_DENIED');
      expect(req.bodyUsed).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  test('accepts the required scope, registered wildcard scopes, and administrator access', async () => {
    for (const principal of [PRINCIPAL, { ...PRINCIPAL, scopes: ['write:*'] },
      { ...PRINCIPAL, scopes: ['*'] }, { ...PRINCIPAL, admin: true, scopes: [] }]) {
      const { handler, calls } = fixture({ authenticate: () => principal });
      expect((await handler(request())).status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.principal).toBe(principal);
    }
  });

  test('refuses cookie-style and malformed-bearer requests with no Origin', async () => {
    for (const authorization of [null, '', 'Basic fixture', 'Bearer', 'Bearer fixture extra']) {
      const headers = new Headers({ cookie: 'fixture-session=synthetic' });
      if (authorization !== null) headers.set('authorization', authorization);
      const req = request({ origin: null, headers });
      const { handler, calls } = fixture();
      await expectHeld(await handler(req), 'JUDGMENT_ORIGIN_DENIED');
      expect(req.bodyUsed).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  test('accepts authenticated bearer callers without an Origin', async () => {
    for (const authorization of ['Bearer fixture-only', 'bEaReR fixture-only']) {
      const { handler, calls } = fixture();
      expect((await handler(request({ origin: null, headers: { authorization } }))).status).toBe(200);
      expect(calls).toHaveLength(1);
    }
    const { handler } = fixture({ authenticate: () => null });
    await expectHeld(await handler(request({ origin: null, headers: { authorization: 'Bearer fixture-only' } })),
      'JUDGMENT_AUTH_REQUIRED');
  });

  test('accepts only exact server-configured same-origin values', async () => {
    const { handler, calls } = fixture();
    expect((await handler(request())).status).toBe(200);
    for (const origin of ['null', 'not-an-origin', 'https://untrusted.fixture.invalid',
      `${ORIGIN}/`, `${ORIGIN}:444`, 'http://daemon.fixture.invalid', `${ORIGIN}.attacker.invalid`]) {
      const req = request({ origin });
      await expectHeld(await handler(req), 'JUDGMENT_ORIGIN_DENIED');
      expect(req.bodyUsed).toBe(false);
    }
    expect(calls).toHaveLength(1);
  });

  test('a bearer header does not bypass an explicitly untrusted or null Origin', async () => {
    const { handler, calls } = fixture();
    for (const origin of ['null', CORS_ORIGIN]) {
      await expectHeld(await handler(request({ origin, headers: { authorization: 'Bearer fixture-only' } })),
        'JUDGMENT_ORIGIN_DENIED');
    }
    expect(calls).toHaveLength(0);
  });

  test('does not derive trusted origins from Host or forwarded headers', async () => {
    const { handler, calls } = fixture({ sameOrigins: () => [] });
    await expectHeld(await handler(request({ headers: {
      host: 'daemon.fixture.invalid', 'x-forwarded-host': 'daemon.fixture.invalid',
      'x-forwarded-proto': 'https', forwarded: 'host=daemon.fixture.invalid;proto=https',
    } })), 'JUDGMENT_ORIGIN_DENIED');
    expect(calls).toHaveLength(0);
  });

  test('allows exact CORS origins only when CORS is enabled and explicitly configured', async () => {
    for (const cors of [
      { enabled: false, allowedOrigins: [CORS_ORIGIN] },
      { enabled: true, allowedOrigins: [] },
      { enabled: true, allowedOrigins: ['*'] },
      { enabled: true, allowedOrigins: [`${CORS_ORIGIN}/`] },
    ]) {
      const { handler, calls } = fixture({ cors: () => cors });
      await expectHeld(await handler(request({ origin: CORS_ORIGIN })), 'JUDGMENT_ORIGIN_DENIED');
      expect(calls).toHaveLength(0);
    }
    const { handler, calls } = fixture({ cors: () => ({ enabled: true, allowedOrigins: [CORS_ORIGIN, 'null'] }) });
    expect((await handler(request({ origin: CORS_ORIGIN }))).status).toBe(200);
    await expectHeld(await handler(request({ origin: 'null' })), 'JUDGMENT_ORIGIN_DENIED');
    expect(calls).toHaveLength(1);
  });
});

describe('browser judgment HTTP bounded body admission', () => {
  test('accepts JSON content types with parameters and identity encoding', async () => {
    const { handler, calls } = fixture();
    for (const contentType of ['application/json', 'Application/JSON; charset=utf-8']) {
      expect((await handler(request({ contentType, headers: { 'content-encoding': 'identity' } }))).status).toBe(200);
    }
    expect(calls).toHaveLength(2);
  });

  test('rejects other content types or encodings before consuming the body', async () => {
    const { handler, calls } = fixture();
    for (const req of [request({ contentType: null }), request({ contentType: 'text/plain' }),
      request({ contentType: 'application/problem+json' }), request({ contentType: 'multipart/form-data' }),
      request({ headers: { 'content-encoding': 'gzip' } }), request({ headers: { 'content-encoding': 'br' } })]) {
      await expectHeld(await handler(req), 'JUDGMENT_CONTENT_TYPE_UNSUPPORTED');
      expect(req.bodyUsed).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  test('rejects query parameters and non-POST methods before consuming input', async () => {
    const { handler, calls } = fixture();
    for (const req of [request({ path: `${BROWSER_JUDGMENT_PATH}?route=fixture` }),
      request({ method: 'GET' }), request({ method: 'PUT' }), request({ method: 'DELETE' })]) {
      await expectHeld(await handler(req), 'JUDGMENT_INVALID_INPUT');
      expect(req.bodyUsed).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  test('rejects empty, malformed, and schema-invalid JSON without executing the service', async () => {
    const { handler, calls } = fixture();
    for (const body of [null, '', ' ', '{', '{"input":', 'null', '[]', '{}',
      JSON.stringify({ ...REQUEST, prompt: 'untrusted' }), JSON.stringify({ ...REQUEST, input: { errorRef: '' } })]) {
      await expectHeld(await handler(request({ body })), 'JUDGMENT_INVALID_INPUT');
    }
    expect(calls).toHaveLength(0);
  });

  test('does not replace specific version or battery refusals with generic parse failures', async () => {
    const { handler, calls } = fixture();
    for (const [body, code] of [
      [{ ...REQUEST, protocolVersion: 2 }, 'JUDGMENT_PROTOCOL_VERSION_UNSUPPORTED'],
      [{ ...REQUEST, batteryVersion: 2 }, 'JUDGMENT_BATTERY_VERSION_UNSUPPORTED'],
      [{ ...REQUEST, battery: 'fixture.unknown' }, 'JUDGMENT_BATTERY_UNKNOWN'],
    ] as const) await expectHeld(await handler(request({ body: JSON.stringify(body) })), code);
    expect(calls).toHaveLength(0);
  });

  test('rejects malformed or oversized advertised body lengths', async () => {
    const { handler, calls } = fixture();
    for (const length of ['-1', '1.5', 'not-a-length', String(LIMIT.bodyBytes + 1)]) {
      await expectHeld(await handler(request({ headers: { 'content-length': length } })), 'JUDGMENT_INPUT_TOO_LARGE');
    }
    expect(calls).toHaveLength(0);
  });

  test('admits the byte ceiling and rejects one byte more, regardless of declared length', async () => {
    const json = JSON.stringify(REQUEST);
    const body = json + ' '.repeat(LIMIT.bodyBytes - new TextEncoder().encode(json).byteLength);
    const { handler, calls } = fixture();
    expect((await handler(request({ body, headers: { 'content-length': String(LIMIT.bodyBytes) } }))).status).toBe(200);
    await expectHeld(await handler(request({ body: `${body} ` })), 'JUDGMENT_INPUT_TOO_LARGE');
    await expectHeld(await handler(request({ body: `${body} `, headers: { 'content-length': '1' } })), 'JUDGMENT_INPUT_TOO_LARGE');
    expect(calls).toHaveLength(1);
  });

  test('counts streamed UTF-8 bytes rather than characters against the body ceiling', async () => {
    const body = new TextEncoder().encode('é'.repeat(Math.floor(LIMIT.bodyBytes / 2) + 1));
    const { handler, calls } = fixture();
    await expectHeld(await handler(request({ body: streamedBody([body.slice(0, 100), body.slice(100)]) })),
      'JUDGMENT_INPUT_TOO_LARGE');
    expect(calls).toHaveLength(0);
  });

  test('decodes multibyte characters split across chunks and rejects invalid UTF-8', async () => {
    const json = JSON.stringify({ ...REQUEST, input: { errorRef: 'fixture-é' } });
    const encoded = new TextEncoder().encode(json);
    const split = encoded.indexOf(0xc3) + 1;
    const { handler, calls } = fixture();
    expect((await handler(request({ body: streamedBody([encoded.slice(0, split), encoded.slice(split)]) }))).status).toBe(200);
    for (const bytes of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0xc3])]) {
      await expectHeld(await handler(request({ body: streamedBody([bytes]) })), 'JUDGMENT_INVALID_INPUT');
    }
    expect(calls).toHaveLength(1);
  });

  test('cancels oversized streams without awaiting an uncooperative cancel hook', async () => {
    let cancellations = 0;
    const body = streamedBody([new Uint8Array(LIMIT.bodyBytes + 1)], () => {
      cancellations++;
      return new Promise<void>(() => {});
    });
    const { handler, calls } = fixture();
    await expectHeld(await handler(request({ body })), 'JUDGMENT_INPUT_TOO_LARGE');
    expect(cancellations).toBe(1);
    expect(calls).toHaveLength(0);
  }, 1_000);
});

describe('browser judgment HTTP borrowed execution and cancellation', () => {
  test('passes the validated immutable request, authenticated principal, and request signal to the borrowed service', async () => {
    let authentications = 0;
    const { handler, calls } = fixture({ authenticate: () => { authentications++; return PRINCIPAL; } });
    const req = request();
    const response = await handler(req);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toEqual(SERVICE_RESULT);
    expect(authentications).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual(REQUEST);
    expect(Object.isFrozen(calls[0]!.input)).toBe(true);
    expect(calls[0]!.principal).toBe(PRINCIPAL);
    expect(calls[0]!.signal).toBe(req.signal);
  });

  test('reports an absent capability as unavailable rather than fabricating success', async () => {
    const { handler, calls } = fixture({ service: undefined });
    await expectHeld(await handler(request()), 'JUDGMENT_UNAVAILABLE');
    expect(calls).toHaveLength(0);
  });

  test('preserves known service refusals and scrubs arbitrary service error details', async () => {
    for (const thrown of [new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'), new Error('synthetic-private-detail')]) {
      const { handler } = fixture({ service: { async execute() { throw thrown; } } });
      await expectHeld(await handler(request()), thrown instanceof BrowserJudgmentError ? thrown.code : 'JUDGMENT_UNAVAILABLE');
    }
  });

  test('withholds completed results after authentication, principal, or scope changes', async () => {
    for (const current of [null, { ...PRINCIPAL, principalId: 'fixture-other-operator' },
      { ...PRINCIPAL, scopes: [] }, { ...PRINCIPAL, scopes: ['read:judgment'] }]) {
      let authentications = 0;
      let executions = 0;
      let active = true;
      const { handler } = fixture({
        authenticate: () => { authentications++; return active ? PRINCIPAL : current; },
        service: { async execute() { executions++; active = false; return SERVICE_RESULT; } },
      });
      await expectHeld(await handler(request()), 'JUDGMENT_AUTH_REQUIRED');
      expect(authentications).toBe(3);
      expect(executions).toBe(1);
    }
  });

  test('revocation during body streaming prevents any service admission', async () => {
    let active = true;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      active = false; controller.enqueue(new TextEncoder().encode(JSON.stringify(REQUEST))); controller.close();
    } }, { highWaterMark: 0 });
    const { handler, calls } = fixture({ authenticate: () => active ? PRINCIPAL : null });
    await expectHeld(await handler(request({ body })), 'JUDGMENT_AUTH_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  test('rechecks an administrator who loses judgment access while a run is in flight', async () => {
    let authentications = 0;
    const { handler } = fixture({ authenticate: () => ++authentications === 1
      ? { ...PRINCIPAL, admin: true, scopes: [] } : { ...PRINCIPAL, admin: false, scopes: [] } });
    await expectHeld(await handler(request()), 'JUDGMENT_AUTH_REQUIRED');
  });

  test('aborted requests never invoke the service', async () => {
    const controller = new AbortController();
    controller.abort();
    const { handler, calls } = fixture();
    await expectHeld(await handler(request({ signal: controller.signal })), 'JUDGMENT_ABORTED');
    expect(calls).toHaveLength(0);
  });

  test('aborting a pending body read cancels its stream and holds execution', async () => {
    const controller = new AbortController();
    let cancellations = 0;
    let readStarted!: () => void;
    const reading = new Promise<void>((resolve) => { readStarted = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull() { readStarted(); },
      cancel() { cancellations++; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 });
    const { handler, calls } = fixture();
    const response = handler(request({ body, signal: controller.signal }));
    await reading;
    controller.abort();
    await expectHeld(await response, 'JUDGMENT_ABORTED');
    expect(cancellations).toBe(1);
    expect(calls).toHaveLength(0);
  }, 1_000);

  test('does not publish a service result if the request was aborted during execution', async () => {
    const controller = new AbortController();
    let executed = 0;
    const { handler } = fixture({ service: { async execute(_input, _principal, signal) {
      executed++;
      expect(signal.aborted).toBe(false);
      controller.abort();
      expect(signal.aborted).toBe(true);
      return SERVICE_RESULT;
    } } });
    await expectHeld(await handler(request({ signal: controller.signal })), 'JUDGMENT_ABORTED');
    expect(executed).toBe(1);
  });
});

describe('browser judgment route dispatch', () => {
  test('does not intercept unrelated or prefix-matching paths', () => {
    let calls = 0;
    const handlers = { postBrowserJudgment: () => { calls++; return Response.json(SERVICE_RESULT); } };
    for (const path of ['/api/other', `${BROWSER_JUDGMENT_PATH}/extra`, `${BROWSER_JUDGMENT_PATH}/`]) {
      expect(dispatchBrowserJudgmentRoutes(request({ path }), handlers)).toBeNull();
    }
    expect(calls).toBe(0);
  });

  test('returns an honest unavailable refusal when no handler is installed', async () => {
    const response = await dispatchBrowserJudgmentRoutes(request(), {});
    expect(response).not.toBeNull();
    await expectHeld(response!, 'JUDGMENT_UNAVAILABLE');
  });

  test('rejects wrong methods on the exact route without invoking a handler', async () => {
    let calls = 0;
    const handlers = { postBrowserJudgment: () => { calls++; return Response.json(SERVICE_RESULT); } };
    for (const method of ['GET', 'PUT', 'DELETE']) {
      await expectHeld((await dispatchBrowserJudgmentRoutes(request({ method }), handlers))!, 'JUDGMENT_INVALID_INPUT');
    }
    expect(calls).toBe(0);
  });

  test('forwards the original request and actual handler response without a synthetic success', async () => {
    const req = request();
    const response = Response.json({ fixture: 'actual-handler-response' }, { status: 202 });
    let calls = 0;
    expect(await dispatchBrowserJudgmentRoutes(req, { async postBrowserJudgment(actual) {
      calls++;
      expect(actual).toBe(req);
      return response;
    } })).toBe(response);
    expect(calls).toBe(1);
  });

  test('composed dispatch retains handler admission, no-store, and unavailable behavior', async () => {
    const { handler } = fixture({ service: undefined });
    await expectHeld((await dispatchBrowserJudgmentRoutes(request(), { postBrowserJudgment: handler }))!, 'JUDGMENT_UNAVAILABLE');
    await expectHeld((await dispatchBrowserJudgmentRoutes(request({ path: `${BROWSER_JUDGMENT_PATH}?x=1` }),
      { postBrowserJudgment: handler }))!, 'JUDGMENT_INVALID_INPUT');
  });
});
