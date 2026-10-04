import { expect, test } from 'bun:test';
import { createScopedBrowserSdk } from '../sdk/src/browser-scoped.js';
import type { NativeWorkExecutionSnapshot } from '../sdk/src/platform/workflow/work-ledger/native-execution-wire.js';

const method = 'workLedger.execution.status';
const routes = { [method]: { method: 'POST', path: '/api/work-ledger/execution/status' } };
const identity = { projectId: 'fixture-project', workId: 'fixture-work', attemptId: 'fixture-attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 } };

test('scoped browser typed transport retains each native execution union branch', async () => {
  const common = { ...identity, currentRevision: identity.expectedRevision, currentAttempt: true, stale: false };
  for (const snapshot of [
    { ...common, kind: 'execution', state: 'prepared', recovery: 'available', receipt: null, progress: null },
    { ...common, kind: 'pending-intent', state: 'admitting', recovery: 'pending' },
    { ...common, kind: 'prevented-before-admission', state: 'cancelled', recovery: 'cancelled' },
  ] satisfies readonly NativeWorkExecutionSnapshot[]) {
    const sdk = createScopedBrowserSdk(routes, [], { baseUrl: 'https://native-fixture.invalid', fetch: async () => new Response(JSON.stringify(snapshot), { headers: { 'Content-Type': 'application/json' } }) });
    const result = await sdk.operator.invoke(method, identity);
    expect(result).toEqual(snapshot);
    // The public generated output retains discriminator narrowing.
    if (result.kind === 'execution') expect(result.receipt).toBeNull();
    else expect('receipt' in result).toBe(false);
  }
});

test('scoped browser invoke turns synchronous request preparation failures into rejected promises', async () => {
  const failure = new Error('Owned request preparation failure');
  const sdk = createScopedBrowserSdk(routes, [], { baseUrl: 'https://native-fixture.invalid', fetch: async () => { throw new Error('No transport should run'); } });
  let result: Promise<unknown> | undefined;
  expect(() => { result = sdk.operator.invoke(method, identity, { get headers(): HeadersInit { throw failure; } }); }).not.toThrow();
  expect(result).toBeInstanceOf(Promise);
  await expect(result).rejects.toBe(failure);
});
