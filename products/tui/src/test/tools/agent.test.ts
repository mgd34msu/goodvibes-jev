import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAgentTool, AgentManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { AgentMessageBus, ArchetypeLoader } from '@goodvibes-jev/engine/sdk/platform/agents';
import { ContractStore, createContractRunner } from '@goodvibes-jev/engine/sdk/platform/contract';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import type { AgentEvent } from '@goodvibes-jev/engine/sdk/events';
import { configGetStub, configGetCategoryStub } from '../helpers/config-manager-stub.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** Actual public tool/manager/buses/store/runner; only execution is synthetic. */
function makeAgentHarness() {
  const projectRoot = makeProjectTempDir('gv-agent-public-lifecycle');
  const configManager = {
    get: configGetStub({ 'fleet.maxSize': 8, 'agents.maxActive': 8, 'orchestration.maxDepth': 1, 'orchestration.recursionEnabled': true }),
    getCategory: configGetCategoryStub({ contract: { isolation: 'shared', gates: [] } }),
  };
  const runtimeBus = new RuntimeEventBus();
  const messageBus = new AgentMessageBus();
  messageBus.setRuntimeBus(runtimeBus);
  const archetypeLoader = new ArchetypeLoader();
  const releases = new Map<string, () => void>();
  const running: Promise<void>[] = [];
  const manager = new AgentManager({
    messageBus, configManager, archetypeLoader,
    executor: {
      runAgent(record) {
        record.status = 'running';
        const pending = new Promise<void>((resolve) => { releases.set(record.id, resolve); });
        running.push(pending);
        return pending;
      },
    },
  });
  manager.setRuntimeBus(runtimeBus);
  const store = new ContractStore({ projectRoot, sweepIntervalMs: 0 });
  const unexpectedPlanning = (): never => { throw new Error('This ordinary-agent fixture must not execute contract planning'); };
  const contractRunner = createContractRunner({
    agentManager: manager, messageBus, runtimeBus, configManager, projectRoot, store,
    routeSelector: async () => unexpectedPlanning(),
    decompositionRunner: { run: async () => unexpectedPlanning() },
    createEngine: unexpectedPlanning,
    fleetCapacity: () => ({ active: manager.list().filter((agent) => agent.status === 'running').length, maxSize: 8, capKey: 'fleet.maxSize' }),
    priceUsage: () => null, priceProvenance: () => null,
  });
  manager.setContractRunner(contractRunner);
  const agentTool = createAgentTool({ manager, messageBus, configManager, archetypeLoader, contractRunner, projectRoot, resolveSessionId: () => 'synthetic-session' });
  return { agentTool, manager, messageBus, runtimeBus, contractRunner, async dispose() {
    for (const record of manager.list()) manager.cancel(record.id);
    for (const release of releases.values()) release();
    await Promise.all(running);
    contractRunner.dispose();
    store.dispose();
  } };
}

let harness: ReturnType<typeof makeAgentHarness>;
beforeEach(() => { harness = makeAgentHarness(); });
afterEach(async () => { await harness.dispose(); });

async function runAgent(args: Record<string, unknown>) {
  const result = await harness.agentTool.execute(args);
  expect(result.success).toBe(true);
  if (!result.success || !result.output) throw new Error(result.error ?? 'Agent tool produced no result');
  return JSON.parse(result.output) as Record<string, unknown>;
}
function spawn(task: string, extra: Record<string, unknown> = {}) {
  // The public API now requires this explicit flag for ordinary direct agents;
  // default spawn goes through the contract runner and is covered in the SDK.
  return runAgent({ mode: 'spawn', task, outsideContract: true, ...extra });
}

describe('ordinary agent lifecycle through the public tool', () => {
  test('spawn and get preserve the task, template, and direct execution state', async () => {
    const started = await spawn('Inspect package metadata', { template: 'researcher' });
    const record = await runAgent({ mode: 'get', agentId: started.agentId });
    expect(record).toMatchObject({ id: started.agentId, task: 'Inspect package metadata', template: 'researcher', reviewMode: 'none', status: 'running', contractId: null });
    expect(harness.contractRunner.list({ includeTerminal: true })).toEqual([]);
  });

  test('a direct reviewer remains a reviewer instead of being rewritten into a removed owner role', async () => {
    const started = await spawn('Review a synthetic change', { template: 'reviewer' });
    const record = await runAgent({ mode: 'get', agentId: started.agentId });
    expect(record.template).toBe('reviewer');
    expect(record.reviewMode).toBe('none');
    expect(record.contractId).toBeNull();
  });

  test('batch spawn preserves each requested tool restriction', async () => {
    const result = await runAgent({ mode: 'batch-spawn', outsideContract: true, tasks: [
      { task: 'Inspect package metadata', template: 'engineer', tools: ['read', 'find'], restrictTools: true },
      { task: 'Inspect tests', template: 'engineer', tools: ['read'], restrictTools: true },
    ] });
    const agents = result.agents as Array<{ id: string }>;
    expect(agents).toHaveLength(2);
    expect((await runAgent({ mode: 'get', agentId: agents[0]!.id })).tools).toEqual(['read', 'find']);
    expect((await runAgent({ mode: 'get', agentId: agents[1]!.id })).tools).toEqual(['read']);
    expect(harness.contractRunner.list({ includeTerminal: true })).toEqual([]);
  });

  test('a child inherits the parent capability ceiling and keeps its execution requirements', async () => {
    const parent = await spawn('Inspect the project', { tools: ['read', 'find'], restrictTools: true });
    const child = await spawn('Inspect a subdirectory', {
      parentAgentId: parent.agentId, tools: ['read', 'exec', 'find'], restrictTools: true,
      successCriteria: ['answer the question'], requiredEvidence: ['file list'], writeScope: ['src/runtime'],
      executionProtocol: 'gather-plan-apply', communicationLane: 'parent-only',
    });
    expect(child).toMatchObject({ tools: ['read', 'find'], capabilityCeilingTools: ['read', 'find'], parentAgentId: parent.agentId,
      successCriteria: ['answer the question'], requiredEvidence: ['file list'], writeScope: ['src/runtime'],
      executionProtocol: 'gather-plan-apply', reviewMode: 'none', communicationLane: 'parent-only' });
  });

  test('the actual AGENT_SPAWNING event carries the execution contract', async () => {
    const events: Array<Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>> = [];
    const unsubscribe = harness.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>>('AGENT_SPAWNING', ({ payload }) => { events.push(payload); });
    try {
      const started = await spawn('Inspect the target', { cohort: 'alpha', tools: ['read', 'find'], restrictTools: true,
        successCriteria: ['answer the question'], requiredEvidence: ['file list'], writeScope: ['src/core'], communicationLane: 'parent-only' });
      await Promise.resolve();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ agentId: started.agentId, task: 'Inspect the target', taskContract: {
        allowedTools: ['read', 'find'], capabilityCeiling: ['read', 'find'], successCriteria: ['answer the question'],
        requiredEvidence: ['file list'], writeScope: ['src/core'], executionProtocol: 'gather-plan-apply', reviewMode: 'none',
        inheritsParentConstraints: false, communicationLane: 'parent-only',
      } });
    } finally { unsubscribe(); }
  });

  test('list reads actual manager records and filters cohorts', async () => {
    const first = await spawn('Inspect A', { cohort: 'alpha' });
    await spawn('Inspect B', { cohort: 'beta' });
    expect((await runAgent({ mode: 'list' })).count).toBe(2);
    const filtered = await runAgent({ mode: 'list', cohort: 'alpha' });
    expect(filtered.count).toBe(1);
    expect(filtered.agents).toMatchObject([{ id: first.agentId, task: 'Inspect A', cohort: 'alpha' }]);
  });

  test('cancel aborts a running agent and status reports cancellation', async () => {
    const started = await spawn('Wait for a synthetic result');
    const signal = harness.manager.getCancellationSignal(started.agentId as string)!;
    expect(signal.aborted).toBe(false);
    expect(await runAgent({ mode: 'cancel', agentId: started.agentId })).toMatchObject({ status: 'cancelled' });
    expect(signal.aborted).toBe(true);
    expect(await runAgent({ mode: 'status', agentId: started.agentId })).toMatchObject({ status: 'cancelled' });
    expect(await runAgent({ mode: 'wait', agentId: started.agentId })).toMatchObject({ status: 'cancelled', timedOut: false });
  });

  test('message reaches the actual message bus and is visible through get', async () => {
    const started = await spawn('Wait for a question');
    const reply = await runAgent({ mode: 'message', agentId: started.agentId, message: 'Inspect the second fixture', kind: 'directive' });
    expect(reply).toMatchObject({ sent: true, content: 'Inspect the second fixture', kind: 'directive' });
    expect(harness.messageBus.getMessages(started.agentId as string)).toMatchObject([{ from: 'orchestrator', content: 'Inspect the second fixture' }]);
    expect((await runAgent({ mode: 'get', agentId: started.agentId, detail: 'messages' })).recentMessages).toMatchObject([{ from: 'orchestrator', content: 'Inspect the second fixture' }]);
  });

  test('invalid requests fail without creating agents', async () => {
    for (const request of [
      { mode: 'spawn', task: ' ', outsideContract: true }, { mode: 'get', agentId: 'unknown' },
      { mode: 'cancel', agentId: 'unknown' }, { mode: 'message', agentId: 'unknown', message: 'hello' },
      { mode: 'invalid' },
    ]) {
      expect((await harness.agentTool.execute(request)).success).toBe(false);
    }
    expect(harness.manager.list()).toEqual([]);
  });
});
