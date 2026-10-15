import { expect, test } from 'bun:test';
import { executeHeadlessTurn } from '../../cli/native-headless-turn.ts';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';

function fixture() {
  const contract = { id: 'owned', status: 'running', answer: undefined as string | undefined };
  const previous = { id: 'previous', status: 'running' };
  const subscribers = new Set<() => void>();
  const events = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
  const cancelled: string[] = [];
  let started = false;
  let joined = false;
  let ready!: () => void;
  const submitted = new Promise<void>(resolve => { ready = resolve; });
  const runner = {
    list: () => started ? [previous, contract] : [previous],
    get: () => contract,
    on: (callback: () => void) => { subscribers.add(callback); return () => { subscribers.delete(callback); }; },
    join: async () => { joined = true; },
    cancel: (id: string) => { cancelled.push(id); contract.status = 'cancelled'; for (const callback of subscribers) callback(); },
  };
  const ctx = {
    runtime: { sessionId: 'session', model: 'model', provider: 'provider' },
    uiServices: { agents: { contractRunner: runner, agentManager: { list: () => [], cancel() {} } } },
    runtimeBus: { on: (name: string, callback: (event: { payload: Record<string, unknown> }) => void) => { events.set(name, callback); return () => { events.delete(name); }; } },
    orchestrator: {
      abort() {},
      async handleUserInput() {
        started = true;
        events.get('TURN_COMPLETED')!({ payload: { response: 'I will review it.', stopReason: 'completed' } });
        ready();
      },
    },
  } as unknown as BootstrapContext;
  return { ctx, submitted, cancelled, joined: () => joined,
    finish: () => { contract.answer = 'Verified review findings.'; contract.status = 'passed'; for (const callback of subscribers) callback(); },
  };
}

test('headless delegation waits for the deliverable instead of exiting after the announcement', async () => {
  const f = fixture(); let settled = false;
  const pending = executeHeadlessTurn(f.ctx, 'Review the project', new AbortController().signal, 'json');
  void pending.then(() => { settled = true; });
  await f.submitted; await Promise.resolve();
  expect(settled).toBe(false);
  f.finish();
  expect(await pending).toMatchObject({ exitCode: 0, response: 'Verified review findings.' });
  expect(f.joined()).toBe(true);
});

test('cancelling headless delegation cancels only work created by that invocation', async () => {
  const f = fixture(); const abort = new AbortController();
  const pending = executeHeadlessTurn(f.ctx, 'Review the project', abort.signal, 'json');
  await f.submitted; abort.abort();
  expect((await pending).exitCode).toBe(130);
  expect(f.cancelled).toEqual(['owned']);
});


test('headless waits for standalone agents even when the foreground response is empty', async () => {
  const done = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const agent = { id: 'child', status: 'pending', fullOutput: '' };
  let started = false;
  const events = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
  const ctx = {
    runtime: { sessionId: 'session', model: 'model', provider: 'provider' },
    uiServices: { agents: {
      contractRunner: { list: () => [] },
      agentManager: { list: () => started ? [agent] : [], getStatus: () => agent, join: () => done.promise, cancel() {} },
    } },
    runtimeBus: { on: (name: string, callback: (event: { payload: Record<string, unknown> }) => void) => { events.set(name, callback); return () => events.delete(name); } },
    orchestrator: { abort() {}, async handleUserInput() {
      started = true; events.get('TURN_COMPLETED')!({ payload: { response: '', stopReason: 'empty_response' } }); ready.resolve();
    } },
  } as unknown as BootstrapContext;
  let settled = false;
  const pending = executeHeadlessTurn(ctx, 'Review', new AbortController().signal, 'json');
  void pending.then(() => { settled = true; });
  await ready.promise; await Promise.resolve(); expect(settled).toBe(false);
  agent.fullOutput = 'Completed standalone review.'; agent.status = 'completed'; done.resolve();
  expect(await pending).toMatchObject({ exitCode: 0, response: 'Completed standalone review.' });
});
