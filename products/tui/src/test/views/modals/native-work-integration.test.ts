import { expect, test } from 'bun:test';
import { createOperatorNativeWorkExecutionClient, type NativeWorkExecutionIdentity, type NativeWorkExecutionSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import type { WorkLedgerReadClient, WorkLedgerReadSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { nativeWorkIntegrationView } from '../../../runtime/native-work-integration.ts';
import type { NativeWorkLedgerSelection } from '../../../runtime/native-work-ledger.ts';
import { createNativeWorkLedgerModalSurface } from '../../../views/modals/native-work-ledger-modal.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { handleConfigModalToken } from '../../../input/handler-modal-routes.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';
import { frameFromLayer } from '../../helpers/surface-frame.ts';

type Execution = Extract<NativeWorkExecutionSnapshot, { kind: 'execution' }>;
type Inspection = NonNullable<Execution['integration']>;
type Unit = Extract<Inspection, { state: 'live' }>['units'][number];
const identity: NativeWorkExecutionIdentity = { workId: 'work-1', attemptId: 'attempt-1', expectedRevision: { work: 3, criteria: 2, attempt: 4 } };
const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const unit = (unitId = 'unit-1', item: Unit['item'] = { state: 'recorded', itemId: 'item-1', workstreamId: 'group-1', integration: 'pending' }): Unit => ({
  unitId, groupId: 'group-1', unitStatus: 'running', latestCheck: null, item,
});
const live = (units: Unit[] = [unit()]): Inspection => ({ state: 'live', contractId: 'contract-1', isolation: 'worktree', units });
const execution = (integration: Inspection | undefined, target = identity): Execution => ({
  kind: 'execution', projectId: 'project-1', ...target, currentRevision: target.expectedRevision, currentAttempt: true, stale: false,
  state: 'launch-claimed', recovery: 'available', receipt: { contractId: 'contract-1', ownerAgentId: 'owner-1' },
  progress: { status: 'running', sessionMode: integration?.state === 'not-applicable' && integration.reason === 'session-mode', semanticState: null, stage: null, retrying: false,
    units: { total: 1, passed: 0, failed: 0 }, criteria: { total: 1, met: 0, unmet: 0, unshown: 1 } },
  ...(integration === undefined ? {} : { integration }),
});
function fixture(initial: Inspection | undefined = live()) {
  const calls: string[] = []; const signals: (AbortSignal | undefined)[] = [];
  let response = (target: NativeWorkExecutionIdentity): NativeWorkExecutionSnapshot | Promise<NativeWorkExecutionSnapshot> => execution(initial, target);
  const snapshot: WorkLedgerReadSnapshot = { projectId: 'project-1', revision: 0, cursor: 0, works: [{
    work: { source: null, id: identity.workId, title: 'Native work', goal: 'Preserve original criteria', criteria: ['Original criterion'], revision: 3, criteriaRevision: 2,
      reportedState: 'in_progress', currentAttemptId: identity.attemptId, createdAt: 1, updatedAt: 1 },
    attempt: { id: identity.attemptId, workId: identity.workId, predecessorId: null, ownerId: 'owner-1', revision: 4, state: 'active', report: null, blocker: null, createdAt: 1, updatedAt: 1 },
    verification: { state: 'unverified', reason: 'No current proof', evidence: null }, attention: [],
  }] };
  const reader: WorkLedgerReadClient = { projectId: snapshot.projectId, readSnapshot: async () => snapshot, history: async () => [], subscribe: () => () => {}, dispose() {} };
  let selection: NativeWorkLedgerSelection = { available: true, identity: 'host-A', projectId: snapshot.projectId, bind: () => ({ available: true, client: reader,
    execution: createOperatorNativeWorkExecutionClient({ invoke: async <T>(operation: string, args: unknown, options?: { signal?: AbortSignal }): Promise<T> => {
      calls.push(operation); signals.push(options?.signal); return await response(args as NativeWorkExecutionIdentity) as T;
    } }, snapshot.projectId),
  }) };
  const surface = createNativeWorkLedgerModalSurface(() => selection);
  const modal = new ConfigModal();
  const route = { configModal: modal, requestRender() {}, handleEscape: () => modal.close() };
  const key = (logicalName: string) => handleConfigModalToken(route, { type: 'key', logicalName } as never);
  const frame = (width = 180, height = 45): string => frameFromLayer(renderConfigModal(modal, width, height), width, height)
    .map(line => line.map(cell => cell.char).join('')).join('\n');
  const tab = (id: string): void => {
    for (let i = 0; i < surface.buildView().tabs.length && modal.getActiveTabId() !== id; i++) key('right');
    expect(modal.getActiveTabId()).toBe(id);
  };
  const inspect = async (): Promise<void> => {
    tab('work'); key('down'); handleConfigModalToken(route, { type: 'text', value: 'i' }); await tick(); tab('integration');
  };
  return { surface, modal, calls, signals, key, frame, tab, inspect, reader,
    open: async () => { modal.open(surface); await tick(); frame(); },
    replace: (value: Inspection | undefined) => { response = target => execution(value, target); },
    respond: (fn: typeof response) => { response = fn; },
    switchHost: () => { selection = { ...selection, identity: 'host-B' }; },
    text: () => surface.buildView().tabs.find(tab => tab.id === 'integration')!.rows.map(row => row.label).join('\n'),
  };
}

test('production status path exposes more than 11 read-only integration facts without adding mutations or changing verification', async () => {
  const f = fixture(live([
    unit('pending'), unit('unrecorded', { state: 'recorded', itemId: 'original', workstreamId: 'group-1', integration: 'unrecorded' }),
    unit('merged', { state: 'recorded', itemId: 'merged-item', workstreamId: 'group-1', integration: 'merged', mergeHash: 'actual-merge-hash', worktreeKept: false, conflictFiles: [] }),
    unit('no-changes', { state: 'recorded', itemId: 'unchanged-item', workstreamId: 'group-1', integration: 'merged' }),
    { ...unit('fix', { state: 'recorded', itemId: 'original-conflict-item', workstreamId: 'group-1', integration: 'conflict', worktreeKept: true, conflictFiles: ['src/real-conflict.ts'] }),
      unitStatus: 'passed', attemptOf: 'pending', attemptIndex: 0, latestCheck: { id: 'fix-check', at: 12, trigger: 'fix-passed', result: 'pass' } },
    unit('missing', { state: 'unavailable', reason: 'missing-item' }), unit('plan', { state: 'not-applicable', reason: 'best-of-n-plan' }),
  ]));
  try {
    await f.open(); expect(f.calls).toEqual([]); await f.inspect();
    const tab = f.surface.buildView().tabs.find(tab => tab.id === 'integration')!;
    expect(tab.rows.length).toBeGreaterThan(11); expect(tab.rows.every(row => row.selectable === false)).toBe(true);
    const text = f.text();
    for (const fact of ['execution attempt attempt-1', 'Contract contract-1', 'Recorded integration: pending', 'Recorded integration: unrecorded',
      'Merge hash: actual-merge-hash', 'Recorded integration: merged (no changes)', 'Current unit status: passed', 'fix-passed · pass',
      'Item original-conflict-item', 'Recorded integration: conflict', 'src/real-conflict.ts', 'attempt index: 0',
      'Worktree kept: false', 'Worktree kept: true', 'Conflict files: not recorded', 'Conflict files: 0 (recorded empty)', 'Item unavailable: missing-item', 'Item not applicable: best-of-n-plan']) expect(text).toContain(fact);
    expect(text).not.toMatch(/waiting on (?:the )?user|needsAttention|verified success/);
    for (const key of ['s', 'i', 'c', 'r']) expect(f.modal.fireAction(key, { print() {} })).toBe(false);
    expect(f.calls).toEqual(['workLedger.execution.status']);
    const work = f.surface.buildView().tabs.find(tab => tab.id === 'work')!.rows.map(row => row.label).join('\n');
    expect(work).toContain('verificationState unverified'); expect(work).toContain('reportedState in_progress');
    expect(f.frame()).toContain('Integration: live');
  } finally { f.modal.close(); }
});

test('optional absence stays distinct from recorded empty paths, false and empty conflicts', () => {
  const inspection = live([unit('absent'), unit('empty', { state: 'recorded', itemId: 'empty-item', workstreamId: 'group-1', integration: 'conflict', worktreePath: '', worktreeBranch: '', worktreeKept: false, conflictFiles: [] })]);
  const view = nativeWorkIntegrationView({ workId: 'work-1', action: 'status', busy: false, message: '', snapshot: execution(inspection) });
  const text = view.rows.map(row => row.label).join('\n');
  for (const fact of ['Worktree path: not recorded', 'Worktree path: ""', 'Worktree branch: not recorded', 'Worktree branch: ""', 'Worktree kept: not recorded', 'Worktree kept: false', 'Conflict files: not recorded', 'Conflict files: 0 (recorded empty)']) expect(text).toContain(fact);
});

test('a disconnected native host reports unavailable integration without offering absent controls', () => {
  const surface = createNativeWorkLedgerModalSurface(() => ({ available: false, identity: 'disconnected', reason: 'Selected host is offline.' }));
  const modal = new ConfigModal();
  try {
    modal.open(surface);
    const tab = surface.buildView().tabs.find(tab => tab.id === 'integration')!;
    expect(tab.header?.join(' ')).toContain('Integration unavailable: native execution status is not connected.');
    expect(tab.header?.join(' ')).not.toContain('press i'); expect(surface.actions).toEqual([]); expect(tab.rows).toEqual([]);
  } finally { modal.close(); }
});

test('admission intents cannot masquerade as execution attempts or integration receipts', () => {
  const common = { projectId: 'project-1', ...identity, currentRevision: identity.expectedRevision, currentAttempt: true, stale: false };
  for (const snapshot of [
    { ...common, kind: 'pending-intent', state: 'admitting', recovery: 'pending' },
    { ...common, kind: 'prevented-before-admission', state: 'cancelled', recovery: 'cancelled' },
  ] as const) {
    const view = nativeWorkIntegrationView({ workId: identity.workId, action: 'status', busy: false, message: '', snapshot });
    const text = view.rows.map(row => row.label).join('\n');
    expect(view.status).toContain('no admitted execution receipt'); expect(text).toContain('admission intent attempt-1');
    expect(text).not.toContain('execution attempt'); expect(text).not.toContain('Contract ');
  }
});

test('actual integration tab keeps long hostile worktree and conflict paths reachable at narrow widths and after resizing', async () => {
  const hostile = '\u001b[31m\n\r\u202e';
  const f = fixture(live([unit('hostile', { state: 'recorded', itemId: 'path-item', workstreamId: 'group-1', integration: 'conflict',
    worktreePath: `/root/${hostile}${'unbroken/'.repeat(45)} PATH_TAIL`, worktreeBranch: `${hostile}${'longbranch'.repeat(30)} BRANCH_TAIL`,
    conflictFiles: Array.from({ length: 18 }, (_, index) => `src/${index}/${'very-long-path/'.repeat(4)} FILE_TAIL_${index}`),
  })]));
  try {
    await f.open(); await f.inspect();
    expect(f.text()).not.toMatch(/[\u001b\r\u202e]/);
    expect(f.text()).toContain('\\u001b'); expect(f.text()).toContain('\\u202e');
    for (const width of [80, 48, 100, 48]) {
      f.tab('work'); f.tab('integration');
      const found = new Set<string>();
      for (let i = 0; i < 700 && found.size < 3; i++) {
        const screen = f.frame(width, 24);
        for (const tail of ['PATH_TAIL', 'BRANCH_TAIL', 'FILE_TAIL_17']) if (screen.includes(tail)) found.add(tail);
        f.key('down');
      }
      expect([...found].sort()).toEqual(['BRANCH_TAIL', 'FILE_TAIL_17', 'PATH_TAIL']);
      expect(f.modal.getRenderModel().scroll.offset).toBeGreaterThan(0);
    }
    expect(f.calls).toEqual(['workLedger.execution.status']);
  } finally { f.modal.close(); }
}, 15_000);

test('tuple row identities resist suffix collisions and remain stable across status/check value updates', () => {
  const units = ['u', 'u:status', 'u:line:0', '["u","status"]'].map((id, index) => ({ ...unit(id, { state: 'recorded', itemId: `${id}:hash`, workstreamId: 'group-1', integration: 'pending' }), attemptIndex: index }));
  const read = (snapshot: Execution) => nativeWorkIntegrationView({ workId: 'work-1', action: 'status', busy: false, message: '', snapshot }).rows;
  const before = read(execution(live(units))); const ids = before.map(row => row.id);
  expect(new Set(ids).size).toBe(ids.length);
  const updated = read(execution(live(units.map(value => ({ ...value, unitStatus: 'passed', latestCheck: { id: 'check', at: 2, trigger: 'fix-passed', result: 'pass' } })))));
  expect(updated.map(row => row.id)).toEqual(ids);
  expect(updated.filter(row => row.label === 'Current unit status: passed')).toHaveLength(units.length);
  const otherAttempt = read({ ...execution(live(units)), attemptId: 'attempt:1' });
  expect(otherAttempt.every(row => !ids.includes(row.id))).toBe(true);
  const otherItem = read(execution(live([unit('u', { state: 'recorded', itemId: 'different-item', workstreamId: 'group-1', integration: 'pending' })])));
  expect(otherItem.find(row => row.label.startsWith('Unit '))?.id).not.toBe(before.find(row => row.label.startsWith('Unit '))?.id);
});

test('unavailable, non-applicable, old hosts and empty live inspection stay explicit through the native status client', async () => {
  const f = fixture();
  try {
    await f.open(); f.tab('integration'); expect(f.frame()).toContain('Integration unavailable');
    for (const reason of ['not-live', 'no-engine', 'no-receipt', 'stale-attempt', 'recovery-required', 'unsupported-runner', 'invalid-data', 'limit'] as const) {
      f.replace({ state: 'unavailable', reason }); await f.inspect(); expect(f.frame()).toContain(`Integration unavailable: ${reason}`); expect(f.text()).not.toContain('Recorded integration:');
    }
    for (const reason of ['session-mode', 'shared-isolation'] as const) {
      f.replace({ state: 'not-applicable', contractId: 'contract-1', reason }); await f.inspect(); expect(f.frame()).toContain(`Integration not applicable: ${reason}`);
    }
    f.replace(undefined);
    await f.inspect(); expect(f.frame()).toContain('this host did not report integration inspection');
    f.replace(live([])); await f.inspect(); expect(f.frame()).toContain('0 recorded units');
    expect(f.calls.every(call => call === 'workLedger.execution.status')).toBe(true);
  } finally { f.modal.close(); }
});

for (const transition of ['close/reopen', 'host switch'] as const) test(`${transition} clears frozen integration data, aborts transport, and rejects a late native status result`, async () => {
  const f = fixture(live([unit('OLD_HOST_UNIT')]));
  let finish!: (value: NativeWorkExecutionSnapshot) => void;
  try {
    await f.open(); await f.inspect(); f.key('down'); expect(f.frame()).toContain('OLD_HOST_UNIT');
    f.respond(() => new Promise(resolve => { finish = resolve; }));
    f.tab('work'); f.key('down'); expect(f.modal.fireAction('i', { print() {} })).toBe(true); await tick(); f.tab('integration');
    if (transition === 'close/reopen') { f.key('escape'); expect(f.modal.active).toBe(false); await f.open(); }
    else { f.switchHost(); f.frame(); await tick(); }
    expect(f.signals.at(-1)?.aborted).toBe(true);
    f.tab('integration'); expect(f.frame()).not.toContain('OLD_HOST_UNIT');
    finish(execution(live([unit('LATE_HOST_UNIT')]))); await tick();
    expect(f.frame()).not.toContain('LATE_HOST_UNIT'); expect(f.text()).not.toContain('OLD_HOST_UNIT');
    f.replace(live([unit('FRESH_HOST_UNIT')])); await f.inspect(); expect(f.frame()).toContain('FRESH_HOST_UNIT');
    expect(f.calls).toEqual(Array(3).fill('workLedger.execution.status'));
  } finally { f.modal.close(); }
});

test('an integration tab opened during status request shows an explicit layout refresh when the response arrives', async () => {
  const f = fixture(); let finish!: (value: NativeWorkExecutionSnapshot) => void;
  try {
    await f.open(); f.respond(() => new Promise(resolve => { finish = resolve; }));
    f.key('down'); expect(f.modal.fireAction('i', { print() {} })).toBe(true); await tick(); f.tab('integration');
    expect(f.frame()).toContain('request is pending');
    finish(execution(live([unit('ARRIVED_UNIT')]))); await tick();
    const arrived = f.frame(); expect(arrived).toContain('Integration: live'); expect(arrived).toContain('Native rows changed');
    f.key('down'); expect(f.frame()).toContain('ARRIVED_UNIT'); expect(f.calls).toEqual(['workLedger.execution.status']);
  } finally { f.modal.close(); }
});
