import { expect, test } from 'bun:test';
import { createRuntimeAcquisitionScope } from '../../runtime/acquisition.js';

test('partial construction closes every returned owner in reverse order', async () => {
  const scope = createRuntimeAcquisitionScope('fixture'); const closed: string[] = [];
  scope.ownUntilRegistered('first', () => { closed.push('first'); });
  scope.ownUntilRegistered('second', () => { closed.push('second'); });
  await scope.close(); await scope.close();
  expect(closed).toEqual(['second', 'first']);
});

test('final registration replaces its provisional callback and establishes dependency order', async () => {
  const scope = createRuntimeAcquisitionScope('fixture'); const closed: string[] = [];
  scope.ownUntilRegistered('agent runs', () => { closed.push('old agents'); });
  scope.ownUntilRegistered('fleet', () => { closed.push('old fleet'); });
  scope.registry.add('fleet', () => { closed.push('fleet'); });
  scope.registry.add('agent runs', () => { closed.push('agents'); });
  await scope.close();
  expect(closed).toEqual(['agents', 'fleet']);
});

test('ordinary equal labels retain independent cleanup', async () => {
  const scope = createRuntimeAcquisitionScope('fixture'); const closed: number[] = [];
  scope.registry.add('connection', () => { closed.push(1); });
  scope.registry.add('connection', () => { closed.push(2); });
  await scope.close(); expect(closed).toEqual([2, 1]);
});

test('async partial cleanup drains before dependencies and failure preserves remaining cleanup', async () => {
  const scope = createRuntimeAcquisitionScope('fixture'); const closed: string[] = [];
  let release!: () => void; const hold = new Promise<void>((done) => { release = done; });
  scope.ownUntilRegistered('storage', () => { closed.push('storage'); });
  scope.ownUntilRegistered('consumer', async () => { closed.push('consumer'); await hold; throw new Error('fixture cleanup failure'); });
  const closing = scope.close(); void closing.catch(() => {});
  expect(closed).toEqual(['consumer']); release();
  await expect(closing).rejects.toMatchObject({ code: 'DISPOSAL_FAILED' });
  expect(closed).toEqual(['consumer', 'storage']);
});

test('late acquired resources close without reopening the scope', async () => {
  const scope = createRuntimeAcquisitionScope('fixture'); let closed = 0;
  await scope.close(); scope.ownUntilRegistered('late', async () => { closed++; });
  await scope.close(); expect(closed).toBe(1);
});
