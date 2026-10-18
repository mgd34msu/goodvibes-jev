import { afterEach, expect, test } from 'bun:test';
import { OrchestratorFollowUpRuntime } from '../sdk/src/platform/core/orchestrator-follow-up-runtime.js';
import type { ConversationFollowUpItem } from '../sdk/src/platform/core/conversation-follow-ups.js';

const runtimes: OrchestratorFollowUpRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.dispose(); });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(resumeWork: (items: readonly ConversationFollowUpItem[], signal: AbortSignal) => Promise<void>) {
  const state = { isThinking: false, isCompacting: false }, failures: string[] = [];
  let queued = 0;
  const runtime = new OrchestratorFollowUpRuntime({ getThinkingState: () => state,
    getQueuedUserMessageCount: () => queued, routeLowPriorityMessage: message => failures.push(message), resumeWork });
  runtimes.push(runtime);
  return { runtime, state, failures, setQueued: (count: number) => { queued = count; } };
}

test('both completed results and failure notices resume checked execution without an acknowledgement path', async () => {
  const received: ConversationFollowUpItem[] = [];
  const f = fixture(async items => { received.push(...items); });
  const result = 'full finding with all supporting evidence';
  f.runtime.enqueue({ key: 'passed', summary: 'Contract passed', result });
  f.runtime.enqueue({ key: 'failed', summary: 'Planner failed; original review is unfinished' });
  await flush();
  expect(received).toEqual([{ key: 'passed', summary: 'Contract passed', result },
    { key: 'failed', summary: 'Planner failed; original review is unfinished' }]);
  expect(f.failures).toEqual([]);
});

test('busy turns and pending user input retain background evidence until execution can resume', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; });
  f.state.isThinking = true;
  f.runtime.enqueue({ key: 'update', summary: 'Review needs recovery' });
  await flush(); expect(calls).toBe(0);
  f.state.isThinking = false; f.setQueued(1); f.runtime.scheduleFlush();
  await flush(); expect(calls).toBe(0);
  f.setQueued(0); f.runtime.scheduleFlush();
  await flush(); expect(calls).toBe(1);
});

test('cancellation aborts the recovery and requeued work receives a fresh signal', async () => {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const f = fixture(async (_items, signal) => { signals.push(signal); entered.resolve(); if (signals.length === 1) await released.promise; signal.throwIfAborted(); });
  f.runtime.enqueue({ key: 'update', summary: 'Recover review' });
  await entered.promise; f.runtime.cancel(true); released.resolve(); await flush();
  f.runtime.scheduleFlush(); await flush();
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]).not.toBe(signals[0]);
  expect(f.failures).toEqual([]);
});

test('duplicate event keys do not resume twice and distinct outcomes remain distinct', async () => {
  const received: ConversationFollowUpItem[] = [];
  const f = fixture(async items => { received.push(...items); });
  f.runtime.enqueue({ key: 'a', summary: 'Failed' });
  f.runtime.enqueue({ key: 'a', summary: 'Failed' });
  f.runtime.enqueue({ key: 'b', summary: 'Failed' });
  await flush();
  f.runtime.enqueue({ key: 'a', summary: 'Failed' }); await flush();
  expect(received.map(item => item.key)).toEqual(['a', 'b']);
});
