import { afterEach, describe, expect, test } from 'bun:test';
import { CostTracker, COST_TRACKER_MAX_AGENTS } from '../sdk/src/platform/observe/index.ts';
import { RuntimeEventBus, createEventEnvelope } from '../sdk/src/platform/runtime/state.ts';
import { createUiRuntimeEvents } from '../sdk/src/platform/runtime/ui.ts';
import { calcSessionCost, resolveSessionCost, setModelPricingResolver, setPricingSource } from '../sdk/src/platform/providers/session-cost.ts';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/record.ts';

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function record(id: string, inputTokens = 1_000_000, contractRole?: AgentRecord['contractRole']): AgentRecord {
  return {
    id, task: 'Synthetic usage fixture', template: 'fixture', status: 'running', startedAt: 1,
    model: 'cost-tracker-terminal:synthetic', tools: [], toolCallCount: 0, orchestrationDepth: 0,
    executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'direct', contractRole,
    usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 },
  };
}
const price = (input: number): number => input / 1_000_000;
afterEach(() => { setModelPricingResolver(null); setPricingSource(null); });

describe('terminal agent costs', () => {
  test('the real event feed captures final cancelled and failed usage and detaches', async () => {
    const bus = new RuntimeEventBus();
    const events = createUiRuntimeEvents(bus);
    const records = new Map([['cancelled', record('cancelled')], ['failed', record('failed')]]);
    const tracker = new CostTracker({ price, getAgentStatus: (id) => records.get(id) ?? null });
    const detach = tracker.attach(events.turns, events.agents, () => usage);
    const envelope = { sessionId: 'cost-fixture', traceId: 'cost-fixture', source: 'cost-test' };
    for (const [agentId, current] of records) {
      bus.emit('agents', createEventEnvelope('AGENT_SPAWNING', { type: 'AGENT_SPAWNING', agentId, task: current.task }, envelope));
    }
    await Promise.resolve();
    records.get('cancelled')!.usage!.inputTokens = 2_000_000;
    records.get('failed')!.usage!.inputTokens = 3_000_000;
    bus.emit('agents', createEventEnvelope('AGENT_CANCELLED', { type: 'AGENT_CANCELLED', agentId: 'cancelled' }, envelope));
    bus.emit('agents', createEventEnvelope('AGENT_FAILED', { type: 'AGENT_FAILED', agentId: 'failed', error: 'Fixture stopped', durationMs: 1 }, envelope));
    await Promise.resolve();
    expect(tracker.agents()).toEqual([
      expect.objectContaining({ agentId: 'cancelled', status: 'cancelled', inputTokens: 2_000_000, cost: 2 }),
      expect.objectContaining({ agentId: 'failed', status: 'failed', inputTokens: 3_000_000, cost: 3 }),
    ]);
    tracker.agentCompleted('cancelled');
    tracker.agentFailed('cancelled');
    expect(tracker.agents()[0]?.status).toBe('cancelled');
    expect(tracker.agentsCost()).toBe(5);
    detach();
    bus.emit('agents', createEventEnvelope('AGENT_SPAWNING', { type: 'AGENT_SPAWNING', agentId: 'after-detach', task: 'Ignored' }, envelope));
    await Promise.resolve();
    expect(tracker.agents()).toHaveLength(2);
  });

  test('terminal details are bounded without losing lifetime cost or counting owner rollups', () => {
    const records = new Map([
      ['running', record('running')], ['leaf-a', record('leaf-a', 2_000_000)],
      ['owner', record('owner', 5_000_000, 'owner')], ['leaf-b', record('leaf-b', 3_000_000)],
    ]);
    const tracker = new CostTracker({ maxAgents: 2, price, getAgentStatus: (id) => records.get(id) ?? null });
    for (const [id, current] of records) tracker.agentSpawned(id, current.task);
    expect(tracker.agents()).toHaveLength(4); // All are still running, so none may be evicted.
    tracker.pollRunningAgents();
    expect(tracker.agentsCost()).toBe(6);
    tracker.agentCompleted('owner');
    expect(tracker.agents().map((row) => row.agentId)).toEqual(['running', 'leaf-a', 'leaf-b']);
    expect(tracker.agentsCost()).toBe(6);
    tracker.agentCancelled('leaf-a');
    expect(tracker.agents().map((row) => row.agentId)).toEqual(['running', 'leaf-b']);
    expect(tracker.agentsCost()).toBe(6);
    tracker.agentFailed('leaf-b');
    tracker.agentCompleted('leaf-a'); // A late duplicate cannot recreate an evicted row.
    expect(tracker.agentsCost()).toBe(6);
    tracker.agentSpawned('next', 'Next task');
    expect(tracker.agents().map((row) => row.agentId)).toEqual(['running', 'next']);
    expect(tracker.agentsCost()).toBe(6);
  });

  test('eviction follows terminal order, never the age of an active agent', () => {
    const tracker = new CostTracker({ maxAgents: 2 });
    tracker.agentSpawned('old-running', 'A');
    tracker.agentSpawned('first-terminal', 'B');
    tracker.agentCompleted('first-terminal');
    tracker.agentCompleted('old-running');
    tracker.agentSpawned('new-running', 'C');
    expect(tracker.agents().map((row) => row.agentId)).toEqual(['old-running', 'new-running']);
  });

  test('default history cap is 200 and zero retains running rows until they terminate', () => {
    const tracker = new CostTracker({ price, getAgentStatus: (id) => record(id) });
    for (let index = 0; index < COST_TRACKER_MAX_AGENTS + 5; index++) {
      tracker.agentSpawned(String(index), 'Fixture');
      tracker.agentCompleted(String(index));
    }
    expect(COST_TRACKER_MAX_AGENTS).toBe(200);
    expect(tracker.agents()).toHaveLength(200);
    expect(tracker.agents()[0]?.agentId).toBe('5');
    expect(tracker.agentsCost()).toBe(205);
    const none = new CostTracker({ maxAgents: 0, price, getAgentStatus: (id) => record(id) });
    none.agentSpawned('active', 'Fixture');
    expect(none.agents()).toHaveLength(1);
    none.agentCancelled('active');
    expect(none.agents()).toHaveLength(0);
    expect(none.agentsCost()).toBe(1);
  });

  test('invalid retention limits fail explicitly', () => {
    for (const maxAgents of [-1, 1.5, NaN, Infinity]) expect(() => new CostTracker({ maxAgents })).toThrow(RangeError);
  });

  test('wake accounting works with fresh record snapshots, duplicate events, and a changed price', () => {
    let rate = 1;
    const current = record('woken');
    const tracker = new CostTracker({ maxAgents: 0, price: (input) => input / 1_000_000 * rate, getAgentStatus: () => ({ ...current }) });
    tracker.agentSpawned(current.id, current.task);
    tracker.agentFailed(current.id);
    expect(tracker.agentsCost()).toBe(1);
    tracker.agentSpawned(current.id, current.task); // A duplicate spawn cannot count the retired run again.
    tracker.agentCompleted(current.id); // Neither can a late terminal event.
    expect(tracker.agents()).toHaveLength(0);
    expect(tracker.agentsCost()).toBe(1);
    rate = 2;
    tracker.agentRunning(current.id);
    tracker.agentRunning(current.id);
    expect(tracker.agents()[0]?.status).toBe('running');
    expect(tracker.agentsCost()).toBe(2); // Same cumulative quote as a retained row at the new rate.
    current.usage!.inputTokens = 2_000_000;
    expect(tracker.pollRunningAgents()).toBe(true);
    expect(tracker.agentsCost()).toBe(4);
    tracker.agentCompleted(current.id);
    tracker.agentCompleted(current.id);
    expect(tracker.agents()).toHaveLength(0);
    expect(tracker.agentsCost()).toBe(4);
  });

  test('a retained wake leaves terminal eviction order and polls until its next outcome', () => {
    const current = record('woken');
    const tracker = new CostTracker({ maxAgents: 2, price, getAgentStatus: (id) => id === current.id ? current : record(id) });
    tracker.agentSpawned(current.id, current.task);
    tracker.agentFailed(current.id);
    tracker.agentSpawned('other', 'Other');
    tracker.agentCompleted('other');
    tracker.agentRunning(current.id);
    tracker.agentSpawned('active', 'Active');
    expect(tracker.agents().map((row) => row.agentId)).toEqual([current.id, 'active']);
    current.usage!.inputTokens = 2_000_000;
    expect(tracker.pollRunningAgents()).toBe(true);
    expect(tracker.agents()[0]).toMatchObject({ status: 'running', cost: 2 });
    tracker.agentCompleted(current.id);
    tracker.agentSpawned('next', 'Next');
    expect(tracker.agents().map((row) => row.agentId)).toEqual(['active', 'next']);
    expect(tracker.agentsCost()).toBe(4);
  });

  test('an evicted owner wake stays excluded and cancelled rows never reopen', () => {
    const records = new Map([['owner', record('owner', 5_000_000, 'owner')], ['cancelled', record('cancelled')]]);
    const tracker = new CostTracker({ maxAgents: 0, price, getAgentStatus: (id) => records.get(id) ?? null });
    tracker.agentSpawned('owner', 'Owner');
    tracker.agentCompleted('owner');
    tracker.agentSpawned('cancelled', 'Cancelled');
    tracker.agentCancelled('cancelled');
    tracker.agentRunning('cancelled');
    expect(tracker.agents()).toHaveLength(0);
    tracker.agentRunning('owner');
    records.get('owner')!.usage!.inputTokens = 10_000_000;
    tracker.agentCompleted('owner');
    expect(tracker.agentsCost()).toBe(1);
    expect(tracker.agents()).toHaveLength(0);
    const retained = new CostTracker({ getAgentStatus: () => record('cancelled') });
    retained.agentSpawned('cancelled', 'Cancelled');
    retained.agentCancelled('cancelled');
    retained.agentRunning('cancelled');
    expect(retained.agents()[0]?.status).toBe('cancelled');
  });
});

describe('cost quote provenance', () => {
  test('cost and source use the same single resolver answer, including cache rates', () => {
    let calls = 0;
    setModelPricingResolver(() => ++calls === 1
      ? { status: 'priced', source: 'provider', asOf: '2026-10-01', rates: { inputPerMTok: 2, outputPerMTok: 4, cacheReadPerMTok: 0.5, cacheWritePerMTok: 3 } }
      : { status: 'priced', source: 'user', rates: { inputPerMTok: 99, outputPerMTok: 99 } });
    const current = record('quoted');
    current.usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, llmCallCount: 1, turnCount: 1 };
    const tracker = new CostTracker({ getAgentStatus: () => current });
    tracker.agentSpawned(current.id, current.task);
    tracker.agentCancelled(current.id);
    expect(calls).toBe(1);
    expect(tracker.agents()[0]).toMatchObject({ cost: 9.5, priced: true, pricingSource: 'provider', pricingAsOf: '2026-10-01' });
  });

  test('provenance-only changes notify live readers and stale provenance is removed', () => {
    const current = record('live');
    const tracker = new CostTracker({ getAgentStatus: () => current });
    setModelPricingResolver(() => ({ status: 'priced', source: 'catalog', asOf: '2026-09-30', rates: { inputPerMTok: 1, outputPerMTok: 0 } }));
    tracker.agentSpawned(current.id, current.task);
    expect(tracker.pollRunningAgents()).toBe(true);
    expect(tracker.pollRunningAgents()).toBe(false);
    setModelPricingResolver(() => ({ status: 'priced', source: 'user', rates: { inputPerMTok: 1, outputPerMTok: 0 } }));
    expect(tracker.pollRunningAgents()).toBe(true);
    expect(tracker.agents()[0]).toMatchObject({ cost: 1, priced: true, pricingSource: 'user', pricingAsOf: undefined });
  });

  test('real free pricing differs from unknown and preserves the explicit free-tier convention', () => {
    setModelPricingResolver(() => ({ status: 'unknown' }));
    expect(resolveSessionCost(1_000_000, 0, 0, 0, 'cost-tracker-terminal:absent')).toMatchObject({ cost: 0, priced: false });
    setModelPricingResolver(() => ({ status: 'priced', source: 'user', rates: { inputPerMTok: 9, outputPerMTok: 9 } }));
    expect(resolveSessionCost(1_000_000, 0, 0, 0, 'fixture:free')).toEqual({ cost: 0, priced: true, source: 'catalog' });
    expect(calcSessionCost(1_000_000, 0, 0, 0, 'fixture:free')).toBe(0);
  });

  test('unpriced lifetime usage remains visible after its detail row is evicted', () => {
    setModelPricingResolver(() => ({ status: 'unknown' }));
    const tracker = new CostTracker({ maxAgents: 0, getAgentStatus: (id) => record(id) });
    tracker.agentSpawned('unknown', 'Unknown price');
    tracker.agentCompleted('unknown');
    expect(tracker.agents()).toHaveLength(0);
    expect(tracker.agentsCost()).toBe(0);
    expect(tracker.hasUnpricedAgentUsage()).toBe(true);
    const free = new CostTracker({ maxAgents: 0, getAgentStatus: (id) => ({ ...record(id), model: 'fixture:free' }) });
    free.agentSpawned('free', 'Free price');
    free.agentCompleted('free');
    expect(free.agentsCost()).toBe(0);
    expect(free.hasUnpricedAgentUsage()).toBe(false);
  });

  test('legacy explicit SessionPricer is priced without a fabricated source', () => {
    const tracker = new CostTracker({ price: () => 0, getAgentStatus: (id) => record(id) });
    tracker.agentSpawned('custom', 'Custom');
    tracker.agentCompleted('custom');
    expect(tracker.agents()[0]).toMatchObject({ cost: 0, priced: true });
    expect(tracker.agents()[0]?.pricingSource).toBeUndefined();
    expect(tracker.agents()[0]?.pricingAsOf).toBeUndefined();
  });

  test('a priced wake resolves only its own retired unknown usage', () => {
    let known = false;
    setModelPricingResolver(() => known
      ? { status: 'priced', source: 'user', rates: { inputPerMTok: 2, outputPerMTok: 0 } }
      : { status: 'unknown' });
    const tracker = new CostTracker({ maxAgents: 0, getAgentStatus: (id) => record(id) });
    for (const id of ['first', 'second']) {
      tracker.agentSpawned(id, id);
      tracker.agentFailed(id);
    }
    expect(tracker.hasUnpricedAgentUsage()).toBe(true);
    known = true;
    tracker.agentRunning('first');
    tracker.agentCompleted('first');
    expect(tracker.hasUnpricedAgentUsage()).toBe(true);
    expect(tracker.agentsCost()).toBe(2);
    tracker.agentRunning('second');
    expect(tracker.agents()[0]).toMatchObject({ priced: true, pricingSource: 'user', cost: 2 });
    tracker.agentCompleted('second');
    expect(tracker.hasUnpricedAgentUsage()).toBe(false);
    expect(tracker.agentsCost()).toBe(4);
  });
});
