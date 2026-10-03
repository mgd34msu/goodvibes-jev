import { expect, test } from 'bun:test';
import fixture from '../fixtures/legacy-ledger/preparation.json';
import { prepareLegacyWorkLedgerMigration, replayLegacyWorkLedgerPreparation, type LegacyMigrationInput } from '../../runtime/legacy-work-ledger-migration.ts';

function input(): LegacyMigrationInput { return structuredClone(fixture); }
function prepared(value = input()) {
  const result = prepareLegacyWorkLedgerMigration(value);
  expect(result.kind).toBe('prepared');
  if (result.kind !== 'prepared') throw new Error(result.reason);
  return result.manifest;
}
function mutable() { return structuredClone(fixture); }
function state(value: ReturnType<typeof mutable>) {
  const result = value.sources.find(source => source.source.metadata.planningArtifactKind === 'state')?.source.metadata.value;
  if (!result || !('openQuestions' in result)) throw new Error('State fixture missing');
  return result as { goal: string; tasks: Array<{ id: string; title: string; status: string }> };
}
function work(value: ReturnType<typeof mutable>) {
  const result = value.sources.find(source => source.source.metadata.planningArtifactKind === 'work-plan')?.source.metadata.value;
  if (!result || !('tasks' in result) || !result.tasks) throw new Error('Work fixture missing');
  return result as { tasks: Array<{ title: string; status: string }> };
}

test('preserves complete source images, identities, decisions, questions and all link provenance', () => {
  const before = input(); const manifest = prepared(before);
  expect(manifest.sources.map(entry => entry.source).sort((a, b) => String(a.id).localeCompare(String(b.id))) as unknown)
    .toEqual(before.sources.map(entry => entry.source).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  expect(manifest.entities.filter(entity => entity.kind === 'work').map(entity => entity.id).sort()).toEqual(['planning-task-1', 'task-1', 'task-2']);
  expect(manifest.entities.filter(entity => entity.kind === 'question').map(entity => entity.id)).toEqual(['q-open', 'q-answered']);
  const decision = manifest.entities.find(entity => entity.kind === 'decision');
  expect(decision?.id).toBe('decision-1'); expect(decision?.fragments).toHaveLength(2);
  expect(manifest.links).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: 'task-1', relation: 'linkedArtifactIds', to: 'artifact-external', pointer: '/metadata/value/tasks/0/linkedArtifactIds/0' }),
    expect.objectContaining({ from: 'task-1', relation: 'linkedSourceIds', to: 'source-external' }),
    expect.objectContaining({ from: 'task-1', relation: 'linkedNodeIds', to: 'node-external' }),
    expect.objectContaining({ from: 'task-1', relation: 'decisionId', to: 'decision-1' }),
    expect.objectContaining({ from: 'task-2', relation: 'parentTaskId', to: 'task-1' }),
  ]));
  expect(before).toEqual(fixture);
});

test('legacy done, passed gates and executionApproved never create verification or authority', () => {
  const manifest = prepared();
  expect(manifest.entities.filter(entity => entity.kind === 'work').map(entity => [entity.id, entity.reportedState])).toEqual([
    ['planning-task-1', 'complete'], ['task-1', 'complete'], ['task-2', 'blocked'],
  ]);
  expect(manifest.entities.every(entity => entity.verification === 'unverified')).toBe(true);
  expect(manifest.executionAuthority).toBe('none'); expect(manifest.persistence).toBe('not-imported');
  expect(manifest.sources.find(entry => entry.source.id === 'source-state')?.source.metadata).toMatchObject({ value: { executionApproved: true, metadata: { executionApproved: true }, verificationGates: [{ status: 'passed' }] } });
  expect(manifest.entities.find(entity => entity.id === 'task-1')?.fragments[0]?.original.metadata).toMatchObject({ executionApproved: true, evidence: 'old claim' });
});

test('stable preparation replay tolerates source ordering and exact duplicate source captures', () => {
  const first = prepared(); const next = input();
  const repeated = { ...next, sources: [...next.sources].reverse().concat(next.sources[0]!) };
  expect(replayLegacyWorkLedgerPreparation(first, repeated)).toEqual({ kind: 'prepared', manifest: first });
  expect(first.digest).toHaveLength(64);
});

test('captures and freezes detached values without freezing or mutating originals', () => {
  const original = mutable(); const manifest = prepared(original);
  state(original).goal = 'Local edit after capture';
  expect(manifest.sources.find(entry => entry.source.id === 'source-state')?.source.metadata).toMatchObject({ value: { goal: 'Preserve synthetic history' } });
  expect(Object.isFrozen(original)).toBe(false); expect(Object.isFrozen(manifest.entities)).toBe(true);
  expect(Object.isFrozen(manifest.sources[0]?.source)).toBe(true);
});

for (const [field, value] of [['hostId', 'other-host'], ['projectId', 'other-project'], ['expectedLedgerRevision', 1]] as const) {
  test(`replay rejects changed ${field}`, () => {
    expect(replayLegacyWorkLedgerPreparation(prepared(), { ...input(), [field]: value }).kind).toBe('blocked');
  });
}
test('same-generation source edits and generation-only changes invalidate review', () => {
  const prior = prepared(); const changed = mutable(); state(changed).goal = 'Changed';
  expect(replayLegacyWorkLedgerPreparation(prior, changed)).toMatchObject({ kind: 'blocked', code: 'stale-preparation' });
  const revision = mutable(); revision.sources[0]!.generation = 'c'.repeat(64);
  expect(replayLegacyWorkLedgerPreparation(prior, revision)).toMatchObject({ kind: 'blocked', code: 'stale-preparation' });
  expect(replayLegacyWorkLedgerPreparation(prior, { ...input(), sources: input().sources.slice(1) })).toMatchObject({ kind: 'blocked', code: 'stale-preparation' });
});

test('dirty source capture and cancellation preserve all user/source data', () => {
  const dirty = { ...input(), pendingLocalChanges: true }; const before = structuredClone(dirty);
  expect(prepareLegacyWorkLedgerMigration(dirty)).toMatchObject({ kind: 'blocked', code: 'pending-local-changes' });
  const controller = new AbortController(); controller.abort();
  expect(prepareLegacyWorkLedgerMigration(input(), controller.signal)).toMatchObject({ kind: 'blocked', code: 'cancelled' });
  expect(replayLegacyWorkLedgerPreparation(prepared(), input(), controller.signal)).toMatchObject({ kind: 'blocked', code: 'cancelled' });
  expect(dirty).toEqual(before); expect(prepared().persistence).toBe('not-imported');
});

for (const status of ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled']) {
  test(`legitimate unfinished or terminal ${status} work is not a dirty source`, () => {
    const fresh = mutable(); work(fresh).tasks![0]!.status = status;
    expect(prepareLegacyWorkLedgerMigration(fresh).kind).toBe('prepared');
  });
}

test('different source images with the same source ID cannot silently win', () => {
  const fresh = mutable(); const collision = structuredClone(fresh.sources[0]!); collision.source.updatedAt++;
  expect(prepareLegacyWorkLedgerMigration({ ...fresh, sources: [...fresh.sources, collision] })).toMatchObject({ kind: 'blocked', code: 'identity-conflict' });
});

test('divergent decision and work identities require reconciliation', () => {
  const decisions = mutable(); const record = decisions.sources.find(source => source.source.metadata.planningArtifactKind === 'decision');
  if (!record || !('decision' in record.source.metadata.value)) throw new Error('Decision fixture missing');
  record.source.metadata.value.decision = 'Different decision';
  expect(prepareLegacyWorkLedgerMigration(decisions)).toMatchObject({ kind: 'blocked', code: 'identity-conflict' });
  const tasks = mutable(); const task = structuredClone(work(tasks).tasks![0]!); task.title = 'Conflicting title'; work(tasks).tasks!.push(task);
  expect(prepareLegacyWorkLedgerMigration(tasks)).toMatchObject({ kind: 'blocked', code: 'identity-conflict' });
});

test('occupied native IDs fail closed rather than reporting a successful replay', () => {
  expect(prepareLegacyWorkLedgerMigration({ ...input(), occupiedWorkIds: ['task-1'] })).toMatchObject({ kind: 'blocked', code: 'target-conflict' });
});

test('unknown fields, __proto__ data and external references survive losslessly', () => {
  const fresh = mutable(); const source = fresh.sources[0]!.source;
  Object.assign(source, JSON.parse('{"future":{"__proto__":{"value":"literal"}},"unknown":null}'));
  const manifest = prepared(fresh);
  expect(manifest.sources.find(entry => entry.source.id === source.id)?.source.future).toEqual(JSON.parse('{"__proto__":{"value":"literal"}}'));
});

for (const value of [undefined, NaN, Infinity, -0, 1n, new Date(0), () => 'drop']) {
  test(`rejects unsupported non-JSON data ${String(value)}`, () => {
    const fresh = mutable(); Object.assign(fresh.sources[0]!.source, { unsupported: value });
    expect(prepareLegacyWorkLedgerMigration(fresh)).toMatchObject({ kind: 'blocked', code: 'invalid-source' });
  });
}
test('getters are rejected without executing them', () => {
  const fresh = mutable(); let called = false;
  Object.defineProperty(fresh.sources[0]!.source, 'getter', { enumerable: true, get() { called = true; return 'bad'; } });
  expect(prepareLegacyWorkLedgerMigration(fresh).kind).toBe('blocked'); expect(called).toBe(false);
});

test('oversized, cyclic and malformed source bundles fail closed', () => {
  const huge = mutable(); state(huge).goal = 'x'.repeat(2_000_001);
  expect(prepareLegacyWorkLedgerMigration(huge)).toMatchObject({ kind: 'blocked', code: 'limit' });
  const cyclic = mutable(); Object.assign(cyclic.sources[0]!.source, { cycle: cyclic.sources });
  expect(prepareLegacyWorkLedgerMigration(cyclic)).toMatchObject({ kind: 'blocked', code: 'invalid-source' });
  const malformed = mutable(); work(malformed).tasks![0]!.status = 'verified';
  expect(prepareLegacyWorkLedgerMigration(malformed)).toMatchObject({ kind: 'blocked', code: 'invalid-source' });
  expect(prepareLegacyWorkLedgerMigration({ ...input(), sources: [] })).toMatchObject({ kind: 'blocked', code: 'limit' });
});

test('compatible source-qualified task fragments preserve both schemas; explicit status disagreement blocks', () => {
  const fresh = mutable(); state(fresh).tasks![0]!.id = 'task-1'; state(fresh).tasks![0]!.title = 'Legacy done item';
  const manifest = prepared(fresh); const task = manifest.entities.find(entity => entity.kind === 'work' && entity.id === 'task-1');
  expect(task?.fragments).toHaveLength(2); expect(task?.reportedState).toBe('complete');
  expect(task?.fragments.map(fragment => fragment.original)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'task-1', verification: ['Historical claim only'] }),
    expect.objectContaining({ taskId: 'task-1', notes: 'Keep notes' }),
  ]));
  state(fresh).tasks![0]!.status = 'blocked';
  expect(prepareLegacyWorkLedgerMigration(fresh)).toMatchObject({ kind: 'blocked', code: 'identity-conflict' });
});

test('manifest limit counts source and fragment copies, not only input size', () => {
  const fresh = mutable(); state(fresh).goal = 'x'.repeat(150_000);
  expect(prepareLegacyWorkLedgerMigration(fresh)).toMatchObject({ kind: 'blocked', code: 'limit' });
});
