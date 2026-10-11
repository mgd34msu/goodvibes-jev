import { afterEach, expect, test } from 'bun:test';
import { Client } from 'undici/index.js';
import { createDiscordInboxOwner, type DiscordInboxOwnerOptions } from '../sdk/src/platform/intake/providers/discord-owner.ts';
import { createDiscordInboxHttpOwner } from '../sdk/src/platform/intake/providers/discord-http.ts';
import { digestSender } from '../sdk/src/platform/intake/text-normalization.ts';

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const pause = () => new Promise<void>(done => setTimeout(done, 5));
const snowflake = (ms: number) => (BigInt(ms - 1_420_070_400_000) << 22n).toString();
const account = { userId: '100000000000000001' };
const channel = '100000000000000002', sender = '100000000000000003';
async function fixture(options: { credentialGate?: Promise<void>; screeningGate?: Promise<void>; ids?: string[]; privacyRevision?: string } = {}) {
  let token: string | null = 'synthetic-discord-token';
  let actualId = account.userId, bot = true, readable = true, current = true, channelType = 1, channelId = channel;
  let credentialReads = 0, credentialRevision = 0; let pendingCredential = false;
  const calls: { path: string; authorization: string | null }[] = [], sourceCalls: string[] = [];
  const receivedAt = Date.now() - 2_000, id = snowflake(receivedAt);
  const text = 'Contact person@example.test, keep the build notes.';
  const remote = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push({ path, authorization: request.headers.get('authorization') });
    if (path === '/api/v10/users/@me') return Response.json({ id: actualId, bot });
    if (path === `/api/v10/channels/${channel}`) return readable
      ? Response.json({ id: channelId, type: channelType, recipients: [{ id: sender }] }) : new Response(null, { status: 403 });
    if (path === `/api/v10/channels/${channel}/messages`) return Response.json([
      { id, channel_id: channel, author: { id: sender }, content: text },
    ]);
    return new Response(null, { status: 404 });
  } });
  const local = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname; sourceCalls.push(path);
    if (path === '/v1/chat/completions') {
      const body = await request.json() as { messages: { content: string }[] };
      const source = JSON.parse(body.messages[1]!.content) as { revision: string };
      await options.screeningGate;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
        revision: source.revision, spans: [{ part: 1, start: 8, end: 27 }, { part: 3, start: 8, end: 27 }],
      }) } }] });
    }
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } }, usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  cleanups.push(() => local.stop(true), () => remote.stop(true));
  const channelSignal = new AbortController(), privacySignal = new AbortController();
  const ownerOptions: DiscordInboxOwnerOptions = { account,
    channels: { channelIds: options.ids ?? [channel], revision: 'declared-dm-scope-1', signal: channelSignal.signal,
      assertCurrent() { if (!current) throw new Error('private-channel-marker'); } },
    assertCurrent() {}, screening: { authority: { ownerId: 'synthetic-local-screening', revision: options.privacyRevision ?? '1', retention: 'ephemeral-no-log',
      signal: privacySignal.signal, assertCurrent() {} }, proposal: { endpoint: `http://127.0.0.1:${local.port}`, model: 'synthetic-proposer' },
      judgment: { endpoint: `http://127.0.0.1:${local.port}`, model: 'jev-1.13.0' } },
  };
  const owner = await createDiscordInboxOwner({ logger: { info() {}, warn() {}, error() {} },
    credentials: { resolveConfigCredentialSnapshot() { return pendingCredential ? { state: 'unsupported' as const } : token === null
      ? { state: 'absent' as const, revision: String(credentialRevision) } : { state: 'resolved' as const, value: token, revision: String(credentialRevision) }; },
      resolveRef: async () => null, async resolveConfigSecret(key) {
      expect(key).toBe('surfaces.discord.botToken'); credentialReads++; await options.credentialGate; return token;
    } }, resolveRouteId: async () => 'synthetic-profile',
  }, ownerOptions, { createHttpClient(origin, settings) {
    expect(origin).toBe('https://discord.com'); expect(settings.connect).toEqual({ rejectUnauthorized: true });
    return new Client(`http://127.0.0.1:${remote.port}`, settings);
  } });
  cleanups.push(() => owner.close());
  return { owner, ownerOptions, calls, sourceCalls, id, text, channelSignal, privacySignal, get credentialReads() { return credentialReads; },
    setToken(value: string | null) { token = value; credentialRevision++; }, pendingCredential() { pendingCredential = true; }, reassign() { actualId = '100000000000000099'; }, nonBot() { bot = false; },
    denyChannel() { readable = false; }, revokeScope() { current = false; }, changeType(value: number) { channelType = value; },
    replaceChannel() { channelId = '100000000000000088'; },
  };
}
test('construction is inert; authenticated channel/history transport maps a real local screened preview', async () => {
  const f = await fixture(); expect(f.credentialReads).toBe(0); expect(f.calls).toEqual([]);
  const result = await f.owner.adapter.poll({ limit: 10 });
  expect(result).toMatchObject({ state: 'ready', configured: true, items: [{ id: `discord:${channel}:${f.id}`,
    provider: 'discord', kind: 'dm', fromDigest: digestSender(sender), subjectPreview: 'Direct message',
    bodyPreview: 'Contact [redacted], keep the build notes.', routeId: 'synthetic-profile' }] });
  expect(f.calls.map(call => call.path)).toEqual(['/api/v10/users/@me', `/api/v10/channels/${channel}`, `/api/v10/channels/${channel}/messages`]);
  expect(f.sourceCalls.length).toBeGreaterThan(1); expect(JSON.stringify(result)).not.toContain('person@example.test');
  expect(() => f.owner.adapter.assertCurrent!()).not.toThrow();
});
test.each(['reassign', 'nonBot'] as const)('unverified account %s refuses before catalog or private history', async action => {
  const f = await fixture(); f[action]();
  expect(await f.owner.adapter.poll({ limit: 10 })).toMatchObject({ state: 'unavailable', items: [] });
  expect(f.calls.map(call => call.path)).toEqual(['/api/v10/users/@me']); expect(f.sourceCalls).toEqual([]);
});
test.each([0, 2, 4, 15])('guild or unsupported channel type %d never becomes an admitted DM', async type => {
  const f = await fixture(); f.changeType(type);
  expect((await f.owner.adapter.poll({ limit: 10 })).items).toEqual([]);
  expect(f.calls.some(call => call.path.endsWith('/messages'))).toBe(false); expect(f.sourceCalls).toEqual([]);
});
test('every intended channel must be verified; a replaced response cannot authorize a different channel', async () => {
  const f = await fixture(); f.replaceChannel();
  expect((await f.owner.adapter.poll({ limit: 10 })).items).toEqual([]); expect(f.sourceCalls).toEqual([]);
});
test('channel denial revokes read leases and cannot release previously stored previews', async () => {
  const f = await fixture(); await f.owner.adapter.poll({ limit: 10 });
  const lease = await f.owner.acquireReadLease(); f.denyChannel();
  await expect(lease()).rejects.toThrow(); expect(() => lease.assertCurrent!()).toThrow();
  await expect(f.owner.assertReadCurrent()).rejects.toThrow();
});
test('same-token account reassignment is rechecked on every mirror read', async () => {
  const f = await fixture(); await f.owner.adapter.poll({ limit: 10 }); f.reassign();
  await expect(f.owner.acquireReadLease()).rejects.toThrow();
});
test('same-account token rotation preserves scope but requires new authentication', async () => {
  const f = await fixture(); await f.owner.adapter.poll({ limit: 10 }); const scope = f.owner.scopeId;
  f.setToken('synthetic-discord-rotated'); await f.owner.assertReadCurrent();
  expect(f.owner.scopeId).toBe(scope); expect(f.calls.at(-1)?.authorization).toBe('Bot synthetic-discord-rotated');
});
test('credential ABA during local privacy judgment cannot commit old history', async () => {
  const gate = Promise.withResolvers<void>(); cleanups.push(() => gate.resolve());
  const f = await fixture({ screeningGate: gate.promise }); const pending = f.owner.adapter.poll({ limit: 10 });
  while (!f.sourceCalls.length) await pause();
  f.owner.invalidateCredential(); gate.resolve();
  expect((await pending).items).toEqual([]); expect(() => f.owner.adapter.assertCurrent!()).toThrow();
});
test('trusted channel authority and privacy revocations fence polling and mirror reads', async () => {
  const f = await fixture(); await f.owner.adapter.poll({ limit: 10 });
  const proof = await f.owner.verifyEligibility(); f.channelSignal.abort();
  expect(proof.signal.aborted).toBe(true); expect(() => proof.assertCurrent()).toThrow();
  await expect(f.owner.acquireReadLease()).rejects.toThrow();
  const other = await fixture(); await other.owner.adapter.poll({ limit: 10 }); other.privacySignal.abort();
  expect((await other.owner.adapter.poll({ limit: 10 })).items).toEqual([]);
});
test('snapshot copies intended channel membership; untrusted payloads cannot widen it', async () => {
  const ids = [channel], f = await fixture({ ids }); ids.push('100000000000000099');
  expect((await f.owner.adapter.poll({ limit: 10 })).state).toBe('ready');
  expect(f.calls.some(call => call.path.includes('100000000000000099'))).toBe(false);
});
test('missing credential refuses all remote work and previous mirror reads', async () => {
  const f = await fixture(); f.setToken(null);
  expect(await f.owner.adapter.poll({ limit: 10 })).toMatchObject({ state: 'unavailable', configured: false, items: [] });
  await expect(f.owner.assertReadCurrent()).rejects.toThrow(); expect(f.calls).toEqual([]);
});
test('close drains a late credential lookup and admits no late provider request', async () => {
  const gate = Promise.withResolvers<void>(); cleanups.push(() => gate.resolve());
  const f = await fixture({ credentialGate: gate.promise }); const pending = f.owner.adapter.poll({ limit: 10 });
  while (!f.credentialReads) await pause(); let closed = false;
  const closing = f.owner.close().then(() => { closed = true; }); await pause(); expect(closed).toBe(false);
  gate.resolve(); await closing; expect((await pending).items).toEqual([]); expect(f.calls).toEqual([]);
});
test('account scope includes intended catalog and privacy policy revision, independently of secrets', async () => {
  const f = await fixture(), second = await fixture({ ids: ['100000000000000099'] }), third = await fixture({ privacyRevision: '2' });
  expect(new Set([f.owner.scopeId, second.owner.scopeId, third.owner.scopeId]).size).toBe(3); expect(f.owner.scopeId).toMatch(/^[a-f0-9]{64}$/);
});
test('production transport rejects undeclared channels, unsupported DM listing, redirects, credentials and extra query before opening a client', async () => {
  let constructed = 0;
  const owner = createDiscordInboxHttpOwner({ channelIds: [channel], signal: new AbortController().signal, assertCurrent() {},
    createClient() { constructed++; throw new Error('No client should open'); },
  }); cleanups.push(() => owner.close());
  const request = { method: 'GET' as const, headers: { Authorization: 'Bot synthetic-token', Accept: 'application/json' as const } };
  for (const target of ['https://discord.com/api/v10/users/@me/channels', 'https://discord.com/api/v10/channels/999/messages?limit=50&before=111',
    `https://discord.com/api/v10/channels/${channel}/messages?limit=50&before=111&after=1`,
    'https://attacker.invalid/api/v10/users/@me', 'https://user:pass@discord.com/api/v10/users/@me']) {
    await expect(owner.http(new URL(target), request)).rejects.toThrow('not allowed');
  }
  expect(constructed).toBe(0);
});

test('pending credential replacement immediately fences already-acquired read and commit proof', async () => {
  const f = await fixture(); await f.owner.adapter.poll({ limit: 10 }); const read = await f.owner.acquireReadLease();
  f.pendingCredential(); expect(() => read.assertCurrent!()).toThrow(); expect(() => f.owner.adapter.assertCurrent!()).toThrow();
  await expect(f.owner.acquireReadLease()).rejects.toThrow();
});
test('same bytes with a different local incarnation revoke an existing read without a post-write callback', async () => {
  const f = await fixture(); await f.owner.adapter.poll({ limit: 10 }); const read = await f.owner.acquireReadLease();
  f.setToken('synthetic-discord-token'); expect(() => read.assertCurrent!()).toThrow();
});
