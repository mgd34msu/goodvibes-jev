import { afterEach, describe, expect, test } from 'bun:test';
import { createProcessRegistry, type ProcessRegistry, type ProcessNode } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import type { ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';
import { buildFleetTreeHints } from '../../views/fleet-stop.ts';
import { FleetActs, type FleetDiffSurface } from '../../views/fleet-acts.ts';
import { workstreamIdFromNodeId, workItemIdFromNodeId, type FleetGateway, type FleetHeldMergeGroup } from '../../views/fleet-gateway.ts';
import { contractFixture, contractUnit } from '../helpers/contract-work-tree-fixtures.ts';

const registries: ProcessRegistry[] = [];
afterEach(() => { for (const registry of registries.splice(0)) registry.dispose(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function waitingContract(): ContractView {
  return contractFixture({ id: 'ctr', status: 'awaiting-owner', completedAt: undefined,
    units: [contractUnit({ id: 'u1', status: 'awaiting-owner', attempts: 2,
      attemptSelection: { engineGroupId: 'attempts-u1', candidateIds: ['u1-a', 'u1-b'], outcome: 'confirm', reasons: 'Owner chooses' },
    })],
    escalations: [{ id: 'choice', at: 1, scope: 'unit', targetId: 'u1', reason: 'attempts-undecided', question: 'Choose an attempt', unmetCriterionIds: [] }],
  });
}

function heldGroup(groupId = 'ctr:attempts-u1'): FleetHeldMergeGroup {
  return { groupId, workstreamId: 'ctr:g1', sourceTitle: 'Repair retry cap', ready: true, autoAccept: false, judgment: null,
    candidates: ['u1-a', 'u1-b'].map((id, index) => ({ itemId: `ctr:${id}`, attemptIndex: index, state: 'held-merge', title: id,
      worktreePath: `/synthetic/${id}`, branch: id, failureReason: null,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 0, costUsd: null, costState: 'unpriced' },
      diff: { files: ['retry.ts'], unifiedDiff: `--- a/retry.ts\n+++ b/retry.ts\n@@ -1 +1 @@\n-old\n+${id}`, stat: '1 file' },
    })),
  };
}

function fixture(initial = waitingContract(), groups = [heldGroup()]) {
  let contract = initial;
  const registry = createProcessRegistry({
    agentManager: { list: () => [], cancel: () => false },
    contractRunner: { list: () => [contract], cancel: () => false },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
    },
  });
  registries.push(registry);
  const calls: Array<{ action: string; value: unknown }> = [];
  const notes: string[] = [];
  const confirms: Array<Parameters<FleetDiffSurface['armConfirm']>[0]> = [];
  const shown: string[] = [];
  const gateway: FleetGateway = {
    listAttempts: async id => { calls.push({ action: 'list', value: id }); return { groups }; },
    pick: async input => { calls.push({ action: 'pick', value: input }); return { applied: input.confirm, groupId: input.groupId, winnerItemId: input.winnerItemId, loserItemIds: [], auto: false, requiresConfirm: !input.confirm, group: groups[0]! }; },
    resolveConflict: async itemId => { calls.push({ action: 'resolve', value: itemId }); return { itemId, sessionId: 'resolution-1', worktreePath: '/synthetic/kept', files: ['retry.ts'] }; },
    discardWorktree: async path => { calls.push({ action: 'discard', value: path }); return { ok: true, path, branch: 'kept-branch', preservedCommit: 'saved', discardedAt: 1, detail: 'directory removed; branch kept' }; },
    getGraph: async id => { calls.push({ action: 'graph', value: id }); throw new Error('Synthetic graph unavailable'); },
    steerObserved: async () => ({ queued: false, reason: 'not supported by this fixture' }),
    armFixSessionAttach: id => { calls.push({ action: 'attach', value: id }); },
  };
  const acts = new FleetActs({ resolveGateway: () => ({ available: true, gateway }), notify: text => notes.push(text), markDirty: () => {},
    findNode: id => registry.getNode(id), diffSurface: { show: (_title, diff) => shown.push(diff), close: () => {}, armConfirm: options => confirms.push(options) },
  });
  const node = (id: string): ProcessNode => { const value = registry.getNode(id); if (!value) throw new Error(`Missing real registry node ${id}`); return value; };
  return { acts, calls, notes, confirms, shown, gateway, node, replace: (value: ContractView) => { contract = value; } };
}

describe('fleet acts over actual public contract adapter nodes', () => {
  test('ID extraction keeps contract qualification and refuses retired or incomplete IDs', () => {
    expect(workstreamIdFromNodeId('group:ctr:g1')).toBe('ctr:g1');
    expect(workItemIdFromNodeId('unit:ctr:u1')).toBe('ctr:u1');
    for (const id of ['workstream:g1', 'group:g1', 'group::g1', 'contract:ctr']) expect(workstreamIdFromNodeId(id)).toBeNull();
    for (const id of ['work-item:u1', 'unit:u1', 'unit:ctr:', 'agent:a']) expect(workItemIdFromNodeId(id)).toBeNull();
  });

  test('real pick flag selects its recorded group, previews, then applies only after confirmation', async () => {
    const f = fixture(waitingContract(), [heldGroup('ctr:unrelated'), heldGroup()]);
    const unit = f.node('unit:ctr:u1');
    expect(unit.needsAttention?.reason).toBe('pick');
    expect(f.acts.handleTreeKey('enter', unit)).toBe(true);
    await flush();
    expect(f.calls).toEqual([{ action: 'list', value: 'ctr:g1' }]);
    f.acts.handlePickInput('down');
    f.acts.handlePickInput('enter');
    await flush();
    expect(f.shown[0]).toContain('+u1-b');
    expect(f.calls[1]).toEqual({ action: 'pick', value: { groupId: 'ctr:attempts-u1', winnerItemId: 'ctr:u1-b', confirm: false } });
    expect(f.confirms).toHaveLength(1);
    await f.confirms[0]!.onConfirm();
    expect(f.calls[2]).toEqual({ action: 'pick', value: { groupId: 'ctr:attempts-u1', winnerItemId: 'ctr:u1-b', confirm: true } });
    expect(f.acts.pickModeActive()).toBe(false);
  });

  test('cancelled choice never applies a pick', async () => {
    const f = fixture();
    await f.acts.beginPick(f.node('unit:ctr:u1'));
    f.acts.handlePickInput('enter'); await flush();
    f.confirms[0]!.onCancel?.();
    expect(f.calls.filter(call => call.action === 'pick')).toEqual([{ action: 'pick', value: { groupId: 'ctr:attempts-u1', winnerItemId: 'ctr:u1-a', confirm: false } }]);
    expect(f.notes.join('\n')).toContain('nothing merged');
  });

  test('an ended choice or a candidate outside the recorded unit never applies', async () => {
    const f = fixture();
    await f.acts.beginPick(f.node('unit:ctr:u1'));
    f.acts.handlePickInput('enter'); await flush();
    f.replace({ ...waitingContract(), status: 'cancelled' });
    await f.confirms[0]!.onConfirm();
    expect(f.calls.filter(call => call.action === 'pick')).toHaveLength(1);
    expect(f.notes.join('\n')).toContain('no longer available');
    const other = heldGroup();
    const wrong = fixture(waitingContract(), [{ ...other, candidates: other.candidates.map(candidate => ({ ...candidate, itemId: 'other:u1-a' })) }]);
    await wrong.acts.beginPick(wrong.node('unit:ctr:u1'));
    expect(wrong.acts.pickModeActive()).toBe(false);
  });

  test('roots and groups cannot accidentally choose the first unrelated unit', async () => {
    const f = fixture();
    await f.acts.beginPick(f.node('contract:ctr'));
    await f.acts.beginPick(f.node('group:ctr:g1'));
    expect(f.calls).toEqual([]);
    expect(f.acts.pickModeActive()).toBe(false);
  });

  test('graph reads use the qualified group; root has no guessed group', async () => {
    const f = fixture();
    f.acts.ensureGraphFor(f.node('group:ctr:g1'));
    f.acts.ensureGraphFor(f.node('group:ctr:g1'));
    f.acts.ensureGraphFor(f.node('contract:ctr'));
    await flush();
    expect(f.calls).toEqual([{ action: 'graph', value: 'ctr:g1' }]);
    expect(f.acts.graphFor('group:ctr:g1')).toBeNull();
  });

  test('conflict resolution passes only the recorded qualified unit and attaches the returned session', async () => {
    const f = fixture();
    await f.acts.resolveConflict(f.node('unit:ctr:u1'));
    expect(f.calls).toEqual([{ action: 'resolve', value: 'ctr:u1' }, { action: 'attach', value: 'resolution-1' }]);
    await f.acts.resolveConflict({ ...f.node('unit:ctr:u1'), id: 'unit:other:u1' });
    expect(f.calls).toHaveLength(2);
  });

  test('only a completed root owns a discardable worktree and still requires confirmation', async () => {
    const record = { ...waitingContract(), worktreePath: '/synthetic/contract', status: 'passed' as const };
    const f = fixture(record);
    expect(buildFleetTreeHints(f.node('unit:ctr:u1'), false, false).some(hint => hint.keys === 'D')).toBe(false);
    expect(buildFleetTreeHints(f.node('contract:ctr'), false, false)).toContainEqual({ keys: 'D', label: 'discard worktree' });
    expect(f.acts.discardWorktree(f.node('unit:ctr:u1'))).toBe(false);
    expect(f.acts.discardWorktree(f.node('contract:ctr'))).toBe(true);
    expect(f.calls).toEqual([]);
    await f.confirms[0]!.onConfirm();
    expect(f.calls).toEqual([{ action: 'discard', value: '/synthetic/contract' }]);
    expect(f.notes.join('\n')).toContain('branch kept: kept-branch');
    expect(f.notes.join('\n')).toContain('preservation commit: saved');
  });

  test('active roots and changed worktree records cannot discard', async () => {
    const active = fixture({ ...waitingContract(), worktreePath: '/synthetic/active' });
    expect(active.acts.discardWorktree(active.node('contract:ctr'))).toBe(true);
    expect(buildFleetTreeHints(active.node('contract:ctr'), false, false).some(hint => hint.keys === 'D')).toBe(false);
    expect(active.confirms).toEqual([]);
    expect(active.calls).toEqual([]);
    const done = fixture({ ...waitingContract(), status: 'passed', worktreePath: '/synthetic/one' });
    done.acts.discardWorktree(done.node('contract:ctr'));
    done.replace({ ...waitingContract(), status: 'passed', worktreePath: '/synthetic/two' });
    await done.confirms[0]!.onConfirm();
    expect(done.calls).toEqual([]);
  });
});
