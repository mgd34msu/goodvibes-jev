import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, promises as fs, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PersistentStore } from '../sdk/src/platform/state/persistent-store.js';
import { AutomationJobCommitIndeterminateError, AutomationJobMutationStaleError } from '../sdk/src/platform/automation/job-mutations.js';
import { AutomationJobStore } from '../sdk/src/platform/automation/store/jobs.js';
import type { MutationPublication } from '../sdk/src/platform/utils/file-mutation.js';
import { automationMutationFixture, managedAutomationJob } from './_helpers/automation-mutation-fixture.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const directory = makeProjectTempDir('automation-mutation');
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const f = automationMutationFixture(directory); cleanup.push(() => f.close());
  return { ...f, directory };
}

test('actual private stage keeps the original job visible until durable publication', async () => {
  const f = fixture(), job = await f.create(), bytes = readFileSync(f.path);
  const original = PersistentStore.prototype.persist;
  let stages = 0;
  const persist = spyOn(PersistentStore.prototype, 'persist').mockImplementation(async function(this: PersistentStore<Record<string, unknown>>, data, options = {}) {
    return await original.call(this, data, { ...options, beforePublish: () => {
      expect(readFileSync(f.path)).toEqual(bytes);
      expect(f.manager.getJob(job.id)?.name).toBe('Original'); stages++;
      options.beforePublish?.();
    } });
  });
  try {
    const updated = managedAutomationJob(await f.manager.updateJob(job.id, { name: 'Durable', expectedMutationRevision: job.mutationRevision }));
    expect(stages).toBe(1); expect(updated.mutationRevision).not.toBe(job.mutationRevision);
    expect(f.manager.getJob(job.id)).toEqual(updated);
    expect((await new AutomationJobStore(f.path).load()).jobs[0]).toEqual(updated);
  } finally { persist.mockRestore(); }
});

test.each(['abort', 'revoke', 'stop', 'patch', 'options', 'publication'] as const)('actual temp-file stage rejects %s before publishing bytes or memory', async kind => {
  const f = fixture(), job = await f.create(), bytes = readFileSync(f.path), controller = new AbortController();
  let valid = true;
  const patch = { name: 'Never published', expectedMutationRevision: job.mutationRevision };
  const withPublication: MutationPublication = async operation => await operation(() => {});
  const options = { signal: controller.signal, assertCurrent: () => { if (!valid) throw new Error('Synthetic source revoked'); }, withPublication };
  const original = PersistentStore.prototype.persist;
  const persist = spyOn(PersistentStore.prototype, 'persist').mockImplementation(async function(this: PersistentStore<Record<string, unknown>>, data, controls = {}) {
    return await original.call(this, data, { ...controls, beforePublish: () => {
      if (kind === 'abort') controller.abort();
      if (kind === 'revoke') valid = false;
      if (kind === 'stop') f.manager.stop();
      if (kind === 'patch') patch.name = 'Retargeted';
      if (kind === 'options') options.assertCurrent = () => undefined;
      if (kind === 'publication') options.withPublication = async operation => await operation(() => {});
      controls.beforePublish?.(); controls.assertCurrent?.();
    } });
  });
  try {
    await expect(f.manager.updateJob(job.id, patch, options)).rejects.toThrow();
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(f.manager.getJob(job.id)).toEqual(job);
    expect((await fs.readdir(f.directory)).filter(name => name.includes('.tmp.'))).toEqual([]);
  } finally { persist.mockRestore(); }
});

test.each(['abort', 'revoke'] as const)('awaited final publication retains %s before actual rename', async kind => {
  const f = fixture(), job = await f.create(), bytes = readFileSync(f.path), controller = new AbortController();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let valid = true;
  const withPublication: MutationPublication = async operation => { entered.resolve(); await release.promise; return await operation(() => {}); };
  const pending = f.manager.updateJob(job.id, { name: 'Held private stage' }, { signal: controller.signal, withPublication,
    assertCurrent: () => { if (!valid) throw new Error('Original source revoked'); } });
  await entered.promise;
  expect(readdirSync(f.directory).some(name => name.startsWith('jobs.json.tmp.'))).toBe(true);
  expect(readFileSync(f.path)).toEqual(bytes); expect(f.manager.getJob(job.id)).toEqual(job);
  if (kind === 'abort') controller.abort(); else valid = false;
  release.resolve(); await expect(pending).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(bytes); expect(f.manager.getJob(job.id)).toEqual(job);
});

test.each(['create', 'enable', 'delete'] as const)('cancelled actual %s stage leaves no phantom live job or deleted record', async action => {
  const f = fixture(), job = await f.create(), bytes = readFileSync(f.path), controller = new AbortController();
  const original = PersistentStore.prototype.persist;
  const persist = spyOn(PersistentStore.prototype, 'persist').mockImplementation(async function(this: PersistentStore<Record<string, unknown>>, data, controls = {}) {
    return await original.call(this, data, { ...controls, beforePublish: () => { controller.abort(); controls.beforePublish?.(); controls.assertCurrent?.(); } });
  });
  try {
    const pending = action === 'create' ? f.manager.createJob({ name: 'Phantom', prompt: 'Synthetic', schedule: { kind: 'every', intervalMs: 3_600_000 } }, { signal: controller.signal })
      : action === 'enable' ? f.manager.setEnabled(job.id, true, { signal: controller.signal })
      : f.manager.removeJob(job.id, { signal: controller.signal });
    await expect(pending).rejects.toThrow();
    expect(f.manager.listJobs()).toEqual([job]); expect(readFileSync(f.path)).toEqual(bytes); expect(f.manager.listRuns()).toEqual([]);
  } finally { persist.mockRestore(); }
});

test('own-job ABA is stale while unrelated job mutations remain independent', async () => {
  const f = fixture(), a = await f.create('A'), b = await f.create('B');
  const selected = f.manager.retainJobTarget(a.id, a.mutationRevision);
  await f.manager.updateJob(b.id, { name: 'B changed' }); selected.assertCurrent();
  await f.manager.updateJob(a.id, { name: 'Different' });
  await f.manager.updateJob(a.id, { name: 'A' });
  expect(() => selected.assertCurrent()).toThrow(AutomationJobMutationStaleError);
  await expect(f.manager.updateJob(a.id, { name: 'Stale', expectedMutationRevision: a.mutationRevision })).rejects.toBeInstanceOf(AutomationJobMutationStaleError);
  expect(f.manager.getJob(b.id)?.name).toBe('B changed');
});

test('another job remains current between actual owned rename and durability confirmation', async () => {
  const f = fixture(), a = await f.create('A'), b = await f.create('B');
  const selected = f.manager.retainJobTarget(a.id, a.mutationRevision);
  const original = PersistentStore.prototype.persist;
  let publications = 0;
  const persist = spyOn(PersistentStore.prototype, 'persist').mockImplementation(async function(this: PersistentStore<Record<string, unknown>>, data, options = {}) {
    return await original.call(this, data, { ...options, afterPublish: () => {
      options.afterPublish?.(); selected.assertCurrent(); publications++;
      const disk: unknown = JSON.parse(readFileSync(f.path, 'utf-8'));
      expect(disk).toMatchObject({ jobs: expect.arrayContaining([a, expect.objectContaining({ id: b.id, name: 'B published', mutationRevision: expect.any(String) })]) });
      expect(f.manager.getJob(b.id)).toEqual(b);
    } });
  });
  try {
    await f.manager.updateJob(b.id, { name: 'B published', expectedMutationRevision: b.mutationRevision });
    expect(publications).toBe(1); selected.assertCurrent();
    expect(f.manager.getJob(a.id)).toEqual(a); expect(f.manager.getJob(b.id)?.name).toBe('B published');
  } finally { persist.mockRestore(); }
});

test('queued old whole-map save preserves another job conditional commit', async () => {
  const f = fixture(), a = await f.create('A'), b = await f.create('B');
  const committed = f.store.commit(a.id, a.mutationRevision, { ...a, name: 'A native', mutationRevision: 'synthetic-input-revision' });
  const unrelated = f.store.save([a, { ...b, name: 'B internal' }]);
  await Promise.all([committed, unrelated]);
  const persisted = (await new AutomationJobStore(f.path).load()).jobs;
  expect(persisted.find(job => job.id === a.id)?.name).toBe('A native');
  expect(persisted.find(job => job.id === b.id)?.name).toBe('B internal');
  expect(persisted.find(job => job.id === a.id)?.mutationRevision).not.toBe('synthetic-input-revision');
});

test.each(['identical', 'unrelated', 'deletion'] as const)('real failed private publication retains %s retry deltas', async kind => {
  const f = fixture(), a = await f.create('A'), b = await f.create('B');
  const before = readFileSync(f.path);
  const next = kind === 'deletion' ? [b] : [{ ...a, name: 'After' }, b];
  const original = PersistentStore.prototype.persist;
  const failure = spyOn(PersistentStore.prototype, 'persist').mockImplementationOnce(async function(this: PersistentStore<Record<string, unknown>>, data, options = {}) {
    return await original.call(this, data, { ...options, beforePublish: () => {
      options.beforePublish?.();
      const stage = readdirSync(f.directory).find(name => name.startsWith('jobs.json.tmp.'));
      if (!stage) throw new Error('The actual private stage was absent.');
      rmSync(join(f.directory, stage));
    } });
  });
  try { await expect(f.store.save(next)).rejects.toThrow('Prepared publication is unavailable.'); } finally { failure.mockRestore(); }
  expect(readFileSync(f.path)).toEqual(before);
  await f.store.save(kind === 'unrelated' ? [{ ...a, name: 'After' }, { ...b, name: 'B changed' }] : next);
  const jobs = (await new AutomationJobStore(f.path).load()).jobs;
  if (kind === 'deletion') expect(jobs.find(job => job.id === a.id)).toBeUndefined();
  else expect(jobs.find(job => job.id === a.id)?.name).toBe('After');
  if (kind === 'unrelated') expect(jobs.find(job => job.id === b.id)?.name).toBe('B changed');
});

test('originally absent parent cannot be replaced by a link into another store owner', async () => {
  const f = fixture(), job = await f.create(), missing = join(f.directory, 'missing'), foreign = join(f.directory, 'foreign');
  const store = new AutomationJobStore(join(missing, 'jobs.json')); await store.load();
  mkdirSync(foreign); symlinkSync(foreign, missing);
  await expect(store.save([job])).rejects.toBeInstanceOf(AutomationJobMutationStaleError);
  expect(existsSync(join(foreign, 'jobs.json'))).toBe(false);
});

test('load refuses old bytes paired with a newer external physical identity', async () => {
  const f = fixture(), job = await f.create(), reader = new AutomationJobStore(f.path);
  const load = PersistentStore.prototype.load;
  const interleave = spyOn(PersistentStore.prototype, 'load').mockImplementationOnce(async function(this: PersistentStore<Record<string, unknown>>) {
    const snapshot = await load.call(this);
    writeFileSync(f.path, JSON.stringify({ version: 1, jobs: [{ ...job, name: 'External winner' }] }));
    return snapshot;
  });
  try { await expect(reader.load()).rejects.toBeInstanceOf(AutomationJobMutationStaleError); } finally { interleave.mockRestore(); }
  expect((await new AutomationJobStore(f.path).load()).jobs[0]?.name).toBe('External winner');
});

test('equal-byte physical replacement holds while preserving replacement bytes', async () => {
  const f = fixture(), job = await f.create(), bytes = readFileSync(f.path);
  writeFileSync(`${f.path}.replacement`, bytes); renameSync(`${f.path}.replacement`, f.path);
  await expect(f.manager.updateJob(job.id, { name: 'Never' })).rejects.toBeInstanceOf(AutomationJobMutationStaleError);
  expect(readFileSync(f.path)).toEqual(bytes); expect(f.manager.getJob(job.id)?.name).toBe('Original');
});

test('cancellation after actual rename reports indeterminate commit and reconciles actual bytes', async () => {
  const f = fixture(), job = await f.create(), controller = new AbortController();
  const original = PersistentStore.prototype.persist;
  const persist = spyOn(PersistentStore.prototype, 'persist').mockImplementation(async function(this: PersistentStore<Record<string, unknown>>, data, options = {}) {
    return await original.call(this, data, { ...options, afterPublish: () => { options.afterPublish?.(); controller.abort(); } });
  });
  try {
    await expect(f.manager.updateJob(job.id, { name: 'Published' }, { signal: controller.signal })).rejects.toBeInstanceOf(AutomationJobCommitIndeterminateError);
    const disk = managedAutomationJob((await new AutomationJobStore(f.path).load()).jobs[0]);
    expect(disk?.name).toBe('Published'); expect(f.manager.getJob(job.id)).toEqual(disk);
  } finally { persist.mockRestore(); }
});

test('manager revisions survive restart and returned records cannot be mutated in place', async () => {
  const f = fixture(), job = await f.create();
  const second = automationMutationFixture(f.directory); cleanup.push(() => second.close());
  await second.manager.start();
  expect(second.manager.getJob(job.id)?.mutationRevision).toBe(job.mutationRevision);
  const actual = f.manager.getJob(job.id);
  expect(Object.isFrozen(actual)).toBe(true); expect(Object.isFrozen(actual?.execution)).toBe(true);
  expect(() => Object.defineProperty(actual, 'name', { value: 'Changed' })).toThrow();
});
