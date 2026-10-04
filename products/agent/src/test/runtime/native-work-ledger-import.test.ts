import { expect, test } from 'bun:test';
import fixture from '../fixtures/legacy-ledger/preparation.json';
import { prepareLegacyWorkLedgerMigration, projectLegacyImportWorks } from '../../runtime/legacy-work-ledger-migration.ts';
import { nativeWorkLedgerLines } from '../../renderer/native-work-ledger.ts';
import { NativeWorkLedgerModel } from '../../runtime/native-work-ledger.ts';
import type { WorkLedgerEvent, WorkLedgerReadEvent, WorkLedgerReadSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';

test('actual Agent history renders one atomic import without treating it as evidence or an ordinary create', async () => {
  const prepared = prepareLegacyWorkLedgerMigration(fixture); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const works = projectLegacyImportWorks(prepared.manifest, 123);
  const event: WorkLedgerEvent = { type: 'import_legacy', sequence: 1, actorId: 'host-owner', requestId: 'import-request', at: 123, manifest: prepared.manifest, works };
  const snapshot: WorkLedgerReadSnapshot = { projectId: fixture.projectId, revision: 1, cursor: 1, works: works.map(work => ({ work, attempt: null, verification: { state: 'unverified', reason: 'Imported historical claim', evidence: null }, attention: [] })) };
  const model = new NativeWorkLedgerModel(); let disposed = false;
  model.open({ available: true, client: { projectId: fixture.projectId, subscribe: () => () => {}, readSnapshot: async () => snapshot, history: async cursor => cursor ? [] : [event], dispose: () => { disposed = true; } } });
  for (let i = 0; i < 15; i++) await Promise.resolve();
  const text = nativeWorkLedgerLines(model.state).join('\n');
  expect(text).toContain('#1 import_legacy'); expect(text).toContain('3 work records');
  expect(text).toContain('decision-1'); expect(text).toContain('q-answered');
  expect(text).toContain('source-state /metadata/value/answeredQuestions/0');
  expect(text).toContain('artifact-external'); expect(text).toContain('historical approval is not execution authority');
  expect(text).toContain('Reported: complete · Verification: unverified'); expect(text).toContain('Evidence: none');
  expect(model.state.status === 'ready' && model.state.history).toHaveLength(1);
  model.close(); expect(disposed).toBe(true);
});


test('Agent clears imported snapshot when history authorization is revoked', async () => {
  const prepared = prepareLegacyWorkLedgerMigration(fixture); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const works = projectLegacyImportWorks(prepared.manifest, 123);
  const snapshot: WorkLedgerReadSnapshot = { projectId: fixture.projectId, revision: 1, cursor: 1, works: works.map(work => ({ work, attempt: null, verification: { state: 'unverified', reason: 'Historical claim', evidence: null }, attention: [] })) };
  const model = new NativeWorkLedgerModel(); let disposed = false;
  model.open({ available: true, client: { projectId: fixture.projectId, subscribe: () => () => {}, readSnapshot: async () => snapshot, history: async () => { throw new Error('Ledger history access revoked.'); }, dispose: () => { disposed = true; } } });
  for (let i = 0; i < 15; i++) await Promise.resolve();
  const text = nativeWorkLedgerLines(model.state).join('\n');
  expect(model.state.status).toBe('unavailable'); expect(text).toContain('access revoked');
  expect(text).not.toContain('Legacy done item'); expect(text).not.toContain('decision-1');
  expect(disposed).toBe(true); model.close();
});


test('limited Agent reader keeps native imports and cursor with explicit protected provenance', async () => {
  const prepared = prepareLegacyWorkLedgerMigration(fixture); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const works = projectLegacyImportWorks(prepared.manifest, 123);
  const event: WorkLedgerReadEvent = { type: 'import_legacy', sequence: 1, actorId: 'host-owner', requestId: 'import-request', at: 123, works, manifest: null, provenance: 'requires_read_knowledge' };
  const snapshot: WorkLedgerReadSnapshot = { projectId: fixture.projectId, revision: 1, cursor: 1, works: works.map(work => ({ work, attempt: null, verification: { state: 'unverified', reason: 'Historical claim', evidence: null }, attention: [] })) };
  const model = new NativeWorkLedgerModel();
  model.open({ available: true, client: { projectId: fixture.projectId, subscribe: () => () => {}, readSnapshot: async () => snapshot, history: async cursor => cursor ? [] : [event], dispose: () => {} } });
  for (let i = 0; i < 15; i++) await Promise.resolve();
  const text = nativeWorkLedgerLines(model.state).join('\n');
  expect(model.state.status).toBe('ready'); expect(text).toContain('history 1');
  expect(text).toContain('Legacy done item'); expect(text).toContain('Protected legacy provenance requires read:knowledge');
  expect(text).not.toContain('decision-1'); expect(text).not.toContain('artifact-external');
  expect(model.state.status === 'ready' && model.state.history).toHaveLength(1); model.close();
});

test('Agent purges same-cursor protected provenance immediately and rehydrates on a fresh grant', async () => {
  const prepared = prepareLegacyWorkLedgerMigration(fixture); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const works = projectLegacyImportWorks(prepared.manifest, 123);
  const event: WorkLedgerReadEvent = { type: 'import_legacy', sequence: 1, actorId: 'host', requestId: 'request', at: 123, manifest: prepared.manifest, works };
  let provenance: WorkLedgerReadSnapshot['provenance'] = 'available';
  const snapshot = (): WorkLedgerReadSnapshot => ({ projectId: fixture.projectId, revision: 1, cursor: 1, provenance,
    works: works.map(work => ({ work, attempt: null, verification: { state: 'unverified', reason: 'Historical', evidence: null }, attention: [] })) });
  let notify!: (snapshot: WorkLedgerReadSnapshot) => void;
  const model = new NativeWorkLedgerModel();
  model.open({ available: true, client: { projectId: fixture.projectId, readSnapshot: async () => snapshot(), history: async cursor => cursor ? [] : [event],
    subscribe: listener => { notify = listener; return () => {}; }, dispose() {} } });
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  await settle(); expect(nativeWorkLedgerLines(model.state).join('\n')).toContain('decision-1');
  provenance = 'requires_read_knowledge'; notify(snapshot());
  expect(nativeWorkLedgerLines(model.state).join('\n')).not.toContain('decision-1');
  expect(nativeWorkLedgerLines(model.state).join('\n')).toContain('Legacy done item');
  await settle(); expect(nativeWorkLedgerLines(model.state).join('\n')).toContain('Protected legacy provenance');
  provenance = 'available'; notify(snapshot()); await settle();
  expect(nativeWorkLedgerLines(model.state).join('\n')).toContain('decision-1');
  expect(model.state.status === 'ready' && model.state.cursor).toBe(1); model.close();
});

test('Agent fences late raw history when knowledge permission changes during initial catchup', async () => {
  const prepared = prepareLegacyWorkLedgerMigration(fixture); if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const works = projectLegacyImportWorks(prepared.manifest, 123);
  const event: WorkLedgerReadEvent = { type: 'import_legacy', sequence: 1, actorId: 'host', requestId: 'request', at: 123, manifest: prepared.manifest, works };
  const snapshot: WorkLedgerReadSnapshot = { projectId: fixture.projectId, revision: 1, cursor: 1, provenance: 'available', works: works.map(work => ({ work, attempt: null, verification: { state: 'unverified', reason: 'Historical', evidence: null }, attention: [] })) };
  let notify!: (snapshot: WorkLedgerReadSnapshot) => void; let finish!: (events: WorkLedgerReadEvent[]) => void; let calls = 0;
  const held = new Promise<WorkLedgerReadEvent[]>(resolve => { finish = resolve; }); const model = new NativeWorkLedgerModel();
  model.open({ available: true, client: { projectId: fixture.projectId, readSnapshot: async () => snapshot, history: async () => ++calls === 1 ? held : [event],
    subscribe: listener => { notify = listener; return () => {}; }, dispose() {} } });
  for (let index = 0; index < 10; index++) await Promise.resolve();
  notify({ ...snapshot, provenance: 'requires_read_knowledge' }); finish([event]);
  for (let index = 0; index < 30; index++) await Promise.resolve();
  const text = nativeWorkLedgerLines(model.state).join('\n'); expect(text).toContain('Legacy done item'); expect(text).toContain('Protected legacy provenance');
  expect(text).not.toContain('decision-1'); model.close();
});
