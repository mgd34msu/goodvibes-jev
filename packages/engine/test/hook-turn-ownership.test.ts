import { HookActivityTracker } from '../sdk/src/platform/hooks/activity.ts';
import { expect, test } from 'bun:test';
import { TurnHookOwner } from '../sdk/src/platform/hooks/turn-ownership.ts';

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('ownership is reserved before synchronous reentrant drain and cancellation', async () => {
  const abort = new AbortController();
  const owner = new TurnHookOwner('session', 'turn', abort.signal);
  const held = gate();
  let nested: Promise<void> | undefined;
  const work = owner.admit(() => { nested = owner.closeAndDrain(); abort.abort(); return held.promise; });
  expect(owner.closeAndDrain()).toBe(nested!);
  let settled = false;
  void nested!.then(() => { settled = true; });
  await tick();
  expect(settled).toBe(false);
  let started = false;
  await expect(owner.admit(() => { started = true; })).rejects.toThrow('admission is closed');
  expect(started).toBe(false);
  held.release();
  await Promise.all([work, nested!]);
  expect(settled).toBe(true);
});

test('normal drain includes later async work from an already-admitted dispatch', async () => {
  const owner = new TurnHookOwner('session', 'turn', new AbortController().signal);
  const first = gate();
  const second = gate();
  let secondStarted = false;
  const dispatch = owner.dispatch(async (admitHook) => {
    await admitHook(() => first.promise);
    void admitHook(() => { secondStarted = true; return second.promise; });
  });
  let drained = false;
  const drain = owner.closeAndDrain().then(() => { drained = true; });
  first.release();
  await dispatch;
  await tick();
  expect(secondStarted).toBe(true);
  expect(drained).toBe(false);
  second.release();
  await drain;
  expect(drained).toBe(true);
});

test('cancel prevents later hooks even within an admitted dispatch and other scopes survive', async () => {
  const abort = new AbortController();
  const a = new TurnHookOwner('session-a', 'turn-a', abort.signal);
  const b = new TurnHookOwner('session-b', 'turn-b', new AbortController().signal);
  const held = gate();
  let laterStarted = false;
  const dispatch = a.dispatch(async (admitHook) => {
    await admitHook(() => held.promise);
    await admitHook(() => { laterStarted = true; });
  });
  const rejected = dispatch.catch(() => {});
  abort.abort();
  held.release();
  await Promise.all([rejected, a.closeAndDrain()]);
  expect(laterStarted).toBe(false);
  expect(await b.admit(() => 'unaffected')).toBe('unaffected');
  await b.closeAndDrain();
});


test('owned hook activity retains exact turn identity and typed no-admission diagnostics', () => {
  const tracker = new HookActivityTracker();
  tracker.record({ path: 'Post:tool:read', phase: 'Post', category: 'tool', specific: 'read', sessionId: 'session', timestamp: 1, payload: {} }, {
    pattern: 'Post:tool:*', hookType: 'command', result: { ok: false, code: 'OWNED_PROCESS_GROUP_UNSUPPORTED', error: 'command was not started' }, durationMs: 0, async: true, turnId: 'turn',
  });
  expect(tracker.listRecent()[0]).toMatchObject({ sessionId: 'session', turnId: 'turn', code: 'OWNED_PROCESS_GROUP_UNSUPPORTED', ok: false });
});
