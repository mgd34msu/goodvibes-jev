import { afterEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createTriageTagger, type TriageTaggerOptions } from '../sdk/src/platform/intake/triage/tagger/index.js';
import { readFileSync } from 'node:fs';
import { coverageFindings, sourceFindings } from '../scripts/judgment-lint-rules.js';
import { registry } from '../sdk/src/platform/gate/judgment-registry.js';
import { triageTagMeaning } from '../sdk/src/platform/intake/triage/tagger/meaning.js';
import { createOwnedInboxTagging } from '../sdk/src/platform/intake/triage/tagged-owned.js';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import type { InboundChannelItem, OwnedInboxSource, ImapStoreArgs } from '../sdk/src/platform/intake/index.js';
import { triageCredentials } from './_helpers/intake-triage-credentials.js';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); forgetGateReadings(); });
const guard = () => ({ signal: new AbortController().signal, assertCurrent() {} });
function fixture(provider: TriageTaggerOptions['provider'] = 'slack', options: {
  readonly role?: string; readonly confidence?: number; readonly unrecorded?: boolean;
  readonly forumTagIds?: Record<string, string>; readonly responses?: Response[];
  readonly beforeMeaning?: (() => void | Promise<void>); readonly wrongModel?: boolean; readonly malformed?: boolean;
  readonly refuse?: boolean; readonly ignoreMeaningGuard?: boolean;
} = {}) {
  const log = new SqliteDecisionLog(':memory:'); cleanups.push(() => log[Symbol.dispose]());
  const requests: unknown[] = [], transports: Array<{ url: string; init: RequestInit }> = [], stores: ImapStoreArgs[] = [];
  const credentials = triageCredentials({ key: 'synthetic-custom-token' });
  let credentialReads = 0;
  const meanings = fakePort((_name, question) => options.malformed ? { type: 'choice', probabilities: { invented: 1 } } : choiceAnswer(question, options.role ?? 'normal', options.confidence ?? .99));
  const gate = gateReadingsPort(), admission = fakePort((_name, question) => choiceAnswer(question, options.refuse ? 'reject' : 'act', .99));
  const inner: JudgmentPort = { model: 'jev-1.13.0', async ask(request) {
    request.beforeAttempt?.(); requests.push(request.state);
    if ('meaning' in request.questions) {
      await options.beforeMeaning?.(); if (!options.ignoreMeaningGuard) request.beforeAttempt?.();
      const result = await meanings.port.ask(request);
      return options.wrongModel ? { ...result, model: 'jev-wrong' } : result;
    }
    return 'disposition' in request.questions ? admission.port.ask(request) : gate.port.ask(request);
  } };
  const port = options.unrecorded ? inner : withDecisionLog(inner, log);
  const lifetime = new AbortController();
  const responses = [...options.responses ?? []];
  const tagger = createTriageTagger({ provider, accountScopeId: 'fixture-account', credentialKey: 'key', port,
    credentials: { ...credentials.credentials, async resolveConfigSecret(key) { credentialReads++; return credentials.credentials.resolveConfigSecret(key); } },
    captureCredential: () => credentials.capture('key'), signal: lifetime.signal, assertCurrent() {},
    imap: { host: 'mail.synthetic.invalid', port: 993, user: 'synthetic', mailbox: 'INBOX' },
    ...(options.forumTagIds ? { forumTagIds: options.forumTagIds } : {}),
    imapStoreFlag: async args => { stores.push(args); },
    http: Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      transports.push({ url: String(url), init: init! });
      return responses.shift() ?? (provider === 'slack' ? Response.json({ ok: true }) : new Response(null, { status: 204 }));
    }, { preconnect: fetch.preconnect }),
  });
  cleanups.push(() => tagger.close());
  const id = provider === 'slack' ? 'slack:C123:123.456' : provider === 'discord' ? 'discord:123:234' : 'email:fixture-account:7:42';
  return { tagger, credentials, requests, transports, stores, port, log, lifetime, id, meanings, admission, get credentialReads() { return credentialReads; } };
}

test('registered custom-tag decision declares negation, opaque and ambiguous calibration fixtures', () => {
  expect(triageTagMeaning.name).toBe('engine.intake.triage-tag-meaning');
  expect(triageTagMeaning.version).toBe(1); expect(triageTagMeaning.model).toBe('jev-1.13.0');
  expect(triageTagMeaning.fixtures.map(f => f.expect.meaning)).toEqual(['spam', 'priority', 'normal', 'normal', 'unknown', 'unknown']);
  expect(Object.isFrozen(triageTagMeaning.items.meaning.question)).toBe(true);
});

test('email preserves the custom keyword spelling without inventing a semantic classification', async () => {
  const f = fixture('email', { unrecorded: true });
  await f.tagger.applyTags(f.id, [' Project Alpha / Review ', 'Project Alpha / Review'], guard());
  expect(f.requests).toEqual([]); expect(f.stores).toHaveLength(1);
  expect(f.stores[0]).toMatchObject({ uid: '42', uidValidity: 7, flag: 'Project_Alpha_Review', password: 'synthetic-custom-token' });
});

test.each([
  ['Not spam', 'normal', 'inbox_tray'], ['Needs urgent attention', 'priority', 'rotating_light'], ['Unsolicited junk', 'spam', 'no_entry_sign'],
])('custom %s uses the recorded %s meaning rather than lexical substring rules', async (tag, role, reaction) => {
  const f = fixture('slack', { role });
  const prepared = await f.tagger.prepareTags(f.id, [tag!], guard());
  expect(prepared.effects).toEqual([{ tag, mode: 'slack-reaction', reaction }]);
  expect(prepared.judgmentDecisionIds).toHaveLength(1);
  expect(f.log.get(prepared.judgmentDecisionIds[0]!)?.context?.battery).toBe(triageTagMeaning.name);
  expect(f.transports).toEqual([]);
  expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.effects[0])).toBe(true);
  await prepared.applyTags(guard());
  expect(JSON.parse(String(f.transports[0]!.init.body))).toEqual({ channel: 'C123', timestamp: '123.456', name: reaction });
  await expect(prepared.applyTags(guard())).rejects.toThrow('consumed'); expect(f.transports).toHaveLength(1);
  expect(f.meanings.requests[0]!.state).toEqual({ tag });
});

test('exact custom forum mapping precedes the interpreted reaction and is captured before caller mutation', async () => {
  const mapping = { 'Project Alpha': '1558282921574400000' };
  const f = fixture('discord', { forumTagIds: mapping, role: 'normal', responses: [
    Response.json({ id: '123', type: 11, parent_id: '456', applied_tags: ['789'] }), Response.json({ id: '456', type: 15 }),
    Response.json({ id: '123', type: 11, parent_id: '456', applied_tags: ['789', '777'] }), Response.json({ id: '456', type: 15 }), new Response(null, { status: 204 }),
  ] });
  mapping['Project Alpha'] = '888';
  const prepared = await f.tagger.prepareTags(f.id, ['Project Alpha'], guard());
  expect(prepared.effects[0]).toMatchObject({ tag: 'Project Alpha', mode: 'discord-forum-tag' });
  expect(prepared.effects[0]?.forumTagRef).toBeString();
  expect(JSON.stringify(prepared.effects)).not.toContain('1558282921574400000');
  await prepared.applyTags(guard());
  expect(f.transports.map(call => call.init.method ?? 'GET')).toEqual(['GET', 'GET', 'GET', 'GET', 'PATCH']);
  expect(JSON.parse(String(f.transports[4]!.init.body))).toEqual({ applied_tags: ['789', '777', '1558282921574400000'] });
  expect(f.meanings.requests).toEqual([]);
});

test('a mapped custom Discord name on a DM falls back to its actual interpreted reaction', async () => {
  const f = fixture('discord', { forumTagIds: { 'Not spam': '890' }, role: 'normal', responses: [Response.json({ id: '123', type: 1 })] });
  await f.tagger.applyTags(f.id, ['Not spam'], guard());
  expect(f.transports.map(call => call.init.method ?? 'GET')).toEqual(['GET', 'PUT']);
  expect(f.transports[1]!.url).toContain(`/reactions/${encodeURIComponent('📥')}/@me`);
});

test.each([{ role: 'unknown', confidence: .99 }, { role: 'normal', confidence: .5 }])('unsettled custom meaning %j holds the complete batch and cannot be resampled', async reading => {
  const f = fixture('slack', reading);
  await expect(f.tagger.applyTags(f.id, ['GoodVibes/Spam', 'Uncertain name'], guard())).rejects.toThrow('unsettled');
  await expect(f.tagger.applyTags(f.id, ['Uncertain name'], guard())).rejects.toThrow('unsettled');
  expect(f.meanings.requests).toHaveLength(1); expect(f.transports).toEqual([]);
});

test.each(['unrecorded', 'wrongModel', 'malformed'] as const)('custom interpretation refuses %s evidence without fallback or provider effects', async kind => {
  const f = fixture('slack', { [kind]: true });
  await expect(f.tagger.applyTags(f.id, ['Project notes'], guard())).rejects.toThrow();
  expect(f.transports).toEqual([]);
  if (kind === 'unrecorded') expect(f.meanings.requests).toHaveLength(0);
});

test.each(['api_key=synthetic-private-value', '4111111111111111', 'x'.repeat(1000) + ' password=synthetic-private-value'])('complete raw custom name is screened before credentials, clipping or a reading', async tag => {
  const f = fixture();
  await expect(f.tagger.applyTags(f.id, [tag], guard())).rejects.toThrow();
  expect(f.credentialReads).toBe(0); expect(f.requests).toEqual([]); expect(f.transports).toEqual([]);
});

test('accessor/proxy names refuse without invoking caller code or starting a reading', async () => {
  const f = fixture(); let traps = 0;
  const array = ['Project notes']; Object.defineProperty(array, '0', { get() { traps++; return 'Project notes'; } });
  const proxy = new Proxy(['Project notes'], { get() { traps++; return 'unexpected'; } });
  for (const names of [array, proxy]) await expect(f.tagger.applyTags(f.id, names, guard())).rejects.toThrow();
  expect(traps).toBe(0); expect(f.requests).toEqual([]);
});

test('unknown target refuses before credential lookup or custom interpretation', async () => {
  const f = fixture();
  await expect(f.tagger.applyTags('unrelated-target', ['Project notes'], guard())).rejects.toThrow('target');
  expect(f.credentialReads).toBe(0); expect(f.requests).toEqual([]); expect(f.transports).toEqual([]);
});

test.each(['resolve', 'reject'] as const)('noncooperative custom reading releases close before late %s and cannot publish', async outcome => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const names = ['Project notes'];
  const f = fixture('slack', { ignoreMeaningGuard: true, beforeMeaning: async () => { entered.resolve(); await release.promise; } });
  const pending = f.tagger.applyTags(f.id, names, guard()); void pending.catch(() => {});
  try {
    await entered.promise; names[0] = 'Unsolicited junk';
    await expect(f.tagger.applyTags(f.id, ['Project notes'], guard())).rejects.toThrow('pending');
    // No release yet: shutdown cannot depend on a cooperative model transport.
    await f.tagger.close(); await expect(pending).rejects.toThrow();
    expect(f.log.query({ battery: triageTagMeaning.name })).toEqual([]);
    if (outcome === 'resolve') release.resolve(); else release.reject(new Error('synthetic late transport failure'));
    await Bun.sleep(0);
    expect(f.transports).toEqual([]); expect(f.requests).toEqual([{ tag: 'Project notes' }]);
    expect(f.log.query({ battery: triageTagMeaning.name })).toEqual([]);
  } finally { release.resolve(); }
});

test('credential ABA while the custom reading waits cannot reach provider mutation', async () => {
  let rotate: (() => Promise<void>) | undefined;
  const f = fixture('slack', { beforeMeaning: () => rotate?.() });
  rotate = async () => { await f.credentials.put('key', 'second'); await f.credentials.put('key', 'synthetic-custom-token'); };
  await expect(f.tagger.applyTags(f.id, ['Project notes'], guard())).rejects.toThrow();
  expect(f.transports).toEqual([]);
});

function ownedFixture(refuse = false, beforeMeaning?: () => void) {
  const f = fixture('slack', { role: 'normal', refuse, ...(beforeMeaning ? { beforeMeaning } : {}) }); let humans = 0;
  const previous = installJudgmentPort(f.port); cleanups.push(() => { installJudgmentPort(previous); });
  const manager = new PermissionManager(async () => { humans++; throw new Error('No human'); }, {
    isAutoApproveEnabled: () => false, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
    getWorkingDirectory: () => '/synthetic', getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic' }),
  } as PermissionConfigReader, new PolicyRuntimeState());
  const row: InboundChannelItem = { id: f.id, provider: 'slack', kind: 'dm', fromDigest: '0123456789abcdef', subjectPreview: 'PRIVATE_SUBJECT_NOT_TAG_MEANING', bodyPreview: 'PRIVATE_BODY_NOT_TAG_MEANING', receivedAt: 1, unread: true };
  const source: OwnedInboxSource = { providerIds: ['slack'], ready: Promise.resolve(), async close() {}, unregister() {}, async acquireRead() {
    return { providerIds: ['slack'], sources: { store: { listItems: () => [structuredClone(row)], countItems: () => 1, countItemsByProvider: () => new Map([['slack', 1]]), maxReceivedAt: () => 1, getImapCheckpoint: () => null }, poller: { snapshotStatuses: () => [], isProviderRunning: () => false } }, async validate() {}, assertCurrent() {}, release() {} };
  } };
  const owner = createOwnedInboxTagging({ source, tagger: f.tagger, permissionManager: manager, port: f.port, ...guard(), onInvalidate() { return () => {}; } });
  cleanups.push(() => owner.close());
  const operation = { sourceOf: () => ({ goal: 'Apply my Not spam triage label to the selected message', criteria: ['Only that message and its prepared provider effect'] }), assertCurrent() {} };
  return { ...f, owner, operation, mutate() { row.bodyPreview = 'Changed current owned row'; }, get humans() { return humans; } };
}

test('custom meaning and exact interpreted effect flow through real recorded autonomous admission', async () => {
  const f = ownedFixture();
  await f.owner.applyTags(f.id, ['Not spam'], f.operation);
  expect(f.transports).toHaveLength(1); expect(f.humans).toBe(0);
  expect(JSON.parse(String(f.transports[0]!.init.body)).name).toBe('inbox_tray');
  const evidence = JSON.stringify(f.requests);
  expect(evidence).toContain('Not spam'); expect(evidence).toContain('inbox_tray');
  expect(evidence).not.toContain('PRIVATE_'); expect(evidence).not.toContain('synthetic-custom-token');
  expect(f.log.query({ battery: triageTagMeaning.name })).toHaveLength(1);
});

test('settled custom classification cannot override a fresh autonomous rejection', async () => {
  const f = ownedFixture(true);
  await expect(f.owner.applyTags(f.id, ['Not spam'], f.operation)).rejects.toThrow();
  expect(f.meanings.requests).toHaveLength(1); expect(f.transports).toEqual([]); expect(f.humans).toBe(0);
});


test('the custom-tag reading is genuinely registered and has complete fixture choice coverage', async () => {
  expect(registry.get(triageTagMeaning.name)).toBe(triageTagMeaning);
  expect(await coverageFindings([triageTagMeaning])).toEqual({ findings: [], open: [] });
  const file = '../sdk/src/platform/intake/triage/tagger/meaning.ts';
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const names = new Set(registry.list().map(decision => decision.name));
  expect(sourceFindings(file, source, names)).toEqual([]);
  names.delete(triageTagMeaning.name);
  expect(sourceFindings(file, source, names).some(finding => finding.message.includes(triageTagMeaning.name))).toBe(true);
});

test('a missing credential refuses before reading the custom label', async () => {
  const f = fixture(); await f.credentials.put('key', '');
  await expect(f.tagger.applyTags(f.id, ['Project notes'], guard())).rejects.toThrow('credential');
  expect(f.requests).toEqual([]); expect(f.transports).toEqual([]);
});

test('provider failure after a partial custom batch stops before further effects and never retries completed writes', async () => {
  const f = fixture('slack', { responses: [Response.json({ ok: true }), Response.json({ ok: false, error: 'missing_scope' })] });
  await expect(f.tagger.applyTags(f.id, ['Project one', 'Project two', 'Project three'], guard())).rejects.toThrow('rejected');
  expect(f.meanings.requests).toHaveLength(3); expect(f.transports).toHaveLength(2);
});

test('custom forum lookup never treats inherited object names as configured mappings', async () => {
  const f = fixture('discord', { forumTagIds: {} });
  await f.tagger.applyTags(f.id, ['toString'], guard());
  expect(f.transports.map(call => call.init.method)).toEqual(['PUT']);
});

test('held semantic capacity does not evict earlier holds or ask again for new names', async () => {
  const f = fixture('slack', { role: 'unknown' });
  for (let index = 0; index < 1024; index++) {
    await expect(f.tagger.applyTags(f.id, [`Uncertain name ${index}`], guard())).rejects.toThrow('unsettled');
  }
  expect(f.meanings.requests).toHaveLength(1024);
  await expect(f.tagger.applyTags(f.id, ['Another uncertain name'], guard())).rejects.toThrow('unsettled');
  await expect(f.tagger.applyTags(f.id, ['Uncertain name 0'], guard())).rejects.toThrow('unsettled');
  expect(f.meanings.requests).toHaveLength(1024); expect(f.transports).toEqual([]);
  await f.tagger.applyTags(f.id, ['GoodVibes/Normal'], guard());
  expect(f.transports).toHaveLength(1);
});

test('source revision changes during custom interpretation revoke the effect before autonomous admission', async () => {
  let mutate: (() => void) | undefined;
  const f = ownedFixture(false, () => mutate?.()); mutate = f.mutate;
  await expect(f.owner.applyTags(f.id, ['Not spam'], f.operation)).rejects.toThrow();
  expect(f.admission.requests).toEqual([]);
  expect(f.transports).toEqual([]); expect(f.humans).toBe(0);
});


test('opaque exact forum labels need no semantic guess, and an admitted forum cannot silently become a reaction', async () => {
  const f = fixture('discord', { unrecorded: true, forumTagIds: { 'ZXQ-7': '890' }, responses: [
    Response.json({ id: '123', type: 11, parent_id: '456', applied_tags: [] }), Response.json({ id: '456', type: 15 }),
    Response.json({ id: '123', type: 1 }),
  ] });
  const prepared = await f.tagger.prepareTags(f.id, ['ZXQ-7', 'Unmapped label'], guard());
  expect(prepared.effects.map(effect => effect.mode)).toEqual(['discord-forum-tag', 'discord-unmapped-noop']);
  expect(prepared.judgmentDecisionIds).toEqual([]); expect(f.meanings.requests).toEqual([]);
  await expect(prepared.applyTags(guard())).rejects.toThrow('forum target changed');
  expect(f.transports.every(call => call.init.method === undefined)).toBe(true);
});
