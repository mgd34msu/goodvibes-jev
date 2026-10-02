import { afterEach, describe, expect, test } from 'bun:test';
import { WorkPlanStore, type WorkPlanLinkTargets } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { createProcessRegistry, contractNodeId, type ProcessRegistryDeps } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { AgentsModal } from '../../input/agents-modal.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerAcpRuntimeCommands } from '../../input/commands/acp-runtime.ts';
import { ConfigModal } from '../../input/config-modal.ts';
import { handleConfigModalToken } from '../../input/handler-modal-routes.ts';
import type { ViewTarget } from '../../input/views.ts';
import { createFleetReadModel } from '../../views/fleet-read-model.ts';
import { createWorkPlanModalSurface } from '../../views/modals/work-plan-modal.ts';
import { contractFixture } from '../helpers/contract-work-tree-fixtures.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture(linked?: WorkPlanLinkTargets, contractId = 'contract-1') {
  const options = { homeDirectory: makeProjectTempDir('work-plan-contract-links'), surfaceRoot: 'tui', projectId: 'links', projectRoot: '/synthetic/project' };
  const writer = new WorkPlanStore(options);
  const item = writer.addItem('Work to inspect', { linked });
  // Reopen the public store: exercise persisted link normalization, not a local shape.
  const store = new WorkPlanStore(options);
  const contract = contractFixture({ id: contractId });
  let contracts = [contract];
  const registry = createProcessRegistry({
    agentManager: {
      list: () => [{ id: 'agent-1', task: 'Independent agent', template: 'engineer', tools: [], status: 'running', startedAt: 1000, toolCallCount: 0, orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only' }],
      cancel: () => false,
    },
    contractRunner: { list: () => contracts, cancel: () => false },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
    },
    now: () => 2500,
    timers: { setInterval: () => 0, clearInterval: () => {} },
  } satisfies ProcessRegistryDeps);
  cleanup.push(() => registry.dispose());
  const agents = new AgentsModal({
    readModel: createFleetReadModel(registry),
    actions: {
      interrupt: () => false, resume: () => false, kill: () => [], getConversationSnapshot: () => [],
      resolveSessionLogPath: () => { throw new Error('Deep linking must not read transcripts'); },
      steer: () => ({ queued: false, reason: 'unused' }),
    },
    requestRender: () => {}, tickMs: 0,
  });
  cleanup.push(() => agents.onClose());
  const surface = createWorkPlanModalSurface({ workPlanStore: store });
  const modal = new ConfigModal();
  modal.open(surface);
  modal.syncStructure();
  cleanup.push(() => modal.close());
  const commands = new CommandRegistry();
  registerAcpRuntimeCommands(commands);
  const opened: Array<{ target: ViewTarget | undefined; revealed: boolean }> = [];
  const dispatched: Array<[string, string[]]> = [];
  const pending: Promise<boolean>[] = [];
  const ctx: CommandContext = {
    session: { conversationManager: {} as never, runtime: { model: '', provider: '', debugMode: false, systemPrompt: '', reasoningEffort: '', sessionId: 'links' } },
    provider: { providerRegistry: {} as never }, workspace: { workPlanStore: store },
    platform: { config: {} as never, configManager: {} as never }, ops: {},
    extensions: { toolRegistry: {} as never, mcpRegistry: {} as never },
    print: () => {}, renderRequest: () => {}, exit: () => {},
    openAgents: ({ target } = {}) => { opened.push({ target, revealed: target ? agents.reveal(target) : false }); },
    executeCommand: (name, args) => {
      dispatched.push([name, args]);
      const result = commands.execute(name, args, ctx);
      pending.push(result);
      return result;
    },
  };
  const state = { configModal: modal, commandContext: ctx, requestRender: () => {}, handleEscape: () => modal.close() };
  const text = async (value: string) => {
    expect(handleConfigModalToken(state, { type: 'text', value })).toBe(true);
    await Promise.all(pending.splice(0));
  };
  return { item, store, registry, surface, modal, agents, opened, dispatched, text, removeContract: () => { contracts = []; } };
}

describe('Work Plan public store to Agents contract deep link', () => {
  test('persisted public links render the contract alongside agent, task and session details', () => {
    const linked: WorkPlanLinkTargets = { contractId: 'contract-1', agentId: 'agent-1', taskId: 'task-1', sessionId: 'queue-session-1' };
    const f = fixture(linked);
    expect(f.store.getActivePlan().items[0]?.linked).toEqual(linked);
    const label = f.surface.buildView().tabs[0]!.rows[0]!.label;
    for (const detail of ['contract:contract-1', 'agent:agent-1', 'task:task-1', 'session:queue-session-1']) expect(label).toContain(detail);
  });

  test('w traverses the actual command parser and registry to reveal the namespaced contract node', async () => {
    const f = fixture({ contractId: 'contract-1' });
    const before = f.store.getActivePlan();
    expect(f.registry.getNode(contractNodeId('contract-1'))?.kind).toBe('contract');
    await f.text('w');
    expect(f.dispatched).toEqual([['agents', ['--target', 'contract:contract-1:contract']]]);
    expect(f.opened).toEqual([{ target: { id: 'contract:contract-1', kind: 'contract' }, revealed: true }]);
    expect(f.agents.selectedId).toBe('contract:contract-1');
    expect(f.agents.selectedNode()?.kind).toBe('contract');
    expect(f.agents.status).toBeNull();
    expect(f.modal.getFilterQuery()).toBe('');
    expect(f.store.getActivePlan()).toEqual(before);
  });

  test('a contract ID containing a namespace survives the complete boundary', async () => {
    const f = fixture({ contractId: 'team:job-1' }, 'team:job-1');
    await f.text('w');
    expect(f.dispatched).toEqual([['agents', ['--target', 'contract:team:job-1:contract']]]);
    expect(f.opened).toEqual([{ target: { id: 'contract:team:job-1', kind: 'contract' }, revealed: true }]);
    expect(f.agents.selectedId).toBe(contractNodeId('team:job-1'));
  });

  test('i still reveals the actual agent with the same store and command boundary', async () => {
    const f = fixture({ contractId: 'contract-1', agentId: 'agent-1' });
    await f.text('i');
    expect(f.dispatched).toEqual([['agents', ['--target', 'agent-1:agent']]]);
    expect(f.opened).toEqual([{ target: { id: 'agent-1', kind: 'agent' }, revealed: true }]);
    expect(f.agents.selectedId).toBe('agent-1');
  });

  test('w is disabled without a contract link and remains ordinary filter text', async () => {
    const f = fixture({ agentId: 'agent-1', taskId: 'task-1', sessionId: 'queue-session-1' });
    expect(f.modal.resolveAction('w')).toBeNull();
    await f.text('w');
    expect(f.modal.getFilterQuery()).toBe('w');
    expect(f.dispatched).toEqual([]);
    expect(f.opened).toEqual([]);
    expect(f.modal.getSelectedRowId()).toBe(f.item.id);
  });

  test('w respects the selected row and filter text capture', async () => {
    const f = fixture({ agentId: 'agent-1' });
    const linked = f.store.addItem('Other work', { linked: { contractId: 'contract-1' } });
    await f.text('r'); // reload from the real store
    f.modal.jumpToRow('items', linked.id);
    await f.text('w');
    expect(f.opened[0]?.revealed).toBe(true);
    expect(f.modal.getSelectedRowId()).toBe(linked.id);
    await f.text('o');
    await f.text('w');
    expect(f.modal.getFilterQuery()).toBe('ow');
    expect(f.dispatched).toHaveLength(1);
  });

  test('close and reopen retain contract navigation without mutating the plan', async () => {
    const f = fixture({ contractId: 'contract-1' });
    const before = f.store.getActivePlan();
    await f.text('w');
    f.modal.close();
    f.modal.open(f.surface);
    f.modal.syncStructure();
    await f.text('w');
    expect(f.opened.map((entry) => entry.revealed)).toEqual([true, true]);
    expect(f.agents.selectedId).toBe('contract:contract-1');
    expect(f.store.getActivePlan()).toEqual(before);
  });

  test('refresh disables a removed link and an empty plan has no w action', async () => {
    const f = fixture({ contractId: 'contract-1' });
    expect(f.modal.resolveAction('w')).not.toBeNull();
    f.store.updateItem(f.item.id, { linked: null });
    await f.text('r');
    expect(f.modal.resolveAction('w')).toBeNull();
    f.store.removeItem(f.item.id);
    await f.text('r');
    expect(f.modal.getSelectedRow()).toBeNull();
    expect(f.modal.resolveAction('w')).toBeNull();
    await f.text('w');
    expect(f.dispatched).toEqual([]);
    expect(f.opened).toEqual([]);
  });

  test('a disappeared contract reports the exact unavailable node rather than selecting another process', async () => {
    const f = fixture({ contractId: 'contract-1' });
    f.removeContract();
    await f.text('w');
    expect(f.opened).toEqual([{ target: { id: 'contract:contract-1', kind: 'contract' }, revealed: false }]);
    expect(f.agents.selectedId).toBeNull();
    expect(f.agents.status?.text).toBe('contract:contract-1 is no longer running here.');
  });
});
