import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { prepareLegacyWorkLedgerMigration, replayLegacyWorkLedgerPreparation, type LegacyMigrationInput } from '../../runtime/legacy-work-ledger-migration.ts';

test('actual legacy service records replay without changing SQLite or conflating source projections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-ledger-product-')); const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath });
  const service = new ProjectPlanningService(store, { defaultProjectId: 'fixture-project' });
  try {
    await service.upsertState({ projectId: 'fixture-project', state: {
      id: 'fixture-plan', goal: 'Synthetic migration proof', scope: 'No production data', executionApproved: true,
      tasks: [{ id: 'shared-task', title: 'Preserve both representations', status: 'in-progress', verification: ['Inspect synthetic output'], metadata: { extraStateField: 'keep' } }],
      openQuestions: [{ id: 'open-question', prompt: 'Which artifact?', status: 'open' }],
      answeredQuestions: [{ id: 'answered-question', prompt: 'Preserve?', answer: 'Yes', status: 'answered' }],
      decisions: [{ id: 'shared-decision', title: 'Keep originals', decision: 'No deletion', metadata: { embeddedOnly: true } }],
    } });
    await service.recordDecision({ projectId: 'fixture-project', decision: { id: 'shared-decision', title: 'Keep originals', decision: 'No deletion', metadata: { standaloneOnly: true } } });
    await service.upsertLanguage({ projectId: 'fixture-project', language: { terms: [{ term: 'reported', definition: 'A claim, not verification' }], ambiguities: [] } });
    await service.createWorkPlanTask({ projectId: 'fixture-project', task: {
      taskId: 'shared-task', title: 'Preserve both representations', status: 'in_progress', notes: 'Extra work-plan detail',
      linkedArtifactIds: ['outside-artifact'], linkedSourceIds: ['outside-source'], linkedNodeIds: ['outside-node'], metadata: { extraWorkField: 'keep' },
    } });
    const capture = (): LegacyMigrationInput => ({ hostId: 'synthetic-host', projectId: 'fixture-project', expectedLedgerRevision: 0,
      pendingLocalChanges: false, occupiedWorkIds: [], sources: store.listSources(100).map(source => {
        const snapshot = store.getSourceSnapshot({ id: source.id });
        if (!snapshot.source || !snapshot.generation) throw new Error('Complete persisted source missing');
        return { source: snapshot.source, generation: snapshot.generation };
      }) });
    const before = readFileSync(dbPath); const first = prepareLegacyWorkLedgerMigration(capture());
    expect(first.kind).toBe('prepared'); if (first.kind !== 'prepared') throw new Error(first.reason);
    const shared = first.manifest.entities.find(entity => entity.kind === 'work' && entity.id === 'shared-task');
    expect(shared?.fragments).toHaveLength(2);
    expect(shared?.fragments.map(fragment => fragment.original.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ extraStateField: 'keep' }), expect.objectContaining({ extraWorkField: 'keep' }),
    ]));
    expect(shared?.reportedState).toBe('in_progress');
    const decision = first.manifest.entities.find(entity => entity.kind === 'decision' && entity.id === 'shared-decision');
    expect(decision?.fragments).toHaveLength(2);
    expect(decision?.fragments.map(fragment => fragment.original.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ embeddedOnly: true }), expect.objectContaining({ standaloneOnly: true }),
    ]));
    expect(first.manifest.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'planningTaskId', to: 'shared-task' }),
      expect.objectContaining({ relation: 'linkedArtifactIds', to: 'outside-artifact' }),
    ]));
    expect(first.manifest.entities.filter(entity => entity.kind === 'artifact')).toHaveLength(4);
    expect(replayLegacyWorkLedgerPreparation(first.manifest, capture())).toEqual(first);
    expect(readFileSync(dbPath)).toEqual(before);
    // Actual source rewrite changes the complete-source generation. No old review survives.
    await service.updateWorkPlanTask({ projectId: 'fixture-project', taskId: 'shared-task', patch: { notes: 'Changed after preview' } });
    expect(replayLegacyWorkLedgerPreparation(first.manifest, capture())).toMatchObject({ kind: 'blocked', code: 'stale-preparation' });
    expect((await service.getState({ projectId: 'fixture-project', planningId: 'fixture-plan' })).state?.executionApproved).toBe(true);
    expect((await service.getWorkPlanSnapshot({ projectId: 'fixture-project' })).tasks.some(task => task.taskId === 'shared-task')).toBe(true);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});
