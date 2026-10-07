import { expect, test } from 'bun:test';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import { projectToolInputBatch } from '../sdk/src/platform/core/tool-input-ingress.js';
import type { ToolCall } from '../sdk/src/platform/types/tools.js';
import { hashState, type EntryType } from '@goodvibes-jev/judgment';
import { autonomousRevision } from '../sdk/src/platform/permissions/autonomous.js';
import { assertProjectionExecution } from '../sdk/src/platform/tools/input-projection.js';

test('portable registry revisions preserve the judgment canonical JSON and SHA-256 identity', () => {
  const values: readonly EntryType[] = [{ nested: { z: 'last', a: 'first' }, empty: null }, { references: [{ id: 'S1', url: '[source reference S1]' }] },
    { punctuation: 'ordinary Unicode é and 😀', value: [false, 0, 1.5, null] }];
  for (const value of values) {
    expect(autonomousRevision(value)).toBe(hashState(value));
  }
  expect(autonomousRevision({ b: 2, a: 1 })).toBe(autonomousRevision({ a: 1, b: 2 }));
});

test('shared empty context tokens retain independent exact-argument execution lifetimes', async () => {
  const registry = new ToolRegistry(); const context = Object.freeze({}); const first = new AbortController();
  const gates = { one: Promise.withResolvers<void>(), two: Promise.withResolvers<void>() };
  const ready = { one: Promise.withResolvers<Record<string, unknown>>(), two: Promise.withResolvers<Record<string, unknown>>() };
  registry.register({ definition: { name: 'shared', description: 'Synthetic shared-context lifetime',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
  async execute(args) {
    const key = args.value as 'one' | 'two'; assertProjectionExecution(context, args);
    ready[key].resolve(args); await gates[key].promise; assertProjectionExecution(context, args);
    return { success: true };
  } }, { inputProjection: { async project(request) { return { status: 'projected', args: request.args, executionContext: context }; } } });
  const one = await registry.prepareCall('one', 'shared', { value: 'one' });
  const two = await registry.prepareCall('two', 'shared', { value: 'two' });
  const runOne = registry.executePrepared(one, () => {}, { signal: first.signal });
  const runTwo = registry.executePrepared(two, () => {});
  void runOne.catch(() => {}); void runTwo.catch(() => {});
  try {
    const argsOne = await ready.one.promise; const argsTwo = await ready.two.promise;
    first.abort();
    expect(() => assertProjectionExecution(context, argsOne)).toThrow('cancelled');
    expect(() => assertProjectionExecution(context, argsTwo)).not.toThrow();
    gates.one.resolve(); await expect(runOne).rejects.toMatchObject({ problem: 'cancelled' });
    expect(() => assertProjectionExecution(context, argsOne)).toThrow('stale');
    expect(() => assertProjectionExecution(context, argsTwo)).not.toThrow();
    gates.two.resolve(); await expect(runTwo).resolves.toMatchObject({ success: true });
    expect(() => assertProjectionExecution(context, argsTwo)).toThrow('stale');
  } finally { gates.one.resolve(); gates.two.resolve(); await Promise.allSettled([runOne, runTwo]); }
});

test('ingress rejects borrowed array methods, species hooks and inherited wrapper getters without invoking them', async () => {
  const registry = new ToolRegistry();
  let invoked = 0;
  const ordinary = { id: 'one', name: 'unknown', arguments: {} };
  const inherited = Object.assign(Object.create({ get id() { invoked++; return 'one'; }, get name() { invoked++; return 'unknown'; } }), { arguments: {} });
  const method = [ordinary]; Object.defineProperty(method, 'map', { value() { invoked++; return []; } });
  const constructor = [ordinary]; Object.defineProperty(constructor, 'constructor', { value: { get [Symbol.species]() { invoked++; return Array; } } });
  const symbol = [ordinary]; Object.defineProperty(symbol, Symbol.iterator, { value() { invoked++; return [][Symbol.iterator](); } });
  class BorrowedArray extends Array<ToolCall> { static override get [Symbol.species]() { invoked++; return Array; } }
  for (const input of [[inherited], method, constructor, symbol, new BorrowedArray(ordinary)]) {
    await expect(projectToolInputBatch(registry, input)).rejects.toBeDefined();
  }
  expect(invoked).toBe(0);
  const batch = await projectToolInputBatch(registry, [ordinary]);
  expect(batch.calls).toEqual([ordinary]); await batch.release();
});

test('input batch cleanup joins every release before reporting any failure', async () => {
  const registry = new ToolRegistry();
  const blocked = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  let drained = false;
  for (const name of ['first', 'second']) registry.register({
    definition: { name, description: 'Synthetic owned cleanup', parameters: { type: 'object' } },
    async execute() { return { success: true }; },
  }, { inputProjection: { async project() {
    return { status: 'projected', args: {}, async release() {
      if (name === 'first') { failed.resolve(); throw new Error('synthetic release failure'); }
      await blocked.promise; drained = true;
    } };
  } } });
  const batch = await projectToolInputBatch(registry, [
    { id: 'one', name: 'first', arguments: {} }, { id: 'two', name: 'second', arguments: {} },
  ]);
  const cleanup = batch.release();
  let settled = false;
  void cleanup.then(() => { settled = true; }, () => { settled = true; });
  try {
    await failed.promise;
    // A new event-loop turn drains the rejected release's microtasks; the
    // second release stays under explicit fixture control, not a timing guess.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(drained).toBe(false);
    expect(batch.release()).toBe(cleanup);
    blocked.resolve();
    await expect(cleanup).rejects.toThrow('Tool input batch cleanup failed');
    expect(drained).toBe(true);
  } finally { blocked.resolve(); await cleanup.catch(() => {}); }
});
