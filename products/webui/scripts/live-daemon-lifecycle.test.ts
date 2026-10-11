import { expect, test } from 'bun:test';
import { requireSessionCloseReceipt, type LifecycleHandlers } from './live-daemon-lifecycle';

const session = { id: 'owned-session', status: 'closed' };
const receipt = { event: 'session-closed', payload: session };
function harness(close: () => Promise<unknown> = async () => ({ session }), timeoutMs = 30) {
  let handlers!: LifecycleHandlers;
  let disposed = 0;
  let calls = 0;
  const pending = requireSessionCloseReceipt({
    sessionId: session.id, eventName: 'session-update', timeoutMs,
    close: () => { calls++; return close(); },
    open: async (value) => { handlers = value; return () => { disposed++; }; },
  });
  return { pending, get handlers() { return handlers; }, get disposed() { return disposed; }, get calls() { return calls; } };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('requires close acknowledgement and exact closed-session frame, with repeated ready issuing once', async () => {
  const h = harness(); await tick(); h.handlers.onReady(); h.handlers.onReady();
  h.handlers.onEvent('session-update', receipt); await h.pending;
  expect(h.calls).toBe(1); expect(h.disposed).toBe(1);
  h.handlers.onReady(); h.handlers.onEvent('session-update', receipt);
  expect(h.calls).toBe(1); expect(h.disposed).toBe(1);
});

test('matching event cannot turn a rejected close into success', async () => {
  const h = harness(async () => { throw new Error('refused'); });
  const rejection = h.pending.catch((error: unknown) => error);
  await tick(); h.handlers.onReady(); h.handlers.onEvent('session-update', receipt);
  expect(String(await rejection)).toContain('sessions.close failed'); expect(h.disposed).toBe(1);
});

for (const response of [{}, { session: { ...session, id: 'other' } }, { session: { ...session, status: 'active' } }]) {
  test(`rejects invalid close acknowledgement ${JSON.stringify(response)}`, async () => {
    const h = harness(async () => response);
    const rejection = h.pending.catch((error: unknown) => error);
    await tick(); h.handlers.onReady(); h.handlers.onEvent('session-update', receipt);
    expect(String(await rejection)).toContain('did not acknowledge'); expect(h.disposed).toBe(1);
  });
}

test('readiness and successful close alone cannot pass without the matching frame', async () => {
  const h = harness(); const rejection = h.pending.catch((error: unknown) => error);
  await tick(); h.handlers.onEvent('session-update', receipt); h.handlers.onReady();
  h.handlers.onEvent('other', receipt);
  h.handlers.onEvent('session-update', { ...receipt, event: 'session-created' });
  h.handlers.onEvent('session-update', { ...receipt, payload: { ...session, id: 'other' } });
  h.handlers.onEvent('session-update', { ...receipt, payload: { ...session, status: 'active' } });
  expect(String(await rejection)).toContain('matchingFrame=false'); expect(h.calls).toBe(1); expect(h.disposed).toBe(1);
});

test('late readiness after timeout never starts a mutation', async () => {
  const h = harness(); await expect(h.pending).rejects.toThrow('ready=false');
  h.handlers.onReady(); await tick(); expect(h.calls).toBe(0); expect(h.disposed).toBe(1);
});

for (const method of ['onError', 'onTerminate'] as const) {
  test(`${method} interrupts proof, late ready cannot issue close`, async () => {
    const h = harness(); const rejection = h.pending.catch((error: unknown) => error);
    await tick(); h.handlers[method](new Error('disconnected')); expect(String(await rejection)).toContain('stream');
    h.handlers.onReady(); await tick(); expect(h.calls).toBe(0); expect(h.disposed).toBe(1);
  });
}

test('late opener is disposed after synchronous proof callbacks complete', async () => {
  let disposed = 0;
  await requireSessionCloseReceipt({
    sessionId: session.id, eventName: 'session-update', close: async () => ({ session }),
    open: async (handlers) => {
      handlers.onReady(); handlers.onEvent('session-update', receipt);
      await tick(); return () => { disposed++; };
    },
  });
  await tick(); expect(disposed).toBe(1);
});

test('opener rejection is a failure', async () => {
  await expect(requireSessionCloseReceipt({
    sessionId: session.id, eventName: 'session-update', close: async () => ({ session }),
    open: async () => { throw new Error('cannot connect'); },
  })).rejects.toThrow('could not open');
});

test('interruption after ready but before dispatch prevents the scheduled close', async () => {
  const h = harness(); const failure = h.pending.catch((error: unknown) => error);
  await tick(); h.handlers.onReady(); h.handlers.onTerminate({ reason: 'lost connection' });
  expect(String(await failure)).toContain('terminated'); await tick();
  expect(h.calls).toBe(0); expect(h.disposed).toBe(1);
});

test('frame cannot complete proof while acknowledgement is still pending', async () => {
  let acknowledge!: (value: unknown) => void;
  const h = harness(() => new Promise((resolve) => { acknowledge = resolve; }));
  let complete = false; void h.pending.then(() => { complete = true; });
  await tick(); h.handlers.onReady(); await tick(); h.handlers.onEvent('session-update', receipt);
  await tick(); expect(complete).toBe(false); expect(h.disposed).toBe(0);
  acknowledge({ session }); await h.pending; expect(h.disposed).toBe(1);
});

test('throwing disposer rejects successful proof rather than leaving it pending', async () => {
  await expect(requireSessionCloseReceipt({
    sessionId: session.id, eventName: 'session-update', close: async () => ({ session }),
    open: async (handlers) => {
      handlers.onReady(); handlers.onEvent('session-update', receipt);
      return () => { throw new Error('disposer failed'); };
    },
  })).rejects.toThrow('cleanup failed');
});

test('throwing disposer preserves the original close failure', async () => {
  await expect(requireSessionCloseReceipt({
    sessionId: session.id, eventName: 'session-update',
    close: async () => { throw new Error('close refused'); },
    open: async (handlers) => {
      handlers.onReady();
      return () => { throw new Error('disposer failed'); };
    },
  })).rejects.toThrow('sessions.close failed');
});

test('late throwing disposer after timeout is attempted once without unhandled rejection', async () => {
  let deliver!: (closer: () => void) => void;
  let disposed = 0;
  const pending = requireSessionCloseReceipt({
    sessionId: session.id, eventName: 'session-update', timeoutMs: 20,
    close: async () => ({ session }), open: () => new Promise((resolve) => { deliver = resolve; }),
  });
  await expect(pending).rejects.toThrow('timed out');
  deliver(() => { disposed++; throw new Error('late cleanup failed'); });
  await tick(); expect(disposed).toBe(1);
});

test('late throwing disposer after successful callbacks still rejects cleanup', async () => {
  await expect(requireSessionCloseReceipt({
    sessionId: session.id, eventName: 'session-update', close: async () => ({ session }),
    open: async (handlers) => {
      handlers.onReady(); handlers.onEvent('session-update', receipt);
      await tick(); return () => { throw new Error('late cleanup failed'); };
    },
  })).rejects.toThrow('cleanup failed');
});
