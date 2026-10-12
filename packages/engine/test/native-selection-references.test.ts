import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ownedAutomationJob, AutomationJobMutationStaleError } from '../sdk/src/platform/automation/job-mutations.ts';
import { AutomationManager, assertRetainedAutomationTargetCurrent, projectRetainedAutomationRequest } from '../sdk/src/platform/automation/manager-runtime.ts';
import { AutomationJobStore } from '../sdk/src/platform/automation/store/jobs.ts';
import { snapshotJudgmentInput } from '../sdk/src/platform/gate/judgment-input.ts';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.ts';
import { ProjectPlanningService } from '../sdk/src/platform/knowledge/project-planning/service.ts';
import { findCardNumberShapes } from '../sdk/src/platform/security/card-shapes.ts';
import { automationMutationFixture } from './_helpers/automation-mutation-fixture.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const revision = 'aaaa4111-1111-4111-8110-abcdefabcdef';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function automation() {
  const directory = makeProjectTempDir('native-selected-reference');
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const first = automationMutationFixture(directory);
  try { await first.store.save([ownedAutomationJob(await first.create(), revision)]); }
  finally { await first.close(); }
  const actual = automationMutationFixture(directory); cleanup.push(() => actual.close());
  await actual.manager.start();
  const selected = (await actual.store.load()).jobs[0];
  if (!selected) throw new Error('Actual automation store lost the producer job');
  const target = actual.manager.retainJobTarget(selected.id, revision);
  const body = { jobId: selected.id, expectedMutationRevision: revision, name: 'Native durable', admission: 'autonomous' };
  return { ...actual, target, body, selected };
}

test('a real producer-owned card-shaped UUID is local while the full request meaning remains admitted', async () => {
  const f = await automation(); expect(findCardNumberShapes(revision, 1)).toHaveLength(1);
  const projected = snapshotJudgmentInput(projectRetainedAutomationRequest(f.target, 'automation.jobs.update', { ...f.body, extra: { note: 'Keep this unknown meaning' } }));
  expect(projected).toMatchObject({ name: 'Native durable', extra: { note: 'Keep this unknown meaning' }, expectedMutationRevision: { kind: 'selected-native-revision' } });
  expect(JSON.stringify(projected)).not.toContain(revision);
  expect(f.body.expectedMutationRevision).toBe(revision);
});

test('a borrowed selection method cannot mint a native reference through receiver-supplied callbacks', async () => {
  const f = await automation();
  let suppliedCalls = 0;
  const job = ownedAutomationJob(f.selected, revision);
  const foreign = {
    jobs: new Map([[job.id, job]]), mutationLifetime: {},
    jobStore: { assertCurrent: () => { suppliedCalls += 1; } },
    requireEnabled: () => { suppliedCalls += 1; },
  };
  Object.setPrototypeOf(foreign, AutomationManager.prototype);
  expect(() => Reflect.apply(AutomationManager.prototype.retainJobTarget, foreign, [job.id, revision])).toThrow(TypeError);
  expect(suppliedCalls).toBe(0);
});

for (const kind of ['jobs', 'jobs accessor', 'store', 'store accessor', 'owner method', 'owner method accessor',
  'store method', 'store method accessor', 'file method', 'file method accessor', 'map method', 'map method accessor',
  'feature flags accessor', 'lifetime accessor'] as const) {
  test(`a genuine manager refuses replaced ${kind} before invoking supplied ownership`, async () => {
    const f = await automation(); let suppliedCalls = 0;
    const jobs: unknown = Object.getOwnPropertyDescriptor(f.manager, 'jobs')?.value;
    if (!jobs || typeof jobs !== 'object') throw new Error('Actual manager lost its native job map');
    const object = kind.startsWith('store method') || kind.startsWith('file method') ? f.store
      : kind.startsWith('map method') ? jobs : f.manager;
    const key = kind.startsWith('jobs') ? 'jobs' : kind.startsWith('store method') ? 'assertCurrent'
      : kind.startsWith('file method') ? 'fileIdentity' : kind.startsWith('store') ? 'jobStore'
      : kind.startsWith('map method') ? 'get' : kind.startsWith('feature') ? 'featureFlags'
      : kind.startsWith('lifetime') ? 'mutationLifetime' : 'requireEnabled';
    const original = Object.getOwnPropertyDescriptor(object, key);
    const supplied = () => { suppliedCalls += 1; return undefined; };
    const value = kind === 'jobs' ? new Map([[f.selected.id, ownedAutomationJob(f.selected, revision)]])
      : kind === 'store' ? { assertCurrent: supplied } : supplied;
    Object.defineProperty(object, key, kind.endsWith('accessor') ? { configurable: true, get: supplied } : { configurable: true, value });
    try {
      const before = readFileSync(f.path);
      expect(() => f.manager.retainJobTarget(f.selected.id, revision)).toThrow(AutomationJobMutationStaleError);
      expect(() => projectRetainedAutomationRequest(f.target, 'automation.jobs.update', f.body)).toThrow(AutomationJobMutationStaleError);
      expect(suppliedCalls).toBe(0); expect(readFileSync(f.path)).toEqual(before);
    } finally {
      if (original) Object.defineProperty(object, key, original); else Reflect.deleteProperty(object, key);
    }
  });
}

test('a proxy receiver cannot borrow the canonical issuer or invoke receiver traps', async () => {
  const f = await automation(); let suppliedCalls = 0;
  const proxy = new Proxy(f.manager, { get(target, key, receiver) { suppliedCalls += 1; return Reflect.get(target, key, receiver); } });
  expect(() => Reflect.apply(AutomationManager.prototype.retainJobTarget, proxy, [f.selected.id, revision])).toThrow(TypeError);
  expect(suppliedCalls).toBe(0);
});

for (const kind of ['function', 'accessor'] as const) {
  test(`a native parent map refuses a supplied iterator ${kind} before invoking it`, async () => {
    const f = await automation(); let suppliedCalls = 0;
    const parents: unknown = Object.getOwnPropertyDescriptor(f.store, 'parents')?.value;
    if (!(parents instanceof Map)) throw new Error('Actual store lost its native parent map');
    const original = Object.getOwnPropertyDescriptor(parents, Symbol.iterator);
    const supplied = () => { suppliedCalls += 1; return Map.prototype[Symbol.iterator].call(parents); };
    Object.defineProperty(parents, Symbol.iterator, kind === 'function'
      ? { configurable: true, value: supplied } : { configurable: true, get: () => { suppliedCalls += 1; return supplied; } });
    try {
      const before = readFileSync(f.path);
      expect(() => f.manager.retainJobTarget(f.selected.id, revision)).toThrow(AutomationJobMutationStaleError);
      expect(() => projectRetainedAutomationRequest(f.target, 'automation.jobs.update', f.body)).toThrow(AutomationJobMutationStaleError);
      expect(suppliedCalls).toBe(0); expect(readFileSync(f.path)).toEqual(before);
    } finally {
      if (original) Object.defineProperty(parents, Symbol.iterator, original); else Reflect.deleteProperty(parents, Symbol.iterator);
    }
    assertRetainedAutomationTargetCurrent(f.target);
  });
}

test('canonical persistence can establish originally absent parent identities without retiring the native owner', async () => {
  const f = await automation();
  const store = new AutomationJobStore(join(dirname(f.path), 'native-owned', 'inner', 'jobs.json'));
  const manager = new AutomationManager({ configManager: f.config, jobStore: store, routeBindings: f.routes,
    sessionBroker: f.broker, spawnTask: () => 'synthetic-local-agent', agentStatusProvider: { getStatus: () => null } });
  cleanup.push(() => manager.stop());
  const parents: unknown = Object.getOwnPropertyDescriptor(store, 'parents')?.value;
  if (!(parents instanceof Map)) throw new Error('Actual store lost its native parent map');
  expect(parents.size).toBe(2); expect([...parents.values()]).toEqual([null, null]);
  const job = await manager.createJob({ name: 'Nested native', prompt: 'Synthetic local reminder',
    schedule: { kind: 'every', intervalMs: 3_600_000 }, enabled: false });
  if (!job || typeof job.mutationRevision !== 'string') throw new Error('Actual manager lost its producer revision');
  expect([...parents.values()].every(value => typeof value === 'string')).toBe(true);
  const target = manager.retainJobTarget(job.id, job.mutationRevision);
  expect(snapshotJudgmentInput(projectRetainedAutomationRequest(target, 'automation.jobs.update', {
    jobId: job.id, expectedMutationRevision: job.mutationRevision, name: 'Nested native retained',
  }))).toMatchObject({ name: 'Nested native retained', expectedMutationRevision: { kind: 'selected-native-revision' } });
});

for (const kind of ['copy', 'job identity', 'job content', 'assertion', 'accessor', 'unknown method', 'foreign selector', 'foreign revision'] as const) {
  test(`automation reference refuses ${kind} without invoking supplied ownership`, async () => {
    const f = await automation(); let suppliedCalls = 0;
    let target = f.target, body = f.body, method = 'automation.jobs.update';
    if (kind === 'copy') target = { ...target, assertCurrent: () => { suppliedCalls += 1; } };
    if (kind === 'job identity') Object.defineProperty(target, 'job', { value: { ...target.job } });
    if (kind === 'job content') Object.defineProperty(target.job, 'name', { value: 'Different semantic target' });
    if (kind === 'assertion') Object.defineProperty(target, 'assertCurrent', { value: () => { suppliedCalls += 1; } });
    if (kind === 'accessor') Object.defineProperty(target, 'job', { get: () => { suppliedCalls += 1; return f.selected; } });
    if (kind === 'unknown method') method = 'automation.jobs.create';
    if (kind === 'foreign selector') body = { ...body, jobId: 'foreign' };
    if (kind === 'foreign revision') body = { ...body, expectedMutationRevision: 'foreign' };
    const before = readFileSync(f.path);
    expect(() => projectRetainedAutomationRequest(target, method, body)).toThrow(AutomationJobMutationStaleError);
    expect(suppliedCalls).toBe(0); expect(readFileSync(f.path)).toEqual(before);
  });
}

for (const tail of [{ unknown: { pan: '4111111111111111' } }, { unknown: { apiKey: 'SYNTHETIC_NOT_A_REAL_KEY' } }]) {
  test('a retained automation reference never suppresses a nested private tail', async () => {
    const f = await automation(); const before = readFileSync(f.path);
    expect(() => snapshotJudgmentInput(projectRetainedAutomationRequest(f.target, 'automation.jobs.update', { ...f.body, ...tail }))).toThrow();
    expect(readFileSync(f.path)).toEqual(before);
  });
}

for (const kind of ['ABA', 'physical replacement', 'stop'] as const) {
  test(`retained automation reference keeps actual ${kind} retirement`, async () => {
    const f = await automation();
    if (kind === 'ABA') {
      await f.manager.updateJob(f.selected.id, { name: 'Temporary' });
      await f.manager.updateJob(f.selected.id, { name: f.selected.name });
    }
    if (kind === 'physical replacement') { const bytes = readFileSync(f.path); renameSync(f.path, `${f.path}.old`); writeFileSync(f.path, bytes); }
    if (kind === 'stop') f.manager.stop();
    const before = readFileSync(f.path);
    expect(() => assertRetainedAutomationTargetCurrent(f.target)).toThrow(AutomationJobMutationStaleError);
    expect(() => projectRetainedAutomationRequest(f.target, 'automation.jobs.update', f.body)).toThrow(AutomationJobMutationStaleError);
    expect(readFileSync(f.path)).toEqual(before);
  });
}

async function planning() {
  const directory = makeProjectTempDir('planning-selected-reference');
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const clock = spyOn(Date, 'now').mockReturnValue(70_000); cleanup.push(() => clock.mockRestore());
  const fake = fakePort(name => { if (name !== 'specified') throw new Error(`Unexpected planning question: ${name}`); return noulAnswer(0.01); });
  const previous = installJudgmentPort(fake.port); cleanup.push(() => { installJudgmentPort(previous); });
  const path = join(directory, 'planning.sqlite'); const store = new KnowledgeStore({ dbPath: path }); cleanup.push(() => store.close());
  const service = new ProjectPlanningService(store);
  const state = { goal: 'Preserve retry history', scope: 'Retry helper only', executionApproved: true,
    tasks: [{ id: 'retry', title: 'Keep retry records', verification: ['Run retry tests'] }], metadata: { active: true, owner: 'tui' },
  };
  await service.upsertState({ projectId: 'proj', state });
  const first = await service.getState({ projectId: 'proj' });
  if (!first.source) throw new Error('Planning fixture lost its native source');
  // Fixed safe metadata produces a card-shaped SHA of the complete actual native row.
  await store.upsertSource({ ...first.source, metadata: { ...first.source.metadata, diagnosticSalt: 'safe-fixture-910' } });
  const selected = await service.getState({ projectId: 'proj' });
  if (!selected.source || !selected.revision) throw new Error('Planning fixture lost its native revision');
  expect(findCardNumberShapes(selected.revision.generation, 1)).toHaveLength(1);
  return { store, service, path, fake, state, selected: { ...selected, source: selected.source, revision: selected.revision } };
}

test('a real full-row card-shaped fingerprint supports selected and native conditional planning publication', async () => {
  const f = await planning();
  const result = await f.service.applyStateAction({ projectId: 'proj', expected: { kind: 'revision', revision: f.selected.revision }, action: { kind: 'dismiss' } });
  expect(result).toMatchObject({ applied: true, state: { metadata: { active: false } } });
  const next = await planning();
  await next.service.upsertState({ projectId: 'proj', state: { ...next.state, goal: 'A newer historical record' } });
  expect((await next.service.getState({ projectId: 'proj' })).state?.goal).toBe('A newer historical record');
});

for (const tail of [{ unknown: { pan: '4111111111111111' } }, { unknown: { apiKey: 'SYNTHETIC_NOT_A_REAL_KEY' } }]) {
  test('matched planning input and write references still refuse complete private tails without new dispatch', async () => {
    const f = await planning(), before = readFileSync(f.path), requests = f.fake.requests.length;
    await expect(f.service.applyStateAction({ projectId: 'proj', expected: { kind: 'revision', revision: f.selected.revision }, action: { kind: 'dismiss' }, ...tail })).rejects.toThrow();
    await expect(f.store.upsertOwnedCanonicalSources([{ input: { ...f.selected.source, ...tail }, generation: f.selected.revision.generation }], () => {}, () => {})).rejects.toThrow();
    const writes = [{ input: f.selected.source, generation: f.selected.revision.generation }];
    Object.defineProperty(writes, 'unknown', { value: tail.unknown, enumerable: true });
    await expect(f.store.upsertOwnedCanonicalSources(writes, () => {}, () => {})).rejects.toThrow();
    expect(f.fake.requests.length).toBe(requests); expect(readFileSync(f.path)).toEqual(before);
  });
}

test('forged planning revision keeps ordinary privacy admission and cannot grant a native write', async () => {
  const f = await planning(), before = readFileSync(f.path), requests = f.fake.requests.length;
  const generation = `${'a'.repeat(24)}4111111111111111${'a'.repeat(24)}`;
  await expect(f.service.applyStateAction({ projectId: 'proj', expected: { kind: 'revision', revision: { ...f.selected.revision, generation } }, action: { kind: 'dismiss' } })).rejects.toMatchObject({ problem: 'card-material' });
  await expect(f.store.upsertOwnedCanonicalSources([{ input: f.selected.source, generation }], () => {}, () => {})).rejects.toMatchObject({ problem: 'card-material' });
  expect(f.fake.requests.length).toBe(requests); expect(readFileSync(f.path)).toEqual(before);
});


for (const state of ['existing', 'absent'] as const) {
  test(`an unmatched ${state} planning source screens a forged revision before its held result`, async () => {
    const f = await planning();
    const store = state === 'existing' ? f.store : new KnowledgeStore({ dbPath: `${f.path}.absent` });
    if (state === 'absent') { await store.init(); cleanup.push(() => store.close()); }
    const service = state === 'existing' ? f.service : new ProjectPlanningService(store);
    const path = store.storagePath, before = existsSync(path) ? readFileSync(path) : undefined, requests = f.fake.requests.length;
    const generation = `${'a'.repeat(24)}4111111111111111${'a'.repeat(24)}`;
    await expect(service.applyStateAction({ projectId: 'proj',
      expected: { kind: 'revision', revision: { ...f.selected.revision, generation } }, action: { kind: 'dismiss' },
    })).rejects.toMatchObject({ problem: 'card-material' });
    expect(f.fake.requests.length).toBe(requests);
    expect(existsSync(path)).toBe(before !== undefined);
    if (before !== undefined) expect(readFileSync(path)).toEqual(before);
  });

  test(`an ordinary unmatched ${state} planning revision keeps its effect-free held result`, async () => {
    const f = await planning();
    const store = state === 'existing' ? f.store : new KnowledgeStore({ dbPath: `${f.path}.ordinary-absent` });
    if (state === 'absent') { await store.init(); cleanup.push(() => store.close()); }
    const service = state === 'existing' ? f.service : new ProjectPlanningService(store);
    const path = store.storagePath, before = existsSync(path) ? readFileSync(path) : undefined, requests = f.fake.requests.length;
    const generation = 'a'.repeat(64);
    expect(generation).not.toBe(f.selected.revision.generation);
    const result = await service.applyStateAction({ projectId: 'proj',
      expected: { kind: 'revision', revision: { ...f.selected.revision, generation } }, action: { kind: 'dismiss' },
    });
    expect(result).toMatchObject({ applied: false, reason: state === 'existing' ? 'state-changed' : 'no-state' });
    expect(f.fake.requests.length).toBe(requests);
    expect(existsSync(path)).toBe(before !== undefined);
    if (before !== undefined) expect(readFileSync(path)).toEqual(before);
  });
}

test('a matching generation alone cannot project a foreign planning source identity', async () => {
  const f = await planning(), before = readFileSync(f.path), requests = f.fake.requests.length;
  const revision = { ...f.selected.revision, sourceId: 'foreign-source' };
  await expect(f.service.applyStateAction({ projectId: 'proj',
    expected: { kind: 'revision', revision }, action: { kind: 'dismiss' },
  })).rejects.toMatchObject({ problem: 'card-material' });
  expect(f.fake.requests.length).toBe(requests);
  expect(readFileSync(f.path)).toEqual(before);
});
