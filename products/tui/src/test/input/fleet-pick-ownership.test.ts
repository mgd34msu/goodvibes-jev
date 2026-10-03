import { afterEach, describe, expect, test } from 'bun:test';
import { createProcessRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { AgentsModal } from '../../input/agents-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { ChangesModal } from '../../input/changes-modal.ts';
import { FleetActs, type FleetDiffSurface } from '../../views/fleet-acts.ts';
import { createFleetReadModel } from '../../views/fleet-read-model.ts';
import type { FleetGateway, FleetHeldMergeGroup, FleetPickResult } from '../../views/fleet-gateway.ts';
import { contractFixture, contractUnit } from '../helpers/contract-work-tree-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const key = (logicalName: string): InputToken => ({ type: 'key', name: logicalName, logicalName, ctrl: false, meta: false, shift: false });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function group(title = 'Current choice'): FleetHeldMergeGroup {
  return { groupId: 'ctr:attempts-u1', workstreamId: 'ctr:g1', sourceTitle: title, ready: true, autoAccept: false, judgment: null,
    candidates: ['u1-a', 'u1-b'].map((id, index) => ({ itemId: `ctr:${id}`, attemptIndex: index, state: 'held-merge', title: id,
      worktreePath: `/synthetic/${id}`, branch: id, failureReason: null,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, toolCallCount: 0, costUsd: null, costState: 'unpriced' },
      diff: { files: ['retry.ts'], unifiedDiff: `--- a/retry.ts\n+++ b/retry.ts\n@@ -1 +1 @@\n-old\n+${id}`, stat: '1 file' },
    })),
  };
}
function receipt(confirm: boolean): FleetPickResult {
  return { applied: confirm, groupId: 'ctr:attempts-u1', winnerItemId: 'ctr:u1-a', loserItemIds: [], auto: false, requiresConfirm: !confirm, group: group() };
}
function setup(overrides: Partial<FleetGateway> = {}) {
  let contract = contractFixture({ id: 'ctr', status: 'awaiting-owner', units: [contractUnit({ id: 'u1', groupId: 'g1', status: 'awaiting-owner', attempts: 2,
    attemptSelection: { engineGroupId: 'attempts-u1', candidateIds: ['u1-a', 'u1-b'], outcome: 'confirm', reasons: 'Owner chooses' } })],
    escalations: [{ id: 'choice', at: 1, scope: 'unit', targetId: 'u1', reason: 'attempts-undecided', question: 'Choose an attempt', unmetCriterionIds: [] }],
  });
  const registry = createProcessRegistry({
    agentManager: { list: () => [], cancel: () => false }, contractRunner: { list: () => [contract], cancel: () => false },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined }, watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: { workflowManager: { list: () => [], cancel: () => false }, triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false }, scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false } },
  });
  const host = new SurfaceModalHost(); const calls: boolean[] = []; const notes: string[] = []; const shown: string[] = [];
  const confirms: Array<Parameters<FleetDiffSurface['armConfirm']>[0]> = []; let renders = 0;
  let preview: ChangesModal | null = null;
  const gateway: FleetGateway = {
    listAttempts: async () => ({ groups: [group()] }), pick: async input => { calls.push(input.confirm); return receipt(input.confirm); },
    resolveConflict: async () => { throw new Error('No conflict expected'); }, discardWorktree: async () => { throw new Error('No discard expected'); },
    getGraph: async () => { throw new Error('No graph expected'); }, steerObserved: async () => ({ queued: false, reason: 'unused' }), armFixSessionAttach: () => {}, ...overrides,
  };
  const acts = new FleetActs({ resolveGateway: () => ({ available: true, gateway }), findNode: id => registry.getNode(id), notify: text => notes.push(text), markDirty: () => { renders++; },
    diffSurface: { show: (title, diff) => {
      shown.push(diff);
      preview = new ChangesModal({ workingDirectory: '/synthetic', getSessionFiles: () => [], requestRender: () => { renders++; } }, 'preview');
      preview.loadPreview(title, diff, null); host.push(preview);
    }, close: () => { if (preview) host.close(preview, 'done'); preview = null; }, armConfirm: args => {
      confirms.push(args);
      if (!preview) throw new Error('Missing candidate preview');
      void preview.ask({ text: args.label, confirmLabel: args.verb, tone: 'warning' }).then(ok => ok ? args.onConfirm() : args.onCancel?.());
    } },
  });
  const open = () => {
    const modal = new AgentsModal({ readModel: createFleetReadModel(registry), acts, actions: {
      interrupt: () => false, resume: () => false, kill: () => [], getConversationSnapshot: () => [], resolveSessionLogPath: () => '', steer: () => ({ queued: false, reason: 'unused' }),
    }, requestRender: () => { renders++; }, tickMs: 0 });
    host.push(modal); expect(modal.reveal({ id: 'unit:ctr:u1' })).toBe(true); return modal;
  };
  const modal = open(); cleanups.push(() => { host.clear(); registry.dispose(); });
  const rendered = () => host.render(120, 40).map(layer => layer.lines.map(line => line.map(cell => cell.char).join('')).join('\n')).join('\n');
  return { host, modal, open, acts, calls, notes, shown, confirms, rendered, renders: () => renders,
    finish: () => { contract = { ...contract, status: 'passed' }; } };
}

describe('contract attempt picker ownership through real Agents modal input', () => {
  test('repeated Enter while listing admits one read and renders the recorded candidates', async () => {
    const pending = deferred<{ groups: FleetHeldMergeGroup[] }>(); let reads = 0;
    const f = setup({ listAttempts: () => { reads++; return pending.promise; } });
    f.host.handleToken(key('enter')); f.host.handleToken(key('enter')); expect(reads).toBe(1);
    pending.resolve({ groups: [group()] }); await flush();
    expect(f.rendered()).toContain('Current choice'); expect(f.rendered()).toContain('u1-a'); expect(f.calls).toEqual([]);
  });
  for (const settlement of ['resolve', 'reject'] as const) {
    test(`Escape during a read ignores late ${settlement} when a filter consumes Escape`, async () => {
      const pending = deferred<{ groups: FleetHeldMergeGroup[] }>(); const f = setup({ listAttempts: () => pending.promise });
      f.host.handleToken(key('enter')); f.host.handleToken({ type: 'text', value: '/' }); f.host.escape();
      expect(f.host.depth).toBe(1); const renders = f.renders();
      if (settlement === 'resolve') pending.resolve({ groups: [group('Stale choice')] }); else pending.reject(new Error('Stale read error'));
      await flush(); expect(f.acts.pickModeActive()).toBe(false); expect(f.renders()).toBe(renders);
      expect(f.rendered()).not.toContain('Stale choice'); expect(f.notes).toEqual([]); expect(f.calls).toEqual([]);
    });
    test(`closing and reopening fences the old list ${settlement}`, async () => {
      const pending = deferred<{ groups: FleetHeldMergeGroup[] }>(); let reads = 0;
      const f = setup({ listAttempts: () => ++reads === 1 ? pending.promise : Promise.resolve({ groups: [group()] }) });
      f.host.handleToken(key('enter')); f.host.handleToken(key('f2')); f.open(); f.host.handleToken(key('enter')); await flush();
      if (settlement === 'resolve') pending.resolve({ groups: [group('Stale choice')] }); else pending.reject(new Error('Stale read error'));
      await flush(); expect(f.rendered()).toContain('Current choice'); expect(f.rendered()).not.toContain('Stale choice'); expect(f.notes).toEqual([]);
    });
    test(`Escape during preview ignores late ${settlement} without opening confirmation`, async () => {
      const pending = deferred<FleetPickResult>(); const f = setup({ pick: () => pending.promise });
      f.host.handleToken(key('enter')); await flush(); f.host.handleToken(key('enter')); f.host.escape(); const renders = f.renders();
      if (settlement === 'resolve') pending.resolve(receipt(false)); else pending.reject(new Error('Stale preview error'));
      await flush(); expect(f.host.depth).toBe(1); expect(f.acts.pickModeActive()).toBe(false);
      expect(f.shown).toEqual([]); expect(f.confirms).toEqual([]); expect(f.notes).toEqual([]); expect(f.renders()).toBe(renders);
    });
  }
  test('repeated preview Enter coalesces and waits for actual confirmation', async () => {
    const pending = deferred<FleetPickResult>(); const inputs: boolean[] = [];
    const f = setup({ pick: input => { inputs.push(input.confirm); return input.confirm ? Promise.resolve(receipt(true)) : pending.promise; } });
    f.host.handleToken(key('enter')); await flush(); f.host.handleToken(key('enter')); f.host.handleToken(key('enter'));
    expect(inputs).toEqual([false]); pending.resolve(receipt(false)); await flush();
    expect(f.confirms).toHaveLength(1); expect(f.host.depth).toBe(2); expect(f.rendered()).toContain('merge it');
    f.host.handleToken(key('right')); f.host.handleToken(key('enter')); await flush(); expect(inputs).toEqual([false, true]);
    expect(f.acts.pickModeActive()).toBe(false); expect(f.notes.join('\n')).toContain('Winner picked');
  });
  test('a confirmation callback is one-shot', async () => {
    const pending = deferred<FleetPickResult>(); const inputs: boolean[] = [];
    const f = setup({ pick: input => { inputs.push(input.confirm); return input.confirm ? pending.promise : Promise.resolve(receipt(false)); } });
    f.host.handleToken(key('enter')); await flush(); f.host.handleToken(key('enter')); await flush();
    const arm = f.confirms[0]!; const first = arm.onConfirm(); const second = arm.onConfirm();
    expect(inputs).toEqual([false, true]); pending.resolve(receipt(true)); await first; await second;
    expect(f.notes.filter(note => note.includes('Winner picked'))).toHaveLength(1);
  });
  test('an admitted apply keeps its receipt but cannot clear a reopened picker', async () => {
    const pending = deferred<FleetPickResult>();
    const f = setup({ pick: input => input.confirm ? pending.promise : Promise.resolve(receipt(false)) });
    f.host.handleToken(key('enter')); await flush(); f.host.handleToken(key('enter')); await flush();
    f.host.handleToken({ type: 'text', value: 'y' }); await flush();
    f.host.clear(); f.open(); f.host.handleToken(key('enter')); await flush();
    expect(f.acts.pickModeActive()).toBe(true);
    pending.resolve(receipt(true)); await flush();
    expect(f.acts.pickModeActive()).toBe(true); expect(f.rendered()).toContain('Current choice');
    expect(f.notes.filter(note => note.includes('Winner picked'))).toHaveLength(1);
  });
  test('cleared confirmations cannot apply or cancel a newer picker', async () => {
    const f = setup();
    f.host.handleToken(key('enter')); await flush(); f.host.handleToken(key('enter')); await flush();
    const stale = f.confirms[0]!;
    f.host.clear(); f.open(); f.host.handleToken(key('enter')); await flush();
    await stale.onConfirm(); stale.onCancel?.();
    expect(f.calls).toEqual([false]); expect(f.acts.pickModeActive()).toBe(true); expect(f.notes).toEqual([]);
  });
  test('current preview failures are reported and can be retried', async () => {
    let previews = 0;
    const f = setup({ pick: async input => {
      if (!input.confirm && ++previews === 1) throw new Error('Synthetic preview failure');
      return receipt(input.confirm);
    } });
    f.host.handleToken(key('enter')); await flush(); f.host.handleToken(key('enter')); await flush();
    expect(f.notes.join(' ')).toContain('Synthetic preview failure'); expect(f.acts.pickModeActive()).toBe(true);
    f.host.handleToken(key('enter')); await flush(); expect(f.confirms).toHaveLength(1);
    f.host.escape(); await flush(); expect(f.acts.pickModeActive()).toBe(false);
    expect(f.notes.join(' ')).toContain('nothing merged');
  });
  test('newer list navigation revokes the pending choice', async () => {
    const pending = deferred<{ groups: FleetHeldMergeGroup[] }>(); const f = setup({ listAttempts: () => pending.promise });
    f.host.handleToken(key('enter')); f.host.handleToken(key('up'));
    const selected = f.modal.selectedNode()?.id;
    expect(selected).not.toBe('unit:ctr:u1');
    pending.resolve({ groups: [group('Stale choice')] }); await flush();
    expect(f.acts.pickModeActive()).toBe(false); expect(f.modal.selectedNode()?.id).toBe(selected);
    expect(f.rendered()).not.toContain('Stale choice');
  });
  test.each(['archive', 'filter', 'filter-open', 'blocked', 'follow', 'hosted'] as const)('%s navigation revokes a pending list read', async navigation => {
    const pending = deferred<{ groups: FleetHeldMergeGroup[] }>(); const f = setup({ listAttempts: () => pending.promise });
    f.host.handleToken(key('enter'));
    if (navigation === 'filter' || navigation === 'filter-open') {
      f.host.handleToken({ type: 'text', value: '/' });
      if (navigation === 'filter') f.host.handleToken({ type: 'text', value: 'no-match' });
    } else if (navigation === 'hosted') f.modal.showHosted();
    else f.host.handleToken({ type: 'text', value: navigation === 'archive' ? 'v' : navigation === 'blocked' ? 'b' : 'f' });
    pending.resolve({ groups: [group('Stale choice')] }); await flush();
    expect(f.acts.pickModeActive()).toBe(false); expect(f.rendered()).not.toContain('Stale choice'); expect(f.calls).toEqual([]);
  });
  test('a settled contract choice is not shown after its list read finishes', async () => {
    const pending = deferred<{ groups: FleetHeldMergeGroup[] }>(); const f = setup({ listAttempts: () => pending.promise });
    f.host.handleToken(key('enter')); f.finish(); pending.resolve({ groups: [group()] }); await flush();
    expect(f.acts.pickModeActive()).toBe(false); expect(f.confirms).toEqual([]);
  });
});
