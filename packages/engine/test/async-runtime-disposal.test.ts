import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { AsyncDisposalError, createAsyncDisposalScope } from '../sdk/src/platform/runtime/async-disposal.js';

let restore: () => void;
let warnings: number;
beforeEach(() => {
  warnings = 0;
  const mocked = spyOn(logger, 'warn').mockImplementation(() => { warnings++; });
  restore = () => mocked.mockRestore();
});
afterEach(() => restore());
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}
async function turn() { await Promise.resolve(); await Promise.resolve(); }

test('legacy dispose preserves immediate synchronous reverse order and idempotence', async () => {
  const calls: string[] = []; const scope = createAsyncDisposalScope('fixture');
  scope.registry.add('parent', () => { calls.push('parent'); });
  scope.registry.add('child', () => { calls.push('child'); });
  scope.dispose(); expect(calls).toEqual(['child', 'parent']);
  const first = scope.close(); expect(scope.close()).toBe(first);
  await first; scope.dispose(); expect(calls).toHaveLength(2);
});

test('close waits for an asynchronous child before disposing its parent', async () => {
  const calls: string[] = []; const hold = deferred(); const scope = createAsyncDisposalScope('fixture');
  scope.registry.add('parent', () => { calls.push('parent'); });
  scope.registry.add('child', async () => { calls.push('child-start'); await hold.promise; calls.push('child-done'); });
  const closing = scope.close(); let settled = false; void closing.then(() => { settled = true; });
  try { await turn(); expect(settled).toBe(false); expect(calls).toEqual(['child-start']); }
  finally { hold.release(); await closing; }
  expect(calls).toEqual(['child-start', 'child-done', 'parent']);
});

test('failure is logged, retained and rejected only after all cleanup has run', async () => {
  const calls: string[] = []; const scope = createAsyncDisposalScope('fixture');
  scope.registry.add('parent', () => { calls.push('parent'); throw new Error('fixture parent error'); });
  scope.registry.add('child', async () => { calls.push('child'); throw new Error('fixture child error'); });
  const closing = scope.close();
  await expect(closing).rejects.toBeInstanceOf(AsyncDisposalError);
  const error = await closing.catch((value: unknown) => value) as AsyncDisposalError;
  expect(error.code).toBe('DISPOSAL_FAILED'); expect(error.failures.map((value) => value.label)).toEqual(['child', 'parent']);
  expect(calls).toEqual(['child', 'parent']); expect(warnings).toBe(2);
  expect(scope.close()).toBe(closing);
});

test('the sync compatibility wrapper observes asynchronous rejection without hiding it from close', async () => {
  const scope = createAsyncDisposalScope('fixture');
  scope.registry.add('child', async () => { throw new Error('fixture'); });
  scope.dispose(); await turn();
  await expect(scope.close()).rejects.toBeInstanceOf(AsyncDisposalError);
  expect(warnings).toBe(1);
});

test('late synchronous registration is cleaned immediately and never reopened', async () => {
  const scope = createAsyncDisposalScope('fixture'); await scope.close();
  let calls = 0; scope.registry.add('late', () => { calls++; });
  expect(calls).toBe(1); await scope.close(); scope.dispose(); expect(calls).toBe(1);
});

test('late async registration after a settled close starts immediately and is drained by the next close', async () => {
  const scope = createAsyncDisposalScope('fixture'); const first = scope.close(); await first;
  const hold = deferred(); let started = false; let ended = false;
  scope.registry.add('late', async () => { started = true; await hold.promise; ended = true; });
  expect(started).toBe(true); const second = scope.close(); expect(second).not.toBe(first);
  try { await turn(); expect(ended).toBe(false); expect(scope.close()).toBe(second); }
  finally { hold.release(); await second; }
  expect(ended).toBe(true);
});

test('late work registered during drain, including its late child, completes before older dependencies', async () => {
  const scope = createAsyncDisposalScope('fixture'); const first = deferred(); const late = deferred(); const nested = deferred();
  const calls: string[] = [];
  scope.registry.add('parent', () => { calls.push('parent'); });
  scope.registry.add('child', () => first.promise);
  const closing = scope.close();
  scope.registry.add('late', async () => {
    calls.push('late-start'); await late.promise;
    scope.registry.add('nested', async () => { calls.push('nested-start'); await nested.promise; calls.push('nested-done'); });
    calls.push('late-done');
  });
  try {
    expect(calls).toEqual(['late-start']); first.release(); late.release(); await turn();
    expect(calls).toContain('nested-start'); expect(calls).not.toContain('parent');
  } finally { first.release(); late.release(); nested.release(); await closing; }
  expect(calls.at(-1)).toBe('parent');
});

test('registration before the initial empty close settles remains owned by that close', async () => {
  const scope = createAsyncDisposalScope('fixture'); const hold = deferred(); const closing = scope.close();
  scope.registry.add('late', () => hold.promise);
  let settled = false; void closing.then(() => { settled = true; });
  try { await turn(); expect(settled).toBe(false); }
  finally { hold.release(); await closing; }
});

test('a late asynchronous failure is handled and remains visible even when registration caller does not close', async () => {
  const scope = createAsyncDisposalScope('fixture'); await scope.close();
  scope.registry.add('late', async () => { throw new Error('fixture late failure'); });
  await turn(); expect(warnings).toBe(1);
  await expect(scope.close()).rejects.toMatchObject({ code: 'DISPOSAL_FAILED' });
});

test('reentrant legacy dispose does not duplicate callbacks or deadlock', async () => {
  const scope = createAsyncDisposalScope('fixture'); let calls = 0;
  scope.registry.add('reentrant', () => { calls++; scope.dispose(); });
  await scope.close(); expect(calls).toBe(1);
});

test('directly returning the scope own close promise is refused rather than deadlocking', async () => {
  const scope = createAsyncDisposalScope('fixture'); scope.registry.add('cycle', () => scope.close());
  await expect(scope.close()).rejects.toMatchObject({ code: 'DISPOSAL_FAILED' }); expect(warnings).toBe(1);
});

test('a throwing reporter cannot stop the remaining cleanup or erase the failure', async () => {
  restore(); const mocked = spyOn(logger, 'warn').mockImplementation(() => { throw new Error('fixture reporter'); });
  restore = () => mocked.mockRestore();
  const scope = createAsyncDisposalScope('fixture'); let parent = false;
  scope.registry.add('parent', () => { parent = true; }); scope.registry.add('child', () => { throw new Error('fixture child'); });
  await expect(scope.close()).rejects.toBeInstanceOf(AsyncDisposalError); expect(parent).toBe(true);
});
