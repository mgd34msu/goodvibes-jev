import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  WEBUI_METHOD_ROUTES,
  WEBUI_WS_INVOKE_METHOD_IDS,
} from '@goodvibes-jev/engine/contracts/generated/webui-facade';
import {
  WEBUI_TOKEN_STORE_KEY,
  getCurrentAuth,
  hostedSessionDetachBeacon,
  isRuntimeDomain,
  isExtraRoutedMethod,
  webuiRouteFor,
  sdk,
} from './goodvibes';
import { getObservedClientCompatibilityFloor } from './client-compatibility';

describe('isRuntimeDomain', () => {
  test('returns true for known domains', () => {
    const known = [
      'session', 'turn', 'providers', 'tools', 'tasks', 'agents', 'contracts',
      'communication', 'planner', 'gate', 'plugins',
      'mcp', 'transport', 'compaction', 'ui', 'ops', 'forensics', 'security',
      'automation', 'routes', 'control-plane', 'deliveries', 'watchers',
      'surfaces', 'knowledge', 'workspace', 'fleet', 'config',
    ];
    for (const domain of known) {
      expect(isRuntimeDomain(domain)).toBe(true);
    }
  });

  test('returns false for unknown domain string', () => {
    expect(isRuntimeDomain('unknown-domain')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isRuntimeDomain('')).toBe(false);
  });

  test('is case-sensitive: uppercase variant is not a domain', () => {
    expect(isRuntimeDomain('Session')).toBe(false);
    expect(isRuntimeDomain('TASKS')).toBe(false);
  });

  test('returns false for partial prefix match', () => {
    expect(isRuntimeDomain('sess')).toBe(false);
    expect(isRuntimeDomain('control')).toBe(false); // 'control-plane' is valid, 'control' is not
  });
});

describe('EXTRA_METHOD_ROUTES retirement (W2B)', () => {
  test('sessions.get/steer/followUp resolve NATIVELY, no EXTRA row', () => {
    // These gained native coverage in the 0.38 browser SDK (SHARED_BROWSER_ROUTES);
    // they must fall through to scopedSdk.operator.invoke, not a hand-written route.
    expect(isExtraRoutedMethod('sessions.get')).toBe(false);
    expect(isExtraRoutedMethod('sessions.steer')).toBe(false);
    expect(isExtraRoutedMethod('sessions.followUp')).toBe(false);
  });

  test('sessions.messages/inputs also resolve natively', () => {
    expect(isExtraRoutedMethod('sessions.messages.list')).toBe(false);
    expect(isExtraRoutedMethod('sessions.messages.create')).toBe(false);
    expect(isExtraRoutedMethod('sessions.inputs.list')).toBe(false);
    expect(isExtraRoutedMethod('sessions.inputs.cancel')).toBe(false);
  });

  test('sessions.close/reopen STILL require their table rows (not in 0.38 shared routes)', () => {
    expect(isExtraRoutedMethod('sessions.close')).toBe(true);
    expect(isExtraRoutedMethod('sessions.reopen')).toBe(true);
  });

  test('the justified survivors remain (SDK-coverage targets)', () => {
    for (const method of [
      'approvals.approve', 'approvals.list', 'models.list', 'models.current.get', 'models.current.set',
      'tasks.list', 'tasks.cancel', 'tasks.retry', 'config.get', 'config.set', 'local_auth.status',
      'companion.chat.sessions.delete',
    ]) {
      expect(isExtraRoutedMethod(method)).toBe(true);
    }
  });

  test('sessions.delete / companion.chat.sessions.close / control.methods.get are table-routed (delete-means-delete)', () => {
    // None of these three ids are in the installed 0.38 OperatorMethodId union
    // (sessions.delete, companion.chat.sessions.close) or have a browser-SDK REST
    // binding (control.methods.get), every one needs its own EXTRA_METHOD_ROUTES row.
    expect(isExtraRoutedMethod('sessions.delete')).toBe(true);
    expect(isExtraRoutedMethod('companion.chat.sessions.close')).toBe(true);
    expect(isExtraRoutedMethod('control.methods.get')).toBe(true);
  });

  test('fleet.*/checkpoints.* are NOT extra-routed. They ride the generic invoke path, not EXTRA_METHOD_ROUTES', () => {
    for (const method of ['fleet.snapshot', 'fleet.list', 'checkpoints.list', 'checkpoints.create', 'checkpoints.diff', 'checkpoints.restore', 'checkpoints.restorePreview']) {
      expect(isExtraRoutedMethod(method)).toBe(false);
    }
  });

  // sessions.changes.get / cost.attribution.get (SDK 1.6.1): `transport: ["ws"]` only,
  // no `http` route, same generic-invoke-only shape as fleet.*/checkpoints.* above, not
  // a table-routed EXTRA_METHOD_ROUTES entry.
  test('sessions.changes.get and cost.attribution.get are NOT extra-routed, generic invoke path', () => {
    expect(isExtraRoutedMethod('sessions.changes.get')).toBe(false);
    expect(isExtraRoutedMethod('cost.attribution.get')).toBe(false);
  });

  // sessions.permissionMode.get/set + sessions.contextUsage.get (SDK 1.6.1): real REST
  // routes with real generated I/O maps, but not in SHARED/KNOWLEDGE_BROWSER_ROUTES,
  // same table-routed shape as sessions.close/reopen above, not the generic-invoke path.
  test('sessions.permissionMode.get/set and sessions.contextUsage.get are table-routed', () => {
    expect(isExtraRoutedMethod('sessions.permissionMode.get')).toBe(true);
    expect(isExtraRoutedMethod('sessions.permissionMode.set')).toBe(true);
    expect(isExtraRoutedMethod('sessions.contextUsage.get')).toBe(true);
  });

  // ci.* (SDK 1.6.1's initiative-family repack): real REST routes with real generated
  // I/O maps, but not in SHARED/KNOWLEDGE_BROWSER_ROUTES, same table-routed shape as
  // sessions.permissionMode.*/contextUsage.get above.
  test('ci.status and ci.watches.* are table-routed', () => {
    expect(isExtraRoutedMethod('ci.status')).toBe(true);
    expect(isExtraRoutedMethod('ci.watches.list')).toBe(true);
    expect(isExtraRoutedMethod('ci.watches.create')).toBe(true);
    expect(isExtraRoutedMethod('ci.watches.delete')).toBe(true);
    expect(isExtraRoutedMethod('ci.watches.run')).toBe(true);
  });

  // checkin.* (SDK 1.6.1's initiative-family repack): same table-routed shape as ci.*
  // above.
  test('checkin.* is table-routed', () => {
    expect(isExtraRoutedMethod('checkin.config.get')).toBe(true);
    expect(isExtraRoutedMethod('checkin.config.set')).toBe(true);
    expect(isExtraRoutedMethod('checkin.receipts.list')).toBe(true);
    expect(isExtraRoutedMethod('checkin.run')).toBe(true);
  });

  // principals.* / channels.profiles.* (SDK 1.6.1's initiative-family repack): same
  // table-routed shape as ci.*/checkin.* above.
  test('principals.* and channels.profiles.* are table-routed', () => {
    for (const method of [
      'principals.create', 'principals.delete', 'principals.get', 'principals.list', 'principals.resolve', 'principals.update',
      'channels.profiles.delete', 'channels.profiles.get', 'channels.profiles.list', 'channels.profiles.set',
    ]) {
      expect(isExtraRoutedMethod(method)).toBe(true);
    }
  });

  // occasions.* (docs/occasions.md, the dates panel): same table-routed shape as
  // checkin.*/ci.*/principals.* above, real REST routes, no browser-SDK coverage.
  test('occasions.* is table-routed', () => {
    for (const method of [
      'occasions.list', 'occasions.pending', 'occasions.propose', 'occasions.confirm', 'occasions.remove',
      'occasions.answer', 'occasions.gifts', 'occasions.sweep', 'occasions.state',
      'occasions.conflict.resolve', 'occasions.interview.get', 'occasions.interview.answer', 'occasions.interview.record',
      'occasions.plans.list', 'occasions.plans.propose', 'occasions.plans.confirm',
    ]) {
      expect(isExtraRoutedMethod(method)).toBe(true);
    }
  });
});

describe('facade route knowledge is generated, not hand-maintained', () => {
  // The drift protection the migration to the generated facade must keep: EXTRA_METHOD_ROUTES
  // is DERIVED ENTIRELY from @goodvibes-jev/engine/contracts/generated/webui-facade
  // (WEBUI_METHOD_ROUTES), not hand-authored. These tests pin that no hand-written row
  // shadows or diverges from a generated one, and that the rest/ws-invoke disposition the
  // webui acts on is the generated one. Until the 2.0.0 re-pin, models.list/models.current/
  // models.select were the sole documented exception (no contract backing at all); the
  // 2.0.0 contract now carries real models.list/models.current.get/models.current.set
  // entries with real REST bindings, so that exception is retired, see the test below.
  const MODELS_METHOD_IDS = ['models.list', 'models.current.get', 'models.current.set'];

  test('every table route matches the generated WEBUI_METHOD_ROUTES artifact EXACTLY (no hand-written row shadows or diverges from a generated one)', () => {
    for (const [methodId, generated] of Object.entries(WEBUI_METHOD_ROUTES)) {
      const resolved = webuiRouteFor(methodId);
      // undefined ⇒ the method is browser-SDK-covered and resolves natively (falls through);
      // present ⇒ it must equal the generated route byte-for-byte.
      if (resolved === undefined) continue;
      expect(resolved, `${methodId}: table route diverges from the generated artifact`).toEqual({
        method: generated.method,
        path: generated.path,
      });
    }
  });

  test('models.list/current.get/current.set now arrive DERIVED from the generated artifact (the 2.0.0 contract gap closed, no more hand-written row)', () => {
    for (const id of MODELS_METHOD_IDS) {
      expect(webuiRouteFor(id), `${id} should be table-routed`).toBeDefined();
    }
  });

  test('no ws-invoke method (per the generated disposition) is shadowed by a REST table row', () => {
    for (const methodId of WEBUI_WS_INVOKE_METHOD_IDS) {
      expect(webuiRouteFor(methodId), `${methodId} must not carry a REST table row (it is ws-invoke-only)`).toBeUndefined();
      expect(isExtraRoutedMethod(methodId)).toBe(false);
    }
  });

  test('the nine profile.* verbs arrive DERIVED: real REST rows from the generated artifact, no hand-written row', () => {
    // The owner profile added no route wiring to goodvibes.ts at all: every row below comes
    // from WEBUI_METHOD_ROUTES via buildExtraMethodRoutes. This pins that they are present,
    // that they are REST (not ws-invoke), and that each resolves to the generated path, so
    // a future contract change to any of these paths fails here rather than at runtime.
    const expected = {
      'profile.read': { method: 'GET', path: '/api/profile' },
      'profile.get': { method: 'GET', path: '/api/profile/fields/{fieldId}' },
      'profile.person': { method: 'POST', path: '/api/profile/person' },
      'profile.provenance': { method: 'GET', path: '/api/profile/fields/{fieldId}/provenance' },
      'profile.set': { method: 'POST', path: '/api/profile/set' },
      'profile.append': { method: 'POST', path: '/api/profile/append' },
      'profile.forget': { method: 'POST', path: '/api/profile/forget' },
      'profile.undo': { method: 'POST', path: '/api/profile/undo' },
      'profile.status': { method: 'GET', path: '/api/profile/status' },
    } as const;
    for (const [id, route] of Object.entries(expected)) {
      expect(webuiRouteFor(id), `${id} should be table-routed from the generated artifact`).toEqual(route);
      expect(isExtraRoutedMethod(id)).toBe(true);
    }
  });

  test('the sixteen occasions.* verbs arrive DERIVED: real REST rows from the generated artifact, no hand-written row', () => {
    // Same shape as the profile.* pin above: DatesView/goodvibes.ts add no route
    // wiring of their own, every row below comes from WEBUI_METHOD_ROUTES via
    // buildExtraMethodRoutes.
    const expected = {
      'occasions.list': { method: 'GET', path: '/api/occasions' },
      'occasions.pending': { method: 'GET', path: '/api/occasions/pending' },
      'occasions.propose': { method: 'POST', path: '/api/occasions/propose' },
      'occasions.confirm': { method: 'POST', path: '/api/occasions/confirm' },
      'occasions.remove': { method: 'POST', path: '/api/occasions/remove' },
      'occasions.answer': { method: 'POST', path: '/api/occasions/answer' },
      'occasions.gifts': { method: 'POST', path: '/api/occasions/gifts' },
      'occasions.sweep': { method: 'POST', path: '/api/occasions/sweep' },
      'occasions.state': { method: 'GET', path: '/api/occasions/state' },
      'occasions.conflict.resolve': { method: 'POST', path: '/api/occasions/conflict/resolve' },
      'occasions.interview.get': { method: 'POST', path: '/api/occasions/interview' },
      'occasions.interview.answer': { method: 'POST', path: '/api/occasions/interview/answer' },
      'occasions.interview.record': { method: 'POST', path: '/api/occasions/interview/record' },
      'occasions.plans.list': { method: 'GET', path: '/api/occasions/plans' },
      'occasions.plans.propose': { method: 'POST', path: '/api/occasions/plans/propose' },
      'occasions.plans.confirm': { method: 'POST', path: '/api/occasions/plans/confirm' },
    } as const;
    for (const [id, route] of Object.entries(expected)) {
      expect(webuiRouteFor(id), `${id} should be table-routed from the generated artifact`).toEqual(route);
      expect(isExtraRoutedMethod(id)).toBe(true);
    }
  });

  // channels.inbox.list (2.0.0 pin): the daemon's unified inbox, Slack DMs, Discord
  // messages, and email threads merged into one feed, distinct from the mail-specific
  // email.inbox.list this app already wires up in ChatView/MailView. No view calls it
  // yet, but it arrives table-routed the same DERIVED way as profile.*/occasions.* above,
  // with no route wiring of its own needed here, this pins that it is genuinely reachable
  // over REST the moment a consumer is built.
  test('channels.inbox.list (the unified inbox verb) arrives DERIVED, real REST row, no hand-written wiring, no consumer yet', () => {
    expect(webuiRouteFor('channels.inbox.list')).toEqual({ method: 'GET', path: '/api/channels/inbox' });
    expect(isExtraRoutedMethod('channels.inbox.list')).toBe(true);
  });

});

describe('sdk.operator.fleet / sdk.operator.checkpoints: generic invoke-by-id', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; method: string; body: unknown }[];

  function stubFetch(responseBody: unknown, status = 200): void {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('fleet.snapshot POSTs to the generic invoke endpoint with an empty body envelope', async () => {
    stubFetch({ capturedAt: 1, nodes: [], truncated: false, totalCount: 0 });
    await sdk.operator.fleet.snapshot();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/control-plane/methods/fleet.snapshot/invoke');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ body: {} });
  });

  test('fleet.list forwards its filter input inside the body envelope', async () => {
    stubFetch({ items: [], hasMore: false, capturedAt: 1 });
    await sdk.operator.fleet.list({ kinds: ['agent'], limit: 10 });
    expect(calls[0].url).toContain('/api/control-plane/methods/fleet.list/invoke');
    expect(calls[0].body).toEqual({ body: { kinds: ['agent'], limit: 10 } });
  });

  test('checkpoints.create forwards kind/label inside the body envelope', async () => {
    stubFetch({ checkpoint: null, noop: true });
    await sdk.operator.checkpoints.create({ kind: 'manual', label: 'test' });
    expect(calls[0].url).toContain('/api/control-plane/methods/checkpoints.create/invoke');
    expect(calls[0].body).toEqual({ body: { kind: 'manual', label: 'test' } });
  });

  test('checkpoints.restore of an unknown id surfaces the daemon\'s honest 404/NOT_FOUND as a thrown error', async () => {
    stubFetch({ error: 'Checkpoint not found: wcp_ghost', code: 'NOT_FOUND' }, 404);
    let caught: unknown;
    try {
      await sdk.operator.checkpoints.restore({ id: 'wcp_ghost' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { status?: number }).status).toBe(404);
  });

  test('sessions.search (typed-client scaffold) POSTs to the generic invoke endpoint with its filter input', async () => {
    stubFetch({ sessions: [], hasMore: false });
    await sdk.operator.sessions.search({ query: 'deploy', includeClosed: true });
    expect(calls[0].url).toContain('/api/control-plane/methods/sessions.search/invoke');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ body: { query: 'deploy', includeClosed: true } });
  });

  test('sessions.search of a route-absent/NOT_INVOKABLE method surfaces the honest error, never silent undefined', async () => {
    stubFetch({ error: 'Method sessions.search is not invokable from this surface', code: 'NOT_INVOKABLE' }, 400);
    let caught: unknown;
    let result: unknown;
    try {
      result = await sdk.operator.sessions.search();
    } catch (error) {
      caught = error;
    }
    expect(result).toBeUndefined();
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { category?: string }).category).toBe('service');
    expect((caught as { body?: unknown }).body).toEqual({ error: 'Method sessions.search is not invokable from this surface', code: 'NOT_INVOKABLE' });
  });

  test('sessions.changes.get POSTs to the generic invoke endpoint with the sessionId', async () => {
    stubFetch({
      sessionId: 's-1', checkpointCount: 0, checkpointIds: [], from: 'EMPTY', to: 'EMPTY',
      files: [], unifiedDiff: '', stat: '',
    });
    await sdk.operator.sessions.changes.get('s-1');
    expect(calls[0].url).toContain('/api/control-plane/methods/sessions.changes.get/invoke');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ body: { sessionId: 's-1' } });
  });

  test('cost.attribution.get POSTs to the generic invoke endpoint with window/dimension', async () => {
    stubFetch({
      window: '24h', windowStartMs: 1, dimension: 'session', totalCostUsd: null, costState: 'unpriced',
      pricedRecordCount: 0, unpricedRecordCount: 0,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      rows: [],
    });
    await sdk.operator.cost.attribution.get({ window: '24h', dimension: 'session' });
    expect(calls[0].url).toContain('/api/control-plane/methods/cost.attribution.get/invoke');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ body: { window: '24h', dimension: 'session' } });
  });
});

describe('delete-means-delete: sessions.delete / chat.sessions.close / control.methods.get wire calls', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; method: string; body: unknown }[];

  function stubFetch(responseBody: unknown, status = 200): void {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('operator.sessions.delete DELETEs /api/sessions/{sessionId} with no body', async () => {
    stubFetch({ sessionId: 'sess-1', deleted: true });
    const result = await sdk.operator.sessions.delete('sess-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/sessions/sess-1');
    expect(calls[0].method).toBe('DELETE');
    expect(result).toEqual({ sessionId: 'sess-1', deleted: true });
  });

  test('operator.sessions.delete surfaces a 409 SESSION_ACTIVE honestly (never a silent success)', async () => {
    stubFetch({ error: 'Session is active; close it, then delete.', code: 'SESSION_ACTIVE' }, 409);
    let caught: unknown;
    try {
      await sdk.operator.sessions.delete('sess-1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { status?: number }).status).toBe(409);
  });

  test('chat.sessions.close POSTs /api/companion/chat/sessions/{sessionId}/close', async () => {
    stubFetch({ sessionId: 'chat-1', status: 'closed' });
    await sdk.chat.sessions.close('chat-1');
    expect(calls[0].url).toContain('/api/companion/chat/sessions/chat-1/close');
    expect(calls[0].method).toBe('POST');
  });

  test('operator.control.methodInfo GETs /api/control-plane/methods/{methodId}', async () => {
    stubFetch({ method: { id: 'sessions.delete', invokable: true } });
    const result = await sdk.operator.control.methodInfo('sessions.delete');
    expect(calls[0].url).toContain('/api/control-plane/methods/sessions.delete');
    expect(calls[0].method).toBe('GET');
    expect(result.method.id).toBe('sessions.delete');
    expect(result.method.invokable).toBe(true);
  });

  test('operator.control.methodInfo of an unregistered id surfaces the honest "Unknown gateway method" 404, never a fake success', async () => {
    stubFetch({ error: 'Unknown gateway method', status: 404 }, 404);
    let caught: unknown;
    try {
      await sdk.operator.control.methodInfo('totally-not-a-real-method');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { status?: number }).status).toBe(404);
    expect((caught as { body?: unknown }).body).toEqual({ error: 'Unknown gateway method', status: 404 });
  });
});

describe('ci.* (SDK 1.6.1 initiative family) wire calls', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; method: string; body: unknown }[];

  function stubFetch(responseBody: unknown, status = 200): void {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('operator.ci.watches.list GETs /api/ci/watches', async () => {
    stubFetch({ watches: [] });
    const result = await sdk.operator.ci.watches.list();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/ci/watches');
    expect(calls[0].method).toBe('GET');
    expect(result).toEqual({ watches: [] });
  });

  test('operator.ci.watches.create POSTs the full body to /api/ci/watches', async () => {
    stubFetch({ watch: { id: 'ciw-1', repo: 'acme/example', deliveryChannel: 'slack:#ci', triggerFixSession: false, createdAt: 1, updatedAt: 1 } });
    await sdk.operator.ci.watches.create({ repo: 'acme/example', deliveryChannel: 'slack:#ci', triggerFixSession: false });
    expect(calls[0].url).toContain('/api/ci/watches');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ repo: 'acme/example', deliveryChannel: 'slack:#ci', triggerFixSession: false });
  });

  test('operator.ci.watches.delete DELETEs /api/ci/watches/{watchId} with no body', async () => {
    stubFetch({ watchId: 'ciw-1', deleted: true });
    const result = await sdk.operator.ci.watches.delete('ciw-1');
    expect(calls[0].url).toContain('/api/ci/watches/ciw-1');
    expect(calls[0].method).toBe('DELETE');
    expect(result).toEqual({ watchId: 'ciw-1', deleted: true });
  });

  test('operator.ci.watches.run POSTs /api/ci/watches/{watchId}/run and returns the full report envelope', async () => {
    const report = { repo: 'acme/example', overall: 'failed' as const, jobs: [{ name: 'lint', status: 'completed' as const, conclusion: 'failure' }], violations: ['job "lint" concluded failure'], checkedAt: 1 };
    stubFetch({ report, notified: true, fixSessionTriggered: false });
    const result = await sdk.operator.ci.watches.run('ciw-1');
    expect(calls[0].url).toContain('/api/ci/watches/ciw-1/run');
    expect(calls[0].method).toBe('POST');
    // The honesty bar: the full per-job report rides through untouched, never collapsed
    // to a bare rollup.
    expect(result.report.jobs).toEqual(report.jobs);
    expect(result.notified).toBe(true);
  });

  test('operator.ci.status POSTs the repo/ref/prNumber body to /api/ci/status', async () => {
    const report = { repo: 'acme/example', ref: 'main', overall: 'passed', jobs: [], violations: [], checkedAt: 1 };
    stubFetch({ report });
    const result = await sdk.operator.ci.status({ repo: 'acme/example', ref: 'main' });
    expect(calls[0].url).toContain('/api/ci/status');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ repo: 'acme/example', ref: 'main' });
    expect(result.report.overall).toBe('passed');
  });
});

describe('checkin.* (SDK 1.6.1 initiative family) wire calls', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; method: string; body: unknown }[];

  function stubFetch(responseBody: unknown, status = 200): void {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('operator.checkin.config.get GETs /api/checkin/config', async () => {
    const config = { enabled: true, cadence: '0 9 * * *', deliveryChannel: 'slack:#daily', quietHours: '22:00-07:00' };
    stubFetch({ config });
    const result = await sdk.operator.checkin.config.get();
    expect(calls[0].url).toContain('/api/checkin/config');
    expect(calls[0].method).toBe('GET');
    expect(result).toEqual({ config });
  });

  test('operator.checkin.config.set POSTs only the provided fields to /api/checkin/config', async () => {
    stubFetch({ config: { enabled: false, cadence: '0 9 * * *', deliveryChannel: 'slack:#daily', quietHours: '22:00-07:00' } });
    await sdk.operator.checkin.config.set({ enabled: false });
    expect(calls[0].url).toContain('/api/checkin/config');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ enabled: false });
  });

  test('operator.checkin.receipts.list GETs /api/checkin/receipts and preserves every receipt field', async () => {
    const receipts = [{ id: 'ckr-1', ranAt: 1, trigger: 'scheduled' as const, outcome: 'skipped-quiet-hours' as const, briefingSummary: 'x', decisionReason: 'quiet hours' }];
    stubFetch({ receipts });
    const result = await sdk.operator.checkin.receipts.list();
    expect(calls[0].url).toContain('/api/checkin/receipts');
    expect(calls[0].method).toBe('GET');
    // The honesty bar: outcome and decisionReason ride through untouched.
    expect(result.receipts).toEqual(receipts);
  });

  test('operator.checkin.run POSTs /api/checkin/run with no body and returns the receipt shape', async () => {
    stubFetch({ outcome: 'delivered', summary: 'All quiet.', deliveryId: 'dlv-1' });
    const result = await sdk.operator.checkin.run();
    expect(calls[0].url).toContain('/api/checkin/run');
    expect(calls[0].method).toBe('POST');
    expect(result).toEqual({ outcome: 'delivered', summary: 'All quiet.', deliveryId: 'dlv-1' });
  });
});

describe('occasions.* (docs/occasions.md, the dates panel) wire calls', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; method: string; body: unknown }[];

  function stubFetch(responseBody: unknown, status = 200): void {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('operator.occasions.list GETs /api/occasions', async () => {
    stubFetch({ today: '2026-07-29', timezone: 'America/Chicago', occasions: [], unparsed: [], conflicts: [] });
    const result = await sdk.operator.occasions.list();
    expect(calls[0].url).toContain('/api/occasions');
    expect(calls[0].method).toBe('GET');
    expect(result.occasions).toEqual([]);
  });

  test('operator.occasions.pending GETs /api/occasions/pending', async () => {
    stubFetch({ today: '2026-07-29', nudge: null, conflicts: [], interviews: [] });
    const result = await sdk.operator.occasions.pending();
    expect(calls[0].url).toContain('/api/occasions/pending');
    expect(calls[0].method).toBe('GET');
    expect(result.nudge).toBeNull();
  });

  test('operator.occasions.plans.list GETs /api/occasions/plans', async () => {
    stubFetch({ today: '2026-07-29', plans: [], unparsed: [], awayNow: null });
    const result = await sdk.operator.occasions.plans.list();
    expect(calls[0].url).toContain('/api/occasions/plans');
    expect(calls[0].method).toBe('GET');
    expect(result.awayNow).toBeNull();
  });

  test('operator.occasions.state GETs /api/occasions/state', async () => {
    stubFetch({ path: '/tmp/occasions-state.json', acknowledgements: 1, giftRecords: 2, openItems: 0, interviews: 0, mirrors: 0, lastSweep: null, corruption: null });
    const result = await sdk.operator.occasions.state();
    expect(calls[0].url).toContain('/api/occasions/state');
    expect(calls[0].method).toBe('GET');
    expect(result.acknowledgements).toBe(1);
  });

  test('operator.occasions.answer POSTs occasionId/answer/occurrence to /api/occasions/answer', async () => {
    stubFetch({ ok: true, reason: null, interview: null });
    await sdk.operator.occasions.answer({ occasionId: 'occ-1', answer: 'yes' });
    expect(calls[0].url).toContain('/api/occasions/answer');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ occasionId: 'occ-1', answer: 'yes' });
  });

  test('operator.occasions.remove POSTs occasionId/confirmed/authority to /api/occasions/remove', async () => {
    stubFetch({ ok: true, reason: null, occasionId: 'occ-1', disclosure: 'Removed.', droppedRecords: 2 });
    const result = await sdk.operator.occasions.remove({ occasionId: 'occ-1', confirmed: true, authority: 'owner-direct' });
    expect(calls[0].url).toContain('/api/occasions/remove');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ occasionId: 'occ-1', confirmed: true, authority: 'owner-direct' });
    expect(result.droppedRecords).toBe(2);
  });

  test('operator.occasions.confirm POSTs the full owner-profile write body to /api/occasions/confirm', async () => {
    stubFetch({ ok: true, reason: null, occasionId: 'occ-new', disclosure: 'Added.', droppedRecords: 0 });
    await sdk.operator.occasions.confirm({
      title: 'Sarah’s birthday', date: '2026-03-14', kind: 'gift-giving', surface: 'webui', said: '(added in the dates panel)', authority: 'owner-direct',
    });
    expect(calls[0].url).toContain('/api/occasions/confirm');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      title: 'Sarah’s birthday', date: '2026-03-14', kind: 'gift-giving', surface: 'webui', said: '(added in the dates panel)', authority: 'owner-direct',
    });
  });

  test('operator.occasions.gifts POSTs occasionId to /api/occasions/gifts', async () => {
    stubFetch({ occasionId: 'occ-1', gifts: [] });
    const result = await sdk.operator.occasions.gifts('occ-1');
    expect(calls[0].url).toContain('/api/occasions/gifts');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ occasionId: 'occ-1' });
    expect(result.gifts).toEqual([]);
  });

  test('operator.occasions.sweep POSTs /api/occasions/sweep with no body and returns the full run receipt', async () => {
    stubFetch({
      ranAt: 1, today: '2026-07-29', hold: null, nudge: null, conflictMessages: [], resumedInterviews: [],
      delivered: false, deliveryChannel: 'telegram', deliveryId: null, mirrored: 0, housekeeping: null,
    });
    const result = await sdk.operator.occasions.sweep();
    expect(calls[0].url).toContain('/api/occasions/sweep');
    expect(calls[0].method).toBe('POST');
    expect(result.delivered).toBe(false);
  });

  test('operator.occasions.conflict.resolve POSTs occasionId to /api/occasions/conflict/resolve', async () => {
    stubFetch({ occasionId: 'occ-1', resolved: true });
    const result = await sdk.operator.occasions.conflict.resolve('occ-1');
    expect(calls[0].url).toContain('/api/occasions/conflict/resolve');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ occasionId: 'occ-1' });
    expect(result.resolved).toBe(true);
  });

  test('operator.occasions.interview.get POSTs interviewId to /api/occasions/interview', async () => {
    stubFetch({ present: false, interview: null });
    const result = await sdk.operator.occasions.interview.get('iv-1');
    expect(calls[0].url).toContain('/api/occasions/interview');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ interviewId: 'iv-1' });
    expect(result.present).toBe(false);
  });

  test('operator.occasions.interview.answer POSTs interviewId/stepId/text to /api/occasions/interview/answer', async () => {
    stubFetch({ present: true, interview: null });
    await sdk.operator.occasions.interview.answer({ interviewId: 'iv-1', stepId: 'step-1', text: 'A scarf' });
    expect(calls[0].url).toContain('/api/occasions/interview/answer');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ interviewId: 'iv-1', stepId: 'step-1', text: 'A scarf' });
  });

  test('operator.occasions.interview.record POSTs interviewId/landedOn to /api/occasions/interview/record', async () => {
    stubFetch({ present: true, interview: null });
    await sdk.operator.occasions.interview.record({ interviewId: 'iv-1', landedOn: 'A scarf' });
    expect(calls[0].url).toContain('/api/occasions/interview/record');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ interviewId: 'iv-1', landedOn: 'A scarf' });
  });

  test('operator.occasions.plans.propose/confirm POST to their own paths', async () => {
    stubFetch({ ok: true, reason: null, line: 'sample', confirmation: 'sample', needsKind: false, conflictsWith: [] });
    await sdk.operator.occasions.plans.propose({ title: 'Lisbon', from: '2026-09-12', to: '2026-09-19', away: true });
    expect(calls[0].url).toContain('/api/occasions/plans/propose');
    expect(calls[0].method).toBe('POST');

    stubFetch({ ok: true, reason: null, occasionId: 'plan-1', disclosure: 'Added.', droppedRecords: 0 });
    await sdk.operator.occasions.plans.confirm({
      title: 'Lisbon', from: '2026-09-12', to: '2026-09-19', away: true, surface: 'webui', said: '(added in the dates panel)', authority: 'owner-direct',
    });
    expect(calls[0].url).toContain('/api/occasions/plans/confirm');
    expect(calls[0].method).toBe('POST');
  });
});

describe('principals.* / channels.profiles.* (SDK 1.6.1 initiative family) wire calls', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; method: string; body: unknown }[];

  function stubFetch(responseBody: unknown, status = 200): void {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('operator.principals.create POSTs the full body to /api/principals', async () => {
    stubFetch({ principal: { id: 'p-1', name: 'Mike', kind: 'user', identities: [], createdAt: 1, updatedAt: 1 } });
    await sdk.operator.principals.create({ name: 'Mike', kind: 'user' });
    expect(calls[0].url).toContain('/api/principals');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ name: 'Mike', kind: 'user' });
  });

  test('operator.principals.update POSTs to /api/principals/{principalId}/update, principalId consumed by the path (not duplicated in the body)', async () => {
    stubFetch({ principal: { id: 'p-1', name: 'Mike D', kind: 'user', identities: [], createdAt: 1, updatedAt: 2 } });
    await sdk.operator.principals.update('p-1', { name: 'Mike D' });
    expect(calls[0].url).toContain('/api/principals/p-1/update');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ name: 'Mike D' });
  });

  test('operator.principals.delete DELETEs /api/principals/{principalId} with no body', async () => {
    stubFetch({ principalId: 'p-1', deleted: true });
    const result = await sdk.operator.principals.delete('p-1');
    expect(calls[0].url).toContain('/api/principals/p-1');
    expect(calls[0].method).toBe('DELETE');
    expect(result).toEqual({ principalId: 'p-1', deleted: true });
  });

  test('operator.principals.resolve POSTs channel/value and preserves known:false for an unmapped identity', async () => {
    const unknown = { id: 'principal-unknown', name: 'unknown', kind: 'user', identities: [], createdAt: 0, updatedAt: 0 };
    stubFetch({ principal: unknown, known: false });
    const result = await sdk.operator.principals.resolve({ channel: 'slack', value: 'U999' });
    expect(calls[0].url).toContain('/api/principals/resolve');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ channel: 'slack', value: 'U999' });
    expect(result.known).toBe(false);
  });

  test('operator.channels.profiles.set POSTs the full binding body to /api/channels/profiles', async () => {
    stubFetch({ binding: { id: 'cp-1', surfaceKind: 'slack', updatedAt: 1 } });
    await sdk.operator.channels.profiles.set({ surfaceKind: 'slack', model: 'claude-sonnet' });
    expect(calls[0].url).toContain('/api/channels/profiles');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ surfaceKind: 'slack', model: 'claude-sonnet' });
  });

  test('operator.channels.profiles.delete DELETEs /api/channels/profiles/{surfaceKind} with an honest deleted boolean', async () => {
    stubFetch({ surfaceKind: 'slack', deleted: false });
    const result = await sdk.operator.channels.profiles.delete('slack');
    expect(calls[0].url).toContain('/api/channels/profiles/slack');
    expect(calls[0].method).toBe('DELETE');
    expect(result.deleted).toBe(false);
  });
});

// Wrong-typed input is a COMPILE error, not a runtime cast. These functions are never
// invoked: each `@ts-expect-error` line fails `tsc --noEmit` the moment the call stops
// erroring ("Unused '@ts-expect-error' directive"), so the typecheck job is the test.
// There is nothing to assert at runtime, so there is deliberately no test() around them.
function typeOnlySessionsSteerRejectsNumericBody(): void {
  // @ts-expect-error -- OperatorMethodInput<'sessions.steer'> requires body: string; this used to silently pass through a removed `as never` cast.
  void sdk.operator.sessions.steer('session-1', { body: 123 });
}
function typeOnlyCheckpointsCreateRejectsUnknownKind(): void {
  // @ts-expect-error -- CheckpointsCreateInput.kind is 'turn' | 'agent-run' | 'manual', not an arbitrary string.
  void sdk.operator.checkpoints.create({ kind: 'not-a-real-kind' });
}
function typeOnlyTasksCreateRejectsNumericTitle(): void {
  // @ts-expect-error -- title is typed string on the generated contract; tasks.create's input flows straight from OperatorMethodInput<'tasks.create'>.
  void sdk.operator.tasks.create({ task: 'x', title: 123 });
}
void typeOnlySessionsSteerRejectsNumericBody;
void typeOnlyCheckpointsCreateRejectsUnknownKind;
void typeOnlyTasksCreateRejectsNumericTitle;

describe('sdk facade rules', () => {
  // The facade's key lists are not pinned here: a namespace a view uses cannot be
  // removed without a compile error in that view, and a snapshot of every key only
  // fails on additions. What IS pinned is the two facts a snapshot cannot express.

  test('every voice.wake verb resolves through a generated REST route, not a hand-written row', () => {
    for (const methodId of ['voice.wake.status', 'voice.wake.provision', 'voice.wake.model.get'] as const) {
      expect(isExtraRoutedMethod(methodId)).toBe(true);
    }
    expect(webuiRouteFor('voice.wake.status')).toEqual({ method: 'GET', path: '/api/voice/wake/status' });
    expect(webuiRouteFor('voice.wake.provision')).toEqual({ method: 'POST', path: '/api/voice/wake/provision' });
    expect(webuiRouteFor('voice.wake.model.get')).toEqual({ method: 'GET', path: '/api/voice/wake/model' });
  });

  test('sdk.chat.sessions.delete still points at the companion delete verb (the honest hard-delete behind the same id)', () => {
    expect(isExtraRoutedMethod('companion.chat.sessions.delete')).toBe(true);
  });
});

// Token honesty: the daemon's control-plane/auth is a STATUS endpoint, it
// answers 200 even for an invalid/expired token, carrying the verdict in the
// `authenticated` boolean (verified against both real daemons and an isolated
// bootDaemon). getCurrentAuth must REJECT on authenticated!==true so the signed-in
// gate + health axis hand off to sign-in instead of leaving the operator in a shell
// where every data endpoint 401s.
describe('getCurrentAuth honors the authenticated field (token-honesty handoff)', () => {
  const original = sdk.auth.current;
  // Deliberate PARTIAL snapshots, the real AuthSnapshot has ~10 fields, but
  // getCurrentAuth only inspects `authenticated`. Cast to the property's type so the
  // stubs stand in without hand-authoring every field.
  const stub = (value: unknown): typeof sdk.auth.current =>
    (() => Promise.resolve(value)) as typeof sdk.auth.current;
  afterEach(() => { sdk.auth.current = original; });

  test('rejects with a 401/authentication error when authenticated is false', async () => {
    sdk.auth.current = stub({ authenticated: false, authMode: 'invalid' });
    let thrown: unknown;
    try { await getCurrentAuth(); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    const err = thrown as { status?: number; category?: string };
    expect(err.status).toBe(401);
    expect(err.category).toBe('authentication');
  });

  test('resolves when authenticated is true', async () => {
    const snapshot = { authenticated: true, authMode: 'shared-token' };
    sdk.auth.current = stub(snapshot);
    expect(await getCurrentAuth()).toEqual(snapshot);
  });

  test('does not misclassify a snapshot with no authenticated field (unknown shape passes through)', async () => {
    const snapshot = { some: 'other-shape' };
    sdk.auth.current = stub(snapshot);
    expect(await getCurrentAuth()).toEqual(snapshot);
  });
});

describe('requestJson records the daemon-announced client-build floor off every response', () => {
  const originalFetch = globalThis.fetch;

  function stubFetch(responseBody: unknown, headers: Record<string, string> = {}): void {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
    ) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('a response carrying X-Goodvibes-Client-Floor updates the observed-floor store', async () => {
    stubFetch({ sessionId: 'sess-1', deleted: true }, { 'X-Goodvibes-Client-Floor': '1.14.0' });
    await sdk.operator.sessions.delete('sess-1');
    expect(getObservedClientCompatibilityFloor()).toBe('1.14.0');
  });

  test('a response with no floor header leaves the store at undefined', async () => {
    stubFetch({ sessionId: 'sess-1', deleted: true });
    await sdk.operator.sessions.delete('sess-1');
    expect(getObservedClientCompatibilityFloor()).toBeUndefined();
  });
});

describe('hostedSessionDetachBeacon: the pagehide/visibilitychange keepalive detach', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.localStorage.removeItem(WEBUI_TOKEN_STORE_KEY);
  });

  test('POSTs to the hosted detach invoke endpoint with keepalive:true and the session/client ids', () => {
    hostedSessionDetachBeacon('hosted-1', 'client-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/control-plane/methods/sessions.hosted.detach/invoke');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.keepalive).toBe(true);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ body: { sessionId: 'hosted-1', clientId: 'client-1' } });
  });

  test('attaches a bearer token read synchronously from localStorage, when one is stored', () => {
    window.localStorage.setItem(WEBUI_TOKEN_STORE_KEY, 'tok_abc123');
    hostedSessionDetachBeacon('hosted-1', 'client-1');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok_abc123');
  });

  test('sends no Authorization header when signed out', () => {
    hostedSessionDetachBeacon('hosted-1', 'client-1');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  test('never throws even if fetch itself throws synchronously', () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new Error('network layer unavailable at teardown');
    }) as unknown as typeof fetch;
    expect(() => hostedSessionDetachBeacon('hosted-1', 'client-1')).not.toThrow();
  });
});
