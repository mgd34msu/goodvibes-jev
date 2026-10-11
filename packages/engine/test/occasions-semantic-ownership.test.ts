import type { ProfilePersonReadingOptions } from '../sdk/src/platform/owner-profile/person-reading.ts';
import type { ProfileProjection } from '../sdk/src/platform/owner-profile/types.ts';
/** Recorded synthetic meanings through actual service/store/caller boundaries; no live provider. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { ProfilePersistIo } from '../sdk/src/platform/owner-profile/writer.ts';
import { resetProcessUntrustedContentLedgerForTests } from '../sdk/src/platform/security/untrusted-content.ts';
import { OwnerProfileStore } from '../sdk/src/platform/owner-profile/store.ts';
import { OccasionsService } from '../sdk/src/platform/occasions/service.ts';
import { OccasionStateStore } from '../sdk/src/platform/occasions/state-store.ts';
import { PersistentStore } from '../sdk/src/platform/state/persistent-store.ts';
import { StoreWriteQueue } from '../sdk/src/platform/state/store-write-queue.ts';
import { composeNudge } from '../sdk/src/platform/occasions/nudge.ts';
import { openInterview } from '../sdk/src/platform/occasions/interview.ts';
import { composePending } from '../sdk/src/platform/occasions/pending.ts';
import { readOccasionDeclarations } from '../sdk/src/platform/occasions/reader.ts';
import { StoredRecordAdmissionOwner, storedGiftEvidence, storedOpenItemEvidence, storedAcknowledgementEvidence } from '../sdk/src/platform/occasions/stored-reading-evidence.ts';
import { judgmentInputProblem } from '../sdk/src/platform/gate/judgment-input.ts';
import { nameOf } from '../sdk/src/platform/occasions/nudge.ts';
import { ownerAliasSet, possessiveSubject, resolveOccasionSubject } from '../sdk/src/platform/occasions/index.ts';
import { RAISE_BOUNDARIES } from '../sdk/src/platform/occasions/types.ts';
import { OccasionReadingWork } from '../sdk/src/platform/occasions/readings.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { registerOccasionsGatewayMethods } from '../sdk/src/platform/control-plane/routes/occasions.ts';
import { composeOccasions } from '../sdk/src/platform/control-plane/routes/occasions-composition.ts';
import type { ConfigManager } from '../sdk/src/platform/config/manager.ts';

const PROFILE = `# Owner profile
## Identity
name: Avery Chen
## People
- Jo no longer enjoys chess. That was a childhood pastime.
- Jo spends every Saturday at the pottery wheel.
## Important dates
- Annual reunion · 03-14 · annual · gift-giving · for Jo
## Plans
`;
const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
let installed = false;
const restores: (() => void)[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); installed = true; });
afterEach(() => { for (const restore of restores.splice(0)) restore(); if (installed) installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
/** Observe a successor enqueue on the same queue as the blocked first store write. */
function nextStoreWriteQueued() {
  const queued = deferred<void>();
  const original = StoreWriteQueue.prototype.run;
  let owner: StoreWriteQueue | undefined;
  let writes = 0;
  const spy = spyOn(StoreWriteQueue.prototype, 'run').mockImplementation(function(this: StoreWriteQueue, write) {
    owner ??= this;
    const attempt = original.call(this, write);
    if (this === owner && ++writes === 2) queued.resolve();
    return attempt;
  });
  restores.push(() => spy.mockRestore());
  return queued.promise;
}
function recorded(options: { chosen?: string; names?: number; subject?: 'owner' | 'other' | 'unknown'; confidence?: number; fit?: number } = {}) {
  const chosen = options.chosen ?? 'line_1';
  return fakePort((name, question) => {
    if (name === 'personLine') return noulAnswer(0.99);
    if (name === 'subject') return choiceAnswer(question, options.subject ?? 'other', options.confidence ?? 0.99);
    if (name === 'names') return noulAnswer(options.names ?? 0.01);
    if (name === 'pick') return choiceAnswer(question, chosen, options.confidence ?? 0.99);
    return noulAnswer(options.fit ?? (name === `fits_${chosen.slice('line_'.length)}` ? 0.99 : 0.01));
  });
}
function install(port: JudgmentPort) { installJudgmentPort(port); }
function harness(text = PROFILE, persistIo?: ProfilePersistIo) {
  const root = mkdtempSync(join(tmpdir(), 'gv-occasion-semantic-')); roots.push(root);
  const path = join(root, 'profile.md'); writeFileSync(path, text);
  const profile = new OwnerProfileStore({ path, ...(persistIo ? { persistIo } : {}) }); profile.loadSync();
  const statePath = join(root, 'state.json');
  const state = new OccasionStateStore(statePath);
  const config = new Map<string, unknown>([['occasions.nudgeChannel', ''], ['daemon.timezone', 'UTC']]);
  let incarnation = 0;
  const source = {
    captureRead: () => profile.captureRead(), importantDates: () => profile.importantDates(), plans: () => profile.plans(),
    person: async (name: string, options?: ProfilePersonReadingOptions) => profile.person(name, options), ownerNames: () => [profile.get('identity.name')?.value ?? ''],
  };
  const deliveries: string[] = [];
  const service = new OccasionsService({ profile: source, writer: profile, state,
    config: { get: key => config.get(key), set: () => {}, getConfigurationIncarnation: () => incarnation },
    now: () => Date.parse('2026-03-06T10:00:00Z'), deliverer: { deliver: async ({ nudge }) => { deliveries.push(nudge.message); return 'synthetic'; } },
  });
  return { profile, source, state, service, path, statePath, deliveries, config,
    setConfig(key: string, value: unknown) { incarnation++; config.set(key, value); },
    reload(next = text) { writeFileSync(path, next); profile.loadSync(); },
  };
}
const yes = { occasionId: 'annual reunion', answer: 'yes' as const };

 test('registered meanings select a source line contrary to old keywords and persist/render exactly it', async () => {
  const fake = recorded(); install(fake.port); const h = harness();
  const answer = await h.service.answer(yes);
  expect(answer.interview?.nextStep?.opensFrom).toBe('Jo spends every Saturday at the pottery wheel.');
  expect((await h.service.interview(answer.interview!.interviewId))?.nextStep).toEqual(answer.interview!.nextStep);
  const reloaded = new OccasionStateStore(h.statePath);
  expect((await reloaded.interview(answer.interview!.interviewId))?.steps[0]?.opensFrom).toBe('Jo spends every Saturday at the pottery wheel.');
  expect((await reloaded.answerFor('annual reunion', '2026-03-14'))?.answer).toBe('yes');
  const sent = JSON.stringify(fake.requests.map(request => request.state));
  expect(sent).toContain('childhood pastime'); expect(sent).toContain('pottery wheel');
  expect(sent).not.toContain('03-14'); expect(sent).not.toContain('2026-03-14');
});
 test('a settled none persists the generic opener, not the first interest keyword', async () => {
  const fake = recorded({ chosen: 'none' }); install(fake.port); const h = harness();
  const result = await h.service.answer(yes);
  expect(result.interview?.nextStep?.opensFrom).toBe('');
  expect(result.interview?.nextStep?.prompt).toBe('What has Jo been into lately?');
});
for (const condition of ['uncertain', 'fit-uncertain', 'unavailable', 'missing', 'malformed'] as const) {
 test(`${condition} interview reading cannot persist yes, an interview or render a guessed question`, async () => {
  const fake = recorded(condition === 'uncertain' ? { confidence: 0.5 } : condition === 'fit-uncertain' ? { fit: 0.5 } : {});
  if (condition !== 'missing') install({ ...fake.port, ask: async request => {
    if (condition === 'unavailable') throw new Error('synthetic offline');
    if (condition === 'malformed') return { ...(await fake.port.ask(request)), answers: { pick: { type: 'choice', choice: 'not-offered' } } } as never;
    return fake.port.ask(request);
  } });
  const h = harness(); await expect(h.service.answer(yes)).rejects.toThrow();
  expect(await h.state.acknowledgements()).toEqual([]); expect((await h.state.disclose()).interviews).toBe(0);
  expect(h.deliveries).toEqual([]);
 });
}
for (const condition of ['profile', 'same-profile-reload', 'config', 'config-aba', 'port', 'request', 'cancel'] as const) {
 test(`in-flight ${condition} change retires the original interview before any persistence`, async () => {
  const fake = recorded(); const entered = deferred<void>(), release = deferred<void>();
  install({ ...fake.port, ask: async request => { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const h = harness(); const controller = new AbortController(); const input = { ...yes };
  const pending = h.service.answer(input, { signal: controller.signal }); const settled = pending.then(() => false, () => true);
  await entered.promise;
  if (condition === 'profile') h.reload(PROFILE.replace('pottery wheel', 'violin lessons'));
  if (condition === 'same-profile-reload') h.reload();
  if (condition === 'config') h.setConfig('occasions.interviewQuestions', 1);
  if (condition === 'config-aba') { h.setConfig('occasions.interviewQuestions', 1); h.setConfig('occasions.interviewQuestions', undefined); }
  if (condition === 'port') install(recorded().port);
  if (condition === 'request') input.occasionId = 'changed';
  if (condition === 'cancel') controller.abort();
  release.resolve(); expect(await settled).toBe(true);
  expect(await h.state.acknowledgements()).toEqual([]); expect((await h.state.disclose()).interviews).toBe(0);
 });
}
 test('capture precedes async person lookup; installing a missing reader later cannot adopt the call', async () => {
  const h = harness(); const entered = deferred<void>(), release = deferred<void>();
  h.source.person = async (name, options) => { entered.resolve(); await release.promise; return h.profile.person(name, options); };
  const pending = h.service.answer(yes); const settled = pending.then(() => false, () => true);
  await entered.promise; install(recorded().port); release.resolve();
  expect(await settled).toBe(true); expect(await h.state.acknowledgements()).toEqual([]);
 });
 test('new no answer supersedes a pending yes without a stale yes/interview overwriting it', async () => {
  const fake = recorded(); const entered = deferred<void>(), release = deferred<void>();
  install({ ...fake.port, ask: async request => { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const h = harness(); const pending = h.service.answer(yes); const settled = pending.then(() => false, () => true);
  await entered.promise; await h.service.answer({ ...yes, answer: 'no' }); release.resolve();
  expect(await settled).toBe(true); expect((await h.state.answerFor('annual reunion', '2026-03-14'))?.answer).toBe('no');
  expect((await h.state.disclose()).interviews).toBe(0);
 });
for (const where of ['late-line', 'provenance', 'occasion-extra', 'raw-config'] as const) {
 test(`complete original ${where} is privacy-screened before any provider call or yes persistence`, async () => {
  const fake = recorded(); install(fake.port);
  const secret = 'password=synthetic-secret';
  const text = where === 'late-line' ? PROFILE.replace('## Important dates', `- Jo: ${secret}\n## Important dates`)
    : where === 'occasion-extra' ? PROFILE.replace('for Jo', `for Jo · ${secret}`) : PROFILE;
  const h = harness(text);
  if (where === 'provenance') h.source.person = async () => [{ lineIndex: 4, section: 'People', text: 'Jo spends Saturdays at a wheel.', provenance: { surface: 'hand-edit', date: '2026-01-01', said: secret } }];
  if (where === 'raw-config') h.config.set('occasions.interviewQuestions', secret);
  await expect(h.service.answer(yes)).rejects.toThrow();
  expect(fake.requests).toHaveLength(0); expect(await h.state.acknowledgements()).toEqual([]);
 });
}
 test('same cached profile source remains current and repeated answer resumes the stored interview', async () => {
  const fake = recorded(); install(fake.port); const h = harness();
  const first = await h.service.answer(yes); const count = fake.requests.length;
  const second = await h.service.answer(yes);
  expect(second.interview).toEqual(first.interview); expect(fake.requests).toHaveLength(count);
 });
for (const point of ['queued', 'before-publish'] as const) {
 test(`lease retirement ${point} leaves disk and memory unchanged; a successor write still succeeds`, async () => {
  const fake = recorded(); install(fake.port); const h = harness(); await h.state.acknowledgements();
  const entered = deferred<void>(), release = deferred<void>(); let held = false; let reachedPublication = false;
  const queued = point === 'queued' ? nextStoreWriteQueued() : undefined;
  const original = PersistentStore.prototype.persist;
  const spy = spyOn(PersistentStore.prototype, 'persist').mockImplementation(async function(this: PersistentStore<Record<string, unknown>>, data, options) {
    if (held) return original.call(this, data, options);
    held = true;
    if (point === 'queued') {
      entered.resolve(); await release.promise;
      return original.call(this, data, options);
    }
    return original.call(this, data, { ...options, beforePublish: () => {
      // This callback runs after the real temporary file was written, synced
      // and closed, immediately before rename. Retire at that actual boundary.
      reachedPublication = true; h.reload(); options?.beforePublish?.();
    } });
  }); restores.push(() => spy.mockRestore());
  let blocker: Promise<unknown> | undefined;
  let failed: Promise<boolean> | undefined;
  try {
    if (point === 'queued') {
      blocker = h.state.recordGift({ occasionId: 'other', occurrence: '2026-03-14', landedOn: 'kept', recordedAt: 1 });
      await entered.promise;
    }
    const pending = h.service.answer(yes); failed = pending.then(() => false, () => true);
    if (point === 'queued') {
      await Promise.race([queued!, pending.then(() => { throw new Error('Interview completed before its store write was queued.'); })]);
      h.reload(); release.resolve(); await blocker;
    }
    expect(await failed).toBe(true);
    if (point === 'before-publish') expect(reachedPublication).toBe(true);
    expect(await h.state.acknowledgements()).toEqual([]); expect((await h.state.disclose()).interviews).toBe(0);
    if (point === 'before-publish') expect(existsSync(h.statePath)).toBe(false);
    else {
      const unchanged = JSON.parse(readFileSync(h.statePath, 'utf8')) as { interviews: unknown[]; acknowledgements: unknown[] };
      expect(unchanged.interviews).toEqual([]); expect(unchanged.acknowledgements).toEqual([]);
    }
    await h.state.recordGift({ occasionId: 'successor', occurrence: '2026-03-14', landedOn: 'survives', recordedAt: 2 });
    const stored = JSON.parse(readFileSync(h.statePath, 'utf8')) as { interviews: unknown[]; acknowledgements: unknown[]; gifts: { occasionId: string }[] };
    expect(stored.interviews).toEqual([]); expect(stored.acknowledgements).toEqual([]);
    expect(stored.gifts.some(gift => gift.occasionId === 'successor')).toBe(true);
  } finally { release.resolve(); await blocker; await failed; }
 });
}
 test('title-person reading can append Ann despite Annual substring, and omit a differently spelled grounded label', async () => {
  const subject = { occasionId: 'x', title: 'Annual reunion', person: 'Ann', kind: 'gift-giving' as const, proximity: 'soon' as const, subject: 'other' as const, acknowledged: false };
  install(recorded({ names: 0.01 }).port); expect(await nameOf(subject)).toBe('Annual reunion (Ann)');
  install(recorded({ names: 0.99 }).port); expect(await nameOf({ ...subject, title: 'Annie’s birthday' })).toBe('Annie’s birthday');
 });
for (const verdict of ['owner', 'other', 'unknown'] as const) {
 test(`${verdict} subject reading controls owner remember-only suppression without leaking dates`, async () => {
  const fake = recorded({ subject: verdict, names: 0.99 }); install(fake.port);
  const h = harness(PROFILE.replace('gift-giving', 'remember-only')); h.setConfig('occasions.nudgeChannel', 'agent');
  const result = await h.service.sweep();
  expect(result.nudge === null).toBe(verdict === 'owner');
  expect(h.deliveries.length).toBe(verdict === 'owner' ? 0 : 1);
  expect(JSON.stringify(fake.requests.map(request => request.state))).not.toContain('03-14');
 });
}
 test('selfDeclared remains mechanical even with unavailable reader', async () => {
  expect(await resolveOccasionSubject({ title: 'Ambiguous family title', person: '', selfDeclared: true }, [])).toBe('owner');
 });
 test('uncertain name inclusion never delivers or marks the nudge served', async () => {
  install(recorded({ names: 0.5 }).port); const h = harness(); h.setConfig('occasions.nudgeChannel', 'agent');
  await expect(h.service.sweep()).rejects.toThrow(); expect(h.deliveries).toEqual([]); expect(await h.state.openItems()).toEqual([]);
 });
 test('retirement between destinations prevents a second external delivery', async () => {
  install(recorded().port); const h = harness();
  const controller = new AbortController();
  const service = new OccasionsService({ profile: h.source, writer: h.profile, state: h.state,
    config: { get: key => key === 'occasions.nudgeChannel' ? 'telegram, agent' : h.config.get(key), set: () => {} },
    now: () => Date.parse('2026-03-06T10:00:00Z'),
    deliverer: { deliver: async ({ channel }) => { h.deliveries.push(channel); controller.abort(); return 'landed'; } },
  });
  await expect(service.sweep({ signal: controller.signal })).rejects.toThrow(); expect(h.deliveries).toEqual(['telegram']);
 });
for (const reason of ['cancel', 'authorization'] as const) {
 test(`actual gateway ${reason} retirement cannot persist the pending interview`, async () => {
  const fake = recorded(), entered = deferred<void>(), release = deferred<void>();
  install({ ...fake.port, ask: async request => { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const h = harness(), catalog = new GatewayMethodCatalog(); registerOccasionsGatewayMethods(catalog, h.service);
  const controller = new AbortController(); let allowed = true;
  const pending = catalog.invoke('occasions.answer', { context: { admin: true }, body: yes, signal: controller.signal, isAuthorized: () => allowed });
  const failed = pending.then(() => false, () => true);
  await entered.promise; if (reason === 'cancel') controller.abort(); else allowed = false;
  release.resolve(); expect(await failed).toBe(true);
  expect(await h.state.acknowledgements()).toEqual([]); expect((await h.state.disclose()).interviews).toBe(0);
 });
}
 test('real composition disposal aborts pending semantics and drains without publishing yes', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-03-06T10:00:00Z')); restores.push(() => clock.mockRestore());
  const fake = recorded(), entered = deferred<void>(), release = deferred<void>();
  install({ ...fake.port, ask: async request => { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const h = harness();
  const get: ConfigManager['get'] = ((key: string) => key === 'daemon.timezone' ? 'UTC' : undefined) as ConfigManager['get'];
  const composition = composeOccasions(new GatewayMethodCatalog(), { ownerProfile: h.profile, configManager: { get }, statePath: h.statePath });
  const pending = composition.service.answer(yes); const failed = pending.then(() => false, () => true);
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => { throw new Error('Interview completed before the deferred provider was entered.'); }),
    ]);
    await composition.dispose(); release.resolve();
    expect(await failed).toBe(true); expect(await composition.state.acknowledgements()).toEqual([]);
  } finally {
    release.resolve();
    await composition.dispose();
    await failed;
  }
 });
 test('failed shared-store publication leaves no tentative interview and does not poison successor writes', async () => {
  install(recorded().port); const h = harness(); await h.state.acknowledgements();
  const original = PersistentStore.prototype.persist; let failed = false;
  const spy = spyOn(PersistentStore.prototype, 'persist').mockImplementation(async function(this: PersistentStore<Record<string, unknown>>, data, options) {
    if (!failed) { failed = true; throw new Error('synthetic write failure'); }
    return original.call(this, data, options);
  }); restores.push(() => spy.mockRestore());
  await expect(h.service.answer(yes)).rejects.toThrow();
  expect(await h.state.acknowledgements()).toEqual([]); expect((await h.state.disclose()).interviews).toBe(0);
  await h.service.answer(yes); expect((await h.state.disclose()).interviews).toBe(1);
 });
 test('a store lease retires at asynchronous load intent, including a same-content reload', async () => {
  const h = harness(), lease = h.profile.captureRead(); const loading = h.profile.load();
  expect(() => lease.assertCurrent()).toThrow();
  expect(() => h.profile.captureRead().assertCurrent()).toThrow();
  await loading; h.profile.captureRead().assertCurrent();
 });
 test('no-op removal retains default zero-write semantics, including unwritable store', async () => {
  const h = harness(); await h.state.acknowledgements();
  const spy = spyOn(PersistentStore.prototype, 'persist').mockImplementation(async () => { throw new Error('must not write'); }); restores.push(() => spy.mockRestore());
  expect(await h.state.resolveOpenItem('absent')).toBe(false); expect(await h.state.dropOccasion('absent')).toBe(0);
  expect(spy).not.toHaveBeenCalled();
  expect(() => readFileSync(h.statePath)).toThrow();
 });
for (const action of ['no', 'acknowledged'] as const) {
 test(`a concurrent ${action} while nudge wording is read prevents a stale raise or delivery`, async () => {
  const fake = recorded(), entered = deferred<void>(), release = deferred<void>();
  install({ ...fake.port, ask: async request => {
    if (request.context?.battery === 'engine.occasions.title-names-person') { entered.resolve(); await release.promise; }
    return fake.port.ask(request);
  } });
  const h = harness(); h.setConfig('occasions.nudgeChannel', 'agent');
  const pending = h.service.sweep(); const failed = pending.then(() => false, () => true);
  await entered.promise;
  if (action === 'no') await h.service.answer({ ...yes, answer: 'no' });
  else await h.service.acknowledge({ occasionId: yes.occasionId, source: 'explicit' });
  release.resolve(); expect(await failed).toBe(true);
  expect(h.deliveries).toEqual([]);
  const items = await h.state.openItems();
  if (action === 'no') expect(items).toEqual([]);
  else {
    expect(items).toHaveLength(1);
    expect(items[0]?.servedBoundaries).toEqual([...RAISE_BOUNDARIES]);
    expect(items[0]?.raiseCount).toBe(0);
    expect(items[0]?.agentPushedOn).toBeUndefined();
  }
  expect((await h.state.answerFor(yes.occasionId, '2026-03-14'))?.answer).toBe(action);
 });
}
 test('a later explicit acknowledgement retires an earlier pending yes and preserves its quiet open item', async () => {
  const fake = recorded(), entered = deferred<void>(), release = deferred<void>();
  install({ ...fake.port, ask: async request => { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const h = harness();
  const pending = h.service.answer(yes); const failed = pending.then(() => false, () => true);
  await entered.promise;
  expect((await h.service.acknowledge({ occasionId: yes.occasionId, source: 'explicit' })).ok).toBe(true);
  release.resolve(); expect(await failed).toBe(true);
  expect((await h.state.answerFor(yes.occasionId, '2026-03-14'))?.answer).toBe('acknowledged');
  expect((await h.state.disclose()).interviews).toBe(0);
  const items = await h.state.openItems();
  expect(items).toHaveLength(1); expect(items[0]?.servedBoundaries).toEqual([...RAISE_BOUNDARIES]);
  expect(items[0]?.raiseCount).toBe(0); expect(h.deliveries).toEqual([]);
  const disk = new OccasionStateStore(h.statePath);
  expect((await disk.answerFor(yes.occasionId, '2026-03-14'))?.answer).toBe('acknowledged');
  expect((await disk.disclose()).interviews).toBe(0); expect(await disk.openItems()).toEqual(items);
 });
 test('acknowledging another occasion does not cancel useful pending gift preparation', async () => {
  const fake = recorded(), entered = deferred<void>(), release = deferred<void>();
  install({ ...fake.port, ask: async request => { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const h = harness(PROFILE.replace('## Plans', '- Other occasion · 03-14 · annual · remember-only\n## Plans'));
  const pending = h.service.answer(yes);
  await entered.promise;
  await h.service.acknowledge({ occasionId: 'other occasion', source: 'explicit' });
  release.resolve(); expect((await pending).interview?.nextStep?.opensFrom).toBe('Jo spends every Saturday at the pottery wheel.');
  expect((await h.state.answerFor(yes.occasionId, '2026-03-14'))?.answer).toBe('yes');
  expect((await h.state.answerFor('other occasion', '2026-03-14'))?.answer).toBe('acknowledged');
  expect((await h.state.openItems()).map(item => item.occasionId)).toEqual(['other occasion']);
 });


test('public legacy parsers preserve imports and behavior without deciding attribution', async () => {
  expect([...ownerAliasSet(['  Avery Chen  ', 'Avery', '', 'Jo Reyes'])]).toEqual(['avery chen', 'avery', 'jo reyes', 'jo']);
  expect(possessiveSubject("  Avery Chen's birthday  ")).toBe('Avery Chen');
  expect(possessiveSubject('Avery’s birthday')).toBe('Avery');
  expect(possessiveSubject('Our anniversary')).toBe('');
  const occasion = { title: "Avery's birthday", person: 'Avery', selfDeclared: false };
  expect(ownerAliasSet(['Avery Chen']).has(possessiveSubject(occasion.title).toLowerCase())).toBe(true);
  const reading = recorded({ subject: 'other' }); install(reading.port);
  expect(await resolveOccasionSubject(occasion, ['Avery Chen'])).toBe('other');
  installJudgmentPort(undefined);
  await expect(resolveOccasionSubject(occasion, ['Avery Chen'])).rejects.toThrow();
});


// Synthetic millisecond value deliberately satisfying the scanner's PAN shape.
const COLLISION_CLOCK = Date.parse('2026-10-10T17:48:00Z') + 6;
test('real composition keeps generated clocks and stored gift metadata out of semantic evidence', async () => {
  expect(judgmentInputProblem({ now: COLLISION_CLOCK })).toBe('card-material');
  const clock = spyOn(Date, 'now').mockReturnValue(COLLISION_CLOCK); restores.push(() => clock.mockRestore());
  const fake = recorded(); install(fake.port);
  const h = harness(PROFILE.replace('03-14', '10-18'));
  const get: ConfigManager['get'] = ((key: string) => key === 'daemon.timezone' ? 'UTC' : undefined) as ConfigManager['get'];
  const composition = composeOccasions(new GatewayMethodCatalog(), { ownerProfile: h.profile, configManager: { get }, statePath: h.statePath });
  try {
    await composition.state.recordGift({ occasionId: yes.occasionId, occurrence: '2025-10-18', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class', notes: 'Try a different glaze.' });
    const sweep = await composition.service.sweep();
    expect(sweep.nudge?.raisedAt).toBe(COLLISION_CLOCK);
    await composition.state.recordAnswer({ id: 'synthetic-later', occasionId: yes.occasionId, occurrence: '2026-10-18', answer: 'later', answeredAt: COLLISION_CLOCK });
    const pending = await composition.service.pending();
    expect(pending.nudge?.raisedAt).toBe(COLLISION_CLOCK);
    const result = await composition.service.answer(yes);
    expect(result.interview?.nextStep?.opensFrom).toContain('pottery wheel');
    const interview = await composition.state.activeInterview(yes.occasionId, '2026-10-18');
    expect(interview?.startedAt).toBe(COLLISION_CLOCK);
    expect(interview?.steps[1]?.opensFrom).toBe('A pottery class');
    const modelStates = JSON.stringify(fake.requests.map(request => request.state));
    expect(modelStates).not.toContain(String(COLLISION_CLOCK));
    expect(modelStates).not.toContain('2025-10-18');
    expect(modelStates).not.toContain('2026-10-18');
  } finally { await composition.dispose(); }
});

for (const where of ['landedOn', 'notes', 'extra'] as const) {
 test(`stored gift ${where} retains complete privacy admission despite excluded generated clock`, async () => {
  const fake = recorded(); install(fake.port); const h = harness();
  const gift = { occasionId: yes.occasionId, occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class', notes: 'A note', ...(where === 'extra' ? { extra: 'password=synthetic-secret' } : {}) };
  if (where !== 'extra') gift[where] = 'password=synthetic-secret';
  await h.state.recordGift(gift);
  await expect(h.service.answer(yes)).rejects.toMatchObject({ problem: 'credential-material' });
  expect(fake.requests).toHaveLength(0); expect(await h.state.acknowledgements()).toEqual([]);
 });
}

for (const where of ['clock', 'extra'] as const) {
 test(`direct caller ${where} remains fully admitted by interview, nudge and pending wrappers`, async () => {
  const fake = recorded(); install(fake.port); const h = harness();
  const occasion = readOccasionDeclarations(h.source).occasions[0]!;
  const now = where === 'clock' ? COLLISION_CLOCK : Date.parse('2026-03-06T10:00:00Z');
  const extra = where === 'extra' ? { extra: 'password=synthetic-secret' } : {};
  const problem = where === 'clock' ? 'card-material' : 'credential-material';
  await expect(openInterview({ occasion, occurrence: '2026-03-14', now, personLines: h.profile.read().sections.find(section => section.heading === 'People')!.prose, history: [], maxQuestions: 3, ...extra })).rejects.toMatchObject({ problem });
  await expect(composeNudge({ id: 'synthetic', now, subjects: [], ...extra })).rejects.toMatchObject({ problem });
  await expect(composePending({ today: '2026-03-06', now, leadDays: 10, occasions: [occasion], conflicts: [], openItems: [], acknowledgements: [], agentIsPushed: false, ...extra })).rejects.toMatchObject({ problem });
  expect(fake.requests).toHaveLength(0);
 });
}

for (const mutation of ['same', 'changed-and-restored', 'drop', 'unrelated'] as const) {
 test(`gift history publication ${mutation} has per-occasion lifetime through prepared yes`, async () => {
  const fake = recorded(), entered = deferred<void>(), release = deferred<void>();
  install({ ...fake.port, ask: async request => { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const h = harness();
  const gift = { occasionId: yes.occasionId, occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class' };
  await h.state.recordGift(gift);
  const pending = h.service.answer(yes); const failed = pending.then(() => false, () => true);
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Provider was not entered.'); })]);
    if (mutation === 'same') await h.state.recordGift({ ...gift });
    if (mutation === 'changed-and-restored') { await h.state.recordGift({ ...gift, landedOn: 'A different class' }); await h.state.recordGift({ ...gift }); }
    if (mutation === 'drop') await h.state.dropOccasion(yes.occasionId);
    if (mutation === 'unrelated') await h.state.recordGift({ ...gift, occasionId: 'someone else' });
    release.resolve();
    expect(await failed).toBe(mutation !== 'unrelated');
    expect((await h.state.disclose()).interviews).toBe(mutation === 'unrelated' ? 1 : 0);
    expect((await h.state.acknowledgements()).length).toBe(mutation === 'unrelated' ? 1 : 0);
  } finally { release.resolve(); await failed; }
 });
}

test('failed gift publication does not retire the actual current history receipt', async () => {
  const fake = recorded(), entered = deferred<void>(), release = deferred<void>();
  install({ ...fake.port, ask: async request => { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const h = harness();
  const pending = h.service.answer(yes); const failed = pending.then(() => false, () => true);
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Provider was not entered.'); })]);
    const spy = spyOn(PersistentStore.prototype, 'persist').mockRejectedValueOnce(new Error('synthetic failed gift write')); restores.push(() => spy.mockRestore());
    await expect(h.state.recordGift({ occasionId: yes.occasionId, occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class' })).rejects.toThrow();
    spy.mockRestore(); release.resolve();
    expect(await failed).toBe(false); expect((await h.state.disclose()).interviews).toBe(1);
  } finally { release.resolve(); await failed; }
});

for (const retire of ['profile', 'config'] as const) {
 test(`collision-clock real composition ${retire} retirement still prevents final owned construction/publication`, async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(COLLISION_CLOCK); restores.push(() => clock.mockRestore());
  const fake = recorded(), entered = deferred<void>(), release = deferred<void>();
  install({ ...fake.port, ask: async request => { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const h = harness(); let incarnation = 0;
  const get: ConfigManager['get'] = ((key: string) => key === 'daemon.timezone' ? 'UTC' : undefined) as ConfigManager['get'];
  const composition = composeOccasions(new GatewayMethodCatalog(), { ownerProfile: h.profile, configManager: { get, getConfigurationIncarnation: () => incarnation }, statePath: h.statePath });
  const pending = composition.service.answer(yes); const failed = pending.then(() => false, () => true);
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Provider was not entered.'); })]);
    if (retire === 'profile') h.reload(); else incarnation++;
    release.resolve(); expect(await failed).toBe(true);
    expect(await composition.state.acknowledgements()).toEqual([]); expect((await composition.state.disclose()).interviews).toBe(0);
  } finally { release.resolve(); await composition.dispose(); await failed; }
 });
}

test('queued gift publication retires earlier prepared yes before its owned state write', async () => {
  const h = harness(); await h.state.acknowledgements();
  const queued = nextStoreWriteQueued();
  const storeEntered = deferred<void>(), storeRelease = deferred<void>();
  const readerEntered = deferred<void>(), readerRelease = deferred<void>();
  const original = PersistentStore.prototype.persist; let held = false;
  const spy = spyOn(PersistentStore.prototype, 'persist').mockImplementation(async function(this: PersistentStore<Record<string, unknown>>, data, options) {
    if (!held) { held = true; storeEntered.resolve(); await storeRelease.promise; }
    return original.call(this, data, options);
  }); restores.push(() => spy.mockRestore());
  const fake = recorded();
  install({ ...fake.port, ask: async request => { readerEntered.resolve(); await readerRelease.promise; return fake.port.ask(request); } });
  const giftWrite = h.state.recordGift({ occasionId: yes.occasionId, occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class' });
  await storeEntered.promise;
  const pending = h.service.answer(yes); const failed = pending.then(() => false, () => true);
  try {
    await Promise.race([readerEntered.promise, pending.then(() => { throw new Error('Provider was not entered.'); })]);
    readerRelease.resolve();
    await Promise.race([queued, pending.then(() => { throw new Error('Interview completed before its store write was queued.'); })]);
    storeRelease.resolve(); await giftWrite;
    expect(await failed).toBe(true);
    expect(await h.state.acknowledgements()).toEqual([]); expect((await h.state.disclose()).interviews).toBe(0);
    const disk = new OccasionStateStore(h.statePath);
    expect((await disk.giftHistory(yes.occasionId))[0]?.landedOn).toBe('A pottery class');
    expect(await disk.acknowledgements()).toEqual([]);
  } finally { readerRelease.resolve(); storeRelease.resolve(); await giftWrite; await failed; }
});


test('reopened gift state screens duplicate raw extras without exposing them through ordinary history', async () => {
  const fake = recorded(); install(fake.port); const h = harness();
  const gift = { occasionId: yes.occasionId, occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class' };
  writeFileSync(h.statePath, JSON.stringify({ version: 1, gifts: [{ ...gift, extra: 'password=synthetic-secret' }, gift], acknowledgements: [], openItems: [], interviews: [], mirrors: [], lastSweep: null }));
  expect(JSON.stringify(await h.state.giftHistory(yes.occasionId))).not.toContain('synthetic-secret');
  await expect(h.service.answer(yes)).rejects.toMatchObject({ problem: 'credential-material' });
  expect(fake.requests).toHaveLength(0); expect(await h.state.acknowledgements()).toEqual([]);
});

for (const category of ['openItems', 'acknowledgements'] as const) {
 test(`reopened pending ${category} retains raw extra refusal before any semantic reading`, async () => {
  const fake = recorded(); install(fake.port); const h = harness();
  const item = { id: 'synthetic', kind: 'nudge', occasionId: yes.occasionId, occurrence: '2026-03-14', openedAt: COLLISION_CLOCK, lastRaisedAt: COLLISION_CLOCK, raiseCount: 0, servedBoundaries: [], dueOn: '2026-03-06' };
  const acknowledgement = { id: 'synthetic', occasionId: yes.occasionId, occurrence: '2026-03-14', answer: 'later', answeredAt: COLLISION_CLOCK };
  writeFileSync(h.statePath, JSON.stringify({ version: 1, gifts: [], openItems: [{ ...item, ...(category === 'openItems' ? { extra: 'password=synthetic-secret' } : {}) }], acknowledgements: [{ ...acknowledgement, ...(category === 'acknowledgements' ? { extra: 'password=synthetic-secret' } : {}) }], interviews: [], mirrors: [], lastSweep: null }));
  await expect(h.service.pending()).rejects.toMatchObject({ problem: 'credential-material' });
  expect(fake.requests).toHaveLength(0);
  expect(JSON.stringify(await h.state.openItems())).not.toContain('synthetic-secret');
  expect(JSON.stringify(await h.state.acknowledgements())).not.toContain('synthetic-secret');
 });
}

test('explicit stored-record schemas and collection extras cannot become admission shortcuts', () => {
  const gift = { occasionId: 'synthetic', occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class' };
  const item = { id: 'synthetic', kind: 'nudge', occasionId: 'synthetic', occurrence: '2026-03-14', openedAt: COLLISION_CLOCK, lastRaisedAt: COLLISION_CLOCK, raiseCount: 0, servedBoundaries: [], dueOn: '2026-03-06' };
  const acknowledgement = { id: 'synthetic', occasionId: 'synthetic', occurrence: '2026-03-14', answer: 'later', answeredAt: COLLISION_CLOCK };
  expect(() => storedGiftEvidence([{ ...gift, landedOn: 3 }])).toThrow();
  expect(() => storedGiftEvidence([{ ...gift, recordedAt: 'password=synthetic-secret' }])).toThrow();
  expect(() => storedOpenItemEvidence([{ ...item, kind: {} }])).toThrow();
  expect(() => storedOpenItemEvidence([{ ...item, servedBoundaries: ['invented'] }])).toThrow();
  expect(() => storedAcknowledgementEvidence([{ ...acknowledgement, source: 'invented' }])).toThrow();
  expect(() => storedAcknowledgementEvidence([{ ...acknowledgement, answeredAt: 'password=synthetic-secret' }])).toThrow();
  expect(storedAcknowledgementEvidence([acknowledgement])[0]?.answer).toBe('later');
  for (const key of ['extra', '4294967295']) {
    const collection = Object.assign([gift], { [key]: 'password=synthetic-secret' });
    expect(() => storedGiftEvidence(collection)).toThrow();
  }
  const original = Object.assign([gift], { extra: 'ordinary context' });
  const work = new OccasionReadingWork(); storedGiftEvidence(original, work);
  original.extra = 'changed context'; expect(() => work.assertCurrent()).toThrow();
});

test('safe loaded extras retire on successor sanitation but owned yes renews only its publication receipt', async () => {
  const gift = { occasionId: yes.occasionId, occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class', extra: 'ordinary context' };
  const h = harness();
  writeFileSync(h.statePath, JSON.stringify({ version: 1, gifts: [gift], acknowledgements: [], openItems: [], interviews: [], mirrors: [], lastSweep: null }));
  install(recorded().port);
  expect((await h.service.answer(yes)).ok).toBe(true);
  expect((await h.state.disclose()).interviews).toBe(1);
  expect(readFileSync(h.statePath, 'utf8')).not.toContain('ordinary context');

  const other = harness();
  writeFileSync(other.statePath, JSON.stringify({ version: 1, gifts: [gift], acknowledgements: [], openItems: [], interviews: [], mirrors: [], lastSweep: null }));
  const fake = recorded(), entered = deferred<void>(), release = deferred<void>();
  install({ ...fake.port, ask: async request => { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const pending = other.service.answer(yes); const failed = pending.then(() => false, () => true);
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Provider was not entered.'); })]);
    await other.state.recordGift({ occasionId: 'someone else', occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A class' });
    release.resolve(); expect(await failed).toBe(true);
    expect((await other.state.disclose()).interviews).toBe(0);
  } finally { release.resolve(); await failed; }
});

test('failed sanitation publication retains value-free raw refusal until an actual successful write', async () => {
  const h = harness(); const fake = recorded(); install(fake.port);
  const gift = { occasionId: yes.occasionId, occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class', extra: 'password=synthetic-secret' };
  writeFileSync(h.statePath, JSON.stringify({ version: 1, gifts: [gift], acknowledgements: [], openItems: [], interviews: [], mirrors: [], lastSweep: null }));
  await h.state.giftHistory(yes.occasionId);
  const spy = spyOn(PersistentStore.prototype, 'persist').mockRejectedValueOnce(new Error('synthetic failed sanitation')); restores.push(() => spy.mockRestore());
  const other = { occasionId: 'someone else', occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A class' };
  await expect(h.state.recordGift(other)).rejects.toThrow(); spy.mockRestore();
  await expect(h.service.answer(yes)).rejects.toMatchObject({ problem: 'credential-material' });
  expect(fake.requests).toHaveLength(0);
  await h.state.recordGift(other);
  expect(readFileSync(h.statePath, 'utf8')).not.toContain('synthetic-secret');
  expect((await h.service.answer(yes)).ok).toBe(true);
});


test('published reading records own immutable copies while mutation results and getter shapes remain compatible', async () => {
  const h = harness();
  const gift = { occasionId: yes.occasionId, occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class', extra: { description: 'ordinary context' } };
  expect(await h.state.recordGift(gift)).toBe(gift);
  const stored = (await h.state.giftHistory(yes.occasionId))[0]!;
  expect(stored).toEqual(gift); expect(stored).not.toBe(gift);
  expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
  expect(Object.isFrozen(stored)).toBe(true);
  const extra = (stored as typeof gift).extra;
  expect(Object.getPrototypeOf(extra)).toBe(Object.prototype); expect(Object.isFrozen(extra)).toBe(true);
  gift.landedOn = 'changed after publication'; gift.extra.description = 'password=synthetic-secret';
  expect((await h.state.giftHistory(yes.occasionId))[0]?.landedOn).toBe('A pottery class');
  expect(extra.description).toBe('ordinary context');
  const history = await h.state.giftHistory(yes.occasionId);
  expect(Object.isFrozen(history)).toBe(false);
  const reopened = new OccasionStateStore(h.statePath);
  expect((await reopened.giftHistory(yes.occasionId))[0]?.landedOn).toBe('A pottery class');
});

test('incremental proofs reuse only owned immutable records, never caller identity or discarded extras', () => {
  const owner = new StoredRecordAdmissionOwner();
  const gift = { occasionId: 'synthetic', occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class' };
  const first = owner.own('gifts', [gift]);
  const repeated = owner.own('gifts', first);
  expect(repeated[0]).toBe(first[0]); expect(Object.isFrozen(first)).toBe(true);
  gift.landedOn = 'password=synthetic-secret';
  const changedCaller = owner.own('gifts', [gift]);
  expect(changedCaller[0]).not.toBe(first[0]);
  expect(owner.giftAdmission(changedCaller).problems.get('synthetic')).toBe('credential-material');
  expect(owner.giftAdmission(first).problems.size).toBe(0);
  const duplicate = owner.own('gifts', [changedCaller[0]!, first[0]!]);
  expect(owner.giftAdmission(duplicate).problems.get('synthetic')).toBe('credential-material');
  const withExtra = Object.assign([first[0]!], { extra: 'password=synthetic-secret' });
  expect(() => owner.own('gifts', owner.own('gifts', withExtra))).toThrow();
  const ordinaryExtra = owner.own('gifts', Object.assign([first[0]!], { extra: 'ordinary context' }));
  expect(owner.giftAdmission(owner.own('gifts', ordinaryExtra)).problems.size).toBe(0);
});

test('stored record ownership rejects accessors and unsupported prototypes without running user hooks', async () => {
  const h = harness(); let getterCalls = 0;
  const gift = { occasionId: yes.occasionId, occurrence: '2025-03-14', recordedAt: COLLISION_CLOCK, landedOn: 'A pottery class' };
  for (const key of ['extra', 'occasionId']) {
    const accessor = Object.defineProperty({ ...gift }, key, { enumerable: true, get: () => { getterCalls++; return 'ordinary'; } });
    await expect(h.state.recordGift(accessor)).rejects.toMatchObject({ problem: 'unsupported-input' });
  }
  expect(getterCalls).toBe(0); expect(await h.state.giftHistory(yes.occasionId)).toEqual([]);
  const inherited = Object.assign(Object.create({ inherited: 'ordinary' }) as typeof gift, gift);
  await expect(h.state.recordGift(inherited)).rejects.toMatchObject({ problem: 'unsupported-input' });
  const symbolic = { ...gift, [Symbol('extra')]: 'ordinary' };
  await expect(h.state.recordGift(symbolic)).rejects.toMatchObject({ problem: 'unsupported-input' });
  expect(await h.state.giftHistory(yes.occasionId)).toEqual([]);
  await h.state.recordGift(gift);
  expect((await h.state.giftHistory(yes.occasionId))[0]?.landedOn).toBe('A pottery class');
});


for (const empty of [true, false]) {
 test(`nonpersistable protected batch-array extras cannot be discarded before ${empty ? 'empty' : 'nonempty'} publication`, async () => {
  const h = harness(); let published = 0;
  const item = { id: 'synthetic', kind: 'nudge' as const, occasionId: yes.occasionId, occurrence: '2026-03-14', openedAt: COLLISION_CLOCK, lastRaisedAt: COLLISION_CLOCK, raiseCount: 0, servedBoundaries: [], dueOn: '2026-03-06' };
  const batch = Object.assign(empty ? [] : [item], { extra: 'password=synthetic-secret' });
  const spy = spyOn(PersistentStore.prototype, 'persist'); restores.push(() => spy.mockRestore());
  await expect(h.state.putOpenItems(batch, () => {}, () => { published++; })).rejects.toMatchObject({ problem: 'credential-material' });
  expect(spy).not.toHaveBeenCalled(); expect(published).toBe(0);
  expect(() => readFileSync(h.statePath)).toThrow(); expect(await h.state.openItems()).toEqual([]);
  const safe = Object.assign(empty ? [] : [item], { extra: 'ordinary context' });
  await h.state.putOpenItems(safe, () => {}, () => { published++; });
  expect((await h.state.openItems()).length).toBe(empty ? 0 : 1);
  expect(published).toBe(empty ? 0 : 1);
 });
}


for (const outcome of ['success', 'failure', 'same-content'] as const) {
 test(`actual interview cannot publish through an in-flight own profile ${outcome} write`, async () => {
  resetProcessUntrustedContentLedgerForTests();
  const readerEntered = deferred<void>(), readerRelease = deferred<void>();
  const writeEntered = deferred<void>(), writeRelease = deferred<void>();
  const fake = recorded();
  install({ ...fake.port, ask: async request => { readerEntered.resolve(); await readerRelease.promise; return fake.port.ask(request); } });
  const h = harness(PROFILE, {
    mkdir: async () => {},
    writeFile: async (file, content) => {
      writeEntered.resolve(); await writeRelease.promise;
      if (outcome === 'failure') throw new Error('synthetic profile write failed');
      writeFileSync(file, content);
    },
    rename: async (from, to) => { renameSync(from, to); },
    remove: async file => { rmSync(file, { force: true }); },
  });
  const pending = h.service.answer(yes); const failed = pending.then(() => false, () => true);
  let writing: ReturnType<OwnerProfileStore['set']> | undefined;
  try {
    await Promise.race([readerEntered.promise, pending.then(() => { throw new Error('Provider was not entered.'); })]);
    const activeWrite: ReturnType<OwnerProfileStore['set']> = outcome === 'same-content'
      ? h.profile['commit']((projection: ProfileProjection) => ({ ok: true, reason: null, lines: projection.rawLines, changes: [] }))
      : h.profile.set({ authority: 'owner-direct', surface: 'tui', fieldId: 'identity.name', value: 'Avery Chen', said: 'Use this name', date: '2026-03-06' });
    writing = activeWrite;
    await Promise.race([writeEntered.promise, activeWrite.then(() => { throw new Error('Persistence was not entered.'); })]);
    readerRelease.resolve(); expect(await failed).toBe(true);
    expect(await h.state.acknowledgements()).toEqual([]); expect((await h.state.disclose()).interviews).toBe(0);
    writeRelease.resolve(); expect((await activeWrite).ok).toBe(outcome !== 'failure');
    expect((await h.service.answer(yes)).ok).toBe(true);
  } finally { readerRelease.resolve(); writeRelease.resolve(); await writing; await failed; }
 });
}
