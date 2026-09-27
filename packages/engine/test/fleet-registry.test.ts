/**
 * Live process registry (packages/sdk/src/platform/runtime/fleet/).
 *
 * Covers the brief's test matrix with stub managers:
 *  1. Per-kind adapter mapping (agent/contract/group/unit/workflow/trigger/schedule/watcher/background-process).
 *  2. Fine-grained agent state via REAL runtime-bus emitters (no synthetic event shapes).
 *  3. Stalled derivation with an injected now().
 *  4. awaiting-approval cross-reference via approvalBroker.listApprovals().
 *  5. Cost honesty (unknown model → costUsd null + 'unpriced'; never throws).
 *  6. contract → group → unit → agent edge/nesting integrity (no dangling parentIds).
 *  7. subscribe/tick coalescing, unref, dispose.
 *  8. Control dispatch (interrupt/kill routing incl. contract, group and unit kills).
 * 10. Empty fleet → empty snapshot, no throw.
 */
import { describe, expect, test } from 'bun:test';
import { createProcessRegistry } from '../sdk/src/platform/runtime/fleet/index.js';
import type {
  ProcessNode,
  ProcessRegistry,
} from '../sdk/src/platform/runtime/fleet/index.js';
import type { ProcessRegistryDeps, RegistryTimers } from '../sdk/src/platform/runtime/fleet/registry.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import type { Contract, ContractView } from '../sdk/src/platform/contract/types.js';
import { makeContract, makeGroup, makeUnit } from './contract/fixtures.js';
import type { BackgroundProcess } from '../sdk/src/platform/tools/shared/process-manager.js';
import type { WatcherRecord } from '../sdk/src/platform/runtime/store/domains/watchers.js';
import type {
  ScheduleEntry,
  TriggerDefinition,
  WorkflowInstance,
} from '../sdk/src/platform/tools/workflow/index.js';
import type { SharedApprovalRecord } from '../sdk/src/platform/control-plane/approval-broker.js';
import type { SharedSessionRecord } from '../sdk/src/platform/control-plane/session-types.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import {
  emitAgentAwaitingMessage,
  emitAgentAwaitingTool,
  emitAgentCompleted,
  emitAgentFailed,
  emitAgentProgress,
  emitAgentStreamDelta,
} from '../sdk/src/platform/runtime/emitters/agents.js';
import { emitStreamRetry } from '../sdk/src/platform/runtime/emitters/turn.js';
import type { EmitterContext } from '../sdk/src/platform/runtime/emitters/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const T0 = 1_750_000_000_000;

function makeAgent(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    task: 'do work',
    template: 'engineer',
    tools: [],
    status: 'running',
    startedAt: T0,
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

/** A running contract with one group g1 holding the given units (default: one unit u1). */
function makeRunningContract(overrides: Partial<Contract> & { id: string }): Contract {
  return makeContract({ createdAt: T0, ...overrides });
}

/**
 * The runner's list and cancel over the given contracts. A cancel ends the
 * contract (its view reads cancelled afterwards, as the runner's does);
 * `cancelled` records each accepted cancel.
 */
function runnerOf(contracts: readonly Contract[], cancelled: string[] = []): ProcessRegistryDeps['contractRunner'] {
  return {
    list: () => [...contracts] as ContractView[],
    cancel: (contractId: string) => {
      const contract = contracts.find((candidate) => candidate.id === contractId);
      if (!contract || cancelled.includes(contractId) || contract.status === 'cancelled') return false;
      cancelled.push(contractId);
      contract.status = 'cancelled';
      contract.completedAt = T0 + 1;
      return true;
    },
  };
}

function makeWatcher(overrides: Partial<WatcherRecord> & { id: string }): WatcherRecord {
  return {
    kind: 'polling',
    label: 'my watcher',
    state: 'running',
    source: {
      id: 'src-1',
      kind: 'watcher',
      label: 'src',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
      metadata: {},
    },
    metadata: {},
    ...overrides,
  };
}

function makeBackgroundProcess(overrides: Partial<BackgroundProcess> & { id: string }): BackgroundProcess {
  return {
    pid: 4242,
    cmd: 'sleep 999',
    startTime: T0,
    stdout: [],
    stderr: [],
    exitCode: null,
    done: false,
    killDeadline: null,
    ...overrides,
  };
}

function makeApproval(overrides: Partial<SharedApprovalRecord> & { id: string }): SharedApprovalRecord {
  return {
    callId: 'call-1',
    status: 'pending',
    request: {
      callId: 'call-1',
      tool: 'exec',
      args: {},
      category: 'execute',
      analysis: { classification: 'shell', riskLevel: 'medium', summary: 'run command', reasons: [] },
    },
    createdAt: T0,
    updatedAt: T0,
    metadata: {},
    audit: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<SharedSessionRecord> & { id: string }): SharedSessionRecord {
  return {
    kind: 'tui',
    project: 'unknown',
    title: 'session',
    status: 'active',
    createdAt: T0,
    updatedAt: T0,
    lastActivityAt: T0,
    messageCount: 0,
    pendingInputCount: 0,
    routeIds: [],
    surfaceKinds: [],
    participants: [],
    metadata: {},
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ProcessRegistryDeps> = {}): ProcessRegistryDeps {
  return {
    agentManager: { list: () => [], cancel: () => false },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
    },
    now: () => T0 + 5_000,
    ...overrides,
  };
}

function nodeById(registry: ProcessRegistry, id: string): ProcessNode {
  const node = registry.getNode(id);
  if (!node) throw new Error(`node not found: ${id}`);
  return node;
}

const emitterCtx: EmitterContext = { sessionId: 'sess-1', traceId: 'trace-1', source: 'test' };

/** RuntimeEventBus dispatches listeners via queueMicrotask, flush before asserting. */
function flushBus(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── 10. Empty fleet ───────────────────────────────────────────────────────────

describe('fleet registry: empty fleet', () => {
  test('query() over empty managers returns an empty snapshot, no throw', () => {
    const registry = createProcessRegistry(makeDeps());
    const snapshot = registry.query();
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.capturedAt).toBe(T0 + 5_000);
    expect(registry.getNode('nope')).toBeNull();
    registry.dispose();
  });
});

// ── 1. Adapter mapping ────────────────────────────────────────────────────────

describe('fleet registry: adapter mapping', () => {
  test('agent node: usage passthrough, coarse status mapping, capabilities', () => {
    const agent = makeAgent({
      id: 'ag-1',
      status: 'completed',
      completedAt: T0 + 2_000,
      model: 'claude-fable-5',
      provider: 'anthropic',
      toolCallCount: 7,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        llmCallCount: 3,
        turnCount: 2,
      },
    });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
    }));
    const node = nodeById(registry, 'ag-1');
    expect(node.kind).toBe('agent');
    expect(node.state).toBe('done');
    expect(node.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: undefined,
      llmCallCount: 3,
      turnCount: 2,
      toolCallCount: 7,
    });
    expect(node.model).toBe('claude-fable-5');
    expect(node.provider).toBe('anthropic');
    expect(node.elapsedMs).toBe(2_000);
    expect(node.capabilities).toEqual({ interruptible: false, killable: false, pausable: false, resumable: false, steerable: false });
    expect(node.sessionRef?.agentId).toBe('ag-1');
    registry.dispose();
  });

  test('agent coarse statuses: pending→queued, cancelled→killed, failed→failed; live agents are killable', () => {
    const agents = [
      makeAgent({ id: 'a-pending', status: 'pending' }),
      makeAgent({ id: 'a-cancelled', status: 'cancelled' }),
      makeAgent({ id: 'a-failed', status: 'failed' }),
      makeAgent({ id: 'a-running', status: 'running' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
    }));
    expect(nodeById(registry, 'a-pending').state).toBe('queued');
    expect(nodeById(registry, 'a-cancelled').state).toBe('killed');
    expect(nodeById(registry, 'a-failed').state).toBe('failed');
    // No runtimeBus → coarse fallback for running (never crash, never stalled).
    expect(nodeById(registry, 'a-running').state).toBe('executing-tool');
    expect(nodeById(registry, 'a-running').capabilities.killable).toBe(true);
    expect(nodeById(registry, 'a-pending').capabilities.interruptible).toBe(true);
    registry.dispose();
  });

  // terminationKind splits the single 'cancelled' status into
  // two display states without touching `status` itself.
  test('cancelled agent: terminationKind splits killed vs interrupted; missing/unknown kind defaults to killed', () => {
    const agents = [
      makeAgent({ id: 'a-kill', status: 'cancelled', terminationKind: 'kill' }),
      makeAgent({ id: 'a-interrupt', status: 'cancelled', terminationKind: 'interrupt' }),
      // Records cancelled before terminationKind existed (or via the
      // single-arg cancel(id) call, which defaults to 'kill') have no field.
      makeAgent({ id: 'a-legacy', status: 'cancelled' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
    }));
    expect(nodeById(registry, 'a-kill').state).toBe('killed');
    expect(nodeById(registry, 'a-interrupt').state).toBe('interrupted');
    expect(nodeById(registry, 'a-legacy').state).toBe('killed');
    registry.dispose();
  });

  test('parentId precedence: contractUnitId > contractId > parentNodeId(resolved) > parentAgentId', () => {
    const contract = makeRunningContract({ id: 'ctr-1', ownerAgentId: 'owner-1', plannerAgentIds: ['a-plan'], units: [makeUnit({ id: 'u1', agentIds: ['a-unit'], activeAgentId: 'a-unit' })] });
    const agents = [
      makeAgent({ id: 'owner-1', contractId: 'ctr-1', contractRole: 'owner' }),
      makeAgent({ id: 'a-plan', contractId: 'ctr-1', contractRole: 'planner' }),
      makeAgent({ id: 'a-unit', contractId: 'ctr-1', contractRole: 'unit', contractUnitId: 'u1' }),
      makeAgent({ id: 'a-orch-parent', orchestrationNodeId: 'node-9' }),
      makeAgent({ id: 'a-orch-child', parentNodeId: 'node-9' }),
      makeAgent({ id: 'a-plain-child', parentAgentId: 'a-orch-parent' }),
      makeAgent({ id: 'a-dangling', contractId: 'missing-contract', contractUnitId: 'u1', parentAgentId: 'a-orch-parent' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      contractRunner: runnerOf([contract]),
    }));
    expect(nodeById(registry, 'a-unit').parentId).toBe('unit:ctr-1:u1');
    expect(nodeById(registry, 'a-plan').parentId).toBe('contract:ctr-1');
    expect(nodeById(registry, 'owner-1').parentId).toBe('contract:ctr-1');
    expect(nodeById(registry, 'a-orch-child').parentId).toBe('a-orch-parent');
    expect(nodeById(registry, 'a-plain-child').parentId).toBe('a-orch-parent');
    // A contract id with no contract in the snapshot falls through to the next resolvable edge.
    expect(nodeById(registry, 'a-dangling').parentId).toBe('a-orch-parent');
    registry.dispose();
  });
  test('contract node: status map, group and unit children, usage/cost aggregation excludes owner', () => {
    const contract = makeRunningContract({
      id: 'ctr-2',
      status: 'judging',
      ownerAgentId: 'owner-2',
      groups: [makeGroup({ id: 'g1', unitIds: ['u1', 'u2'], status: 'running' })],
      units: [
        makeUnit({ id: 'u1', status: 'passed', agentIds: ['eng-1'] }),
        makeUnit({ id: 'u2', status: 'pending' }),
      ],
    });
    const usage = {
      inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0,
      llmCallCount: 1, turnCount: 1,
    };
    const agents = [
      // Owner usage mirrors the units at completion, must NOT be double-counted.
      makeAgent({ id: 'owner-2', contractId: 'ctr-2', contractRole: 'owner', usage: { ...usage }, toolCallCount: 5 }),
      makeAgent({ id: 'eng-1', contractId: 'ctr-2', contractRole: 'unit', contractUnitId: 'u1', status: 'completed', completedAt: T0 + 1_000, usage: { ...usage }, toolCallCount: 5, model: 'm1' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      contractRunner: runnerOf([contract]),
      priceUsage: () => 0.5,
    }));
    const contractNode = nodeById(registry, 'contract:ctr-2');
    expect(contractNode.kind).toBe('contract');
    expect(contractNode.state).toBe('executing-tool');
    expect(contractNode.currentActivity?.text).toBe('judging');
    expect(contractNode.usage?.inputTokens).toBe(1000); // eng-1 only, owner excluded
    expect(contractNode.costUsd).toBe(0.5);
    expect(contractNode.costState).toBe('priced');
    const group = nodeById(registry, 'group:ctr-2:g1');
    expect(group.kind).toBe('contract-group');
    expect(group.parentId).toBe('contract:ctr-2');
    const u1 = nodeById(registry, 'unit:ctr-2:u1');
    expect(u1.kind).toBe('contract-unit');
    expect(u1.parentId).toBe('group:ctr-2:g1');
    expect(u1.state).toBe('done');
    expect(nodeById(registry, 'unit:ctr-2:u2').state).toBe('queued');
    registry.dispose();
  });
  test('contract terminal and waiting states', () => {
    const contracts = [
      makeRunningContract({ id: 'ctr-passed', status: 'passed', completedAt: T0 + 100 }),
      makeRunningContract({ id: 'ctr-failed', status: 'failed', completedAt: T0 + 100 }),
      makeRunningContract({ id: 'ctr-cancelled', status: 'cancelled', completedAt: T0 + 100 }),
      makeRunningContract({ id: 'ctr-queued', status: 'queued' }),
      makeRunningContract({ id: 'ctr-owner', status: 'awaiting-owner' }),
    ];
    const registry = createProcessRegistry(makeDeps({ contractRunner: runnerOf(contracts) }));
    expect(nodeById(registry, 'contract:ctr-passed').state).toBe('done');
    expect(nodeById(registry, 'contract:ctr-passed').elapsedMs).toBe(100); // frozen at completedAt
    expect(nodeById(registry, 'contract:ctr-failed').state).toBe('failed');
    expect(nodeById(registry, 'contract:ctr-cancelled').state).toBe('killed');
    expect(nodeById(registry, 'contract:ctr-queued').state).toBe('queued');
    expect(nodeById(registry, 'contract:ctr-owner').state).toBe('idle');
    for (const id of ['contract:ctr-passed', 'contract:ctr-failed', 'contract:ctr-cancelled']) {
      expect(nodeById(registry, id).capabilities.killable).toBe(false);
    }
    registry.dispose();
  });
  test('workflow / trigger / schedule nodes', () => {
    const workflow: WorkflowInstance = {
      id: 'wf-1', definition: 'review-cycle', currentState: 'reviewing', task: 'wf task',
      startedAt: T0, transitions: 2, context: {},
    };
    const cancelled: WorkflowInstance = { ...workflow, id: 'wf-2', cancelled: true, completedAt: T0 + 50 };
    const trigger: TriggerDefinition = { id: 'trg-1', event: 'push', action: 'run tests', enabled: true };
    const schedule: ScheduleEntry = {
      name: 'nightly', interval: '1h', command: 'make build', enabled: false, lastRun: T0,
    };
    const registry = createProcessRegistry(makeDeps({
      workflow: {
        workflowManager: { list: () => [workflow, cancelled], cancel: () => false },
        triggerManager: { list: () => [trigger], remove: () => false, disable: () => false, enable: () => false },
        scheduleManager: { list: () => [schedule], remove: () => false, disable: () => false, enable: () => false },
      },
    }));
    const wfNode = nodeById(registry, 'wf-1');
    expect(wfNode.kind).toBe('workflow');
    expect(wfNode.state).toBe('executing-tool');
    expect(wfNode.currentActivity?.text).toBe('reviewing');
    expect(nodeById(registry, 'wf-2').state).toBe('killed');
    const trgNode = nodeById(registry, 'trg-1');
    expect(trgNode.kind).toBe('trigger');
    expect(trgNode.state).toBe('idle');
    expect(trgNode.capabilities.pausable).toBe(true);
    expect(trgNode.capabilities.resumable).toBe(false); // already armed, nothing to resume
    const schNode = nodeById(registry, 'schedule:nightly');
    expect(schNode.kind).toBe('schedule');
    // A disabled schedule entry is 'paused', NOT 'killed', the entry
    // still exists and ScheduleManager.enable() can re-arm it.
    expect(schNode.state).toBe('paused');
    expect(schNode.capabilities.resumable).toBe(true);
    expect(schNode.startedAt).toBe(T0);
    registry.dispose();
  });

  test('watcher nodes: running→idle, degraded→stalled, failed→failed, stopped→killed', () => {
    const watchers = [
      makeWatcher({ id: 'w-run', state: 'running' }),
      makeWatcher({ id: 'w-deg', state: 'degraded', degradedReason: 'heartbeat stale by 99999ms' }),
      makeWatcher({ id: 'w-fail', state: 'failed', lastError: 'boom' }),
      makeWatcher({ id: 'w-stop', state: 'stopped' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      watcherRegistry: { list: () => [...watchers], stopWatcher: () => null },
    }));
    expect(nodeById(registry, 'w-run').state).toBe('idle');
    const degraded = nodeById(registry, 'w-deg');
    expect(degraded.state).toBe('stalled');
    expect(degraded.currentActivity?.text).toBe('heartbeat stale by 99999ms');
    expect(nodeById(registry, 'w-fail').state).toBe('failed');
    expect(nodeById(registry, 'w-stop').state).toBe('killed');
    expect(nodeById(registry, 'w-run').capabilities.killable).toBe(true);
    expect(nodeById(registry, 'w-stop').capabilities.killable).toBe(false);
    registry.dispose();
  });

  test('background-process nodes: running / done / failed, last stdout line as activity', () => {
    const records: BackgroundProcess[] = [
      makeBackgroundProcess({ id: 'bg-run', stdout: ['building...\ncompiling foo\n', 'linking bar\n'] }),
      makeBackgroundProcess({ id: 'bg-done', done: true, exitCode: 0, completedAt: T0 + 500 }),
      makeBackgroundProcess({ id: 'bg-fail', done: true, exitCode: 3, completedAt: T0 + 500 }),
    ];
    const byId = new Map(records.map((record) => [record.id, record]));
    const registry = createProcessRegistry(makeDeps({
      processManager: {
        list: () => records.map((record) => ({ id: record.id, pid: record.pid, cmd: record.cmd, status: 'x' })),
        stop: () => false,
        getStatus: (id: string) => byId.get(id),
      },
    }));
    const running = nodeById(registry, 'bg-run');
    expect(running.kind).toBe('background-process');
    expect(running.state).toBe('executing-tool');
    expect(running.currentActivity).toEqual({ kind: 'output-line', text: 'linking bar', at: T0 });
    expect(running.capabilities.killable).toBe(true);
    expect(nodeById(registry, 'bg-done').state).toBe('done');
    expect(nodeById(registry, 'bg-fail').state).toBe('failed');
    registry.dispose();
  });

  test('query filter narrows by kind and state', () => {
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [makeAgent({ id: 'a1', status: 'completed', completedAt: T0 })],
        cancel: () => false,
      },
      contractRunner: runnerOf([makeRunningContract({ id: 'c1' })]),
    }));
    expect(registry.query({ kinds: ['agent'] }).nodes.map((node) => node.id)).toEqual(['a1']);
    expect(registry.query({ states: ['done'] }).nodes.map((node) => node.id)).toEqual(['a1']);
    expect(registry.query({ kinds: ['contract'] }).nodes.map((node) => node.id)).toEqual(['contract:c1']);
    expect(registry.query({ kinds: ['contract'], states: ['done'] }).nodes).toEqual([]);
    registry.dispose();
  });
});

// ── 2. Fine-grained states from REAL bus emitters ─────────────────────────────

describe('fleet registry: activity side-table via runtime bus', () => {
  function busSetup(agent: AgentRecord): { registry: ProcessRegistry; bus: RuntimeEventBus } {
    const bus = new RuntimeEventBus();
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: bus,
      now: () => T0 + 1_000, // within stalled threshold of every event stamp
    }));
    return { registry, bus };
  }

  test('event sequence drives thinking → executing-tool(+tool) → streaming → done', async () => {
    const agent = makeAgent({ id: 'ag-live' });
    const { registry, bus } = busSetup(agent);

    emitAgentAwaitingMessage(bus, emitterCtx, { agentId: 'ag-live' });
    await flushBus();
    expect(nodeById(registry, 'ag-live').state).toBe('thinking');

    emitAgentAwaitingTool(bus, emitterCtx, { agentId: 'ag-live', callId: 'c1', tool: 'exec' });
    await flushBus();
    const toolNode = nodeById(registry, 'ag-live');
    expect(toolNode.state).toBe('executing-tool');
    expect(toolNode.currentActivity).toMatchObject({ kind: 'tool', text: 'exec', toolName: 'exec' });

    emitAgentStreamDelta(bus, emitterCtx, { agentId: 'ag-live', content: 'x', accumulated: 'x' });
    await flushBus();
    const streamingNode = nodeById(registry, 'ag-live');
    expect(streamingNode.state).toBe('streaming');
    // Prior activity carries forward through non-activity events.
    expect(streamingNode.currentActivity?.toolName).toBe('exec');

    emitAgentProgress(bus, emitterCtx, { agentId: 'ag-live', progress: 'Turn 3 · edit' });
    await flushBus();
    const progressNode = nodeById(registry, 'ag-live');
    expect(progressNode.state).toBe('executing-tool');
    expect(progressNode.currentActivity).toMatchObject({ kind: 'phase', text: 'Turn 3 · edit' });

    // Terminal state comes from the record, not the side-table.
    agent.status = 'completed';
    agent.completedAt = T0 + 900;
    emitAgentCompleted(bus, emitterCtx, { agentId: 'ag-live', durationMs: 900 });
    await flushBus();
    expect(nodeById(registry, 'ag-live').state).toBe('done');
    registry.dispose();
  });

  test('AGENT_FAILED + record failure → failed', async () => {
    const agent = makeAgent({ id: 'ag-fail' });
    const { registry, bus } = busSetup(agent);
    agent.status = 'failed';
    emitAgentFailed(bus, emitterCtx, { agentId: 'ag-fail', error: 'x', durationMs: 10 });
    await flushBus();
    expect(nodeById(registry, 'ag-fail').state).toBe('failed');
    registry.dispose();
  });

  test('STREAM_RETRY with an agent-scoped envelope marks the agent retrying', async () => {
    const agent = makeAgent({ id: 'ag-retry' });
    const bus = new RuntimeEventBus();
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: bus,
      now: () => T0 + 1_000,
    }));
    emitStreamRetry(bus, { ...emitterCtx, agentId: 'ag-retry' }, {
      turnId: 't1', provider: 'anthropic', attempt: 1, maxAttempts: 3, delayMs: 100, reason: 'overloaded',
    });
    await flushBus();
    expect(nodeById(registry, 'ag-retry').state).toBe('retrying');
    // Next agent event flips it back to a live state.
    emitAgentAwaitingMessage(bus, emitterCtx, { agentId: 'ag-retry' });
    await flushBus();
    expect(nodeById(registry, 'ag-retry').state).toBe('thinking');
    registry.dispose();
  });

  test('dispose() detaches the bus tap (later events no longer affect state)', async () => {
    const agent = makeAgent({ id: 'ag-tap' });
    const bus = new RuntimeEventBus();
    const deps = makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: bus,
      now: () => T0 + 1_000,
    });
    const registry = createProcessRegistry(deps);
    emitAgentAwaitingMessage(bus, emitterCtx, { agentId: 'ag-tap' });
    await flushBus();
    expect(nodeById(registry, 'ag-tap').state).toBe('thinking');
    registry.dispose();
    // A fresh registry subscribes BEFORE the next emit; the disposed one's tap
    // is gone, so only the fresh registry may observe the delta.
    const fresh = createProcessRegistry(deps);
    emitAgentStreamDelta(bus, emitterCtx, { agentId: 'ag-tap', content: 'x', accumulated: 'x' });
    await flushBus();
    expect(nodeById(fresh, 'ag-tap').state).toBe('streaming');
    fresh.dispose();
  });
});

// ── 3. Stalled derivation ─────────────────────────────────────────────────────

describe('fleet registry: stalled derivation', () => {
  test('running agent with stale activity flips to stalled, and back on the next event', async () => {
    const agent = makeAgent({ id: 'ag-stall', startedAt: T0 });
    const bus = new RuntimeEventBus();
    let clock = T0 + 1_000;
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: bus,
      now: () => clock,
      stalledThresholdMs: 20_000,
    }));
    emitAgentAwaitingMessage(bus, emitterCtx, { agentId: 'ag-stall' }); // at = T0+1000
    await flushBus();
    expect(nodeById(registry, 'ag-stall').state).toBe('thinking');

    clock = T0 + 30_000; // 29s since last event > 20s threshold
    expect(nodeById(registry, 'ag-stall').state).toBe('stalled');

    emitAgentStreamDelta(bus, emitterCtx, { agentId: 'ag-stall', content: 'x', accumulated: 'x' });
    await flushBus();
    expect(nodeById(registry, 'ag-stall').state).toBe('streaming');
    registry.dispose();
  });

  test('executing-tool is exempt from the stalled check: a long tool call never falsely stalls', async () => {
    const agent = makeAgent({ id: 'ag-tool-stall', startedAt: T0 });
    const bus = new RuntimeEventBus();
    let clock = T0 + 1_000;
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: bus,
      now: () => clock,
      stalledThresholdMs: 20_000,
    }));
    // AGENT_AWAITING_TOOL stamps activity.at once at tool start; no further
    // 'agents' event fires until the tool returns (builds, test suites, bash
    // routinely exceed the 20s threshold).
    emitAgentAwaitingTool(bus, emitterCtx, { agentId: 'ag-tool-stall', callId: 'c1', tool: 'bash' });
    await flushBus();
    expect(nodeById(registry, 'ag-tool-stall').state).toBe('executing-tool');

    clock = T0 + 90_000; // 89s since tool start, far past the 20s threshold
    expect(nodeById(registry, 'ag-tool-stall').state).toBe('executing-tool');

    // Once the tool returns and a new thinking/streaming event lands with no
    // further activity, honest stalling still applies.
    emitAgentAwaitingMessage(bus, emitterCtx, { agentId: 'ag-tool-stall' }); // at = T0+90_000
    await flushBus();
    clock = T0 + 120_000; // 30s of silence since the thinking event > 20s threshold
    expect(nodeById(registry, 'ag-tool-stall').state).toBe('stalled');
    registry.dispose();
  });

  test('bus present but no events yet: stalled baseline is startedAt', () => {
    const agent = makeAgent({ id: 'ag-old', startedAt: T0 });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: new RuntimeEventBus(),
      now: () => T0 + 60_000,
    }));
    expect(nodeById(registry, 'ag-old').state).toBe('stalled');
    registry.dispose();
  });

  test('no bus → no stalled derivation (honest coarse degradation)', () => {
    const agent = makeAgent({ id: 'ag-nobus', startedAt: T0 });
    const registry = createProcessRegistry(makeDeps({
      now: () => T0 + 999_000,
      agentManager: { list: () => [agent], cancel: () => false },
    }));
    expect(nodeById(registry, 'ag-nobus').state).toBe('executing-tool');
    registry.dispose();
  });
});

// ── 4. awaiting-approval cross-reference ──────────────────────────────────────

describe('fleet registry: awaiting-approval', () => {
  test('pending approval with metadata.agentId flips that agent to awaiting-approval', () => {
    const agent = makeAgent({ id: 'ag-appr' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      approvalBroker: {
        listApprovals: () => [makeApproval({ id: 'ap-1', metadata: { agentId: 'ag-appr' } })],
      },
    }));
    const node = nodeById(registry, 'ag-appr');
    expect(node.state).toBe('awaiting-approval');
    // Derived attention marker rides along with the awaiting-approval state.
    expect(node.needsAttention).toEqual({ reason: 'approval' });
    registry.dispose();
  });

  test('a running agent with no pending approval carries no attention marker', () => {
    const agent = makeAgent({ id: 'ag-clear' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
    }));
    const node = nodeById(registry, 'ag-clear');
    expect(node.state).not.toBe('awaiting-approval');
    expect(node.needsAttention).toBeUndefined();
    registry.dispose();
  });

  test('pending approval matches through the session binding; resolved approvals do not', () => {
    const agent = makeAgent({ id: 'ag-sess' });
    const session = makeSession({ id: 'sess-9', activeAgentId: 'ag-sess' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      sessionBroker: { listSessions: () => [session] },
      approvalBroker: {
        listApprovals: () => [makeApproval({ id: 'ap-2', sessionId: 'sess-9' })],
      },
    }));
    const node = nodeById(registry, 'ag-sess');
    expect(node.state).toBe('awaiting-approval');
    expect(node.sessionRef?.sessionId).toBe('sess-9');
    registry.dispose();

    const resolvedRegistry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      sessionBroker: { listSessions: () => [session] },
      approvalBroker: {
        listApprovals: () => [makeApproval({ id: 'ap-3', sessionId: 'sess-9', status: 'approved' })],
      },
    }));
    expect(nodeById(resolvedRegistry, 'ag-sess').state).not.toBe('awaiting-approval');
    resolvedRegistry.dispose();
  });
});

// ── 5. Cost honesty ───────────────────────────────────────────────────────────

describe('fleet registry: cost honesty', () => {
  const usage = {
    inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    llmCallCount: 1, turnCount: 1,
  };

  test('unknown model → costUsd null + unpriced; known → priced; thrower → unpriced (never throws)', () => {
    const agents = [
      makeAgent({ id: 'ag-known', model: 'priced-model', usage: { ...usage } }),
      makeAgent({ id: 'ag-unknown', model: 'mystery-model', usage: { ...usage } }),
      makeAgent({ id: 'ag-nomodel', usage: { ...usage } }),
      makeAgent({ id: 'ag-nousage', model: 'priced-model' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      priceUsage: (model) => {
        if (model === 'priced-model') return 12.5;
        if (model === 'mystery-model') return null;
        throw new Error('must be swallowed');
      },
    }));
    const known = nodeById(registry, 'ag-known');
    expect(known.costUsd).toBe(12.5);
    expect(known.costState).toBe('priced');
    const unknown = nodeById(registry, 'ag-unknown');
    expect(unknown.costUsd).toBeNull();
    expect(unknown.costState).toBe('unpriced');
    const noModel = nodeById(registry, 'ag-nomodel');
    expect(noModel.costUsd).toBeNull(); // priceUsage threw, swallowed, honest null
    expect(noModel.costState).toBe('unpriced');
    expect(nodeById(registry, 'ag-nousage').costUsd).toBeNull();
    registry.dispose();
  });

  test('contract aggregation: mixed priced/unpriced members → estimated with priced subset only', () => {
    const contract = makeRunningContract({
      id: 'ctr-cost', ownerAgentId: 'own',
      units: [makeUnit({ id: 'u1', agentIds: ['m1'] }), makeUnit({ id: 'u2', agentIds: ['m2'] })],
      groups: [makeGroup({ id: 'g1', unitIds: ['u1', 'u2'] })],
    });
    const agents = [
      makeAgent({ id: 'own', contractId: 'ctr-cost', contractRole: 'owner', usage: { ...usage } }),
      makeAgent({ id: 'm1', contractId: 'ctr-cost', contractUnitId: 'u1', model: 'priced-model', usage: { ...usage } }),
      makeAgent({ id: 'm2', contractId: 'ctr-cost', contractUnitId: 'u2', model: 'mystery-model', usage: { ...usage } }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      contractRunner: runnerOf([contract]),
      priceUsage: (model) => (model === 'priced-model' ? 3 : null),
    }));
    const contractNode = nodeById(registry, 'contract:ctr-cost');
    expect(contractNode.costUsd).toBe(3);
    expect(contractNode.costState).toBe('estimated');
    expect(nodeById(registry, 'group:ctr-cost:g1').costState).toBe('estimated');
    expect(nodeById(registry, 'unit:ctr-cost:u1').costState).toBe('priced');
    expect(nodeById(registry, 'unit:ctr-cost:u2').costState).toBe('unpriced');
    registry.dispose();
  });
});

// ── 6. Edge/nesting integrity ─────────────────────────────────────────────────

describe('fleet registry: edge integrity', () => {
  test('contract with a group, 2 units and 3 agents forms a connected tree (no dangling parentIds)', () => {
    const contract = makeRunningContract({
      id: 'ctr-tree',
      ownerAgentId: 'owner-t',
      groups: [makeGroup({ id: 'g1', unitIds: ['u1', 'u2'] })],
      units: [
        makeUnit({ id: 'u1', agentIds: ['eng-a'], activeAgentId: 'eng-a', status: 'running' }),
        makeUnit({ id: 'u2', agentIds: ['eng-b'], activeAgentId: 'eng-b', status: 'running' }),
      ],
    });
    const agents = [
      makeAgent({ id: 'owner-t', contractId: 'ctr-tree', contractRole: 'owner' }),
      makeAgent({ id: 'eng-a', contractId: 'ctr-tree', contractUnitId: 'u1', contractRole: 'unit' }),
      makeAgent({ id: 'eng-b', contractId: 'ctr-tree', contractUnitId: 'u2', contractRole: 'unit' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      contractRunner: runnerOf([contract]),
    }));
    const snapshot = registry.query();
    const ids = new Set(snapshot.nodes.map((node) => node.id));
    expect(ids.size).toBe(7); // 1 contract + 1 group + 2 units + 3 agents
    for (const node of snapshot.nodes) {
      if (node.parentId !== undefined) {
        expect(ids.has(node.parentId)).toBe(true);
      }
    }
    // contract → group → unit → agent nesting.
    expect(nodeById(registry, 'group:ctr-tree:g1').parentId).toBe('contract:ctr-tree');
    expect(nodeById(registry, 'unit:ctr-tree:u1').parentId).toBe('group:ctr-tree:g1');
    expect(nodeById(registry, 'eng-a').parentId).toBe('unit:ctr-tree:u1');
    expect(nodeById(registry, 'eng-b').parentId).toBe('unit:ctr-tree:u2');
    expect(nodeById(registry, 'owner-t').parentId).toBe('contract:ctr-tree');
    expect(nodeById(registry, 'contract:ctr-tree').parentId).toBeUndefined();
    registry.dispose();
  });
});

// ── 7. subscribe / tick / dispose ─────────────────────────────────────────────

interface FakeTimerHarness {
  timers: RegistryTimers;
  fire: () => void;
  unrefCalls: number;
  setCalls: number;
  clearCalls: number;
}

function makeFakeTimers(): FakeTimerHarness {
  const harness: FakeTimerHarness = {
    unrefCalls: 0,
    setCalls: 0,
    clearCalls: 0,
    fire: () => undefined,
    timers: {
      setInterval: (callback: () => void) => {
        harness.setCalls += 1;
        harness.fire = callback;
        return {
          unref: () => {
            harness.unrefCalls += 1;
          },
        };
      },
      clearInterval: () => {
        harness.clearCalls += 1;
        harness.fire = () => undefined;
      },
    },
  };
  return harness;
}

describe('fleet registry: subscribe/tick/dispose', () => {
  test('tick notifies on change, stays silent when unchanged, and dispose stops everything', () => {
    const agent = makeAgent({ id: 'ag-sub' });
    const harness = makeFakeTimers();
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      timers: harness.timers,
    }));

    const seen: number[] = [];
    registry.subscribe((snapshot) => seen.push(snapshot.nodes.length));
    expect(harness.setCalls).toBe(1);
    expect(harness.unrefCalls).toBe(1); // timer.unref path exercised

    harness.fire(); // first tick: initial delivery
    expect(seen).toEqual([1]);

    harness.fire(); // nothing changed → coalesced silence
    harness.fire();
    expect(seen).toEqual([1]);

    agent.status = 'completed'; // material change
    agent.completedAt = T0 + 100;
    harness.fire();
    expect(seen).toEqual([1, 1]);

    registry.dispose();
    expect(harness.clearCalls).toBe(1);
    agent.status = 'running';
    harness.fire(); // cleared fake timer no longer reaches the registry
    expect(seen).toEqual([1, 1]);
  });

  test('elapsedMs drift alone never wakes subscribers', () => {
    let clock = T0 + 1_000;
    const agent = makeAgent({ id: 'ag-drift' });
    const harness = makeFakeTimers();
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      timers: harness.timers,
      now: () => clock,
    }));
    let calls = 0;
    registry.subscribe(() => {
      calls += 1;
    });
    harness.fire();
    expect(calls).toBe(1);
    clock += 5_000; // elapsedMs changes, nothing material does
    harness.fire();
    expect(calls).toBe(1);
    registry.dispose();
  });

  test('unsubscribing the last listener stops the timer; resubscribe restarts it', () => {
    const harness = makeFakeTimers();
    const registry = createProcessRegistry(makeDeps({ timers: harness.timers }));
    const unsubscribe = registry.subscribe(() => undefined);
    expect(harness.setCalls).toBe(1);
    unsubscribe();
    expect(harness.clearCalls).toBe(1);
    registry.subscribe(() => undefined);
    expect(harness.setCalls).toBe(2);
    registry.dispose();
    expect(harness.clearCalls).toBe(2);
  });

  test('subscribe after dispose is a no-op', () => {
    const harness = makeFakeTimers();
    const registry = createProcessRegistry(makeDeps({ timers: harness.timers }));
    registry.dispose();
    const unsubscribe = registry.subscribe(() => undefined);
    expect(harness.setCalls).toBe(0);
    unsubscribe(); // must not throw
  });
});

// ── 8. Control dispatch ───────────────────────────────────────────────────────

describe('fleet registry: control dispatch', () => {
  // Registry routing must pass the termination intent through
  // to AgentManager.cancel(id, kind), kill() always 'kill' (direct agent
  // kill, and group kills via cancelAgents), interrupt() always
  // 'interrupt'. Spy on the exact args cancel() receives.
  test('agent kill passes cancel(id, "kill"); agent interrupt passes cancel(id, "interrupt")', () => {
    const calls: Array<{ id: string; kind: 'interrupt' | 'kill' | undefined }> = [];
    const agent = makeAgent({ id: 'ag-verb' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [agent],
        cancel: (id: string, kind?: 'interrupt' | 'kill') => {
          calls.push({ id, kind });
          return true;
        },
      },
    }));
    expect(registry.kill('ag-verb')).toEqual(['ag-verb']);
    expect(registry.interrupt('ag-verb')).toBe(true);
    expect(calls).toEqual([
      { id: 'ag-verb', kind: 'kill' },
      { id: 'ag-verb', kind: 'interrupt' },
    ]);
    registry.dispose();
  });

  test('group kill always passes cancel(id, "kill") over its working unit agents, never "interrupt"', () => {
    const calls: Array<{ id: string; kind: 'interrupt' | 'kill' | undefined }> = [];
    const contract = makeRunningContract({
      id: 'ctr-verb', ownerAgentId: 'own-verb',
      groups: [makeGroup({ id: 'g1', unitIds: ['u1'], status: 'running' })],
      units: [makeUnit({ id: 'u1', status: 'running', agentIds: ['m1-verb'], activeAgentId: 'm1-verb' })],
    });
    const agents = [
      makeAgent({ id: 'own-verb', contractId: 'ctr-verb', contractRole: 'owner' }),
      makeAgent({ id: 'm1-verb', contractId: 'ctr-verb', contractUnitId: 'u1' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [...agents],
        cancel: (id: string, kind?: 'interrupt' | 'kill') => {
          calls.push({ id, kind });
          return true;
        },
      },
      contractRunner: runnerOf([contract]),
    }));
    expect([...registry.kill('group:ctr-verb:g1')].sort()).toEqual(['group:ctr-verb:g1', 'm1-verb']);
    expect(calls).toEqual([{ id: 'm1-verb', kind: 'kill' }]);
    registry.dispose();
  });
  test('kill routes to the owning manager per kind', () => {
    const calls: string[] = [];
    const agent = makeAgent({ id: 'ag-k' });
    const workflow: WorkflowInstance = {
      id: 'wf-k', definition: 'd', currentState: 's', task: 't', startedAt: T0, transitions: 0, context: {},
    };
    const trigger: TriggerDefinition = { id: 'trg-k', event: 'e', action: 'a', enabled: true };
    const schedule: ScheduleEntry = { name: 'sch-k', interval: '5m', command: 'c', enabled: true };
    const watcher = makeWatcher({ id: 'w-k' });
    const bg = makeBackgroundProcess({ id: 'bg-k' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [agent],
        cancel: (id: string) => {
          calls.push(`agent.cancel:${id}`);
          return true;
        },
      },
      processManager: {
        list: () => [{ id: bg.id, pid: bg.pid, cmd: bg.cmd, status: 'running' }],
        getStatus: () => bg,
        stop: (id: string) => {
          calls.push(`process.stop:${id}`);
          return true;
        },
      },
      watcherRegistry: {
        list: () => [watcher],
        stopWatcher: (id: string) => {
          calls.push(`watcher.stop:${id}`);
          return watcher;
        },
      },
      workflow: {
        workflowManager: {
          list: () => [workflow],
          cancel: (id: string) => {
            calls.push(`workflow.cancel:${id}`);
            return true;
          },
        },
        triggerManager: {
          list: () => [trigger],
          remove: (id: string) => {
            calls.push(`trigger.remove:${id}`);
            return true;
          },
          disable: (id: string) => {
            calls.push(`trigger.disable:${id}`);
            return true;
          },
          enable: (id: string) => {
            calls.push(`trigger.enable:${id}`);
            return true;
          },
        },
        scheduleManager: {
          list: () => [schedule],
          remove: (name: string) => {
            calls.push(`schedule.remove:${name}`);
            return true;
          },
          disable: (name: string) => {
            calls.push(`schedule.disable:${name}`);
            return true;
          },
          enable: (name: string) => {
            calls.push(`schedule.enable:${name}`);
            return true;
          },
        },
      },
    }));

    expect(registry.kill('ag-k')).toEqual(['ag-k']);
    expect(registry.kill('bg-k')).toEqual(['bg-k']);
    expect(registry.kill('w-k')).toEqual(['w-k']);
    expect(registry.kill('wf-k')).toEqual(['wf-k']);
    expect(registry.kill('trg-k')).toEqual(['trg-k']);
    expect(registry.kill('schedule:sch-k')).toEqual(['schedule:sch-k']);
    expect(registry.kill('missing')).toEqual([]);

    expect(registry.interrupt('ag-k')).toBe(true);
    expect(registry.interrupt('trg-k')).toBe(true);
    expect(registry.interrupt('schedule:sch-k')).toBe(true);
    expect(registry.interrupt('bg-k')).toBe(false);

    expect(calls).toEqual([
      'agent.cancel:ag-k',
      'process.stop:bg-k',
      'watcher.stop:w-k',
      'workflow.cancel:wf-k',
      'trigger.remove:trg-k',
      'schedule.remove:sch-k',
      'agent.cancel:ag-k',
      'trigger.disable:trg-k',
      'schedule.disable:sch-k',
    ]);
    registry.dispose();
  });

  test('contract kill goes through the runner: cancel(contractId), agents are the runner\'s to stop', () => {
    const cancelledAgents: string[] = [];
    const cancelledContracts: string[] = [];
    const contract = makeRunningContract({
      id: 'ctr-kill', ownerAgentId: 'own-k',
      units: [makeUnit({ id: 'u1', status: 'running', agentIds: ['m1-k'], activeAgentId: 'm1-k' })],
    });
    const agents = [
      makeAgent({ id: 'own-k', contractId: 'ctr-kill', contractRole: 'owner' }),
      makeAgent({ id: 'm1-k', contractId: 'ctr-kill', contractUnitId: 'u1' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [...agents],
        cancel: (id: string) => { cancelledAgents.push(id); return true; },
      },
      contractRunner: runnerOf([contract], cancelledContracts),
    }));
    expect(registry.kill('contract:ctr-kill')).toEqual(['contract:ctr-kill']);
    expect(cancelledContracts).toEqual(['ctr-kill']);
    expect(cancelledAgents).toEqual([]); // the runner cancels its own units
    // A second kill finds the contract already ended: nothing acted on.
    expect(registry.kill('contract:ctr-kill')).toEqual([]);
    registry.dispose();
  });
  test('contract kill with cascade: the contract id is included even though the unit agents were cancelled first', () => {
    // Under cascade the unit agents stop first, and the runner reads an
    // operator cancel of a unit agent as a stop of the contract, so its own
    // cancel then returns false. The contract was still the target.
    const cancelledOnce = new Set<string>();
    const cancelledContracts: string[] = [];
    const contract = makeRunningContract({
      id: 'ctr-casc', ownerAgentId: 'own-c',
      units: [makeUnit({ id: 'u1', status: 'running', agentIds: ['m1-c'], activeAgentId: 'm1-c' })],
    });
    const agents = [
      makeAgent({ id: 'own-c', contractId: 'ctr-casc', contractRole: 'owner' }),
      makeAgent({ id: 'm1-c', contractId: 'ctr-casc', contractUnitId: 'u1' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [...agents],
        cancel: (id: string) => {
          if (cancelledOnce.has(id)) return false;
          cancelledOnce.add(id);
          // The runner reacts to the unit agent's cancel by ending the contract.
          if (id === 'm1-c') cancelledContracts.push('ctr-casc');
          return true;
        },
      },
      contractRunner: runnerOf([contract], cancelledContracts),
    }));
    const affected = registry.kill('contract:ctr-casc', { cascade: true });
    expect(affected).toContain('contract:ctr-casc');
    expect(affected).toContain('m1-c');
    registry.dispose();
  });
  test('unit kill cancels its active agent with "kill"; a unit without a working agent is not killable', () => {
    const calls: Array<{ id: string; kind: 'interrupt' | 'kill' | undefined }> = [];
    const contract = makeRunningContract({
      id: 'ctr-unit', ownerAgentId: 'own-u',
      groups: [makeGroup({ id: 'g1', unitIds: ['u1', 'u2'] })],
      units: [
        makeUnit({ id: 'u1', status: 'running', agentIds: ['m1-u'], activeAgentId: 'm1-u' }),
        makeUnit({ id: 'u2', status: 'pending' }),
      ],
    });
    const agents = [makeAgent({ id: 'm1-u', contractId: 'ctr-unit', contractUnitId: 'u1' })];
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [...agents],
        cancel: (id: string, kind?: 'interrupt' | 'kill') => { calls.push({ id, kind }); return true; },
      },
      contractRunner: runnerOf([contract]),
    }));
    expect([...registry.kill('unit:ctr-unit:u1')].sort()).toEqual(['m1-u', 'unit:ctr-unit:u1']);
    expect(registry.interrupt('unit:ctr-unit:u1')).toBe(true);
    expect(nodeById(registry, 'unit:ctr-unit:u2').capabilities.killable).toBe(false);
    expect(registry.kill('unit:ctr-unit:u2')).toEqual([]);
    expect(registry.interrupt('unit:ctr-unit:u2')).toBe(false);
    expect(calls).toEqual([{ id: 'm1-u', kind: 'kill' }, { id: 'm1-u', kind: 'interrupt' }]);
    registry.dispose();
  });
});

// ── 9. Steer ───────────────────────────────────────────────────────────────

interface FakeSend {
  send: (fromId: string, toId: string, content: string, opts?: unknown) => boolean;
  calls: Array<{ fromId: string; toId: string; content: string; opts: unknown }>;
}

function fakeMessageBus(sendResult = true): FakeSend {
  const calls: FakeSend['calls'] = [];
  return {
    calls,
    send: (fromId: string, toId: string, content: string, opts?: unknown) => {
      calls.push({ fromId, toId, content, opts });
      return sendResult;
    },
  };
}

describe('fleet registry: steer', () => {
  test('capabilities.steerable: true for a running agent with a messageBus dep, false without one, false once terminal', () => {
    const running = makeAgent({ id: 'ag-run', status: 'running' });
    const done = makeAgent({ id: 'ag-done', status: 'completed', completedAt: T0 });
    const withBus = createProcessRegistry(makeDeps({
      agentManager: { list: () => [running, done], cancel: () => false },
      messageBus: fakeMessageBus(),
    }));
    expect(nodeById(withBus, 'ag-run').capabilities.steerable).toBe(true);
    expect(nodeById(withBus, 'ag-done').capabilities.steerable).toBe(false);
    withBus.dispose();

    const withoutBus = createProcessRegistry(makeDeps({
      agentManager: { list: () => [running], cancel: () => false },
    }));
    expect(nodeById(withoutBus, 'ag-run').capabilities.steerable).toBe(false);
    withoutBus.dispose();
  });

  test('steer(): running agent gets an operator message via the bus (kind steer, TTL well beyond DEFAULT_TTL_MS); returns {queued:true,messageId}', () => {
    const bus = fakeMessageBus(true);
    const agent = makeAgent({ id: 'ag-steer', status: 'running' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      messageBus: bus,
    }));
    const result = registry.steer('ag-steer', 'please stop and rerun the tests first');
    expect(result.queued).toBe(true);
    if (result.queued) {
      expect(typeof result.messageId).toBe('string');
      expect(result.messageId.length).toBeGreaterThan(0);
    }
    expect(bus.calls).toHaveLength(1);
    expect(bus.calls[0]?.fromId).toBe('operator');
    expect(bus.calls[0]?.toId).toBe('ag-steer');
    expect(bus.calls[0]?.content).toBe('please stop and rerun the tests first');
    const opts = bus.calls[0]?.opts as { kind: string; ttlMs: number; id: string };
    expect(opts.kind).toBe('steer');
    expect(opts.ttlMs).toBeGreaterThan(5 * 60 * 1000); // must materially outlive AgentMessageBus's own 5-min default
    if (result.queued) {
      expect(opts.id).toBe(result.messageId);
    } else {
      throw new Error('expected result.queued to be true (checked above)');
    }
    registry.dispose();
  });

  test('steer(): refuses everything when no messageBus dep is configured', () => {
    const agent = makeAgent({ id: 'ag-nobus-steer', status: 'running' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
    }));
    const result = registry.steer('ag-nobus-steer', 'x');
    expect(result.queued).toBe(false);
    registry.dispose();
  });

  test('steer(): honest refusal for a missing node, a terminal agent, a contract and a group (steer a unit), and a non-agent kind', () => {
    const contract = makeRunningContract({ id: 'ctr-steer', ownerAgentId: 'owner-s' });
    const trigger: TriggerDefinition = { id: 'trg-steer', event: 'push', action: 'run tests', enabled: true };
    const doneAgent = makeAgent({ id: 'ag-done-steer', status: 'completed', completedAt: T0 });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [doneAgent], cancel: () => false },
      contractRunner: runnerOf([contract]),
      workflow: {
        workflowManager: { list: () => [], cancel: () => false },
        triggerManager: { list: () => [trigger], remove: () => false, disable: () => false, enable: () => false },
        scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      },
      messageBus: fakeMessageBus(),
    }));

    const missing = registry.steer('nope', 'x');
    expect(missing.queued).toBe(false);

    const doneResult = registry.steer('ag-done-steer', 'x');
    expect(doneResult.queued).toBe(false);

    const contractResult = registry.steer('contract:ctr-steer', 'x');
    expect(contractResult).toEqual({ queued: false, reason: 'steer a unit, not the contract' });
    const groupResult = registry.steer('group:ctr-steer:g1', 'x');
    expect(groupResult).toEqual({ queued: false, reason: 'steer a unit, not the group' });

    const triggerResult = registry.steer('trg-steer', 'x');
    expect(triggerResult.queued).toBe(false);
    if (!triggerResult.queued) expect(triggerResult.reason).toContain('trigger');

    registry.dispose();
  });

  test('steer(): a wedged (failed) agent is re-triggered via wakeWithSteer, not refused', () => {
    const failed = makeAgent({ id: 'ag-wedged', status: 'failed', error: 'Circuit breaker tripped', completedAt: T0 + 1_000 });
    const wakeCalls: Array<{ id: string; text: string }> = [];
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [failed],
        cancel: () => false,
        wakeWithSteer: (id: string, text: string) => { wakeCalls.push({ id, text }); return { woke: true, reason: 'ok' }; },
      },
      messageBus: fakeMessageBus(),
    }));
    const result = registry.steer('ag-wedged', 'rerun with the fix');
    expect(result.queued).toBe(true);
    if (result.queued) expect(result.woke).toBe(true);
    expect(wakeCalls).toEqual([{ id: 'ag-wedged', text: 'rerun with the fix' }]);
    registry.dispose();
  });

  test('steer(): a genuinely-running agent is delivered via the bus, not woken', () => {
    const running = makeAgent({ id: 'ag-live', status: 'running' });
    let wakeCalled = false;
    const bus = fakeMessageBus(true);
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [running],
        cancel: () => false,
        wakeWithSteer: () => { wakeCalled = true; return { woke: true, reason: 'ok' }; },
      },
      messageBus: bus,
    }));
    const result = registry.steer('ag-live', 'keep going but check the edge case');
    expect(result.queued).toBe(true);
    if (result.queued) expect(result.woke).toBeUndefined();
    expect(wakeCalled).toBe(false);
    registry.dispose();
  });

  test('steer(): a contract unit routes to its live active agent, not the unit node id', () => {
    const bus = fakeMessageBus(true);
    const contract = makeRunningContract({
      id: 'ctr-unit-steer', ownerAgentId: 'owner-sub',
      units: [makeUnit({ id: 'u1', status: 'running', agentIds: ['eng-sub'], activeAgentId: 'eng-sub' })],
    });
    const agents = [
      makeAgent({ id: 'owner-sub', contractId: 'ctr-unit-steer', contractRole: 'owner' }),
      makeAgent({ id: 'eng-sub', contractId: 'ctr-unit-steer', contractUnitId: 'u1', status: 'running' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      contractRunner: runnerOf([contract]),
      messageBus: bus,
    }));
    expect(nodeById(registry, 'unit:ctr-unit-steer:u1').capabilities.steerable).toBe(true);
    const result = registry.steer('unit:ctr-unit-steer:u1', 'go faster');
    expect(result.queued).toBe(true);
    expect(bus.calls).toHaveLength(1);
    expect(bus.calls[0]?.toId).toBe('eng-sub'); // NOT 'unit:ctr-unit-steer:u1'
    expect(bus.calls[0]?.fromId).toBe('operator');
    registry.dispose();
  });
  test('steer(): a unit whose active agent is terminal is not steerable and refuses', () => {
    const contract = makeRunningContract({
      id: 'ctr-unit-term', ownerAgentId: 'owner-t2',
      units: [makeUnit({ id: 'u1', status: 'running', agentIds: ['eng-t2'], activeAgentId: 'eng-t2' })],
    });
    const agents = [
      makeAgent({ id: 'eng-t2', contractId: 'ctr-unit-term', contractUnitId: 'u1', status: 'completed', completedAt: T0 }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      contractRunner: runnerOf([contract]),
      messageBus: fakeMessageBus(),
    }));
    expect(nodeById(registry, 'unit:ctr-unit-term:u1').capabilities.steerable).toBe(false);
    const result = registry.steer('unit:ctr-unit-term:u1', 'go faster');
    expect(result).toEqual({ queued: false, reason: 'no live agent to steer for this unit' });
    registry.dispose();
  });
  test('steer(): a unit with no agent working (pending) is not steerable; no bus refuses a live unit too', () => {
    const contract = makeRunningContract({
      id: 'ctr-unit-idle',
      units: [makeUnit({ id: 'u1', status: 'pending' }), makeUnit({ id: 'u2', status: 'running', agentIds: ['eng-live'], activeAgentId: 'eng-live' })],
      groups: [makeGroup({ id: 'g1', unitIds: ['u1', 'u2'] })],
    });
    const agents = [makeAgent({ id: 'eng-live', contractId: 'ctr-unit-idle', contractUnitId: 'u2', status: 'running' })];
    const withBus = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      contractRunner: runnerOf([contract]),
      messageBus: fakeMessageBus(),
    }));
    expect(nodeById(withBus, 'unit:ctr-unit-idle:u1').capabilities.steerable).toBe(false);
    expect(withBus.steer('unit:ctr-unit-idle:u1', 'go').queued).toBe(false);
    withBus.dispose();
    const noBus = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      contractRunner: runnerOf([contract]),
    }));
    expect(nodeById(noBus, 'unit:ctr-unit-idle:u2').capabilities.steerable).toBe(false);
    expect(noBus.steer('unit:ctr-unit-idle:u2', 'go').queued).toBe(false);
    noBus.dispose();
  });
  test('steer(): send() returning false (route blocked) surfaces as an honest refusal, not a false queued:true', () => {
    const agent = makeAgent({ id: 'ag-blocked', status: 'running' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      messageBus: fakeMessageBus(false),
    }));
    const result = registry.steer('ag-blocked', 'x');
    expect(result.queued).toBe(false);
    registry.dispose();
  });
});
