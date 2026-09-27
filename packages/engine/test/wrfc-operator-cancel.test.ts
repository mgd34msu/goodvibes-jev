/**
 * An operator kill is CANCELLED, not FAILED.
 *
 * A cold eval: K on a chain cancelled its running leaf, which routed through
 * failChain and flipped the whole chain + owner to "✗ failed" while the cohort
 * tally read "0 completed, 1 failed, 0 cancelled", contradicting the transcript's
 * "operator cancellation". Only the leaf showed ⊘ cancelled.
 *
 * Fix: a cancelled member agent cancels the CHAIN (cancelChain), setting
 * failureKind='cancelled' at every surface, rolling the member usage onto the
 * owner, and narrating the landed work from the chain's edit ledger.
 */

import { describe, expect, test } from 'bun:test';
import { createWrfcControllerForTest } from '../sdk/src/platform/agents/wrfc-controller-test-support.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../sdk/src/platform/runtime/event-envelope.js';
import type { WrfcChain } from '../sdk/src/platform/agents/wrfc-types.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import type { AgentManagerLike } from '../sdk/src/platform/agents/wrfc-config.js';

function makeRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    template: overrides.template ?? 'engineer', tools: [],
    status: 'running', startedAt: Date.now(), toolCallCount: 0, orchestrationDepth: 0,
    executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 },
    ...overrides,
  };
}

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function createHarness() {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  const spawned: AgentRecord[] = [];
  const workflowEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  bus.onDomain('contracts', (envelope) => {
    workflowEvents.push({ type: envelope.type, data: (envelope as unknown as { payload: Record<string, unknown> }).payload });
  });
  // ConfigManager.get/getCategory are generic over `ConfigKey`/`keyof GoodVibesConfig`
  // with a per-key conditional return type, a by-string-key stub can't be typed
  // against that generic signature directly (TypeScript hits its own recursion
  // limit, "Excessive stack depth", comparing two such generic conditional
  // signatures). Casting the whole mock once at the boundary sidesteps that
  // compiler limitation; ConfigManager's own methods work around the same
  // expressiveness gap internally with `as ConfigValue<K>`.
  const configManager = {
    get: (key: string): unknown => {
      if (key === 'contract.maxFixRounds') return 3;
      if (key === 'contract.autoCommit') return false;
      return undefined;
    },
    getCategory: (c: string): unknown => c === 'contract' ? { maxFixRounds: 3, autoCommit: false, gates: [] } : undefined,
  } as unknown as Pick<import('../sdk/src/platform/config/manager.js').ConfigManager, 'get' | 'getCategory'>;
  const agentManager: AgentManagerLike = {
    spawn: (input) => {
      const id = `agent-${spawned.length + 1}`;
      const record = makeRecord({ id, task: (input as { task?: string }).task ?? 'spawned', template: (input as { template?: string }).template ?? 'engineer' });
      agentStore.set(id, record);
      spawned.push(record);
      return record;
    },
    getStatus: (id) => agentStore.get(id) ?? null,
    list: () => Array.from(agentStore.values()),
    cancel: (id) => { const r = agentStore.get(id); if (r && (r.status === 'running' || r.status === 'pending')) { r.status = 'cancelled'; return true; } return false; },
    listByCohort: () => [],
    clear: () => agentStore.clear(),
  };
  const messageBus = { registerAgent: () => {} };
  const controller = createWrfcControllerForTest(bus, messageBus, {
    agentManager, configManager, projectRoot: '/tmp/test-operator-cancel',
    skipClaimVerification: true,
    createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
  });
  const addAgent = (id: string, task: string): AgentRecord => { const r = makeRecord({ id, task }); agentStore.set(id, r); return r; };
  return { bus, controller, agentStore, spawned, workflowEvents, addAgent };
}

function emitAgentCancelled(bus: RuntimeEventBus, agentId: string, reason: string): void {
  bus.emit('agents', createEventEnvelope('AGENT_CANCELLED', { type: 'AGENT_CANCELLED', agentId, reason }, { sessionId: 'test', traceId: 'test', source: 'test' }));
}

describe('operator cancel: cancelled, not failed', () => {
  test('cancelling a running leaf cancels the chain: cancelled at chain + owner, narration counts landed files, event carries failureKind=cancelled', async () => {
    const h = createHarness();
    const owner = h.addAgent('owner-1', 'implement the feature');
    const chain = h.controller.createChain(owner);
    // Seed the chain's edit ledger with landed work.
    chain.touchedPaths = ['src/a.ts', 'src/b.ts'];

    const leafId = chain.engineerAgentId!;
    expect(leafId).toBeDefined();

    emitAgentCancelled(h.bus, leafId, 'operator cancellation');
    await flush();

    // Chain terminal state reads as cancelled (failureKind), not an ordinary failure.
    expect(chain.state).toBe('failed');
    expect(chain.failureKind).toBe('cancelled');

    // Owner row is cancelled with rolled-up usage (not spawn-time zeros).
    const ownerRec = h.agentStore.get('owner-1')!;
    expect(ownerRec.status).toBe('cancelled');
    expect(ownerRec.usage!.inputTokens).toBeGreaterThan(0);

    // Completion narration summarises the landed work from the ledger.
    expect(chain.error).toContain('2 files already modified on disk');

    // The contract event is a cancellation, never a failure, so every host
    // narrates a cancellation; it carries the landed-file count and narration.
    expect(h.workflowEvents.some((e) => e.type === 'CONTRACT_FAILED')).toBe(false);
    const cancelledEvent = h.workflowEvents.find((e) => e.type === 'CONTRACT_CANCELLED');
    expect(cancelledEvent).toBeDefined();
    const payload = cancelledEvent!.data;
    expect(payload['contractId']).toBe(chain.id);
    expect(payload['filesModified']).toBe(2);
    expect(String(payload['reason'])).toContain('already modified on disk');
    // The status change says cancelled too, not failed.
    const statusChange = h.workflowEvents.filter((e) => e.type === 'CONTRACT_STATUS_CHANGED').at(-1);
    expect(statusChange!.data['to']).toBe('cancelled');

    h.controller.dispose();
  });

  test('a cancelled chain reports cancelled; a genuine failure reports failed', async () => {
    const h = createHarness();
    const owner = h.addAgent('owner-2', 'implement the feature');
    const cancelledChain = h.controller.createChain(owner);
    emitAgentCancelled(h.bus, cancelledChain.engineerAgentId!, 'operator cancellation');
    await flush();

    // A reimported chain whose whole roster is gone is reaped as a genuine failure.
    const failedChain: WrfcChain = {
      id: 'ch-failed', state: 'reviewing', task: 't', ownerAgentId: 'gone-owner', allAgentIds: ['gone-owner', 'gone-engineer'],
      fixAttempts: 0, reviewCycles: 0, reviewScores: [], ownerDecisions: [], ownerTerminalEmitted: false,
      constraints: [], constraintsEnumerated: false, touchedPaths: [], createdAt: Date.now(),
    };
    h.controller.importChain(failedChain);
    await flush();

    const finalStatus = (contractId: string): unknown => h.workflowEvents
      .filter((e) => e.type === 'CONTRACT_STATUS_CHANGED' && e.data['contractId'] === contractId)
      .at(-1)?.data['to'];
    expect(finalStatus(cancelledChain.id)).toBe('cancelled');
    expect(finalStatus('ch-failed')).toBe('failed');
    expect(h.workflowEvents.some((e) => e.type === 'CONTRACT_CANCELLED' && e.data['contractId'] === cancelledChain.id)).toBe(true);
    expect(h.workflowEvents.some((e) => e.type === 'CONTRACT_FAILED' && e.data['contractId'] === 'ch-failed')).toBe(true);
    expect(h.workflowEvents.some((e) => e.type === 'CONTRACT_FAILED' && e.data['contractId'] === cancelledChain.id)).toBe(false);

    h.controller.dispose();
  });
});
