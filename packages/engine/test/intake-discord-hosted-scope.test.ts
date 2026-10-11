import { afterEach, expect, test } from 'bun:test';
import { Client } from 'undici/index.js';
import { createDiscordInboxOwner } from '../sdk/src/platform/intake/providers/discord-owner.ts';
import type { ProtectedSourceOwnerOptions } from '../sdk/src/platform/security/source-screening/types.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const botId = '100000000000000001';
const channelId = '100000000000000002';
const otherChannelId = '100000000000000003';

async function fixture(input: {
  userId?: string;
  channelIds?: readonly string[];
  registryRevision?: string;
  grantId?: string;
  grantRevision?: string;
  abacusApiKey?: string;
  typesafeApiKey?: string;
  local?: boolean;
  credentialGate?: Promise<void>;
} = {}) {
  const userId = input.userId ?? botId;
  const channelIds = input.channelIds ?? [channelId];
  const grantSignal = new AbortController();
  let grantCurrent = true;
  let credentialRevision = 1;
  let credentialReads = 0;
  const calls: string[] = [];
  const token = 'synthetic-hosted-discord-token';
  const remote = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push(path);
    expect(request.headers.get('authorization')).toBe(`Bot ${token}`);
    if (path === '/api/v10/users/@me') return Response.json({ id: userId, bot: true });
    for (const id of channelIds) {
      if (path === `/api/v10/channels/${id}`) return Response.json({ id, type: 1 });
    }
    return new Response(null, { status: 404 });
  } });
  cleanups.push(() => remote.stop(true));
  const authority = {
    ownerId: input.grantId ?? 'synthetic-hosted-grant-1',
    revision: input.grantRevision ?? 'synthetic-hosted-revision-1',
    signal: grantSignal.signal,
    assertCurrent() { if (!grantCurrent) throw new Error('Synthetic grant retired'); },
  };
  const screening: ProtectedSourceOwnerOptions = input.local ? {
    authority: { ...authority, retention: 'ephemeral-no-log' },
    proposal: { endpoint: `http://127.0.0.1:${remote.port}`, model: 'synthetic-local-proposer' },
    judgment: { endpoint: `http://127.0.0.1:${remote.port}`, model: 'jev-1.13.0' },
  } : {
    kind: 'hosted',
    authority: { ...authority, kind: 'hosted', retention: 'provider-managed-zero-retention-unverified' },
    credentials: {
      abacusApiKey: input.abacusApiKey ?? 'synthetic-hosted-abacus-key-1',
      typesafeApiKey: input.typesafeApiKey ?? 'synthetic-hosted-typesafe-key-1',
    },
  };
  const owner = await createDiscordInboxOwner({
    logger: { info() {}, warn() {}, error() {} },
    credentials: {
      resolveRef: async () => null,
      resolveConfigCredentialSnapshot() { return { state: 'resolved', value: token, revision: String(credentialRevision) }; },
      async resolveConfigSecret(key) {
        expect(key).toBe('surfaces.discord.botToken');
        credentialReads++;
        await input.credentialGate;
        return token;
      },
    },
  }, {
    account: { userId },
    channels: { channelIds, revision: input.registryRevision ?? 'synthetic-native-registry-1',
      signal: new AbortController().signal, assertCurrent() {} },
    screening, assertCurrent() {},
  }, { createHttpClient(origin, options) {
    expect(origin).toBe('https://discord.com');
    expect(options.connect).toEqual({ rejectUnauthorized: true });
    return new Client(`http://127.0.0.1:${remote.port}`, options);
  } });
  cleanups.push(() => owner.close());
  return { owner, calls, grantSignal, screening, get credentialReads() { return credentialReads; },
    retireGrant() { grantCurrent = false; },
    replaceSameCredential() { credentialRevision++; },
  };
}

test('hosted scope survives distinct admissions, credential snapshots and channel ordering without reading providers', async () => {
  const first = await fixture({ channelIds: [channelId, otherChannelId] });
  const second = await fixture({ channelIds: [otherChannelId, channelId], grantId: 'synthetic-hosted-grant-2',
    grantRevision: 'synthetic-hosted-revision-2', abacusApiKey: 'synthetic-hosted-abacus-key-2',
    typesafeApiKey: 'synthetic-hosted-typesafe-key-2' });
  expect(first.owner.scopeId).toBe(second.owner.scopeId);
  expect(first.owner.scopeId).toMatch(/^[a-f0-9]{64}$/);
  expect(first.screening.authority.ownerId).not.toBe(second.screening.authority.ownerId);
  expect(first.screening.authority.revision).not.toBe(second.screening.authority.revision);
  expect(first.calls).toEqual([]); expect(second.calls).toEqual([]);
  expect(first.credentialReads).toBe(0); expect(second.credentialReads).toBe(0);
});

test('hosted scope separates bot accounts, exact channel membership and registry revisions', async () => {
  const original = await fixture();
  const account = await fixture({ userId: '100000000000000099' });
  const channels = await fixture({ channelIds: [otherChannelId] });
  const registry = await fixture({ registryRevision: 'synthetic-native-registry-2' });
  expect(new Set([original.owner.scopeId, account.owner.scopeId, channels.owner.scopeId, registry.owner.scopeId]).size).toBe(4);
});

test('local authority strings cannot collide with the fixed hosted policy scope', async () => {
  const hosted = await fixture();
  const local = await fixture({ local: true, grantId: 'abacus-route-llm+typesafe-jev-1.13.0',
    grantRevision: 'provider-managed-zero-retention-unverified' });
  expect(local.owner.scopeId).not.toBe(hosted.owner.scopeId);
});

test.each(['signal', 'currentness'])('stable hosted scope never restores a grant retired through %s', async retirement => {
  const retired = await fixture();
  const fresh = await fixture({ grantId: 'synthetic-independent-grant', grantRevision: 'synthetic-independent-revision' });
  const proof = await retired.owner.verifyEligibility();
  const read = await retired.owner.acquireReadLease();
  const assertReadCurrent = read.assertCurrent;
  if (!assertReadCurrent) throw new Error('Native Discord read lease lacks currentness proof');
  const freshProof = await fresh.owner.verifyEligibility();
  expect(retired.owner.scopeId).toBe(fresh.owner.scopeId);
  const requests = retired.calls.length;
  if (retirement === 'signal') retired.grantSignal.abort(); else retired.retireGrant();
  expect(() => proof.assertCurrent()).toThrow();
  expect(proof.signal.aborted).toBe(true);
  expect(() => assertReadCurrent()).toThrow();
  await expect(read()).rejects.toThrow();
  await expect(retired.owner.acquireReadLease()).rejects.toThrow();
  expect(retired.calls.length).toBe(requests);
  expect(() => freshProof.assertCurrent()).not.toThrow();
});

test('hosted scope stability leaves same-byte native credential incarnation revocation intact', async () => {
  const current = await fixture();
  const scope = current.owner.scopeId;
  const proof = await current.owner.verifyEligibility();
  const read = await current.owner.acquireReadLease();
  const assertReadCurrent = read.assertCurrent;
  if (!assertReadCurrent) throw new Error('Native Discord read lease lacks currentness proof');
  current.replaceSameCredential();
  expect(() => assertReadCurrent()).toThrow();
  expect(() => proof.assertCurrent()).toThrow();
  expect(proof.signal.aborted).toBe(true);
  expect(current.owner.scopeId).toBe(scope);
});

test('retiring a hosted grant during credential acquisition drains without a late Discord request', async () => {
  const gate = Promise.withResolvers<void>();
  const current = await fixture({ credentialGate: gate.promise });
  cleanups.push(() => gate.resolve());
  const reading = current.owner.verifyEligibility();
  while (!current.credentialReads) await new Promise<void>(done => setTimeout(done, 5));
  current.grantSignal.abort();
  gate.resolve();
  await expect(reading).rejects.toThrow();
  expect(current.calls).toEqual([]);
});
