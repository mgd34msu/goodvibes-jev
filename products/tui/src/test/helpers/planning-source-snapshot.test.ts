import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { readPlanningSourceSnapshots } from './planning-source-snapshot.ts';

const projectId = 'planning-snapshot-fixture';
async function fixture(run: (store: KnowledgeStore, path: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'planning-source-snapshot-'));
  const path = join(root, 'knowledge-wiki.sqlite'); const store = new KnowledgeStore({ dbPath: path });
  try {
    await new ProjectPlanningService(store).upsertState({ projectId, state: {
      goal: 'Retain original planning bytes', executionApproved: true,
      openQuestions: [{ id: 'saved', prompt: 'Which saved helper?', status: 'open' }],
      tasks: [{ id: 'task', title: 'Saved completed task', status: 'completed' }],
      metadata: { approvedFrom: 'saved-owner', approvedAt: 123, opaque: { original: 'exactly' } },
    } });
    await run(store, path);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}

test('planning snapshots exclude legitimate bootstrap schedule writes but preserve every saved raw source generation', async () => fixture(async (store, path) => {
  const before = await readPlanningSourceSnapshots(path, projectId); const bytes = readFileSync(path);
  expect(before).toHaveLength(2); expect(before.every(snapshot => snapshot.generation?.length === 64)).toBe(true);
  for (const jobId of ['knowledge-light-consolidation', 'knowledge-deep-consolidation', 'knowledge-semantic-self-improvement']) {
    await store.upsertSchedule({ jobId, label: jobId, enabled: true, schedule: { kind: 'every', intervalMs: 86_400_000 }, nextRunAt: Date.now() + 86_400_000, metadata: { bootstrap: true } });
  }
  expect(readFileSync(path)).not.toEqual(bytes);
  expect(store.listSchedules()).toHaveLength(3);
  expect(await readPlanningSourceSnapshots(path, projectId)).toEqual(before);
}));

test('planning snapshots catch raw JSON changes even when parsed source content and timestamps are equal', async () => fixture(async (store, path) => {
  const before = await readPlanningSourceSnapshots(path, projectId);
  const original = before.find(snapshot => snapshot.source?.metadata.planningArtifactKind === 'state')!.source!;
  await store.replaceSourceRecord({ ...original, metadata: Object.fromEntries(Object.entries(original.metadata).reverse()) });
  const after = await readPlanningSourceSnapshots(path, projectId);
  expect(after.map(snapshot => snapshot.source)).toEqual(before.map(snapshot => snapshot.source));
  expect(after).not.toEqual(before);
  expect(after.find(snapshot => snapshot.source?.id === original.id)?.generation).not.toBe(before.find(snapshot => snapshot.source?.id === original.id)?.generation);
}));

for (const change of ['approval', 'add', 'delete', 'move'] as const) {
  test(`planning snapshots detect ${change} without accepting a different saved record set`, async () => fixture(async (store, path) => {
    const before = await readPlanningSourceSnapshots(path, projectId);
    const original = before.find(snapshot => snapshot.source?.metadata.planningArtifactKind === 'state')!.source!;
    if (change === 'approval') await store.replaceSourceRecord({ ...original, metadata: { ...original.metadata, value: { ...(original.metadata.value as Record<string, unknown>), executionApproved: false } } });
    if (change === 'add') await store.replaceSourceRecord({ ...original, id: 'unexpected-planning-record', canonicalUri: `${original.canonicalUri}-unexpected` });
    if (change === 'delete') await store.deleteSource(original.id);
    if (change === 'move') await store.replaceSourceRecord({ ...original, metadata: { ...original.metadata, projectId: 'other', knowledgeSpaceId: 'project:other' } });
    expect(await readPlanningSourceSnapshots(path, projectId)).not.toEqual(before);
  }));
}
