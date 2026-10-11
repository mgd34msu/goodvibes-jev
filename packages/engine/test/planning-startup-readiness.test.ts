import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/sdk/platform/knowledge';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'planning-startup-')); roots.push(root);
  const path = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath: path }); stores.push(store);
  return { path, store };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('planning waits for its startup owner before observing and writing the first plan', async () => {
  const { path, store } = fixture();
  const entered = deferred(); const release = deferred();
  const planning = new ProjectPlanningService(store, { waitForStartup: async () => {
    entered.resolve(); await release.promise;
  } });
  const pending = planning.createWorkPlanTask({ task: { title: 'First startup task', source: 'agent' } });
  await entered.promise;
  expect(store.listSources()).toHaveLength(0);
  expect(existsSync(path)).toBe(false);
  await store.upsertJobRun({ id: 'startup-owned-write', jobId: 'fixture', mode: 'inline', status: 'completed' });
  release.resolve();
  expect((await pending).task?.title).toBe('First startup task');
  const reopened = new KnowledgeStore({ dbPath: path }); stores.push(reopened); await reopened.init();
  expect(reopened.getJobRun('startup-owned-write')?.status).toBe('completed');
  expect(reopened.listSources()).toHaveLength(1);
});

test('failed startup remains observable and never publishes planning sources', async () => {
  const { path, store } = fixture(); const failure = new Error('startup writes failed');
  const planning = new ProjectPlanningService(store, { waitForStartup: async () => { throw failure; } });
  await expect(planning.createWorkPlanTask({ task: { title: 'Must not publish', source: 'agent' } })).rejects.toBe(failure);
  expect(store.listSources()).toHaveLength(0);
  expect(existsSync(path)).toBe(false);
});

test('completed startup does not authorize overwriting a later pending batch', async () => {
  const { path, store } = fixture();
  const planning = new ProjectPlanningService(store, { waitForStartup: async () => {} });
  await planning.createWorkPlanTask({ task: { title: 'Already durable', source: 'agent' } });
  const before = readFileSync(path);
  await store.batch(async () => {
    await store.upsertJobRun({ id: 'later-pending-write', jobId: 'fixture', mode: 'inline', status: 'completed' });
    await expect(planning.createWorkPlanTask({ task: { title: 'Must remain held', source: 'agent' } })).rejects.toMatchObject({ reason: 'pending-local-changes' });
    expect(readFileSync(path)).toEqual(before);
  });
  const reopened = new KnowledgeStore({ dbPath: path }); stores.push(reopened); await reopened.init();
  expect(reopened.getJobRun('later-pending-write')?.status).toBe('completed');
  const tasks = reopened.listSources()[0]?.metadata.value as { tasks: { title: string }[] };
  expect(tasks.tasks.map(task => task.title)).toEqual(['Already durable']);
});
