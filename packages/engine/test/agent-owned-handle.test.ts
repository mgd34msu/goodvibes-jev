import { expect, test } from 'bun:test';
import { AgentManager, OwnedAgentExecutionUnavailableError, type AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import { run } from '../sdk/src/platform/hooks/runners/agent.js';
import { HookActivityTracker } from '../sdk/src/platform/hooks/activity.js';
import { HookDispatcher } from '../sdk/src/platform/hooks/dispatcher.js';
import { TurnHookOwner } from '../sdk/src/platform/hooks/turn-ownership.js';
import { run as runHook } from '../sdk/src/platform/hooks/runner.js';
import type { HookDefinition, HookEvent } from '../sdk/src/platform/hooks/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const event: HookEvent = { path: 'Post:tool:write', phase: 'Post', category: 'tool', specific: 'write', sessionId: 'owned-hook', timestamp: 1, payload: {} };
const hook: HookDefinition = { type: 'agent', match: event.path, prompt: 'work', timeout: 1 };
function manager(runAgent: (record: AgentRecord) => Promise<void> = async () => {}) {
  return new AgentManager({
    configManager: { get: () => null } as never,
    messageBus: { registerAgent() {} },
    archetypeLoader: { loadArchetype: () => null },
    executor: { runAgent },
  });
}

for (const status of ['completed', 'running'] as const) {
  test(`owned hook refuses legacy ${status} driver without admitting work, including empty options`, async () => {
    let starts = 0;
    const m = manager();
    m.setContractRunner({ startForOwner(owner) {
      starts += 1;
      owner.status = status;
      owner.fullOutput = 'premature answer';
      return { owner, contract: {} as never };
    } });
    expect(() => m.spawnOwned({ mode: 'spawn', task: 'work' })).toThrow(OwnedAgentExecutionUnavailableError);
    expect(starts).toBe(0);
    expect(m.list()).toHaveLength(0);
    const result = await run(hook, event, m, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('owned execution settlement');
    expect(result.code).toBe('OWNED_AGENT_EXECUTION_UNSUPPORTED');
    expect(starts).toBe(0);
    expect(m.list()).toHaveLength(0);
  });
}

test('legacy manager structural mocks are refused before spawn on the owned hook path', async () => {
  let starts = 0;
  const result = await run(hook, event, {
    spawn: () => { starts += 1; throw new Error('must not spawn'); },
    getStatus: () => null,
    cancel: () => true,
  }, {});
  expect(result.error).toContain('captured execution settlement');
  expect(result.code).toBe('OWNED_AGENT_EXECUTION_UNSUPPORTED');
  expect(starts).toBe(0);
});

test('captured original snapshot and stale cancellation do not follow a queued wake', async () => {
  const first = deferred();
  const next = deferred();
  const signals: AbortSignal[] = [];
  let starts = 0;
  const m = manager(async (record) => {
    signals.push(m.getCancellationSignal(record.id)!);
    if (++starts === 1) {
      record.status = 'failed';
      record.error = 'original error';
      record.fullOutput = 'original outcome';
      await first.promise;
    } else {
      record.status = 'running';
      record.fullOutput = 'new invocation';
      await next.promise;
    }
  });
  const parent = new AbortController();
  const owned = m.spawnOwned({ mode: 'spawn', task: 'work', outsideContract: true }, { signal: parent.signal });
  expect(m.wakeWithSteer(owned.record.id, 'later invocation').woke).toBe(true);
  first.resolve();
  const outcome = await owned.settled;
  await tick();
  expect(starts).toBe(2);
  expect(outcome).toMatchObject({ status: 'failed', error: 'original error', fullOutput: 'original outcome' });
  expect(owned.record.status).toBe('running');
  owned.cancel();
  parent.abort();
  expect(signals[1]!.aborted).toBe(false);
  expect(owned.record.status).toBe('running');
  next.resolve();
  await m.join(owned.record.id);
});

test('captured cancellation applies only to its original invocation, not an already queued wake', async () => {
  const first = deferred();
  const next = deferred();
  const signals: AbortSignal[] = [];
  let starts = 0;
  const m = manager(async (record) => {
    signals.push(m.getCancellationSignal(record.id)!);
    record.status = 'failed';
    await (++starts === 1 ? first.promise : next.promise);
  });
  const owned = m.spawnOwned({ mode: 'spawn', task: 'work', outsideContract: true });
  m.wakeWithSteer(owned.record.id, 'later invocation');
  owned.cancel();
  expect(signals[0]!.aborted).toBe(true);
  first.resolve();
  await owned.settled;
  await tick();
  expect(starts).toBe(2);
  expect(signals[1]!.aborted).toBe(false);
  next.resolve();
  await m.join(owned.record.id);
});

test('owned parent signal is installed before synchronous spawn publication', async () => {
  const parent = new AbortController();
  let executions = 0;
  const m = new AgentManager({
    configManager: { get: () => null } as never,
    messageBus: { registerAgent() { parent.abort(); } },
    archetypeLoader: { loadArchetype: () => null },
    executor: { runAgent: async () => { executions += 1; } },
  });
  const owned = m.spawnOwned({ mode: 'spawn', task: 'work', outsideContract: true }, { signal: parent.signal });
  expect((await owned.settled).status).toBe('cancelled');
  expect(executions).toBe(0);
});


test('owned capability diagnostic survives runner, dispatcher aggregation, and activity recording', async () => {
  expect(new OwnedAgentExecutionUnavailableError('unsupported').code).toBe('OWNED_AGENT_EXECUTION_UNSUPPORTED');
  expect((await runHook(hook, event, undefined, {})).code).toBe('OWNED_AGENT_EXECUTION_UNSUPPORTED');
  for (const async of [false, true]) {
    const activity = new HookActivityTracker();
    const dispatcher = new HookDispatcher({}, activity);
    dispatcher.register(event.path, { ...hook, async });
    const owner = new TurnHookOwner(event.sessionId, 'diagnostic-turn', new AbortController().signal);
    const result = await dispatcher.fire(event, { owner });
    await owner.closeAndDrain();
    if (!async) expect(result.code).toBe('OWNED_AGENT_EXECUTION_UNSUPPORTED');
    expect(activity.listRecent()[0]).toMatchObject({
      ok: false, code: 'OWNED_AGENT_EXECUTION_UNSUPPORTED',
      sessionId: event.sessionId, turnId: 'diagnostic-turn', hookType: 'agent', async,
    });
  }
});
