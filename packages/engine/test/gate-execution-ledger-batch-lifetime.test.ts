import { test, expect } from 'bun:test';
import type { JudgmentRequest, Questions } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { AgentExecutionLedger, forgetLedgerArgRoles } from '../sdk/src/platform/gate/policy/execution-ledger.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { emitToolReceived, emitToolCancelled } from '../sdk/src/platform/runtime/emitters/tools.ts';
const ctx = { sessionId: 'review-ledger', traceId: 'review-ledger', source: 'test' };
const call = (callId: string) => ({ callId, turnId: 'review-turn', tool: 'review-fixture' });
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
for (const terminal of ['cancel', 'dispose'] as const) test(`role failure must not orphan parallel readers across ${terminal}`, async () => {
  forgetLedgerArgRoles();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = fakePort((name, question) => name === 'kind' ? choiceAnswer(question, 'other', 0.99) : noulAnswer(0.001));
  const requests: JudgmentRequest<Questions>[] = [];
  const previous = installJudgmentPort({ model: fixture.port.model, async ask(request) {
    requests.push(request as JudgmentRequest<Questions>);
    const state = request.state as { argument?: string };
    if (state.argument === 'failFirst') throw new Error('SYNTHETIC_FAILURE');
    if (state.argument === 'lateRole') await gate;
    return fixture.port.ask(request);
  } });
  const bus = new RuntimeEventBus(); const first = new AgentExecutionLedger(bus);
  let second: AgentExecutionLedger | undefined;
  try {
    emitToolReceived(bus, ctx, { ...call('a'), args: { failFirst: 'harmless', lateRole: 'harmless' } });
    await first.settled();
    expect(first.getSnapshot().records[0]?.argsReadingError).toContain('unavailable');
    expect(requests.filter(r => (r.state as { argument?: string }).argument === 'lateRole')).toHaveLength(1);
    if (terminal === 'cancel') { emitToolCancelled(bus, ctx, { ...call('a'), reason: 'review cancelled' }); await tick(); }
    else first.dispose();
    const lateSignalAborted = requests.find(r => (r.state as { argument?: string }).argument === 'lateRole')?.signal?.aborted;
    release(); await tick();
    // A new call in another live ledger must ask again if the aborted reading did not publish.
    const bus2 = new RuntimeEventBus(); second = new AgentExecutionLedger(bus2);
    emitToolReceived(bus2, ctx, { ...call('b'), args: { lateRole: 'harmless' } });
    await second.settled();
    expect(lateSignalAborted).toBe(true);
    expect(requests.filter(r => (r.state as { argument?: string }).argument === 'lateRole')).toHaveLength(2);
  } finally { release(); first.dispose(); second?.dispose(); installJudgmentPort(previous); forgetLedgerArgRoles(); }
});
test('a failed batch must not launch queued role requests after disposal', async () => {
  forgetLedgerArgRoles();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = fakePort((name, question) => name === 'kind' ? choiceAnswer(question, 'other', 0.99) : noulAnswer(0.001));
  const requests: JudgmentRequest<Questions>[] = [];
  const previous = installJudgmentPort({ model: fixture.port.model, async ask(request) {
    requests.push(request as JudgmentRequest<Questions>);
    const state = request.state as { argument?: string };
    if (state.argument === 'failFirst') throw new Error('SYNTHETIC_FAILURE');
    await gate;
    return fixture.port.ask(request);
  } });
  const bus = new RuntimeEventBus(); const ledger = new AgentExecutionLedger(bus);
  try {
    emitToolReceived(bus, ctx, { ...call('queued'), args: { failFirst: 'harmless', ...Object.fromEntries(Array.from({length: 9}, (_, i) => [`ordinary${i}`, 'harmless'])) } });
    await ledger.settled();
    const before = requests.length;
    ledger.dispose(); release(); await tick();
    expect(before).toBe(8);
    expect(requests).toHaveLength(before);
  } finally { release(); ledger.dispose(); installJudgmentPort(previous); forgetLedgerArgRoles(); }
});

test('a recordAction callback that disposes the ledger cannot publish its role into the next ledger cache', async () => {
  forgetLedgerArgRoles();
  const fixture = fakePort((name, question) => name === 'kind' ? choiceAnswer(question, 'other', 0.99) : noulAnswer(0.001));
  const requests: JudgmentRequest<Questions>[] = [];
  const firstBus = new RuntimeEventBus();
  const first = new AgentExecutionLedger(firstBus);
  let second: AgentExecutionLedger | undefined;
  const previous = installJudgmentPort({
    model: fixture.port.model,
    async ask(request) {
      requests.push(request as JudgmentRequest<Questions>);
      return { ...await fixture.port.ask(request), decisionId: `callback-fixture-${requests.length}` };
    },
    recorder: {
      recordReadings() {},
      recordAction() { first.dispose(); },
    },
  });
  try {
    emitToolReceived(firstBus, ctx, { ...call('callback-first'), args: { ordinary: 'harmless' } });
    await first.settled();
    await tick();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal?.aborted).toBe(true);
    const secondBus = new RuntimeEventBus();
    second = new AgentExecutionLedger(secondBus);
    emitToolReceived(secondBus, ctx, { ...call('callback-second'), args: { ordinary: 'harmless' } });
    await second.settled();
    expect(requests.filter((request) => (request.state as { argument?: string }).argument === 'ordinary')).toHaveLength(2);
    expect(second.getSnapshot().records[0]?.argsPreview).toContain('harmless');
  } finally {
    first.dispose(); second?.dispose(); installJudgmentPort(previous); forgetLedgerArgRoles();
  }
});
