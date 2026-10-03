import { describe, test, expect } from 'bun:test';
import type { WorkLedgerReadClient, WorkLedgerReadSnapshot, WorkLedgerEvent } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { NativeWorkLedgerModel, type NativeWorkLedgerSelection } from '../../../runtime/native-work-ledger.ts';
import { createNativeWorkLedgerModalSurface } from '../../../views/modals/native-work-ledger-modal.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';
import { frameFromLayer } from '../../helpers/surface-frame.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const snapshot = (projectId = 'host-project', cursor = 0): WorkLedgerReadSnapshot => ({ projectId, revision: cursor, cursor, works: [{
  work: { id: 'work-1', title: 'Native title', goal: 'Native intent', criteria: ['real criterion'], revision: 3, criteriaRevision: 2, reportedState: 'complete', currentAttemptId: 'attempt-1', createdAt: 1, updatedAt: 2 },
  attempt: { id: 'attempt-1', workId: 'work-1', predecessorId: null, ownerId: 'worker', revision: 2, state: 'complete', report: 'done', blocker: null, createdAt: 1, updatedAt: 2 },
  verification: { state: 'stale', reason: 'Criteria changed', evidence: null }, attention: [{ kind: 'verification', reason: 'Needs current evidence' }],
}] });
function fixture() {
  const calls: string[] = []; let value = snapshot(); let listener: (() => void) | undefined;
  let unavailable: ((error: Error) => void) | undefined; let disposed = 0;
  const client: WorkLedgerReadClient = { projectId: 'host-project', readSnapshot: async () => { calls.push('snapshot'); return value; }, history: async cursor => { calls.push(`history:${cursor}`); return []; }, subscribe: cb => { calls.push('subscribe'); listener = () => cb(value); return () => { calls.push('unsubscribe'); }; }, dispose: () => { disposed++; } };
  const selection: NativeWorkLedgerSelection = { available: true, identity: 'host-A', projectId: client.projectId, bind: cb => { unavailable = cb; return { available: true, client }; } };
  return { calls, client, selection, update: (v: WorkLedgerReadSnapshot) => { value = v; listener?.(); }, fail: (reason: string) => unavailable?.(new Error(reason)), disposed: () => disposed };
}
function render(modal: ConfigModal): string { return frameFromLayer(renderConfigModal(modal, 180, 45), 180, 45).map(line => line.map(cell => cell.char).join('')).join('\n'); }
describe('native work ledger read-only surface', () => {
  test('actual renderer shows separate reported and verification states, IDs and intent', async () => {
    const f = fixture(); const surface = createNativeWorkLedgerModalSurface(() => f.selection); const modal = new ConfigModal();
    modal.open(surface); await tick();
    expect(f.calls.slice(0, 3)).toEqual(['subscribe', 'snapshot', 'history:0']);
    const text = render(modal);
    expect(text).toContain('work-1'); expect(text).toContain('attempt-1'); expect(text).toContain('criteria revision 2');
    expect(text).toContain('reportedState complete'); expect(text).toContain('verificationState stale'); expect(text).not.toContain('verified success');
    expect(surface.actions).toEqual([]); expect(surface.buildView().tabs[1]?.rows.map(r => r.label).join(' ')).toContain('real criterion');
    modal.close(); expect(f.disposed()).toBe(1);
  });
  test('binding boundary purges frozen old-host text without keyboard interaction', async () => {
    const f = fixture(); let selected: NativeWorkLedgerSelection = f.selection; const modal = new ConfigModal();
    modal.open(createNativeWorkLedgerModalSurface(() => selected)); await tick(); modal.moveDown();
    expect(render(modal)).toContain('Native title');
    selected = { available: false, identity: 'other-workspace', reason: 'Disconnected new workspace' };
    const text = render(modal); expect(text).not.toContain('Native title'); expect(text).not.toContain('host-project'); expect(text).toContain('Disconnected');
    expect(f.disposed()).toBe(1);
  });
  test('revocation purges frozen rows, stale snapshot cannot restore them, reopen reads fresh', async () => {
    const f = fixture(); let resolve!: (v: WorkLedgerReadSnapshot) => void;
    f.client.readSnapshot = () => new Promise(r => { resolve = r; });
    const model = new NativeWorkLedgerModel(() => f.selection); model.open(() => {});
    f.fail('token revoked'); resolve(snapshot()); await tick();
    expect(model.snapshot).toBeNull(); expect(model.reason).toBe('token revoked'); expect(f.disposed()).toBe(1);
    f.client.readSnapshot = async () => snapshot(); model.open(() => {}); await tick(); expect(model.snapshot?.projectId).toBe('host-project'); model.close();
  });
  test('workspace replacement rejects old history response and throwing unsubscribe still disposes', async () => {
    const f = fixture(); let resolve!: (e: readonly WorkLedgerEvent[]) => void;
    f.client.history = () => new Promise(r => { resolve = r; });
    f.client.subscribe = () => () => { throw new Error('cleanup'); };
    let selection: NativeWorkLedgerSelection = f.selection; const model = new NativeWorkLedgerModel(() => selection); model.open(() => {}); await tick();
    selection = { available: false, identity: 'new', reason: 'No selected project' }; model.synchronize(); resolve([]); await tick();
    expect(model.snapshot).toBeNull(); expect(model.reason).toBe('No selected project'); expect(f.disposed()).toBe(1); model.close();
  });
  test('coalesced durable history catches up before publishing snapshot', async () => {
    const f = fixture(); let reads = 0; const work = snapshot().works[0]!.work;
    const event: WorkLedgerEvent = { sequence: 1, type: 'create', actorId: 'a', requestId: 'r', workId: work.id, attemptId: null, at: 1, work, attempts: [], evidence: null, reason: null };
    f.client.readSnapshot = async () => snapshot('host-project', reads++ ? 1 : 0);
    f.client.history = async cursor => { f.calls.push(`history:${cursor}`); return cursor ? [] : [event]; };
    const model = new NativeWorkLedgerModel(() => f.selection); model.open(() => {}); await tick();
    expect(model.snapshot?.cursor).toBe(1); expect(model.history.map(e => e.sequence)).toEqual([1]); expect(f.calls).toContain('history:1'); model.close();
  });
  test('close cleanup reentry cannot resurrect a client or snapshot', async () => {
    const f = fixture(); const model = new NativeWorkLedgerModel(() => f.selection);
    f.client.subscribe = () => () => { model.close(); throw new Error('cleanup'); };
    model.open(() => {}); await tick(); model.close(); expect(f.disposed()).toBe(1); expect(model.snapshot).toBeNull(); expect(model.reason).toContain('closed');
  });
});

test('all four actual tabs render native intent, attention and evidence with safe text', async () => {
  const f = fixture(); const base = snapshot(); const view = base.works[0]!;
  const proof = { id: 'proof-1', target: { workId: 'work-1', workRevision: 1, criteriaRevision: 1, attemptId: 'old-attempt', attemptRevision: 1 }, outcome: 'verified' as const, reason: 'old criteria only', references: [{ kind: 'commit' as const, ref: 'commit:abc' }], source: 'host_check' as const, criteriaResults: [], actorId: 'verifier', at: 1 };
  f.client.readSnapshot = async () => ({ ...base, works: [{ ...view, verification: { ...view.verification, evidence: proof }, work: { ...view.work, goal: 'Native intent\u001b[31m' } }] });
  const surface = createNativeWorkLedgerModalSurface(() => f.selection); const modal = new ConfigModal(); modal.open(surface); await tick();
  const labels = surface.buildView().tabs.flatMap(tab => tab.rows.map(row => row.label)).join('\n');
  expect(labels).not.toContain('\u001b'); expect(labels).toContain('commit:abc'); expect(labels).toContain('historical outcome verified'); expect(labels).toContain('verificationState stale');
  modal.nextTab(); expect(render(modal)).toContain('Native intent');
  modal.nextTab(); expect(render(modal)).toContain('Needs current evidence');
  modal.nextTab(); const evidence = render(modal); expect(evidence).toContain('proof-1'); expect(evidence).toContain('old-attempt'); expect(evidence).toContain('commit:abc'); modal.close();
});

test('reentrant open during throwing cleanup keeps the newer lifecycle and callback', async () => {
  const old = fixture(); const fresh = fixture(); let selected: NativeWorkLedgerSelection = old.selection;
  const model = new NativeWorkLedgerModel(() => selected); let repaints = 0;
  old.client.subscribe = () => () => { selected = { ...fresh.selection, identity: 'new-host' }; model.open(() => { repaints++; }); throw new Error('old cleanup'); };
  model.open(() => {}); await tick(); model.close(); await tick();
  expect(model.snapshot?.projectId).toBe('host-project'); expect(repaints).toBeGreaterThan(0); expect(old.disposed()).toBe(1); model.close();
});
