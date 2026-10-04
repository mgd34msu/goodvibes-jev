import { expect, test } from 'bun:test';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import type { WorkLedgerReadEvent, WorkLedgerReadSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import fixture from '../fixtures/legacy-ledger/preparation.json';
import { prepareLegacyWorkLedgerMigration, projectLegacyImportWorks } from '../../runtime/legacy-work-ledger-migration.ts';
import { NativeWorkLedgerModel } from '../../runtime/native-work-ledger.ts';
import { nativeWorkLedgerLines } from '../../renderer/native-work-ledger.ts';

const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Native ledger projection did not settle');
    await Bun.sleep(5);
  }
}

test('Agent keeps a polled restriction over the initial snapshot continuation and rehydrates on a later same-cursor grant', async () => {
  const prepared = prepareLegacyWorkLedgerMigration(fixture);
  if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const works = projectLegacyImportWorks(prepared.manifest, 123);
  const event: WorkLedgerReadEvent = { type: 'import_legacy', sequence: 1, actorId: 'host', requestId: 'import-request', at: 123, works, manifest: prepared.manifest };
  const snapshot = (provenance: WorkLedgerReadSnapshot['provenance']): WorkLedgerReadSnapshot => ({
    projectId: fixture.projectId, revision: 1, cursor: 1, provenance,
    works: works.map(work => ({ work, attempt: null, verification: { state: 'unverified', reason: 'Historical', evidence: null }, attention: [] })),
  });
  let provenance: WorkLedgerReadSnapshot['provenance'] = 'available';
  let snapshotCalls = 0;
  const held: Array<(value: WorkLedgerReadSnapshot) => void> = [];
  const historyCursors: number[] = [];
  const methods: string[] = [];
  const remote: Pick<OperatorRemoteClient, 'invoke'> = {
    async invoke<T>(method: string, input?: Record<string, unknown>) {
      methods.push(method);
      if (method === 'workLedger.snapshot') {
        // Hold the explicit initial read and the second normal poll. The first
        // poll and its history are allowed to render the authorized import.
        if ([1, 3].includes(++snapshotCalls)) return await new Promise<WorkLedgerReadSnapshot>(resolve => held.push(resolve)) as T;
        return snapshot(provenance) as T;
      }
      const afterSequence = Number(input?.afterSequence);
      historyCursors.push(afterSequence);
      return { projectId: fixture.projectId, afterSequence, cursor: 1, throughSequence: 1, hasMore: false, provenance,
        events: afterSequence ? [] : provenance === 'available' ? [event] : [{ ...event, manifest: null, provenance: 'requires_read_knowledge' }],
      } as T;
    },
  };
  const reader = createOperatorWorkLedgerReadClient(remote, fixture.projectId, { pollIntervalMs: 100 });
  const published: Array<{ provenance: WorkLedgerReadSnapshot['provenance']; raw: boolean }> = [];
  const model = new NativeWorkLedgerModel(() => {
    if (model.state.status === 'ready') published.push({ provenance: model.state.snapshot.provenance,
      raw: model.state.history.some(item => item.type === 'import_legacy' && item.manifest !== null) });
  });
  try {
    model.open({ available: true, client: reader });
    await waitFor(() => held.length === 2);
    expect(nativeWorkLedgerLines(model.state).join('\n')).toContain('decision-1');
    const prior = published.length;
    provenance = 'requires_read_knowledge';
    held[0]!(snapshot('available'));
    held[1]!(snapshot('requires_read_knowledge'));
    await settle();
    // The notification purges cached raw history synchronously. No subsequent
    // initial-read continuation may reclaim ownership of that projection.
    expect(published.slice(prior).length).toBeGreaterThan(0);
    expect(published.slice(prior).every(state => state.provenance === 'requires_read_knowledge' && !state.raw)).toBe(true);
    expect(model.state.status === 'ready' && model.state.snapshot.provenance).toBe('requires_read_knowledge');
    expect(nativeWorkLedgerLines(model.state).join('\n')).toContain('Protected legacy provenance');
    expect(nativeWorkLedgerLines(model.state).join('\n')).not.toContain('decision-1');

    provenance = 'available';
    await waitFor(() => nativeWorkLedgerLines(model.state).join('\n').includes('decision-1'));
    expect(model.state.status === 'ready' && model.state.snapshot.provenance).toBe('available');
    expect(model.state.status === 'ready' && model.state.cursor).toBe(1);
    expect(model.state.status === 'ready' && model.state.history).toHaveLength(1);
    expect(historyCursors.filter(cursor => cursor === 0)).toHaveLength(2);
    expect(methods.every(method => method === 'workLedger.snapshot' || method === 'workLedger.history')).toBe(true);
  } finally { model.close(); }
});
