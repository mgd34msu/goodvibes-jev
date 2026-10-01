import { expect, test } from 'bun:test';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { DeliveryError, DeliveryQueue } from '../sdk/src/platform/integrations/delivery.ts';

function deferred() {
  let resolve!: () => void; let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
const terminal = () => new DeliveryError('synthetic terminal failure', 'terminal');
async function seeded() {
  const queue = new DeliveryQueue();
  await queue.enqueue('fixture', 'retained', 'original synthetic payload', async () => { throw terminal(); });
  return queue;
}

for (const shutdown of ['close', 'dispose'] as const) {
  test(`${shutdown} during a failed replay retains the original dead letter without another send`, async () => {
    const queue = await seeded(); const original = queue.getDlq(); const held = deferred(); let calls = 0;
    const replay = queue.replay(async () => { calls++; await held.promise; });
    const result = replay.catch((error: unknown) => error);
    const closing = shutdown === 'close' ? queue.close() : (queue.dispose(), undefined);
    try {
      held.reject(terminal()); expect(await result).toBeInstanceOf(DeliveryError); await closing;
      expect(queue.getDlq()).toEqual(original); expect(calls).toBe(1);
      expect(queue.getMetrics()).toMatchObject({ totalAttempts: 2, retrying: 0, deadLettered: 1, dlqSize: 1 });
    } finally { held.resolve(); await queue.close(); }
  });
}

test('close awaits successful replay bookkeeping and removes exactly its completed row', async () => {
  const queue = await seeded(); const id = queue.getDlq()[0]!.id; const held = deferred();
  const replay = queue.replay(() => held.promise); const closing = queue.close();
  try {
    held.resolve(); await closing;
    expect(queue.getDlq()).toEqual([]);
    expect(queue.getMetrics()).toMatchObject({ totalAttempts: 2, delivered: 1, retrying: 0, deadLettered: 0, dlqSize: 0 });
    expect(await replay).toEqual([{ id, outcome: 'delivered' }]);
  } finally { held.resolve(); await queue.close(); }
});

test('a failed open replay replaces its row once before notifying observers', async () => {
  const queue = await seeded(); const snapshots: number[] = [];
  queue.onDeadLetter(() => { snapshots.push(queue.getDlq().length); });
  try {
    const result = await queue.replay(async () => { throw terminal(); });
    expect(result.map((entry) => entry.outcome)).toEqual(['dead_letter']);
    expect(queue.getDlq().map((entry) => entry.payload)).toEqual(['original synthetic payload']);
    expect(queue.getMetrics()).toMatchObject({ totalAttempts: 2, deadLettered: 1, dlqSize: 1 });
    expect(snapshots).toEqual([1]);
  } finally { await queue.close(); }
});

test('concurrent replays cannot send the same retained row twice', async () => {
  const queue = await seeded(); const held = deferred(); let firstCalls = 0; let competingCalls = 0;
  const first = queue.replay(async () => { firstCalls++; await held.promise; });
  try {
    expect(await queue.replay(async () => { competingCalls++; })).toEqual([]);
    expect(competingCalls).toBe(0); held.resolve(); await first;
    expect(firstCalls).toBe(1); expect(queue.getDlq()).toEqual([]);
    expect(queue.getMetrics()).toMatchObject({ delivered: 1, deadLettered: 0, dlqSize: 0 });
  } finally { held.resolve(); await first; await queue.close(); }
});

test('shutdown after one successful replay preserves the remaining unattempted row', async () => {
  const queue = await seeded();
  await queue.enqueue('fixture', 'second', 'second synthetic payload', async () => { throw terminal(); });
  const second = queue.getDlq()[1];
  if (!second) throw new Error('Second fixture dead letter was not recorded');
  let calls = 0; let closing: Promise<void> | undefined;
  const result = queue.replay(async () => { calls++; closing = queue.close(); }).catch((error: unknown) => error);
  expect(await result).toBeInstanceOf(DeliveryError); await closing;
  expect(calls).toBe(1); expect(queue.getDlq()).toEqual([second]);
  expect(queue.getMetrics()).toMatchObject({ delivered: 1, deadLettered: 1, dlqSize: 1 });
});

test('close drains restoration before returning, including reentrant shutdown', async () => {
  const queue = await seeded(); const original = queue.getDlq(); const held = deferred();
  let closing: Promise<void> | undefined;
  const replay = queue.replay(async () => { closing = queue.close(); await held.promise; });
  const result = replay.catch((error: unknown) => error);
  try {
    held.reject(terminal()); await closing;
    expect(queue.getDlq()).toEqual(original); expect(await result).toBeInstanceOf(DeliveryError);
  } finally { held.resolve(); await queue.close(); }
});

test('concurrent batches do not replay a later row already completed by another batch', async () => {
  const queue = await seeded(); const held = deferred(); const calls: string[] = [];
  await queue.enqueue('fixture', 'second', 'second synthetic payload', async () => { throw terminal(); });
  const first = queue.replay(async (entry) => { calls.push(entry.payload); if (entry.payload === 'original synthetic payload') await held.promise; });
  try {
    await queue.replay(async (entry) => { calls.push(entry.payload); }); held.resolve(); await first;
    expect(calls).toEqual(['original synthetic payload', 'second synthetic payload']);
    expect(queue.getMetrics()).toMatchObject({ delivered: 2, deadLettered: 0, dlqSize: 0 });
  } finally { held.resolve(); await first; await queue.close(); }
});

test('restoration preserves the configured bounded FIFO and consistent metrics', async () => {
  const queue = new DeliveryQueue({ maxDlqSize: 1 }); const held = deferred();
  await queue.enqueue('fixture', 'retained', 'original synthetic payload', async () => { throw terminal(); });
  const original = queue.getDlq();
  const replay = queue.replay(() => held.promise); const result = replay.catch((error: unknown) => error);
  try {
    await queue.enqueue('fixture', 'interleaved', 'other synthetic payload', async () => { throw terminal(); });
    const closing = queue.close(); held.reject(terminal()); await closing;
    expect(await result).toBeInstanceOf(DeliveryError); expect(queue.getDlq()).toEqual(original);
    expect(queue.getMetrics()).toMatchObject({ totalAttempts: 3, retrying: 0, deadLettered: 1, dlqSize: 1 });
  } finally { held.resolve(); await queue.close(); }
});


test('an unavailable failure reading rejects replay while retaining recovery data', async () => {
  const previous = installJudgmentPort(undefined); forgetFailureReadings();
  const queue = await seeded(); const original = queue.getDlq(); let calls = 0;
  try {
    const result = await queue.replay(async () => { calls++; throw new Error('synthetic unclassified replay failure'); }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError); expect(queue.getDlq()).toEqual(original);
    expect(calls).toBe(1); expect(queue.getMetrics()).toMatchObject({ delivered: 0, retrying: 0, deadLettered: 1, dlqSize: 1 });
  } finally { await queue.close(); installJudgmentPort(previous); forgetFailureReadings(); }
});
