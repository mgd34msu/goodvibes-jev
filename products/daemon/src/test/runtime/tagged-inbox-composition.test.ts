import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager, daemonSecretKeyFor } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { createTriageTagger, type OwnedInboxSource, type InboundChannelItem, type ImapStoreArgs } from '@goodvibes-jev/engine/sdk/platform/intake';
import { acquireCrossProcessLock } from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import { SecretsManager } from '../../config/secrets.js';
import { createDaemonTriageTaggingFactory } from '../../runtime/tagged-inbox-composition.js';
import { gateReadingsPort } from '../helpers/synthetic-gate-readings.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sharedKey = daemonSecretKeyFor('surfaces.email.password');
const imapKey = daemonSecretKeyFor('surfaces.email.imap.password');
const slackKey = daemonSecretKeyFor('surfaces.slack.botToken');
const plain = { scope: 'daemon', medium: 'plaintext' } as const;
async function fixture(provider: 'slack' | 'email' = 'slack') {
  const root = makeOwnedTempDir('tagged-inbox-composition');
  const config = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'daemon' });
  const secrets = new SecretsManager({ projectRoot: root, globalHome: root, daemonHome: join(root, 'daemon'), policy: 'plaintext_allowed' });
  const key = provider === 'slack' ? slackKey : imapKey;
  await secrets.set(key, 'synthetic-one', plain);
  const log = new SqliteDecisionLog(':memory:'); cleanups.push(() => log[Symbol.dispose]());
  let meaning = 'normal';
  let outcome = 'act', hook: (() => void | Promise<void>) | undefined, humans = 0;
  const readings: unknown[] = [];
  const semantic = fakePort((_name, question) => choiceAnswer(question, _name === 'meaning' ? meaning : outcome, 0.99));
  const gate = gateReadingsPort();
  const port: JudgmentPort = withDecisionLog({ model: gate.port.model, async ask(request) {
    readings.push(request.state); request.beforeAttempt?.(); await hook?.(); request.beforeAttempt?.();
    return 'meaning' in request.questions || 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log);
  const previous = installJudgmentPort(port); cleanups.push(() => { installJudgmentPort(previous); });
  const permissionManager = new PermissionManager(async () => { humans++; throw new Error('No human'); }, createPermissionConfigReader(config), new PolicyRuntimeState());
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const stopConfig = config.onDidInvalidate(() => { for (const listener of listeners) listener(); });
  const stopSecrets = secrets.onDidChange(() => { for (const listener of listeners) listener(); });
  cleanups.push(() => { stopConfig(); stopSecrets(); });
  let row: InboundChannelItem = { id: provider === 'slack' ? 'slack:C123:123.456' : 'email:account:0000000007:0000000042', provider, kind: 'dm', fromDigest: '0123456789abcdef', subjectPreview: 'Protected subject', bodyPreview: 'PRIVATE_PREVIEW_EXCLUDED_FROM_MUTATION_JUDGMENT', receivedAt: 1, unread: true };
  let released = 0;
  const source: OwnedInboxSource = { providerIds: [provider], ready: Promise.resolve(), async close() {}, unregister() {}, async acquireRead() {
    return { providerIds: [provider], sources: { store: { listItems: () => [structuredClone(row)], countItems: () => 1, countItemsByProvider: () => new Map([[provider, 1]]), maxReceivedAt: () => 1, getImapCheckpoint: () => null }, poller: { snapshotStatuses: () => [], isProviderRunning: () => false } }, assertCurrent() {}, async validate() {}, release() { released++; } };
  } };
  const writes: Array<{ url?: string; init?: RequestInit; imap?: ImapStoreArgs }> = [];
  const create = createDaemonTriageTaggingFactory({ host: { permissionManager, port, signal: lifetime.signal }, secrets,
    onInvalidate(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, assertCurrent() {} }, {
    createTagger: options => createTriageTagger({ ...options,
      http: (async (url: string | URL | Request, init?: RequestInit) => { writes.push({ url: String(url), init }); return Response.json({ ok: true }); }) as unknown as typeof fetch,
      imapStoreFlag: async args => { args.assertCurrent(); writes.push({ imap: args }); },
    }),
  });
  const owner = create({ source, provider, accountScopeId: 'account', assertCurrent() {}, ...(provider === 'email' ? { imap: { host: 'mail.invalid', port: 993, user: 'synthetic', mailbox: 'INBOX' } } : {}) });
  cleanups.push(() => owner.close());
  const operation = { sourceOf: () => ({ goal: 'Apply a priority triage tag to the selected message', criteria: ['Only the selected current message'] }), assertCurrent() {} };
  return { secrets, config, port, source, writes, readings, owner, operation, id: row.id, lifetime,
    setHook(value: typeof hook) { hook = value; }, setOutcome(value: string) { outcome = value; }, setMeaning(value: string) { meaning = value; }, mutate() { row = { ...row, bodyPreview: 'replacement' }; }, get humans() { return humans; }, get released() { return released; },
  };
}

test('actual product credential factory feeds Slack fixed effect through authentic recorded admission', async () => {
  const f = await fixture(); await f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation);
  expect(f.writes).toHaveLength(1); expect(f.writes[0]!.url).toBe('https://slack.com/api/reactions.add');
  expect(f.writes[0]!.init!.headers).toMatchObject({ Authorization: 'Bearer synthetic-one' });
  expect(f.humans).toBe(0); expect(f.released).toBe(1);
  expect(JSON.stringify(f.readings)).not.toContain('synthetic-one');
  expect(JSON.stringify(f.readings)).not.toContain('PRIVATE_PREVIEW');
});
test('email factory uses canonical shared-to-IMAP fallback and exact UIDVALIDITY target', async () => {
  const f = await fixture('email'); await f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation);
  expect(f.writes[0]!.imap).toMatchObject({ password: 'synthetic-one', mailbox: 'INBOX', uid: '42', uidValidity: 7, flag: 'GoodVibes_Priority' });
});
test('email shared winner takes precedence over the IMAP fallback', async () => {
  const f = await fixture('email'); await f.secrets.set(sharedKey, 'shared-winner', plain);
  await f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation); expect(f.writes[0]!.imap!.password).toBe('shared-winner');
});
test('email absent predecessor becoming present during admission refuses the old fallback', async () => {
  const f = await fixture('email'); let once = false;
  f.setHook(async () => { if (!once) { once = true; await f.secrets.set(sharedKey, 'new-shared', plain); } });
  await expect(f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.writes).toHaveLength(0);
});
test('managed aliases and daemon literal envelopes resolve exactly like asynchronous get', async () => {
  const f = await fixture(); await f.secrets.set(slackKey, 'goodvibes://secrets/goodvibes/LOCAL_TAG_ALIAS', plain);
  await f.secrets.set('LOCAL_TAG_ALIAS', 'op://synthetic-vault/item/password', plain);
  await f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation);
  expect(f.writes[0]!.init!.headers).toMatchObject({ Authorization: `Bearer ${await f.secrets.get(slackKey)}` });
});
test('tier winner replacement during judgment revokes exact prepared credential', async () => {
  const f = await fixture(); let once = false;
  f.setHook(async () => { if (!once) { once = true; await f.secrets.set(slackKey, 'replacement', plain); } });
  await expect(f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.writes).toHaveLength(0);
});
test('alias ABA is refused even when final bytes are identical', async () => {
  const f = await fixture(); await f.secrets.set(slackKey, 'goodvibes://secrets/goodvibes/LOCAL_TAG_ALIAS', plain); await f.secrets.set('LOCAL_TAG_ALIAS', 'synthetic-one', plain); let once = false;
  f.setHook(async () => { if (!once) { once = true; await f.secrets.set('LOCAL_TAG_ALIAS', 'synthetic-two', plain); await f.secrets.set('LOCAL_TAG_ALIAS', 'synthetic-one', plain); } });
  await expect(f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.writes).toHaveLength(0);
});
test('pending managed-alias leaf replacement blocks before post-success notification', async () => {
  const f = await fixture(); await f.secrets.set(slackKey, 'goodvibes://secrets/goodvibes/LOCAL_TAG_ALIAS', plain); await f.secrets.set('LOCAL_TAG_ALIAS', 'synthetic-one', plain);
  const path = (await f.secrets.listDetailed()).find(record => record.key === 'LOCAL_TAG_ALIAS')!.path!;
  const release = await acquireCrossProcessLock(`${path}.mutation.lock`, { strictOwnership: true });
  let pending: Promise<void> | undefined;
  f.setHook(() => { pending ??= f.secrets.set('LOCAL_TAG_ALIAS', 'pending-two', plain); });
  try { await expect(f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.writes).toHaveLength(0); }
  finally { release(); await pending; }
});
test('Jev reject and missing real source never call a human or provider', async () => {
  const f = await fixture(); f.setOutcome('reject');
  await expect(f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.writes).toHaveLength(0); expect(f.humans).toBe(0);
  await expect(f.owner.applyTags(f.id, ['GoodVibes/Priority'], { ...f.operation, sourceOf: () => ({ goal: '', criteria: [] }) })).rejects.toThrow(); expect(f.writes).toHaveLength(0);
});
test('same-ID mirror replacement and root revocation fence execution', async () => {
  const f = await fixture(); f.setHook(f.mutate);
  await expect(f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.writes).toHaveLength(0);
  f.setHook(() => f.lifetime.abort());
  await expect(f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.writes).toHaveLength(0);
});
test('config ABA during judgment revokes the exact operation', async () => {
  const f = await fixture(); let once = false;
  f.setHook(() => { if (!once) { once = true; f.config.set('surfaces.slack.workspaceId', 'T1'); f.config.set('surfaces.slack.workspaceId', 'T2'); f.config.set('surfaces.slack.workspaceId', 'T1'); } });
  await expect(f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.writes).toHaveLength(0);
});

test('missing managed credential refuses before judgment and provider mutation', async () => {
  const f = await fixture(); await f.secrets.delete(slackKey);
  await expect(f.owner.applyTags(f.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow();
  expect(f.writes).toHaveLength(0); expect(f.readings).toHaveLength(0); expect(f.humans).toBe(0);
});


test('actual product email factory preserves a custom keyword instead of silently changing it to a canonical label', async () => {
  const f = await fixture('email');
  await f.owner.applyTags(f.id, ['Project Alpha / Review'], { ...f.operation,
    sourceOf: () => ({ goal: 'Apply the Project Alpha / Review label to the selected email', criteria: ['Preserve the requested keyword spelling'] }),
  });
  expect(f.writes).toHaveLength(1); expect(f.writes[0]!.imap).toMatchObject({ uid: '42', uidValidity: 7, flag: 'Project_Alpha_Review' });
  expect(f.humans).toBe(0);
});

test('actual product held custom name cannot apply an earlier canonical tag or ask a human', async () => {
  const f = await fixture(); f.setMeaning('unknown');
  await expect(f.owner.applyTags(f.id, ['GoodVibes/Spam', 'Uncertain label'], f.operation)).rejects.toThrow();
  expect(f.writes).toHaveLength(0); expect(f.humans).toBe(0);
});
