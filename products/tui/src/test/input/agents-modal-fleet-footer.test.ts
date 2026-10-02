import { afterEach, describe, expect, test } from 'bun:test';
import { createProcessRegistry, type ProcessRegistryDeps } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import type { ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { AgentsModal } from '../../input/agents-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { confirmThrough } from '../../input/confirm-dialog.ts';
import { FleetActs } from '../../views/fleet-acts.ts';
import type { FleetGateway } from '../../views/fleet-gateway.ts';
import { createFleetReadModel } from '../../views/fleet-read-model.ts';
import { getDisplayWidth } from '../../utils/terminal-width.ts';
import { contractFixture } from '../helpers/contract-work-tree-fixtures.ts';

type AgentRecord = ReturnType<ProcessRegistryDeps['agentManager']['list']>[number];
type HostedRecord = ReturnType<NonNullable<ProcessRegistryDeps['acpHost']>['list']>[number];
type ObservedRecord = ReturnType<NonNullable<ProcessRegistryDeps['observedAgents']>['list']>[number];
const close: Array<() => void> = [];
afterEach(() => { for (const dispose of close.splice(0)) dispose(); });
const key = (logicalName: string, ctrl = false): InputToken => ({ type: 'key', name: logicalName, logicalName, ctrl, shift: false, meta: false });
const text = (value: string): InputToken => ({ type: 'text', value });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 };
function agent(id: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return { id, template: id, task: `Task for ${id}`, status: 'running', startedAt: 1000, tools: [], toolCallCount: 0,
    orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only', ...extra };
}
function observed(extra: Partial<ObservedRecord> = {}): ObservedRecord {
  return { externalKind: 'codex', pid: 88, ppid: 1, args: 'codex', cwd: '/synthetic/foreign',
    liveness: { state: 'quiet', cpuSeconds: 0, detail: 'CPU silence is not proof of idleness' }, steer: { kind: 'none', reason: 'No recorded channel' }, ...extra };
}
function hosted(): HostedRecord {
  return { id: 'host-1', agentId: 'codex', title: 'Hosted Codex', binaryPath: '/synthetic/codex', cwd: '/synthetic/project', state: 'idle', startedAt: 1000, promptCount: 0 };
}
function fixture(options: {
  agents?: AgentRecord[]; contracts?: ContractView[]; observed?: ObservedRecord[]; hosted?: HostedRecord[];
  prices?: Record<string, number>; acts?: boolean; schedules?: boolean; sessionCost?: () => number | null;
} = {}) {
  let contracts = options.contracts ?? [];
  const cancelled: string[] = [];
  const discarded: string[] = [];
  const scheduleCalls: string[] = [];
  let scheduleEnabled = true;
  const registry = createProcessRegistry({
    agentManager: { list: () => options.agents ?? [], cancel: id => { cancelled.push(id); return true; } },
    contractRunner: { list: () => contracts, cancel: id => { cancelled.push(id); return true; } },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      scheduleManager: {
        list: () => options.schedules ? [{ name: 'check', interval: '1h', command: 'check', enabled: scheduleEnabled }] : [],
        remove: () => false, disable: () => { scheduleCalls.push('pause'); scheduleEnabled = false; return true; },
        enable: () => { scheduleCalls.push('resume'); scheduleEnabled = true; return true; },
      },
    },
    observedAgents: { list: () => options.observed ?? [], steer: () => ({ queued: false, reason: 'No channel' }) },
    acpHost: { list: () => options.hosted ?? [], prompt: () => ({ queued: true }), stop: async () => true },
    priceUsage: model => model === undefined ? null : options.prices?.[model] ?? null,
    now: () => 100_000,
  });
  const host = new SurfaceModalHost();
  const gateway: FleetGateway = {
    discardWorktree: async path => { discarded.push(path); return { ok: true, path, branch: 'kept', preservedCommit: 'saved', discardedAt: 1, detail: 'branch retained' }; },
    listAttempts: async () => ({ groups: [] }), pick: async () => { throw new Error('No pick expected'); },
    resolveConflict: async () => { throw new Error('No conflict expected'); },
    getGraph: async () => { throw new Error('No recorded graph'); },
    steerObserved: async () => ({ queued: false, reason: 'No channel' }), armFixSessionAttach: () => {},
  };
  const acts = options.acts === false ? undefined : new FleetActs({
    resolveGateway: () => ({ available: true, gateway }), findNode: id => registry.getNode(id), notify: () => {}, markDirty: () => {},
    diffSurface: { show: () => {}, close: () => {}, armConfirm: args => {
      void confirmThrough(host, { title: args.verb, body: args.label, confirmLabel: args.verb, tone: 'danger' })
        .then(ok => ok ? args.onConfirm() : args.onCancel?.());
    } },
  });
  const readModel = createFleetReadModel(registry);
  const modal = new AgentsModal({ readModel, acts, sessionCost: options.sessionCost, actions: {
    interrupt: id => registry.interrupt(id), resume: id => registry.resume(id), kill: (id, opts) => registry.kill(id, opts),
    steer: (id, value) => registry.steer(id, value), getConversationSnapshot: () => [], resolveSessionLogPath: () => '/synthetic/missing.jsonl',
  }, confirm: args => confirmThrough(host, args), requestRender: () => {}, tickMs: 0 });
  host.push(modal);
  close.push(() => { host.clear(); registry.dispose(); });
  const render = (width = 160, height = 55) => modal.render(width, height);
  const rendered = (width = 160, height = 55) => render(width, height).lines.map(line => line.map(cell => cell.char).join('').trimEnd()).join('\n');
  return { registry, host, modal, render, rendered, cancelled, discarded, scheduleCalls, replace: (next: ContractView[]) => { contracts = next; } };
}

describe('Agents modal cost header from the public registry', () => {
  test.each(['empty', 'agent', 'hosted', 'observed'] as const)('%s with no cost reading is unpriced, never dollar zero', kind => {
    const f = fixture({ agents: kind === 'agent' ? [agent('unknown')] : [], hosted: kind === 'hosted' ? [hosted()] : [], observed: kind === 'observed' ? [observed()] : [] });
    expect(f.rendered()).toContain('fleet unpriced');
    expect(f.rendered()).not.toContain('fleet $0.00');
  });

  test.each([0, 0.5])('a recorded %s dollar reading stays a known amount', price => {
    const f = fixture({ agents: [agent('priced', { model: 'priced-model', usage })], prices: { 'priced-model': price } });
    expect(f.registry.getNode('priced')?.costState).toBe('priced');
    expect(f.rendered()).toContain(price === 0 ? 'known fleet $0.00' : 'known fleet $0.500');
    expect(f.rendered()).not.toContain('partial');
    expect(f.rendered()).not.toContain('fleet unpriced');
  });

  test.each(['missing usage', 'unknown model', 'hosted'] as const)('known cost plus %s is labelled as only the known subtotal', missing => {
    const f = fixture({ agents: [agent('priced', { model: 'known', usage }), ...(missing === 'hosted' ? [] : [agent('unknown', missing === 'unknown model' ? { model: 'unmapped', usage } : {})])],
      hosted: missing === 'hosted' ? [hosted()] : [], prices: { known: 0.5 } });
    expect(f.rendered()).toContain('known fleet $0.500');
  });

  test('a known zero plus an unknown actor is only a known subtotal', () => {
    const f = fixture({ agents: [agent('free', { model: 'known', usage }), agent('unknown')], prices: { known: 0 } });
    expect(f.rendered()).toContain('known fleet $0.00');
  });

  test('contract rollups and owner stay excluded; unknown observed and schedule costs do not become dollars', () => {
    const f = fixture({ contracts: [contractFixture({ usage: { ...usage, toolCallCount: 0, costUsd: 100, costState: 'priced' } })], agents: [agent('owner', { contractRole: 'owner', contractId: 'contract-1', model: 'known', usage }),
      agent('worker', { contractRole: 'unit', contractId: 'contract-1', contractUnitId: 'u1', model: 'known', usage })],
      observed: [observed()], schedules: true, prices: { known: 0.5 } });
    expect(f.rendered()).toContain('known fleet $0.500');
    expect(f.rendered()).not.toContain('partial');
  });
});

describe('Agents modal compact header preserves the qualified amount', () => {
  test.each([80, 100])('running, waiting and session-cost facts keep known fleet visible at %s columns', width => {
    const f = fixture({ agents: [agent('priced', { model: 'known', usage }), agent('missing-1'), agent('missing-2')],
      hosted: [{ ...hosted(), state: 'awaiting-approval' }], prices: { known: 0.931 }, sessionCost: () => 1.25 });
    const output = f.rendered(width, 30);
    expect(output).toContain('4 running');
    expect(output).toContain('1 waiting on you');
    expect(output).toContain('known fleet $0.931');
    expect(f.rendered(160)).toContain('known fleet $0.931 · you $1.250');
  });
});

describe('Agents modal footer follows actual selection capabilities', () => {
  test('observed rows retain their liveness meaning and never advertise or execute stop', () => {
    const f = fixture({ observed: [observed()] });
    const output = f.rendered();
    expect(f.registry.getNode('observed:88')?.capabilities.killable).toBe(false);
    expect(output).toContain('CPU silence is not proof of idleness');
    expect(output).toContain('not offered');
    expect(output).not.toMatch(/ctrl\+x\s+stop/);
    expect(output).not.toMatch(/ s  steer/);
    for (const token of [key('x', true), text('x'), text('K')]) f.host.handleToken(token);
    expect(f.host.depth).toBe(1);
    expect(f.cancelled).toEqual([]);
  });

  test('an empty selection never advertises stop or discard', () => {
    const f = fixture();
    expect(f.rendered()).not.toMatch(/ctrl\+x\s+stop/);
    expect(f.rendered()).not.toContain('discard worktree');
  });

  test('live stop still asks, Enter and Escape cancel, and only confirmation cascades', async () => {
    const f = fixture({ agents: [agent('parent'), agent('child', { parentAgentId: 'parent' })] });
    expect(f.rendered()).toMatch(/ctrl\+x\s+stop/);
    for (const cancel of ['enter', 'escape']) {
      f.host.handleToken(key('x', true));
      expect(f.host.top()?.name).toBe('confirm');
      expect(f.cancelled).toEqual([]);
      if (cancel === 'escape') f.host.escape(); else f.host.handleToken(key('enter'));
      await flush();
      expect(f.cancelled).toEqual([]);
    }
    f.host.handleToken(key('x', true));
    f.host.handleToken(key('x', true));
    await flush();
    expect([...f.cancelled].sort()).toEqual(['child', 'parent']);
    expect(f.rendered()).toContain('stopping');
    f.host.escape();
    expect(f.cancelled).toHaveLength(2);
  });

  test('terminal root worktree hint reaches the actual modal and D retains confirmation', async () => {
    const f = fixture({ contracts: [contractFixture({ worktreePath: '/synthetic/owned' })] });
    expect(f.rendered()).toMatch(/D\s+discard worktree/);
    expect(f.rendered()).not.toMatch(/ctrl\+x\s+stop/);
    f.host.handleToken(text('D'));
    expect(f.host.top()?.name).toBe('confirm');
    expect(f.discarded).toEqual([]);
    f.host.escape(); await flush();
    expect(f.discarded).toEqual([]);
    f.host.handleToken(text('D'));
    f.host.handleToken(text('y')); await flush();
    expect(f.discarded).toEqual(['/synthetic/owned']);
  });

  test.each(['missing path', 'live root', 'group', 'unit', 'absent acts'] as const)('%s does not advertise discard or broaden D', selection => {
    const contract = contractFixture({ ...(selection === 'missing path' ? {} : { worktreePath: '/synthetic/owned' }),
      ...(selection === 'live root' ? { status: 'running' as const, completedAt: undefined } : {}) });
    const f = fixture({ contracts: [contract], acts: selection !== 'absent acts' });
    if (selection === 'unit' || selection === 'group') f.modal.reveal({ id: `${selection}:contract-1:${selection === 'unit' ? 'u1' : 'g1'}` });
    expect(f.rendered()).not.toContain('discard worktree');
    f.host.handleToken(text('D'));
    expect(f.host.depth).toBe(1);
    expect(f.discarded).toEqual([]);
  });

  test('a changed terminal root loses its hint and pending discard cannot target the new path', async () => {
    const f = fixture({ contracts: [contractFixture({ worktreePath: '/synthetic/old' })] });
    f.host.handleToken(text('D'));
    f.replace([contractFixture({ status: 'running', completedAt: undefined, worktreePath: '/synthetic/new' })]);
    f.host.handleToken(text('y')); await flush();
    expect(f.discarded).toEqual([]);
    expect(f.rendered()).not.toContain('discard worktree');
  });

  test('terminal contract full view has no stop or list-only discard affordance', () => {
    const f = fixture({ contracts: [contractFixture({ worktreePath: '/synthetic/owned' })] });
    f.host.handleToken(key('enter'));
    expect(f.modal.tabs.activeTabIndex).toBe(1);
    expect(f.rendered()).not.toMatch(/ctrl\+x\s+stop/);
    expect(f.rendered()).not.toContain('discard worktree');
    f.host.handleToken(key('x', true));
    expect(f.host.depth).toBe(1);
    expect(f.cancelled).toEqual([]);
    f.host.escape();
    expect(f.rendered()).toMatch(/D\s+discard worktree/);
  });

  test('full-view hints follow the active tab, not a different list selection', () => {
    const f = fixture({ contracts: [contractFixture({ id: 'live', status: 'running', completedAt: undefined }), contractFixture({ id: 'done' })] });
    f.modal.reveal({ id: 'contract:live' }); f.host.handleToken(key('enter'));
    expect(f.rendered()).toMatch(/ctrl\+x\s+stop \(asks first\)/);
    f.host.escape(); f.modal.reveal({ id: 'contract:done' }); f.host.handleToken(key('enter'));
    expect(f.rendered()).not.toMatch(/ctrl\+x\s+stop/);
    f.host.handleToken(text('['));
    expect(f.modal.selectedId).toBe('contract:done');
    expect(f.rendered()).toMatch(/ctrl\+x\s+stop \(asks first\)/);
  });

  test('pause/resume controls still follow registry state and use the same tokens', () => {
    const f = fixture({ schedules: true });
    expect(f.rendered()).toMatch(/p\s+pause/);
    f.host.handleToken(text('p'));
    expect(f.scheduleCalls).toEqual(['pause']);
    expect(f.rendered()).toMatch(/p\s+resume/);
    f.host.handleToken(text('p'));
    expect(f.scheduleCalls).toEqual(['pause', 'resume']);
    expect(f.rendered()).toMatch(/p\s+pause/);
  });

  test('filtering, archive switching and back retain their public-token paths', () => {
    const f = fixture({ contracts: [contractFixture({ worktreePath: '/synthetic/owned' })] });
    f.host.handleToken(text('/'));
    expect(f.rendered()).toContain('stop filtering');
    expect(f.rendered()).not.toContain('discard worktree');
    f.host.escape();
    expect(f.rendered()).toContain('discard worktree');
    f.host.handleToken(text('v'));
    expect(f.modal.view).toBe('archived');
    expect(f.rendered()).not.toContain('discard worktree');
    f.host.handleToken(text('v'));
    expect(f.rendered()).toContain('discard worktree');
  });

  test.each([40, 60, 80, 120, 160])('honest costs and action hints fit a %s-column renderer', width => {
    const f = fixture({ contracts: [contractFixture({ worktreePath: '/synthetic/owned' })], agents: [agent('known', { model: 'known', usage }), agent('unknown')], prices: { known: 0.5 } });
    f.modal.reveal({ id: 'contract:contract-1' });
    const layer = f.render(width, 55);
    for (const line of layer.lines) {
      expect(line.length).toBeLessThanOrEqual(width);
      expect(getDisplayWidth(line.map(cell => cell.char).join(''))).toBeLessThanOrEqual(width);
    }
    expect(f.rendered(width)).toContain('discard worktree');
    if (width >= 120) expect(f.rendered(width)).toContain('known fleet $0.500');
  });
});
