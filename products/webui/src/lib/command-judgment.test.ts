import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import { WEBUI_COMMAND_CATALOG_VERSION } from '@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs';
import { rankCommandSnapshot, readCommandRankResponse } from './command-judgment';
import { getCommands, getCommandRegistryRevision, registerCommand, unregisterCommand } from './commands';
import { sdk, tokenStore } from './goodvibes';
import { closeRelayClient, setActiveRoute } from './relay-connection';
import { clearStoredRelayPairing, storeRelayPairing } from './relay-pairing';
import { WEBUI_TOKEN_STORE_KEY } from './client-lifetime';

type Request = BrowserJudgmentRequest<'webui.palette.command-rank'>;
type Wire = Extract<OperatorMethodOutput<'judgment.battery.run'>, { battery: 'webui.palette.command-rank' }>;
const originalFetch = globalThis.fetch;
const snapshot = () => ({ commands: getCommands(), revision: getCommandRegistryRevision() });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const request = (): Request => ({ protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.palette.command-rank', batteryVersion: 1,
  input: { query: { kind: 'inline', text: 'start over' }, registryVersion: WEBUI_COMMAND_CATALOG_VERSION,
    candidates: [{ kind: 'builtin', commandId: 'chat.new' }, { kind: 'builtin', commandId: 'nav.chat' }] } });
function wire(input: Request, outcome?: 'act'): Extract<Wire, { status: 'settled' }>;
function wire(input: Request, outcome: 'confirm' | 'escalate'): Extract<Wire, { status: 'held' }>;
function wire(input: Request, outcome: 'act' | 'confirm' | 'escalate' = 'act'): Wire {
  const readings = Object.fromEntries(input.input.candidates.map((_, index) => [`candidate_${index}`, {
    kind: 'yes-no' as const, probability: index === 0 ? 0.93 : 0.03, verdict: index === 0 ? 'yes' as const : 'no' as const, outcome: index === 0 ? outcome : 'act' as const,
  }]));
  const common = { protocolVersion: 1, requestId: input.requestId, battery: input.battery, batteryVersion: 1, readings,
    evidence: input.input.candidates.map((_, i) => ({ decisionId: `fixture-decision-${i}`, model: 'fixture-model-v1', requestedModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 })),
  };
  return outcome === 'act' ? { ...common, status: 'settled', outcome,
    value: { registryVersion: input.input.registryVersion, accepted: [{ candidateIndex: 0, probability: 0.93 }], rejected: input.input.candidates.slice(1).map((_, i) => i + 1) } }
    : { ...common, status: 'held', reason: 'uncertain', outcome };
}
beforeEach(async () => {
  for (const command of getCommands()) unregisterCommand(command.id);
  await tokenStore.setToken('offline-fixture-token');
  registerCommand({ id: 'chat.new', title: 'New Chat', group: 'chat', run() {} });
  registerCommand({ id: 'nav.chat', title: 'Go to Chat', group: 'navigation', run() {} });
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await tokenStore.clearToken();
  clearStoredRelayPairing();
  for (const command of getCommands()) unregisterCommand(command.id);
});

describe('authenticated palette reader', () => {
  test('plain-HTTP LAN without crypto.randomUUID still sends a valid request and settles', async () => {
    const original = crypto.randomUUID;
    let requestId = '';
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
    globalThis.fetch = (async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as Request;
      requestId = input.requestId; return response(wire(input));
    }) as typeof fetch;
    try {
      expect((await rankCommandSnapshot('start over', snapshot(), new AbortController().signal)).status).toBe('ready');
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally { Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true, writable: true }); }
  });

  test('request preparation failure settles as unavailable without a payload or HTTP call', async () => {
    const original = crypto.randomUUID;
    let calls = 0;
    Object.defineProperty(crypto, 'randomUUID', { value: () => { throw new Error('untrusted preparation detail'); }, configurable: true, writable: true });
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      calls++; throw new Error('unexpected HTTP');
    }, { preconnect: originalFetch.preconnect });
    try {
      expect(await rankCommandSnapshot('start over', snapshot(), new AbortController().signal)).toEqual({ status: 'unavailable', reason: 'unavailable' });
      expect(calls).toBe(0);
    } finally { Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true, writable: true }); }
  });

  test('sends only the closed candidate identities and query through the real authenticated route', async () => {
    const calls: { url: string; init: RequestInit; input: Request }[] = [];
    const abort = new AbortController();
    globalThis.fetch = (async (url, init) => {
      const input = JSON.parse(String(init?.body)) as Request;
      calls.push({ url: String(url), init: init!, input });
      return response(wire(input));
    }) as typeof fetch;
    const current = snapshot();
    const result = await rankCommandSnapshot('start over', current, abort.signal);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('fixture result missing');
    expect(result.commands.map(({ id }) => id)).toEqual([current.commands[0]!.id]);
    expect(result.isCurrent()).toBe(true);
    expect(result.reading.value.accepted[0]?.probability).toBe(0.93);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe('/api/judgment/batteries/run');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init.signal?.aborted).toBe(false);
    expect(calls[0]!.init.credentials).toBe('include');
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer offline-fixture-token');
    expect(calls[0]!.input.input).toEqual({ query: { kind: 'inline', text: 'start over' }, registryVersion: WEBUI_COMMAND_CATALOG_VERSION,
      candidates: [{ kind: 'builtin', commandId: 'chat.new' }, { kind: 'builtin', commandId: 'nav.chat' }] });
    expect(JSON.stringify(calls[0]!.input)).not.toContain('New Chat');
  });

  test('unknown registrations and oversized query or list hold before HTTP', async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      calls++; throw new Error('unexpected HTTP');
    }, { preconnect: originalFetch.preconnect });
    expect(await rankCommandSnapshot('x'.repeat(257), snapshot(), new AbortController().signal)).toEqual({ status: 'held', reason: 'unsupported' });
    registerCommand({ id: 'chats.open.0', title: 'Chat without a source identity', group: 'chats', run() {} });
    expect(await rankCommandSnapshot('chat', snapshot(), new AbortController().signal)).toEqual({ status: 'held', reason: 'unsupported' });
    unregisterCommand('chats.open.0');
    registerCommand({ id: 'plugin.unknown', title: 'A private local command', group: 'system', run() {} });
    expect(await rankCommandSnapshot('private', snapshot(), new AbortController().signal)).toEqual({ status: 'held', reason: 'unsupported' });
    for (let i = 0; i < 65; i++) registerCommand({ id: `chat-${i}`, title: 'Private chat', group: 'chats', judgmentSource: { kind: 'chat', sessionId: String(i) }, run() {} });
    expect(await rankCommandSnapshot('chat', snapshot(), new AbortController().signal)).toEqual({ status: 'held', reason: 'unsupported' });
    expect(calls).toBe(0);
  });

  test('chat titles, callbacks and local source revisions stay out of HTTP', async () => {
    registerCommand({ id: 'chats.open.fixture', title: 'Private title', group: 'chats', judgmentSource: { kind: 'chat', sessionId: 'fixture-session' }, sourceRevision: 42, run() {} });
    let input!: Request;
    globalThis.fetch = (async (_url, init) => { input = JSON.parse(String(init?.body)) as Request; return response(wire(input)); }) as typeof fetch;
    expect((await rankCommandSnapshot('recent', snapshot(), new AbortController().signal)).status).toBe('ready');
    expect(input.input.candidates).toContainEqual({ kind: 'chat', sessionId: 'fixture-session' });
    for (const text of ['Private title', 'sourceRevision', 'keywords', 'run']) expect(JSON.stringify(input.input)).not.toContain(text);
  });

  test('permission and missing-source refusals remain held, an uninstalled service stays unavailable', async () => {
    for (const [code, expected] of [
      ['JUDGMENT_PERMISSION_HELD', { status: 'held', reason: 'permission' }],
      ['JUDGMENT_REFERENCE_HELD', { status: 'held', reason: 'source' }],
      ['JUDGMENT_UNAVAILABLE', { status: 'unavailable', reason: 'unavailable' }],
    ] as const) {
      globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => response({ protocolVersion: 1, status: 'held', error: { code, message: 'Fixed daemon refusal.' } }, 503)) as typeof fetch;
      expect(await rankCommandSnapshot('chat', snapshot(), new AbortController().signal)).toEqual(expected);
    }
  });

  test('late results cannot use a replaced session revision or registration', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    registerCommand({ id: 'chats.open.fixture', title: 'Same title', group: 'chats', judgmentSource: { kind: 'chat', sessionId: 'fixture-session' }, sourceRevision: 1, run() {} });
    globalThis.fetch = (async (_url, init) => { const input = JSON.parse(String(init?.body)) as Request; entered(); await gate; return response(wire(input)); }) as typeof fetch;
    const pending = rankCommandSnapshot('chat', snapshot(), new AbortController().signal);
    await started;
    registerCommand({ id: 'chats.open.fixture', title: 'Same title', group: 'chats', judgmentSource: { kind: 'chat', sessionId: 'fixture-session' }, sourceRevision: 2, run() {} });
    finish();
    expect(await pending).toEqual({ status: 'unavailable', reason: 'stale' });
  });

  for (const [name, change] of [
    ['logout', () => tokenStore.clearToken()],
    ['account switch', () => sdk.auth.setToken('offline-account-b')],
    ['account A to B to A', async () => { await tokenStore.setToken('offline-account-b'); await tokenStore.setToken('offline-fixture-token'); }],
    ['sign out and back in', async () => { await sdk.auth.clearToken(); await sdk.auth.setToken('offline-fixture-token'); }],
    ['expiring token entry', () => tokenStore.setTokenEntry('offline-account-b', Date.now() + 60_000)],
    ['route away and back', () => { setActiveRoute('relay'); setActiveRoute('direct'); }],
    ['reconnect', () => closeRelayClient()],
    ['pairing replacement and removal', () => { storeRelayPairing({ protocol: 1, relayUrl: 'wss://relay.example.test', rid: 'offline-pairing', daemonPublicKey: 'offline-public-key' }); clearStoredRelayPairing(); }],
    ['another-tab account transition', () => window.dispatchEvent(new window.StorageEvent('storage', { key: WEBUI_TOKEN_STORE_KEY, storageArea: window.localStorage }))],
  ] as const) {
    test(`pending response is stale and its transport is aborted after ${name}`, async () => {
      let pending!: { input: Request; finish: (value: Response) => void; signal: AbortSignal };
      globalThis.fetch = ((_url, init) => new Promise<Response>((finish) => {
        pending = { input: JSON.parse(String(init?.body)) as Request, finish, signal: init!.signal! };
      })) as typeof fetch;
      const result = rankCommandSnapshot('start over', snapshot(), new AbortController().signal);
      while (!pending) await new Promise((resolve) => setTimeout(resolve, 0));
      await change();
      expect(pending.signal.aborted).toBe(true);
      pending.finish(response(wire(pending.input)));
      expect(await result).toEqual({ status: 'unavailable', reason: 'stale' });
    });

    test(`settled direct-caller commands cannot execute after ${name}`, async () => {
      let runs = 0;
      registerCommand({ id: 'chat.new', title: 'New Chat', group: 'chat', run() { runs++; } });
      globalThis.fetch = (async (_url, init) => response(wire(JSON.parse(String(init?.body)) as Request))) as typeof fetch;
      const result = await rankCommandSnapshot('start over', snapshot(), new AbortController().signal);
      if (result.status !== 'ready') throw new Error('fixture reading did not settle');
      expect(result.isCurrent()).toBe(true);
      await change();
      expect(result.isCurrent()).toBe(false);
      result.commands[0]!.run();
      expect(runs).toBe(0);
    });
  }

  test('a direct storage replacement cannot execute a settled callback even before its storage event', async () => {
    let runs = 0;
    registerCommand({ id: 'chat.new', title: 'New Chat', group: 'chat', run() { runs++; } });
    globalThis.fetch = (async (_url, init) => response(wire(JSON.parse(String(init?.body)) as Request))) as typeof fetch;
    const result = await rankCommandSnapshot('start over', snapshot(), new AbortController().signal);
    if (result.status !== 'ready') throw new Error('fixture reading did not settle');
    window.localStorage.setItem(WEBUI_TOKEN_STORE_KEY, 'offline-account-b');
    result.commands[0]!.run();
    expect(runs).toBe(0);
    expect(result.isCurrent()).toBe(false);
  });

  test('an aborted HTTP request cannot produce a late actionable result', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const abort = new AbortController();
    globalThis.fetch = (async (_url, init) => { const input = JSON.parse(String(init?.body)) as Request; entered(); await gate; return response(wire(input)); }) as typeof fetch;
    const pending = rankCommandSnapshot('chat', snapshot(), abort.signal);
    await started; abort.abort(); finish();
    expect(await pending).toEqual({ status: 'unavailable', reason: 'aborted' });
  });

  test('confirm and escalate preserve genuine readings and never expose commands', async () => {
    for (const outcome of ['confirm', 'escalate'] as const) {
      globalThis.fetch = (async (_url, init) => response(wire(JSON.parse(String(init?.body)) as Request, outcome))) as typeof fetch;
      const result = await rankCommandSnapshot('chat', snapshot(), new AbortController().signal);
      expect(result).toMatchObject({ status: 'held', reason: 'uncertain', reading: { outcome, readings: { candidate_0: { outcome } } } });
      expect(result).not.toHaveProperty('commands');
      if (result.status === 'held' && result.reason === 'uncertain') expect(result.reading).not.toHaveProperty('value');
    }
  });
});

describe('response binding before local command selection', () => {
  test('rejects stale identities, fabricated scores, missing candidates and weakened readings', () => {
    const input = request();
    const valid = wire(input);
    expect(readCommandRankResponse(input, valid)).toEqual(valid);
    const bad = [
      { ...valid, requestId: crypto.randomUUID() },
      { ...valid, batteryVersion: 2 },
      { ...valid, value: { ...valid.value!, registryVersion: 'old' } },
      { ...valid, value: { ...valid.value!, accepted: [{ candidateIndex: 0, probability: 0.99 }] } },
      { ...valid, value: { ...valid.value!, rejected: [0] } },
      { ...valid, readings: { candidate_0: valid.readings.candidate_0 } },
      { ...valid, readings: { ...valid.readings, candidate_0: { ...valid.readings.candidate_0, verdict: 'no' } } },
      { ...valid, readings: { ...valid.readings, candidate_0: { ...valid.readings.candidate_0, outcome: 'confirm' } } },
      { ...valid, evidence: [] },
      { ...wire(input, 'confirm'), value: valid.value },
      { ...wire(input, 'escalate'), outcome: 'confirm' },
    ];
    for (const value of bad) expect(readCommandRankResponse(input, value)).toBeUndefined();
  });
});
