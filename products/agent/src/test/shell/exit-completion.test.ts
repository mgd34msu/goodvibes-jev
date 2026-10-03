import { expect, test } from 'bun:test';
import { settleInteractiveExit } from '../../shell/exit-completion.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('process exit and handover wait for runtime shutdown after audio settles', async () => {
  const runtime = deferred();
  const order: string[] = [];
  const completion = settleInteractiveExit(runtime.promise, Promise.resolve()).then(() => { order.push('handover/exit'); });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(order).toEqual([]);
  order.push('runtime-released'); runtime.resolve();
  await completion;
  expect(order).toEqual(['runtime-released', 'handover/exit']);
});

test('runtime rejection cannot abandon bounded speech drain', async () => {
  const audio = deferred();
  const failure = new Error('runtime failed');
  let settled = false;
  const completion = settleInteractiveExit(Promise.reject(failure), audio.promise).then(errors => { settled = true; return errors; });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(settled).toBe(false);
  audio.resolve();
  expect(await completion).toEqual([failure]);
});

test('audio rejection cannot abandon runtime and both errors remain visible', async () => {
  const runtime = deferred();
  const audioFailure = new Error('audio failed');
  const runtimeFailure = new Error('runtime failed');
  let settled = false;
  const completion = settleInteractiveExit(runtime.promise, Promise.reject(audioFailure)).then(errors => { settled = true; return errors; });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(settled).toBe(false);
  runtime.reject(runtimeFailure);
  expect(await completion).toEqual([runtimeFailure, audioFailure]);
});

test('each independently failed runtime owner remains visible to exit diagnostics', async () => {
  const early = new Error('spine failed');
  const late = new Error('graph failed');
  const audio = new Error('audio failed');
  const failures = await settleInteractiveExit(
    Promise.reject(new AggregateError([early, late], 'owned shutdown failed')),
    Promise.reject(audio),
  );
  expect(failures).toEqual([early, late, audio]);
});
