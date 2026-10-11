import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, createDaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import { createDiscordInboxOwner } from '@goodvibes-jev/engine/sdk/platform/intake';
import { acquireCrossProcessLock } from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import { SecretsManager } from '../../config/secrets.js';
import { acquireHostedInboxScreening } from '../../runtime/hosted-source-screening-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(grant = true) {
  const root = makeOwnedTempDir('native-hosted-screening');
  const daemonHome = join(root, 'daemon'); mkdirSync(daemonHome);
  const config = new ConfigManager({ homeDir: root, workingDir: root, surfaceRoot: 'daemon', daemonTierPath: join(daemonHome, 'settings.json') });
  if (grant) config.set('surfaces.hostedInboxScreening', 'abacus-typesafe-provider-managed');
  const secrets = new SecretsManager({ globalHome: root, projectRoot: root, daemonHome });
  // Never let a funded ambient key override this explicitly synthetic native fixture.
  for (const key of ['ABACUSAI_API_KEY', 'TYPESAFE_API_KEY']) {
    const old = process.env[key]; delete process.env[key];
    cleanup.push(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  await secrets.set('SYNTHETIC_SCREENING_ABACUS', 'synthetic-abacus-private-value');
  await secrets.set('ABACUSAI_API_KEY', 'goodvibes://secrets/goodvibes/SYNTHETIC_SCREENING_ABACUS');
  await secrets.set('TYPESAFE_API_KEY', 'synthetic-typesafe-private-value');
  const lifecycle = new AbortController();
  const operation = { signal: new AbortController().signal, assertCurrent() {} };
  const acquire = async () => {
    const owner = await acquireHostedInboxScreening({ config, secrets, signal: lifecycle.signal }, 'discord-bot-dms', operation);
    cleanup.push(() => owner.close()); return owner;
  };
  return { root, daemonHome, config, secrets, lifecycle, operation, acquire };
}

test('native opt-in admits only the fixed hosted retention policy with privately resolved aliases', async () => {
  const f = await fixture(), owner = await f.acquire();
  expect('kind' in owner.options && owner.options.kind).toBe('hosted');
  if (!('kind' in owner.options) || owner.options.kind !== 'hosted') throw new Error('Expected exact native hosted options');
  expect(owner.options.authority.retention).toBe('provider-managed-zero-retention-unverified');
  expect(owner.options.credentials).toEqual({ abacusApiKey: 'synthetic-abacus-private-value', typesafeApiKey: 'synthetic-typesafe-private-value' });
  expect(Object.keys(owner.options).sort()).toEqual(['authority', 'credentials', 'kind']);
  expect(owner.options.authority.ownerId).not.toContain('private-value');
  expect(owner.options.authority.revision).not.toContain('private-value');
  owner.options.authority.assertCurrent();
});

test('the default disabled grant refuses before either credential snapshot is resolved', async () => {
  const f = await fixture(false);
  let reads = 0;
  const read = f.secrets.resolveLocalCredentialSnapshot.bind(f.secrets);
  f.secrets.resolveLocalCredentialSnapshot = key => { reads++; return read(key); };
  await expect(f.acquire()).rejects.toThrow('consent'); expect(reads).toBe(0);
});

test('native grant disable and restoration retire the old authority while a fresh admission recovers', async () => {
  const f = await fixture(), old = await f.acquire();
  f.config.set('surfaces.hostedInboxScreening', 'disabled');
  f.config.set('surfaces.hostedInboxScreening', 'abacus-typesafe-provider-managed');
  expect(old.options.authority.signal.aborted).toBe(true);
  expect(() => old.options.authority.assertCurrent()).toThrow();
  const fresh = await f.acquire(); fresh.options.authority.assertCurrent();
  expect(fresh.options.authority.ownerId).not.toBe(old.options.authority.ownerId);
});

test('alias mutation onset retires the original authority and refuses fresh admission while the native write waits', async () => {
  const f = await fixture(), old = await f.acquire();
  const record = (await f.secrets.listDetailed()).find(row => row.key === 'SYNTHETIC_SCREENING_ABACUS');
  if (!record?.path) throw new Error('Expected native stored fixture alias');
  const release = await acquireCrossProcessLock(`${record.path}.mutation.lock`, { strictOwnership: true });
  const pending = f.secrets.set('SYNTHETIC_SCREENING_ABACUS', 'synthetic-replacement-value');
  try {
    expect(f.secrets.getCredentialMutationState().pending).toBe(true);
    expect(old.options.authority.signal.aborted).toBe(true);
    await expect(f.acquire()).rejects.toThrow();
  } finally { release(); await pending; }
  const fresh = await f.acquire(); fresh.options.authority.assertCurrent();
  expect(() => old.options.authority.assertCurrent()).toThrow();
});

test('environment replacement and original account callback mutation cannot be hidden by restored native secrets', async () => {
  const f = await fixture(); process.env.ABACUSAI_API_KEY = 'synthetic-env-first';
  const owner = await f.acquire(); process.env.ABACUSAI_API_KEY = 'synthetic-env-second';
  expect(() => owner.options.authority.assertCurrent()).toThrow('credential changed');
  const fresh = await f.acquire();
  f.operation.assertCurrent = () => { process.env.ABACUSAI_API_KEY = 'synthetic-env-first'; };
  expect(() => fresh.options.authority.assertCurrent()).toThrow();
});

test('an original synchronous account callback cannot mutate the consent and return a still-current authority', async () => {
  const f = await fixture(); let mutate = false;
  const operation = { signal: new AbortController().signal, assertCurrent() {
    if (mutate) { f.config.set('surfaces.hostedInboxScreening', 'disabled'); }
  } };
  const owner = await acquireHostedInboxScreening({ config: f.config, secrets: f.secrets, signal: f.lifecycle.signal }, 'email-inbox', operation);
  cleanup.push(() => owner.close()); mutate = true;
  expect(() => owner.options.authority.assertCurrent()).toThrow();
  expect(owner.options.authority.signal.aborted).toBe(true);
});

test('an async account assertion is refused before an acquisition is exposed', async () => {
  const f = await fixture();
  await expect(acquireHostedInboxScreening({ config: f.config, secrets: f.secrets, signal: f.lifecycle.signal }, 'slack-inbox',
    { signal: new AbortController().signal, async assertCurrent() { throw new Error('Synthetic late failure'); } })).rejects.toThrow('synchronous');
});

test('native daemon shutdown and explicit acquisition close retire all retained authority', async () => {
  const f = await fixture(), owner = await f.acquire(); f.lifecycle.abort();
  expect(owner.options.authority.signal.aborted).toBe(true); expect(() => owner.options.authority.assertCurrent()).toThrow();
  await owner.close(); await owner.close();
});

test('an independent native alias writer restoring its original value cannot reuse the old authority', async () => {
  const f = await fixture(), owner = await f.acquire();
  const writer = new SecretsManager({ globalHome: f.root, projectRoot: f.root, daemonHome: f.daemonHome });
  await writer.set('SYNTHETIC_SCREENING_ABACUS', 'synthetic-other-owner-value');
  await writer.set('SYNTHETIC_SCREENING_ABACUS', 'synthetic-abacus-private-value');
  expect(() => owner.options.authority.assertCurrent()).toThrow();
});

test('physical settings replacement and byte restoration withdraws authority before a reload notification', async () => {
  const f = await fixture(), owner = await f.acquire();
  const path = join(f.daemonHome, 'settings.json'), bytes = readFileSync(path);
  const replacement = join(f.daemonHome, 'synthetic-replacement.json');
  writeFileSync(replacement, JSON.stringify({ surfaces: { hostedInboxScreening: 'disabled' } })); renameSync(replacement, path);
  writeFileSync(replacement, bytes); renameSync(replacement, path);
  expect(f.config.get('surfaces.hostedInboxScreening')).toBe('abacus-typesafe-provider-managed');
  expect(() => owner.options.authority.assertCurrent()).toThrow();
});

async function nativeDiscordOwner(f: Awaited<ReturnType<typeof fixture>>,
  acquisition: Awaited<ReturnType<typeof acquireHostedInboxScreening>>, selection: {
    userId?: string; channelIds?: readonly string[]; revision?: string;
  } = {}) {
  const owner = await createDiscordInboxOwner({ credentials: createDaemonCredentialStore(f.secrets), logger: { info() {}, warn() {}, error() {} } }, {
    account: { userId: selection.userId ?? '100000000000000001' },
    channels: { channelIds: selection.channelIds ?? ['100000000000000002'],
      revision: selection.revision ?? 'same-native-registry-revision', signal: new AbortController().signal, assertCurrent() {} },
    screening: acquisition.options, assertCurrent() {},
  });
  cleanup.push(() => owner.close());
  return owner;
}

test('unchanged native Discord account and registry retain one physical mirror and election scope across genuine admissions', async () => {
  const f = await fixture(), first = await f.acquire(), second = await f.acquire();
  const firstOwner = await nativeDiscordOwner(f, first), secondOwner = await nativeDiscordOwner(f, second);
  // Preserve the independent opposing assertion, using real acquisitions and SDK constructors.
  expect(firstOwner.scopeId).toBe(secondOwner.scopeId);
  expect(first.options.authority.ownerId).not.toBe(second.options.authority.ownerId);
  expect(first.options.authority.revision).not.toBe(second.options.authority.revision);
}, 5_000);

test('hosted Discord physical scopes separate bot, selected DM membership and registry revision while sorting the same registry', async () => {
  const f = await fixture(), acquisition = await f.acquire();
  const original = await nativeDiscordOwner(f, acquisition);
  const otherBot = await nativeDiscordOwner(f, acquisition, { userId: '100000000000000099' });
  const otherChannels = await nativeDiscordOwner(f, acquisition, { channelIds: ['100000000000000099'] });
  const otherRevision = await nativeDiscordOwner(f, acquisition, { revision: 'other-native-registry-revision' });
  expect(new Set([original.scopeId, otherBot.scopeId, otherChannels.scopeId, otherRevision.scopeId]).size).toBe(4);
  const ordered = await nativeDiscordOwner(f, acquisition, { channelIds: ['100000000000000002', '100000000000000003'] });
  const reversed = await nativeDiscordOwner(f, acquisition, { channelIds: ['100000000000000003', '100000000000000002'] });
  expect(ordered.scopeId).toBe(reversed.scopeId);
});

test('hosted Discord credential retirement keeps the physical scope stable while rejecting the old owner before authentication', async () => {
  const f = await fixture(), first = await f.acquire(), oldOwner = await nativeDiscordOwner(f, first);
  await f.secrets.set('SYNTHETIC_SCREENING_ABACUS', 'synthetic-next-native-key');
  expect(first.options.authority.signal.aborted).toBe(true);
  await expect(oldOwner.acquireReadLease()).rejects.toThrow();
  const next = await f.acquire(), newOwner = await nativeDiscordOwner(f, next);
  next.options.authority.assertCurrent();
  expect(newOwner.scopeId).toBe(oldOwner.scopeId);
  expect(next.options.authority.ownerId).not.toBe(first.options.authority.ownerId);
});

test('startup later subscription failure releases the actual earlier native registration', async () => {
  const f = await fixture();
  const subscribe = f.config.onDidChangeIncarnation.bind(f.config);
  let registrations = 0, notifications = 0;
  f.config.onDidChangeIncarnation = listener => {
    const stop = subscribe(() => { notifications++; listener(); }); registrations++;
    return () => { registrations--; stop(); };
  };
  f.config.onDidInvalidate = () => { throw new Error('Synthetic later native subscription failure'); };
  await expect(f.acquire()).rejects.toThrow('later native subscription failure');
  expect(registrations).toBe(0);
  f.config.set('surfaces.slack.workspaceId', 'T-SYNTHETIC-NO-LEAK');
  expect(notifications).toBe(0);
});
