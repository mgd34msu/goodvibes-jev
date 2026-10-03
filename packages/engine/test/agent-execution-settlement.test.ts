import { expect, test } from 'bun:test';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { AgentManager, type AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function manager(runAgent: (record: AgentRecord) => Promise<void>) {
  return new AgentManager({
    configManager: { get: () => null } as unknown as Pick<ConfigManager, 'get'>,
    messageBus: { registerAgent() {} },
    archetypeLoader: { loadArchetype: () => null },
    executor: { runAgent },
  });
}
const spawn = (m: AgentManager) => m.spawn({ mode: 'spawn', task: 'test', outsideContract: true });

test('join waits for actual executor finally after outward cancellation, isolated to that agent', async () => {
  const cleanup = deferred();
  const unrelated = deferred();
  let count = 0;
  const m = manager(async (record) => {
    if (++count === 2) return unrelated.promise;
    record.status = 'running';
    try {
      await new Promise<void>((resolve) => m.getCancellationSignal(record.id)!.addEventListener('abort', () => resolve(), { once: true }));
    } finally {
      await cleanup.promise;
    }
  });
  const record = spawn(m);
  const other = spawn(m);
  let joined = false;
  const barrier = m.join(record.id).then(() => { joined = true; });
  m.cancel(record.id);
  expect(record.status).toBe('cancelled');
  await tick();
  expect(joined).toBe(false);
  expect(other.status).toBe('pending');
  cleanup.resolve();
  await barrier;
  unrelated.resolve();
  await m.join(other.id);
});

test('join is reserved before executor invocation and terminal status is not settlement', async () => {
  const cleanup = deferred();
  let joined = false;
  let barrier!: Promise<void>;
  const m = manager(async (record) => {
    barrier = m.join(record.id).then(() => { joined = true; });
    record.status = 'completed';
    await cleanup.promise;
  });
  spawn(m);
  await tick();
  expect(joined).toBe(false);
  cleanup.resolve();
  await barrier;
});

test('spawn observers can join and cancel before execution starts without missing the reservation', async () => {
  let invocations = 0;
  let joined = false;
  let barrier!: Promise<void>;
  const m = new AgentManager({
    configManager: { get: () => null } as unknown as Pick<ConfigManager, 'get'>,
    archetypeLoader: { loadArchetype: () => null },
    executor: { runAgent: async () => { invocations += 1; } },
    messageBus: { registerAgent({ agentId }) {
      barrier = m.join(agentId).then(() => { joined = true; });
      expect(joined).toBe(false);
      m.cancel(agentId);
    } },
  });
  const record = spawn(m);
  expect(record.status).toBe('cancelled');
  expect(invocations).toBe(0);
  await barrier;
});

test('wake admission waits for prior finally, and join includes both actual invocations', async () => {
  const first = deferred();
  const second = deferred();
  let runs = 0;
  const m = manager(async (record) => {
    record.status = 'failed';
    await (++runs === 1 ? first.promise : second.promise);
  });
  const record = spawn(m);
  expect(m.wakeWithSteer(record.id, 'retry').woke).toBe(true);
  let joined = false;
  const barrier = m.join(record.id).then(() => { joined = true; });
  await tick();
  expect(runs).toBe(1);
  expect(joined).toBe(false);
  first.resolve();
  await tick();
  expect(runs).toBe(2);
  expect(joined).toBe(false);
  second.resolve();
  await barrier;
});


for (const status of ['failed', 'completed'] as const) {
  test(`cancel aborts actual cleanup after ${status} without changing outward status`, async () => {
    const cleanup = deferred();
    let signal!: AbortSignal;
    const m = manager(async (record) => {
      signal = m.getCancellationSignal(record.id)!;
      record.status = status;
      await cleanup.promise;
    });
    const record = spawn(m);
    m.cancel(record.id);
    expect(signal.aborted).toBe(true);
    expect(record.status).toBe(status);
    let joined = false;
    const barrier = m.join(record.id).then(() => { joined = true; });
    await tick();
    expect(joined).toBe(false);
    cleanup.resolve();
    await barrier;
  });
}

test('cancel while a wake is queued prevents it starting; a later independent wake gets a fresh signal', async () => {
  const first = deferred();
  const later = deferred();
  const signals: AbortSignal[] = [];
  let runs = 0;
  const m = manager(async (record) => {
    signals.push(m.getCancellationSignal(record.id)!);
    record.status = 'failed';
    await (++runs === 1 ? first.promise : later.promise);
  });
  const record = spawn(m);
  expect(m.wakeWithSteer(record.id, 'queued').woke).toBe(true);
  m.cancel(record.id);
  expect(record.status).toBe('failed');
  expect(signals[0]!.aborted).toBe(true);
  first.resolve();
  await m.join(record.id);
  expect(runs).toBe(1);
  expect(m.wakeWithSteer(record.id, 'new independent wake').woke).toBe(true);
  expect(runs).toBe(2);
  expect(signals[1]!.aborted).toBe(false);
  later.resolve();
  await m.join(record.id);
});

test('completed execution ledgers are reclaimed without removing a reentrant wake', async () => {
  const first = deferred();
  const second = deferred();
  let runs = 0;
  const m = manager(async (record) => {
    record.status = 'failed';
    await (++runs === 1 ? first.promise : second.promise);
  });
  const record = spawn(m);
  const entries = Reflect.get(m, 'executions') as Map<string, unknown>;
  expect(entries.size).toBe(1);
  m.wakeWithSteer(record.id, 'queued');
  first.resolve();
  await tick();
  expect(entries.size).toBe(1);
  second.resolve();
  await m.join(record.id);
  expect(entries.size).toBe(0);
});


test('a stale phase signal and release cannot abort or detach an independent newer wake', async () => {
  const first = deferred();
  const second = deferred();
  let count = 0;
  let newSignal!: AbortSignal;
  const m = manager(async (record) => {
    record.status = 'failed';
    if (++count === 1) { await first.promise; return; }
    newSignal = m.getCancellationSignal(record.id)!;
    await second.promise;
  });
  const record = spawn(m);
  const oldPhase = new AbortController();
  m.registerCancellationSignal(record.id, oldPhase.signal);
  oldPhase.abort();
  first.resolve();
  await m.join(record.id);
  expect(m.wakeWithSteer(record.id, 'fresh execution').woke).toBe(true);
  expect(newSignal.aborted).toBe(false);
  m.releaseCancellationSignal(record.id, oldPhase.signal);
  expect(m.getCancellationSignal(record.id)).toBe(newSignal);
  m.cancel(record.id);
  expect(newSignal.aborted).toBe(true);
  second.resolve();
  await m.join(record.id);
});


test('a cancellation snapshot does not abort a later wake admitted by an abort listener', async () => {
  const first = deferred();
  const second = deferred();
  const signals: AbortSignal[] = [];
  let runs = 0;
  const m = manager(async (record) => {
    signals.push(m.getCancellationSignal(record.id)!);
    record.status = 'failed';
    await (++runs === 1 ? first.promise : second.promise);
  });
  const record = spawn(m);
  signals[0]!.addEventListener('abort', () => {
    expect(m.wakeWithSteer(record.id, 'later admission').reason).toContain('waiting for prior execution cleanup');
  }, { once: true });
  m.cancel(record.id);
  first.resolve();
  await tick();
  expect(runs).toBe(2);
  expect(signals[1]!.aborted).toBe(false);
  second.resolve();
  await m.join(record.id);
});
