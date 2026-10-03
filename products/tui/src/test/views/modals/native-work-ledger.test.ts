import { describe, test, expect } from 'bun:test';
import type { WorkLedgerReadClient, WorkLedgerReadSnapshot, WorkLedgerEvent } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { NativeWorkLedgerModel, type NativeWorkLedgerSelection } from '../../../runtime/native-work-ledger.ts';
import { createNativeWorkLedgerModalSurface } from '../../../views/modals/native-work-ledger-modal.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { handleConfigModalToken } from '../../../input/handler-modal-routes.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';
import { modalGeometry, MODAL_PAD_X } from '../../../renderer/surface-kit.ts';
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

for (const replacement of ['host', 'authentication'] as const) {
  test(`${replacement} replacement paints its awaited snapshot after real keyboard interaction without another keypress`, async () => {
    const old = fixture(); const fresh = fixture();
    let selected: NativeWorkLedgerSelection = old.selection;
    const projectId = replacement === 'host' ? 'replacement-project' : 'host-project';
    let resolve!: (value: WorkLedgerReadSnapshot) => void;
    const client: WorkLedgerReadClient = { ...fresh.client, projectId, readSnapshot: () => new Promise(r => { resolve = r; }) };
    const modal = new ConfigModal(); let paints = 0;
    modal.open(createNativeWorkLedgerModalSurface(() => selected), () => { paints++; }); await tick();
    const route = { configModal: modal, requestRender: () => { paints++; }, handleEscape: () => modal.close() };
    handleConfigModalToken(route, { type: 'key', logicalName: 'down' } as never);
    expect(render(modal)).toContain('Native title');
    selected = { available: true, identity: `replacement-${replacement}`, projectId, bind: () => ({ available: true, client }) };
    const loading = render(modal);
    expect(loading).not.toContain('Native title'); expect(loading).toContain('Loading native work ledger');
    // The user may navigate the new empty tabs while its snapshot is pending.
    handleConfigModalToken(route, { type: 'key', logicalName: 'right' } as never);
    expect(modal.getActiveTabId()).toBe('intent');
    const next = snapshot(projectId); const paintBefore = paints;
    resolve({ ...next, works: next.works.map(view => ({ ...view, work: { ...view.work, goal: 'Replacement intent now visible' } })) });
    await tick();
    expect(paints).toBeGreaterThan(paintBefore);
    const ready = render(modal); // No input between settlement and rendering.
    expect(ready).toContain('Replacement intent now visible');
    expect(ready).not.toContain('Loading native work ledger');
    expect(ready).not.toContain('Native title'); expect(modal.getActiveTabId()).toBe('intent');
    handleConfigModalToken(route, { type: 'key', logicalName: 'escape' } as never);
    expect(modal.active).toBe(false); expect(old.disposed()).toBe(1); expect(fresh.disposed()).toBe(1);
  });
}

test('ready native updates preserve the established view identity and real-keyboard scroll position', async () => {
  const f = fixture(); const base = snapshot();
  const lots: WorkLedgerReadSnapshot = { ...base, works: Array.from({ length: 30 }, (_, i) => ({ ...base.works[0]!, work: { ...base.works[0]!.work, id: `work-${i}` } })) };
  f.update(lots);
  const surface = createNativeWorkLedgerModalSurface(() => f.selection); const modal = new ConfigModal(); modal.open(surface); await tick(); render(modal);
  const route = { configModal: modal, requestRender: () => {}, handleEscape: () => modal.close() };
  for (let i = 0; i < 6; i++) handleConfigModalToken(route, { type: 'key', logicalName: 'down' } as never);
  const before = modal.getRenderModel(); const identity = surface.buildView().bindingIdentity;
  expect(before.scroll.offset).toBeGreaterThan(0);
  f.update({ ...lots, works: lots.works.map(view => ({ ...view, work: { ...view.work, title: 'Updated native title' } })) }); await tick();
  expect(surface.buildView().bindingIdentity).toBe(identity);
  const after = modal.getRenderModel(); expect(after.scroll.offset).toBe(before.scroll.offset);
  expect(modal.getSelectedRowId()).toBe(''); expect(render(modal)).toContain('Updated native title'); modal.close();
});

test('ready status and cursor update without input; new evidence layout is explicitly deferred without resetting scroll', async () => {
  const f = fixture(); const base = snapshot();
  const proof = (id: string) => ({ id, target: { workId: 'work-1', workRevision: 3, criteriaRevision: 2, attemptId: 'attempt-1', attemptRevision: 2 }, outcome: 'verified' as const, reason: id, references: [{ kind: 'test' as const, ref: `${id}-reference` }], source: 'host_check' as const, criteriaResults: [], actorId: 'verifier', at: 1 });
  const events: WorkLedgerEvent[] = [];
  f.client.history = async cursor => events.filter(event => event.sequence > cursor);
  const surface = createNativeWorkLedgerModalSurface(() => f.selection); const modal = new ConfigModal(); modal.open(surface); await tick();
  const route = { configModal: modal, requestRender: () => {}, handleEscape: () => modal.close() };
  const key = (logicalName: string) => handleConfigModalToken(route, { type: 'key', logicalName } as never);
  key('down'); render(modal); const identity = surface.buildView().bindingIdentity;
  const publish = (sequence: number) => {
    const evidence = proof(`proof-${sequence}`); const work = { ...base.works[0]!.work, reportedState: 'blocked' as const };
    events.push({ sequence, type: 'record_evidence', actorId: 'verifier', requestId: `request-${sequence}`, workId: work.id, attemptId: 'attempt-1', at: sequence, work, attempts: [], evidence, reason: null });
    f.update({ ...base, cursor: sequence, revision: sequence, works: [{ ...base.works[0]!, work, verification: { state: 'verified', reason: 'Current evidence', evidence } }] });
  };
  publish(1); await tick(); const workText = render(modal);
  expect(workText).toContain('reportedState blocked'); expect(workText).toContain('verificationState verified'); expect(workText).toContain('durable cursor 1');
  expect(surface.buildView().bindingIdentity).toBe(identity);
  key('right'); key('right'); key('right'); expect(render(modal)).toContain('proof-1-reference');
  const wrapWidth = modalGeometry(180, 45).w - 2 * MODAL_PAD_X;
  const offset = modal.getRenderModel(wrapWidth).scroll.offset;
  publish(2); await tick(); const deferred = render(modal);
  expect(deferred).toContain('durable cursor 2'); expect(deferred).toContain('Native rows changed');
  expect(deferred).not.toContain('Loading native'); expect(modal.getRenderModel(wrapWidth).scroll.offset).toBe(offset);
  key('down'); expect(render(modal)).toContain('proof-2-reference'); key('escape');
});

test('long native goals, reports and evidence tails remain reachable through real arrow input at 80x24, narrow width and resize', async () => {
  const f = fixture(); const base = snapshot();
  const text = (tail: string) => `${'long fact words '.repeat(180)} ${tail}`;
  const view = base.works[0]!;
  const evidence = { id: 'long-proof', target: { workId: 'work-1', workRevision: 3, criteriaRevision: 2, attemptId: 'attempt-1', attemptRevision: 2 }, outcome: 'verified' as const, reason: 'historical', references: [{ kind: 'artifact' as const, ref: text('EVIDENCE_TAIL') }], source: 'host_check' as const, criteriaResults: [], actorId: 'v', at: 1 };
  f.update({ ...base, works: [{ ...view, work: { ...view.work, goal: text('GOAL_TAIL') }, attempt: { ...view.attempt!, report: text('REPORT_TAIL') }, verification: { ...view.verification, evidence } }] });
  const modal = new ConfigModal(); modal.open(createNativeWorkLedgerModalSurface(() => f.selection)); await tick();
  const route = { configModal: modal, requestRender: () => {}, handleEscape: () => modal.close() };
  const key = (logicalName: string) => handleConfigModalToken(route, { type: 'key', logicalName } as never);
  const frame = (width: number) => frameFromLayer(renderConfigModal(modal, width, 24), width, 24).map(line => line.map(cell => cell.char).join('')).join('\n');
  const reach = (tail: string, width: number): void => {
    let found = false;
    for (let i = 0; i < 160; i++) { if (frame(width).includes(tail)) { found = true; break; } key('down'); }
    expect(found).toBe(true);
  };
  reach('REPORT_TAIL', 80); key('right'); reach('GOAL_TAIL', 80);
  key('right'); key('right'); reach('EVIDENCE_TAIL', 80);
  key('left'); key('left'); frame(48); reach('GOAL_TAIL', 48);
  // A resize after keyboard interaction must rewrap line rows, retaining reachability.
  frame(100); frame(48); reach('GOAL_TAIL', 48);
  key('right'); key('right'); reach('EVIDENCE_TAIL', 48);
  key('escape'); expect(modal.active).toBe(false); expect(f.disposed()).toBe(1);
}, 15_000);

test('valid work and work:states IDs retain distinct titles and states in the actual frozen modal renderer', async () => {
  const f = fixture(); const base = snapshot(); const original = base.works[0]!;
  const value: WorkLedgerReadSnapshot = { ...base, works: ['work', 'work:states'].map((id, index) => ({
    ...original, work: { ...original.work, id, title: index ? 'SECOND_WORK_TITLE' : 'FIRST_WORK_TITLE' },
    verification: { ...original.verification, reason: index ? 'SECOND_STATE_ONLY' : 'FIRST_STATE_ONLY' },
  })) };
  f.update(value); const surface = createNativeWorkLedgerModalSurface(() => f.selection);
  const modal = new ConfigModal(); modal.open(surface); await tick();
  const route = { configModal: modal, requestRender: () => {}, handleEscape: () => modal.close() };
  handleConfigModalToken(route, { type: 'key', logicalName: 'down' } as never);
  const before = render(modal);
  expect(before).toContain('FIRST_WORK_TITLE'); expect(before).toContain('SECOND_WORK_TITLE');
  expect(before.split('FIRST_STATE_ONLY')).toHaveLength(2); expect(before.split('SECOND_STATE_ONLY')).toHaveLength(2);
  const ids = surface.buildView().tabs[0]!.rows.map(row => row.id);
  f.update({ ...value, works: value.works.map(view => ({ ...view, work: { ...view.work, title: `${view.work.title}_UPDATED` } })) }); await tick();
  expect(surface.buildView().tabs[0]!.rows.map(row => row.id)).toEqual(ids);
  const after = render(modal); expect(after).toContain('SECOND_WORK_TITLE_UPDATED'); expect(after).toContain('FIRST_WORK_TITLE_UPDATED');
  handleConfigModalToken(route, { type: 'key', logicalName: 'escape' } as never); expect(f.disposed()).toBe(1);
});

test('native row namespaces isolate suffix-like work, criterion, attention and evidence identities', async () => {
  const f = fixture(); const base = snapshot(); const original = base.works[0]!;
  const ids = ['work', 'work:states', 'work:attempt', 'work:0', 'work:line:0', 'evidence', 'evidence:0', '["work","work","states"]'];
  f.update({ ...base, works: ids.map((id, index) => ({ ...original,
    work: { ...original.work, id, title: `TITLE_${index}`, goal: `GOAL_${index}`, criteria: [`CRITERION_${index}`] },
    attention: [{ kind: 'verification', reason: `ATTENTION_${index}` }],
    verification: { ...original.verification, evidence: { id, target: { workId: id, workRevision: 3, criteriaRevision: 2, attemptId: 'attempt-1', attemptRevision: 2 }, outcome: 'verified', reason: `PROOF_${index}`, references: [{ kind: 'artifact', ref: `REFERENCE_${index}` }], source: 'host_check', criteriaResults: [], actorId: 'v', at: 1 } },
  })) });
  const surface = createNativeWorkLedgerModalSurface(() => f.selection); const modal = new ConfigModal(); modal.open(surface); await tick();
  const view = surface.buildView(); const all = view.tabs.flatMap(tab => tab.rows.map(row => row.id));
  expect(new Set(all).size).toBe(all.length);
  const route = { configModal: modal, requestRender: () => {}, handleEscape: () => modal.close() };
  for (const prefixes of [['TITLE_'], ['GOAL_', 'CRITERION_'], ['ATTENTION_'], ['PROOF_', 'REFERENCE_']]) {
    let frames = '';
    for (let i = 0; i < 35; i++) { frames += render(modal); handleConfigModalToken(route, { type: 'key', logicalName: 'down' } as never); }
    for (const prefix of prefixes) for (let i = 0; i < ids.length; i++) expect(frames).toContain(`${prefix}${i}`);
    handleConfigModalToken(route, { type: 'key', logicalName: 'right' } as never);
  }
  handleConfigModalToken(route, { type: 'key', logicalName: 'escape' } as never); expect(f.disposed()).toBe(1);
});
