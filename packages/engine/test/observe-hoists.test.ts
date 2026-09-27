/**
 * The TUI's eval registry and cost tracking data model, hoisted into the
 * engine's observe subsystem: newest-result-per-suite bookkeeping with
 * notify, and session and agent cost rows driven by the turn and agent feeds.
 */
import { describe, expect, test } from 'bun:test';
import { CostTracker, EvalRegistry } from '../sdk/src/platform/observe/index.ts';
import type { EvalGateResult, EvalSuiteResult } from '../sdk/src/platform/runtime/eval/types.ts';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/record.ts';
import type { UiEventFeed } from '../sdk/src/platform/runtime/ui-events.ts';
import type { AgentEvent, TurnEvent } from '../sdk/src/platform/runtime/events/index.ts';

const suite = (name: string, meanScore: number): EvalSuiteResult => ({ suite: name, startedAt: 0, finishedAt: 1, results: [], meanScore, passed: true });

describe('EvalRegistry', () => {
  test('keeps the newest suite and gate result per suite and notifies on each change', () => {
    let now = 1_000;
    const registry = new EvalRegistry(() => now);
    let notified = 0;
    const unsubscribe = registry.subscribe(() => notified++);
    registry.setRunning(true);
    registry.push(suite('core', 70));
    now = 2_000;
    registry.push(suite('safety', 90));
    registry.push(suite('core', 80));
    registry.pushGate({ suite: 'core', passed: false } as EvalGateResult);
    registry.pushGate({ suite: 'core', passed: true } as EvalGateResult);
    registry.setRunning(false);
    expect(registry.getSuiteResults().map((result) => [result.suite, result.meanScore])).toEqual([['core', 80], ['safety', 90]]);
    expect(registry.getGateResults().map((gate) => [gate.suite, gate.passed])).toEqual([['core', true]]);
    expect(registry.getLastRunAt()).toBe(2_000);
    expect(registry.isRunning()).toBe(false);
    expect(notified).toBe(7);
    unsubscribe();
    registry.setRunning(true);
    expect(notified).toBe(7);
  });

  test('has no run time before the first suite result', () => {
    expect(new EvalRegistry().getLastRunAt()).toBeNull();
  });
});

/** A feed the test fires by hand. */
function manualFeed<E extends { type: string }>() {
  const listeners = new Map<string, Array<(payload: E) => void>>();
  const feed = {
    on(type: string, listener: (payload: E) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      return () => listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
    },
    onEnvelope() {
      return () => {};
    },
  } as unknown as UiEventFeed<E & TurnEvent & AgentEvent>;
  const fire = (payload: E) => {
    for (const listener of listeners.get(payload.type) ?? []) listener(payload);
  };
  return { feed, fire };
}

/** $1 per 1M input-side tokens (fresh plus cache) and $2 per 1M output, on any model but 'free'. */
const price = (input: number, output: number, cacheRead: number, cacheWrite: number, model: string): number =>
  model === 'free' ? 0 : (input + cacheRead + cacheWrite + 2 * output) / 1_000_000;

const record = (usage: Partial<NonNullable<AgentRecord['usage']>>, model = 'm1'): AgentRecord =>
  ({ id: 'agent-1234567890', model, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, ...usage } }) as AgentRecord;

describe('CostTracker', () => {
  test('refreshes session usage from the turn feed and keeps a bounded history of cost deltas', () => {
    const turns = manualFeed<TurnEvent>();
    const agents = manualFeed<AgentEvent>();
    const tracker = new CostTracker({ price, historyLength: 3 });
    let usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, model: 'm1' };
    const detach = tracker.attach(turns.feed as UiEventFeed<TurnEvent>, agents.feed as UiEventFeed<AgentEvent>, () => usage);
    turns.fire({ type: 'TURN_COMPLETED' } as TurnEvent);
    usage = { ...usage, output: 500_000 };
    turns.fire({ type: 'LLM_RESPONSE_RECEIVED' } as TurnEvent);
    usage = { ...usage, cacheRead: 1_000_000 };
    turns.fire({ type: 'TURN_COMPLETED' } as TurnEvent);
    turns.fire({ type: 'TURN_COMPLETED' } as TurnEvent);
    expect(tracker.sessionModel()).toBe('m1');
    expect(tracker.sessionUsage()).toEqual({ input: 1_000_000, output: 500_000, cacheRead: 1_000_000, cacheWrite: 0 });
    expect(tracker.sessionCost()).toBeCloseTo(3, 10);
    expect(tracker.costHistory()).toEqual([1, 1, 0]);
    detach();
    usage = { ...usage, input: 9_000_000 };
    turns.fire({ type: 'TURN_COMPLETED' } as TurnEvent);
    expect(tracker.sessionUsage().input).toBe(1_000_000);
  });

  test('a sync takes counters only, with no history point and no model change', () => {
    const tracker = new CostTracker({ price });
    tracker.refreshSession({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: 'm1' });
    tracker.syncSession({ input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(tracker.costHistory()).toEqual([0]);
    expect(tracker.sessionModel()).toBe('m1');
    expect(tracker.sessionCost()).toBeCloseTo(2, 10);
  });

  test('agent rows follow spawn, completion with real usage, failure and running polls', () => {
    const turns = manualFeed<TurnEvent>();
    const agents = manualFeed<AgentEvent>();
    const records = new Map<string, AgentRecord>();
    const tracker = new CostTracker({ price, getAgentStatus: (id) => records.get(id) ?? null });
    tracker.attach(turns.feed as UiEventFeed<TurnEvent>, agents.feed as UiEventFeed<AgentEvent>, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
    agents.fire({ type: 'AGENT_SPAWNING', agentId: 'agent-1234567890', task: 'write the parser' } as AgentEvent);
    agents.fire({ type: 'AGENT_SPAWNING', agentId: 'agent-abcdefghij', task: 'review' } as AgentEvent);
    agents.fire({ type: 'AGENT_SPAWNING', agentId: 'agent-long', task: 'soak' } as AgentEvent);
    expect(tracker.agents().map((row) => [row.shortId, row.status, row.cost])).toEqual([
      ['agent-12', 'running', 0],
      ['agent-ab', 'running', 0],
      ['agent-lo', 'running', 0],
    ]);

    records.set('agent-1234567890', record({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 500_000 }, 'm2'));
    agents.fire({ type: 'AGENT_COMPLETED', agentId: 'agent-1234567890' } as AgentEvent);
    agents.fire({ type: 'AGENT_FAILED', agentId: 'agent-abcdefghij' } as AgentEvent);
    const [done, failed] = tracker.agents();
    expect(done).toMatchObject({ status: 'done', model: 'm2', inputTokens: 1_500_000, outputTokens: 1_000_000 });
    expect(done!.cost).toBeCloseTo(3.5, 10);
    expect(failed).toMatchObject({ status: 'failed', cost: 0 });

    expect(tracker.pollRunningAgents()).toBe(false);
    records.set('agent-long', record({ inputTokens: 2_000_000 }, 'unknown'));
    expect(tracker.pollRunningAgents()).toBe(true);
    expect(tracker.agents()[2]).toMatchObject({ status: 'running', model: 'unknown', inputTokens: 2_000_000 });
    expect(tracker.pollRunningAgents()).toBe(false);
    expect(tracker.agentsCost()).toBeCloseTo(5.5, 10);
  });

  test('without an agent status source, completed agents stay at zero rather than a made-up figure', () => {
    const tracker = new CostTracker({ price });
    tracker.agentSpawned('agent-x', 'task');
    tracker.agentCompleted('agent-x');
    tracker.agentCompleted('agent-missing');
    expect(tracker.agents()).toEqual([expect.objectContaining({ status: 'done', cost: 0, inputTokens: 0 })]);
    expect(tracker.pollRunningAgents()).toBe(false);
  });
});
