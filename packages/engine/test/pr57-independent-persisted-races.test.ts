import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/sdk/platform/knowledge';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), 'pr57-independent-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
async function seeded() {
  const file = path();
  const store = new KnowledgeStore({ dbPath: file });
  const service = new ProjectPlanningService(store);
  await service.upsertState({ projectId: 'fixture', state: { goal: 'Original selected plan', executionApproved: false,
    openQuestions: [{ id: 'q1', prompt: 'Which tests?', status: 'open' }],
    tasks: [{ id: 'original', title: 'Original task' }],
  } });
  const selected = await service.getState({ projectId: 'fixture' });
  if (!selected.revision || !selected.state) throw new Error('missing seeded revision');
  return { file, store, service, selected };
}

test('a writer through another real handle invalidates a selected approval without overwriting its rows', async () => {
  const first = await seeded();
  const otherStore = new KnowledgeStore({ dbPath: first.file });
  const otherService = new ProjectPlanningService(otherStore);
  await otherService.upsertState({ projectId: 'fixture', state: { ...first.selected.state!, goal: 'Replacement from second handle',
    tasks: [{ id: 'replacement', title: 'Replacement task' }], executionApproved: false,
  } });
  const before = readFileSync(first.file);
  const result = await first.service.applyStateAction({ projectId: 'fixture', expected: { kind: 'revision', revision: first.selected.revision! }, action: { kind: 'approve' } });
  const reopened = new ProjectPlanningService(new KnowledgeStore({ dbPath: first.file }));
  const after = await reopened.getState({ projectId: 'fixture' });
  console.log(JSON.stringify({ scenario: 'two-handles-approval', applied: result.applied, persistedGoal: after.state?.goal, persistedApproval: after.state?.executionApproved, diskUnchanged: readFileSync(first.file).equals(before) }));
  expect(result).toMatchObject({ applied: false, reason: 'state-changed' });
  expect(readFileSync(first.file)).toEqual(before);
  expect(after.state?.goal).toBe('Replacement from second handle');
  expect(after.state?.executionApproved).toBe(false);
});

test('an absent-row condition observes a creation through another initialized real handle', async () => {
  const file = path();
  const first = new KnowledgeStore({ dbPath: file }); const second = new KnowledgeStore({ dbPath: file });
  await first.init(); await second.init();
  const input = { id: 'shared-row', connectorId: 'fixture', sourceType: 'dataset' as const, status: 'indexed' as const, metadata: { value: 'first' } };
  expect((await first.upsertSourceIfCurrent(input, null)).kind).toBe('written');
  const before = readFileSync(file);
  const result = await second.upsertSourceIfCurrent({ ...input, metadata: { value: 'second' } }, null);
  const reopened = new KnowledgeStore({ dbPath: file }); await reopened.init();
  console.log(JSON.stringify({ scenario: 'two-handles-absent', kind: result.kind, persisted: reopened.getSource('shared-row')?.metadata.value }));
  expect(result.kind).toBe('held');
  expect(readFileSync(file)).toEqual(before);
});

test('same-handle deletion and changed recreation invalidate the captured revision', async () => {
  const f = await seeded();
  expect(await f.store.deleteSource(f.selected.revision!.sourceId)).toBe(true);
  await f.service.upsertState({ projectId: 'fixture', state: { ...f.selected.state!, goal: 'Recreated replacement', executionApproved: false } });
  const before = readFileSync(f.file);
  expect(await f.service.applyStateAction({ projectId: 'fixture', expected: { kind: 'revision', revision: f.selected.revision! }, action: { kind: 'approve' } })).toMatchObject({ applied: false, reason: 'state-changed' });
  expect(readFileSync(f.file)).toEqual(before);
});
