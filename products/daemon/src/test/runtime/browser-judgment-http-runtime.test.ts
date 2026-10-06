/** Actual daemon composition and authenticated callers against owned loopback Jev. */
import { expect, spyOn, test } from 'bun:test';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { WEBUI_COMMAND_CATALOG_VERSION } from '@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const PALETTE = 'webui.palette.command-rank';
const ERROR = 'webui.errors.daemon-refusal';
const barrier = () => Promise.withResolvers<void>();
type WireRequest = { readonly state: unknown; readonly questions: Readonly<Record<string, unknown>> };
async function fixture() {
  const calls: WireRequest[] = [];
  let probability = 0.99;
  let beforeAnswer: (() => Promise<void>) | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== '/v1/systemone') return new Response(null, { status: 404 });
    const input = await request.json() as WireRequest;
    calls.push(input); await beforeAnswer?.();
    return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(input.questions).map((name) =>
      [name, { type: 'noul', noul: name === 'match' ? probability : name === 'session_closed' ? 0.99 : 0.01 }])),
      usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const restore = () => { identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); server.stop(true); };
  let daemon: Awaited<ReturnType<typeof startDaemonFixture>>;
  try {
    daemon = await startDaemonFixture({ root: makeOwnedTempDir('browser-judgment-http-runtime'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
      configure(config) { config.set('judgment.endpoint', `http://127.0.0.1:${server.port}`); config.set('judgment.keySource', 'secret'); config.set('judgment.model', 'jev-1.13.0'); },
    });
  } catch (error) { restore(); throw error; }
  const getSecret = daemon.services.secretsManager.get.bind(daemon.services.secretsManager);
  let key: () => Promise<string | null> = async () => 'synthetic-browser-key';
  const secrets = spyOn(daemon.services.secretsManager, 'get').mockImplementation((name) => name === 'TYPESAFE_API_KEY' ? key() : getSecret(name));
  const created = await daemon.fetch('/api/companion/chat/sessions', { method: 'POST', body: JSON.stringify({ title: 'Synthetic café plans' }) });
  if (!created.ok) { await daemon.stop(); secrets.mockRestore(); restore(); throw new Error(await created.text()); }
  const chat = await created.json() as { sessionId: string };
  const palette = (): BrowserJudgmentRequest<'webui.palette.command-rank'> => ({
    protocolVersion: 1, requestId: crypto.randomUUID(), battery: PALETTE, batteryVersion: 1,
    input: { query: { kind: 'inline', text: 'Find synthetic café plans' }, registryVersion: WEBUI_COMMAND_CATALOG_VERSION,
      candidates: [{ kind: 'builtin', commandId: 'nav.chat' }, { kind: 'chat', sessionId: chat.sessionId }] },
  });
  async function wire(input: BrowserJudgmentRequest, options: { token?: string; signal?: AbortSignal } = {}) {
    const response = await fetch(`${daemon.baseUrl}/api/judgment/batteries/run`, { method: 'POST',
      headers: { Authorization: `Bearer ${options.token ?? daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input), ...(options.signal === undefined ? {} : { signal: options.signal }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  return { daemon, calls, chat, palette, wire, setProbability: (value: number) => { probability = value; },
    setBeforeAnswer: (callback: () => Promise<void>) => { beforeAnswer = callback; }, setKey: (callback: () => Promise<string | null>) => { key = callback; },
    async stop() { try { await daemon.stop(); } finally { secrets.mockRestore(); restore(); } },
  };
}

test('production composition ranks genuine host titles, records evidence, and issues canonical error references', async () => {
  const f = await fixture();
  try {
    expect(f.daemon.services.browserJudgment).toBeDefined();
    const response = await f.wire(f.palette());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ status: 'settled', evidence: [{ decisionId: expect.any(String) }, { decisionId: expect.any(String) }] });
    expect(f.calls).toHaveLength(2);
    expect(f.calls.map(call => call.state)).toMatchObject([{ candidate: { title: 'Go to Chat' } }, { candidate: { title: 'Synthetic café plans' } }]);
    expect(JSON.stringify(f.calls)).not.toContain(f.chat.sessionId);
    expect(f.daemon.services.judgment.decisionLog.query({ battery: PALETTE })).toHaveLength(2);
    f.daemon.services.gatewayMethods.register({ id: 'synthetic.browser.failure', title: 'Synthetic failure', description: 'Owned failure source',
      category: 'sessions', access: 'authenticated', source: 'builtin', transport: ['http'], scopes: ['read:sessions'],
    }, async () => { throw new Error('The synthetic conversation has finished and cannot accept this operation.'); });
    const failure = await f.daemon.fetch('/api/control-plane/methods/synthetic.browser.failure/invoke', { method: 'POST', body: '{"body":{}}' });
    const failed = await failure.json() as { errorRef?: string };
    expect(failure.status).toBe(500); expect(failed.errorRef).toBeString(); expect(failure.headers.get('cache-control')).toBe('no-store');
    const interpreted = await f.wire({ protocolVersion: 1, requestId: crypto.randomUUID(), battery: ERROR, batteryVersion: 1, input: { errorRef: failed.errorRef! } });
    expect(interpreted.status, JSON.stringify(interpreted.body)).toBe(200);
    expect(interpreted.body).toMatchObject({ status: 'settled', value: { session_closed: true, method_unknown: false }, structuralBasis: { method_unknown: 'http-status-not-404' } });
    const paired = f.daemon.services.pairingTokens.mint({ name: 'Other synthetic browser' });
    expect((await f.wire({ protocolVersion: 1, requestId: crypto.randomUUID(), battery: ERROR, batteryVersion: 1, input: { errorRef: failed.errorRef! } }, { token: paired.token })).status).toBe(422);
    const known = await f.daemon.fetch('/api/companion/chat/sessions/absent-synthetic-session');
    expect(await known.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(f.calls).toHaveLength(3);
  } finally { await f.stop(); }
}, 30_000);

test('all candidates resolve before transmission; uncertain and missing-key callers remain unusable', async () => {
  const f = await fixture();
  try {
    const input = f.palette();
    const missing = { ...input, input: { ...input.input, candidates: [...input.input.candidates, { kind: 'chat' as const, sessionId: 'absent-synthetic-chat' }] } };
    expect((await f.wire(missing)).status).toBe(422); expect(f.calls).toHaveLength(0);
    f.setProbability(0.5);
    const uncertain = await f.wire(input); expect(uncertain.body.status).toBe('held'); expect(uncertain.body).not.toHaveProperty('value');
    const count = f.calls.length;
    f.setKey(async () => null);
    const absent = await f.wire(f.palette()); expect(absent.status).toBe(503); expect(absent.body).not.toHaveProperty('value'); expect(f.calls).toHaveLength(count);
  } finally { await f.stop(); }
}, 30_000);

test.each(['settings', 'authentication', 'rename', 'shutdown'] as const)('actual %s revocation fences asynchronous key lookup before fetch or retention', async (kind) => {
  const f = await fixture(); const entered = barrier(); const release = barrier();
  f.setKey(async () => { entered.resolve(); await release.promise; return 'synthetic-browser-key'; });
  const paired = f.daemon.services.pairingTokens.mint({ name: 'Synthetic browser authority' });
  const pending = f.wire(f.palette(), { token: paired.token }).catch((error: unknown) => error);
  try {
    await entered.promise;
    if (kind === 'settings') f.daemon.services.configManager.set('judgment.timeoutMs', 11_000);
    if (kind === 'authentication') expect(f.daemon.services.pairingTokens.revoke(paired.id)).toBe(true);
    if (kind === 'rename') {
      const changed = await f.daemon.fetch(`/api/companion/chat/sessions/${f.chat.sessionId}`, { method: 'PATCH', body: JSON.stringify({ title: 'Changed synthetic title' }) });
      expect(changed.status).toBe(200);
    }
    if (kind === 'shutdown') await f.daemon.services.browserJudgment!.close();
    release.resolve();
    const result = await pending;
    expect(result).not.toMatchObject({ status: 200 });
    expect(f.calls).toHaveLength(0);
    expect(f.daemon.services.judgment.decisionLog.query({ battery: PALETTE })).toEqual([]);
  } finally { release.resolve(); await pending; await f.stop(); }
}, 30_000);

test('revocation after provider dispatch prevents retained answers; a fresh request uses the new source', async () => {
  const f = await fixture(); const entered = barrier(); const release = barrier();
  f.setBeforeAnswer(async () => { entered.resolve(); await release.promise; });
  const pending = f.wire(f.palette());
  try {
    await entered.promise;
    await f.daemon.fetch(`/api/companion/chat/sessions/${f.chat.sessionId}`, { method: 'PATCH', body: JSON.stringify({ title: 'Changed synthetic title' }) });
    release.resolve();
    expect((await pending).status).toBe(422);
    expect(f.daemon.services.judgment.decisionLog.query({ battery: PALETTE })).toEqual([]);
    expect((await f.wire(f.palette())).status).toBe(200);
    expect(f.calls.at(-1)?.state).toMatchObject({ candidate: { title: 'Changed synthetic title' } });
  } finally { release.resolve(); await pending.catch(() => {}); await f.stop(); }
}, 30_000);
