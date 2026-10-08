import { afterEach, expect, test } from 'bun:test';
import { Client } from 'undici/index.js';
import { createSlackInboxOwner, type SlackInboxAccount, type SlackInboxOwner } from '../sdk/src/platform/intake/providers/slack-owner.ts';
import { digestSender } from '../sdk/src/platform/intake/text-normalization.ts';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 10));
const deferred = () => Promise.withResolvers<void>();

async function fixture(options: { account?: SlackInboxAccount; sourceGate?: Promise<void>; credentialGate?: Promise<void>; authGate?: Promise<void> } = {}) {
  const account = options.account ?? { workspaceId: 'T-ALPHA', userId: 'U-OWNER' };
  let token: string | null = 'xoxb-synthetic-alpha';
  let actualAccount = { ...account };
  let available = true;
  let current = true;
  let credentialReads = 0;
  const calls: { path: string; authorization: string | null; oldest: string | null }[] = [];
  const sourceCalls: { path: string; parts?: readonly string[] }[] = [];
  const text = 'Contact person@example.test, keep the build notes.';
  const ts = `${Math.floor((Date.now() - 2_000) / 1_000)}.000000`;
  const slack = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    calls.push({ path: url.pathname, authorization: request.headers.get('authorization'), oldest: url.searchParams.get('oldest') });
    if (!available) return new Response('{}', { status: 503 });
    if (url.pathname === '/api/auth.test') await options.authGate;
    if (url.pathname === '/api/auth.test') return Response.json({ ok: true, team_id: actualAccount.workspaceId, user_id: actualAccount.userId });
    if (url.pathname === '/api/conversations.list') return Response.json({ ok: true, channels: [{ id: 'D-FIXTURE', user: 'U-SENDER' }] });
    return Response.json({ ok: true, messages: [{ ts, user: 'U-SENDER', text }] });
  } });
  const local = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json() as { messages?: { content: string }[] };
    if (path === '/v1/chat/completions') {
      const source = JSON.parse(body.messages![1]!.content) as { revision: string; parts: string[] };
      sourceCalls.push({ path, parts: source.parts });
      await options.sourceGate;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans: [{ part: 1, start: 8, end: 27 }, { part: 3, start: 8, end: 27 }] }) } }] });
    }
    sourceCalls.push({ path });
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } }, usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  cleanups.push(() => local.stop(true), () => slack.stop(true));
  const signal = new AbortController();
  const owner = await createSlackInboxOwner({ logger: { info() {}, warn() {}, error() {} }, credentials: {
    resolveRef: async () => null,
    async resolveConfigSecret(key) { expect(key).toBe('surfaces.slack.botToken'); credentialReads++; await options.credentialGate; return token; },
  } }, { account, signal: signal.signal, assertCurrent() { if (!current) throw new Error('synthetic-private-scope-marker'); },
    screening: { authority: { ownerId: 'synthetic-local-services', revision: '1', retention: 'ephemeral-no-log', signal: signal.signal, assertCurrent() {} },
      proposal: { endpoint: `http://127.0.0.1:${local.port}`, model: 'synthetic-proposer' },
      judgment: { endpoint: `http://127.0.0.1:${local.port}`, model: 'jev-1.13.0' }, timeoutMs: 1_000 },
  }, { createHttpClient: (_origin, clientOptions) => new Client(`http://127.0.0.1:${slack.port}`, clientOptions) });
  cleanups.push(() => owner.close());
  return { owner, calls, sourceCalls, text, ts, signal, get credentialReads() { return credentialReads; },
    setToken(value: string | null) { token = value; }, setAccount(value: SlackInboxAccount) { actualAccount = value; },
    outage() { available = false; }, revoke() { current = false; } };
}

test('construction is inert; real Slack HTTP and local screening return content-bearing previews', async () => {
  const f = await fixture();
  expect(f.credentialReads).toBe(0); expect(f.calls).toEqual([]); expect(f.sourceCalls).toEqual([]);
  const result = await f.owner.adapter.poll({ limit: 10 });
  expect(result).toMatchObject({ state: 'ready', configured: true, items: [{
    id: `slack:D-FIXTURE:${f.ts}`, provider: 'slack', fromDigest: digestSender('U-SENDER'),
    subjectPreview: 'Direct message', bodyPreview: 'Contact [redacted], keep the build notes.',
  }] });
  expect(result.items[0]?.routeId).toBeUndefined();
  expect(f.calls.map(call => call.path)).toEqual(['/api/auth.test', '/api/conversations.list', '/api/conversations.history']);
  expect(f.sourceCalls[0]?.parts).toEqual(['Direct message', f.text, 'Direct message', f.text]);
});

test.each([{ workspaceId: 'T-OTHER', userId: 'U-OWNER' }, { workspaceId: 'T-ALPHA', userId: 'U-OTHER' }])(
  'a different account %j is withheld before history or source screening', async account => {
    const f = await fixture(); f.setAccount(account);
    expect(await f.owner.adapter.poll({ limit: 10 })).toMatchObject({ state: 'unavailable', configured: true, items: [] });
    expect(f.calls.map(call => call.path)).toEqual(['/api/auth.test']); expect(f.sourceCalls).toEqual([]);
    await expect(f.owner.assertReadCurrent()).rejects.toThrow('scope is unavailable');
  },
);

test('same-account token rotation preserves the stable scope and authenticates the new token', async () => {
  const f = await fixture(); const scope = f.owner.scopeId;
  expect((await f.owner.adapter.poll({ limit: 10 })).state).toBe('ready');
  f.setToken('xoxb-synthetic-rotated');
  await f.owner.assertReadCurrent();
  expect((await f.owner.adapter.poll({ limit: 10 })).state).toBe('ready');
  expect(f.owner.scopeId).toBe(scope); expect(f.calls.at(-1)?.authorization).toBe('Bearer xoxb-synthetic-rotated');
});

test('rotation to a different account cannot authorize previously stored rows', async () => {
  const f = await fixture(); await f.owner.adapter.poll({ limit: 10 });
  f.setToken('xoxb-synthetic-foreign'); f.setAccount({ workspaceId: 'T-ALPHA', userId: 'U-OTHER' });
  await expect(f.owner.assertReadCurrent()).rejects.toThrow('scope is unavailable');
  expect((await f.owner.adapter.poll({ limit: 10 })).items).toEqual([]);
});

test('an unchanged verified credential retains history eligibility during a provider outage', async () => {
  const f = await fixture(); await f.owner.adapter.poll({ limit: 10 }); f.outage();
  expect((await f.owner.adapter.poll({ limit: 10 })).state).toBe('unavailable');
  const before = f.calls.length; await f.owner.assertReadCurrent(); expect(f.calls).toHaveLength(before);
});

test('a token changed during protected mapping discards the entire old poll', async () => {
  const gate = deferred(); cleanups.push(() => gate.resolve());
  const f = await fixture({ sourceGate: gate.promise });
  const pending = f.owner.adapter.poll({ limit: 10 });
  while (f.sourceCalls.length === 0) await pause();
  f.setToken('xoxb-synthetic-rotated'); gate.resolve();
  expect(await pending).toMatchObject({ state: 'unavailable', items: [] });
  expect((await f.owner.adapter.poll({ limit: 10 })).state).toBe('ready');
});

test('scope revocation withholds in-flight source projection without borrowed diagnostics', async () => {
  const gate = deferred(); cleanups.push(() => gate.resolve());
  const f = await fixture({ sourceGate: gate.promise });
  const pending = f.owner.adapter.poll({ limit: 10 }); while (f.sourceCalls.length === 0) await pause();
  f.revoke(); gate.resolve(); const result = await pending;
  expect(result.items).toEqual([]); expect(JSON.stringify(result)).not.toContain('synthetic-private-scope-marker');
  await expect(f.owner.assertReadCurrent()).rejects.toThrow('scope is unavailable');
});

test('close awaits a credential read that outlives cancellation and admits no late requests', async () => {
  const gate = deferred(); cleanups.push(() => gate.resolve());
  const f = await fixture({ credentialGate: gate.promise });
  const pending = f.owner.adapter.poll({ limit: 10 }); while (!f.credentialReads) await pause();
  let closed = false; const closing = f.owner.close().then(() => { closed = true; }); await pause();
  expect(closed).toBe(false); gate.resolve(); await closing;
  expect((await pending).items).toEqual([]); expect(f.calls).toEqual([]);
});

test('missing credentials stay unconfigured and cannot serve previous account data', async () => {
  const f = await fixture(); f.setToken(null);
  expect(await f.owner.adapter.poll({ limit: 10 })).toMatchObject({ state: 'unavailable', configured: false, items: [] });
  await expect(f.owner.assertReadCurrent()).rejects.toThrow('scope is unavailable'); expect(f.calls).toEqual([]);
});

test('account discriminators distinguish users and workspaces without exposing identifiers', async () => {
  const a = await fixture(), b = await fixture({ account: { workspaceId: 'T-ALPHA', userId: 'U-OTHER' } });
  const c = await fixture({ account: { workspaceId: 'T-OTHER', userId: 'U-OWNER' } });
  expect(new Set([a.owner.scopeId, b.owner.scopeId, c.owner.scopeId]).size).toBe(3);
  for (const owner of [a.owner, b.owner, c.owner]) expect(owner.scopeId).toMatch(/^[a-f0-9]{64}$/);
});

test('eligibility authenticates metadata only and retains its signal across fresh same-account probes', async () => {
  const f = await fixture();
  const first = await f.owner.verifyEligibility();
  const second = await f.owner.verifyEligibility();
  expect(first.signal).toBe(second.signal);
  expect(f.calls.map(call => call.path)).toEqual(['/api/auth.test', '/api/auth.test']);
  expect(f.sourceCalls).toEqual([]);
  expect(() => first.assertCurrent()).not.toThrow();
  expect(() => f.owner.adapter.assertCurrent!()).toThrow();
});

test('credential lifecycle invalidates eligibility and poll commit synchronously, including ABA', async () => {
  const f = await fixture();
  const first = await f.owner.verifyEligibility();
  await f.owner.adapter.poll({ limit: 10 });
  expect(() => f.owner.adapter.assertCurrent!()).not.toThrow();
  f.owner.invalidateCredential();
  expect(first.signal.aborted).toBe(true);
  expect(() => first.assertCurrent()).toThrow();
  expect(() => f.owner.adapter.assertCurrent!()).toThrow();
  const before = f.calls.length;
  const next = await f.owner.verifyEligibility();
  expect(next.signal).not.toBe(first.signal);
  expect(f.calls).toHaveLength(before + 1);
});

test('transport failure preserves eligibility, while same-account token rotation requires fresh proof', async () => {
  const f = await fixture();
  const proof = await f.owner.verifyEligibility();
  f.outage();
  await expect(f.owner.verifyEligibility()).rejects.toThrow();
  expect(proof.signal.aborted).toBe(false);
  expect(() => proof.assertCurrent()).not.toThrow();
  f.setToken('xoxb-synthetic-rotated');
  await expect(f.owner.verifyEligibility()).rejects.toThrow();
  expect(proof.signal.aborted).toBe(true);
});

test('same-token account mismatch revokes eligibility without content polling', async () => {
  const f = await fixture();
  const proof = await f.owner.verifyEligibility();
  f.setAccount({ workspaceId: 'T-ALPHA', userId: 'U-FOREIGN' });
  await expect(f.owner.verifyEligibility()).rejects.toThrow();
  expect(proof.signal.aborted).toBe(true);
  expect(f.calls.map(call => call.path)).toEqual(['/api/auth.test', '/api/auth.test']);
});

test('source-held polling retains eligibility until actual scope revocation', async () => {
  const gate = deferred(); cleanups.push(() => gate.resolve());
  const f = await fixture({ sourceGate: gate.promise });
  const proof = await f.owner.verifyEligibility();
  const pending = f.owner.adapter.poll({ limit: 10 });
  while (f.sourceCalls.length === 0) await pause();
  expect(() => proof.assertCurrent()).not.toThrow();
  f.revoke();
  expect(() => proof.assertCurrent()).toThrow();
  expect(proof.signal.aborted).toBe(true);
  gate.resolve(); await pending;
});

test('a stale auth success cannot restore eligibility after credential lifecycle revocation', async () => {
  const gate = deferred(); cleanups.push(() => gate.resolve());
  const f = await fixture({ authGate: gate.promise });
  const pending = f.owner.verifyEligibility();
  void pending.catch(() => {});
  while (f.calls.length === 0) await pause();
  f.owner.invalidateCredential();
  gate.resolve();
  await expect(pending).rejects.toThrow();
  const proof = await f.owner.verifyEligibility();
  expect(() => proof.assertCurrent()).not.toThrow();
  expect(f.calls).toHaveLength(2);
});
