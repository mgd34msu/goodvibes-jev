import { expect, test } from 'bun:test';
import { prepareLegacyWorkLedgerMigration, projectLegacyImportWorks, type WorkLedgerEvent, type WorkLedgerReadEvent, type WorkLedgerReadSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { createNativeWorkLedgerModalSurface } from '../../../views/modals/native-work-ledger-modal.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { handleConfigModalToken } from '../../../input/handler-modal-routes.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';
import { frameFromLayer } from '../../helpers/surface-frame.ts';

test('actual TUI import history preserves source details without masquerading as verification', async () => {
  const projectId = 'fixture-project'; const knowledgeSpaceId = 'project:fixture-project';
  const prepared = prepareLegacyWorkLedgerMigration({ hostId: 'fixture-host', projectId, expectedLedgerRevision: 0, pendingLocalChanges: false, occupiedWorkIds: [], sources: [{ generation: 'a'.repeat(64), source: {
    id: 'legacy-source', connectorId: 'goodvibes-project-planning', sourceType: 'dataset', status: 'indexed', tags: [], createdAt: 1, updatedAt: 2,
    metadata: { projectPlanning: true, projectId, knowledgeSpaceId, planningArtifactKind: 'work-plan', planningArtifactId: 'plan', value: {
      id: 'plan', projectId, knowledgeSpaceId, createdAt: 1, updatedAt: 2,
      tasks: [{ taskId: 'legacy-task', projectId, knowledgeSpaceId, title: 'Imported done item', status: 'done', notes: 'Historical detail', linkedArtifactIds: ['outside-artifact'], metadata: { executionApproved: true } }],
    } },
  } }] });
  if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const works = projectLegacyImportWorks(prepared.manifest, 123);
  const event: WorkLedgerEvent = { type: 'import_legacy', sequence: 1, actorId: 'trusted-host', requestId: 'fixture-import', at: 123, manifest: prepared.manifest, works };
  const snapshot: WorkLedgerReadSnapshot = { projectId, revision: 1, cursor: 1, works: works.map(work => ({ work, attempt: null, verification: { state: 'unverified', reason: 'Historical claim only', evidence: null }, attention: [] })) };
  let provenance: WorkLedgerReadSnapshot['provenance'] = 'available';
  let notify!: (snapshot: WorkLedgerReadSnapshot) => void;
  let disposed = 0; let unsubscribed = 0; let revoke!: (error: Error) => void;
  const surface = createNativeWorkLedgerModalSurface(() => ({ available: true, identity: 'fixture-binding', projectId, bind: onUnavailable => { revoke = onUnavailable; return { available: true, client: {
    projectId, readSnapshot: async () => ({ ...snapshot, provenance }), history: async cursor => cursor ? [] : [event], subscribe: listener => { notify = listener; return () => { unsubscribed++; }; }, dispose: () => { disposed++; },
  } }; } }));
  const modal = new ConfigModal(); modal.open(surface); await new Promise(resolve => setTimeout(resolve, 5));
  const route = { configModal: modal, requestRender: () => {}, handleEscape: () => modal.close() };
  const key = (logicalName: string) => handleConfigModalToken(route, { type: 'key', logicalName } as never);
  const render = () => frameFromLayer(renderConfigModal(modal, 180, 45), 180, 45).map(line => line.map(cell => cell.char).join('')).join('\n');
  expect(render()).toContain('reportedState complete'); expect(render()).toContain('verificationState unverified');
  key('right'); key('right'); key('right'); expect(modal.getActiveTabId()).toBe('evidence');
  expect(surface.buildView().tabs.find(tab => tab.id === 'evidence')?.rows).toEqual([]);
  key('right'); expect(modal.getActiveTabId()).toBe('imports');
  const imported = render(); expect(imported).toContain('Import #1'); expect(imported).toContain('not execution authority');
  const rows = surface.buildView().tabs.find(tab => tab.id === 'imports')?.rows ?? [];
  expect(rows.map(row => row.label).join('\n')).toContain('Historical detail');
  expect(rows.map(row => row.label).join('\n')).toContain('outside-artifact');
  expect(rows.every(row => row.selectable === false)).toBe(true); expect(surface.actions).toEqual([]);
  // Import/source text remains reachable with actual scrolling at a narrow width.
  let reached = false;
  for (let i = 0; i < 100; i++) {
    const frame = frameFromLayer(renderConfigModal(modal, 48, 24), 48, 24).map(line => line.map(cell => cell.char).join('')).join('\n');
    if (frame.includes('outside-artifact')) { reached = true; break; }
    key('down');
  }
  expect(reached).toBe(true);
  // Same token and cursor, knowledge-only downgrade: ordinary native facts stay.
  provenance = 'requires_read_knowledge'; notify({ ...snapshot, provenance });
  expect(render()).toContain('Protected legacy provenance');
  expect(surface.buildView().tabs.find(tab => tab.id === 'imports')?.rows.map(row => row.label).join('\n')).not.toContain('Historical detail');
  expect(render()).toContain('durable cursor 1');
  provenance = 'available'; notify({ ...snapshot, provenance }); await new Promise(resolve => setTimeout(resolve, 5));
  expect(surface.buildView().tabs.find(tab => tab.id === 'imports')?.rows.map(row => row.label).join('\n')).toContain('Historical detail');
  // Revoked source-read authority must purge even frozen, scrolled historical data.
  revoke(new Error('Ledger history access revoked.'));
  const unavailable = render(); expect(unavailable).toContain('access revoked');
  expect(unavailable).not.toContain('Historical detail'); expect(unavailable).not.toContain('Imported done item');
  expect(surface.buildView().tabs.find(tab => tab.id === 'imports')?.rows).toEqual([]);
  key('escape'); expect(modal.active).toBe(false); expect(disposed).toBe(1); expect(unsubscribed).toBe(1);
});


test('limited TUI reader preserves native history while naming protected legacy provenance', async () => {
  const work = { source: null, id: 'limited-work', title: 'Native imported work', goal: 'Read native facts', criteria: ['Review'], revision: 1, criteriaRevision: 1, reportedState: 'complete' as const, currentAttemptId: null, createdAt: 1, updatedAt: 1 };
  const event: WorkLedgerReadEvent = { type: 'import_legacy', sequence: 1, actorId: 'host-owner', requestId: 'limited-import', at: 1, works: [work], manifest: null, provenance: 'requires_read_knowledge' };
  const snapshot: WorkLedgerReadSnapshot = { projectId: 'limited-project', revision: 1, cursor: 1, works: [{ work, attempt: null, verification: { state: 'unverified', reason: 'Historical claim', evidence: null }, attention: [] }] };
  const surface = createNativeWorkLedgerModalSurface(() => ({ available: true, identity: 'limited-host', projectId: snapshot.projectId, bind: () => ({ available: true, client: {
    projectId: snapshot.projectId, readSnapshot: async () => snapshot, history: async cursor => cursor ? [] : [event], subscribe: () => () => {}, dispose: () => {},
  } }) }));
  const modal = new ConfigModal(); modal.open(surface); await new Promise(resolve => setTimeout(resolve, 5));
  const route = { configModal: modal, requestRender: () => {}, handleEscape: () => modal.close() };
  for (let i = 0; i < 4; i++) handleConfigModalToken(route, { type: 'key', logicalName: 'right' } as never);
  expect(modal.getActiveTabId()).toBe('imports');
  const rendered = frameFromLayer(renderConfigModal(modal, 180, 45), 180, 45).map(line => line.map(cell => cell.char).join('')).join('\n');
  expect(rendered).toContain('durable cursor 1'); expect(rendered).toContain('Native imported work');
  expect(rendered).toContain('Protected legacy provenance requires read:knowledge');
  expect(surface.buildView().degraded).toBeUndefined();
  expect(surface.buildView().tabs.find(tab => tab.id === 'evidence')?.rows).toEqual([]);
  modal.close();
});
