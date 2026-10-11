import { expect, test } from 'bun:test';
import { captureOwnedJson, retainOwnedJson, retainStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';

test('retained snapshots reuse canonical complete capture and keep original data mutable', () => {
  const shared = { value: 'ordinary' };
  const original = { first: shared, second: shared, values: [undefined, null, false, -0] };
  const retained = retainStrictJudgmentJson(original);
  expect(captureOwnedJson(original)).toEqual(retained.snapshot);
  expect(retained.snapshot.first).not.toBe(shared);
  expect(Object.isFrozen(retained.snapshot.first)).toBe(true);
  expect(Object.isFrozen(original)).toBe(false);
  for (let index = 0; index < 100; index++) retained.assertCurrent();
  shared.value = 'changed'; expect(retained.assertCurrent).toThrow('stale');
});

test.each(['scalar', 'undefined removal', 'new key', 'key order', 'prototype', 'descriptor', 'replacement', 'alias'] as const)(
  'complete retained source rejects %s changes', mode => {
    const shared = { value: 'ordinary' };
    const original = { first: shared, second: shared, omitted: undefined };
    const retained = retainStrictJudgmentJson(original);
    if (mode === 'scalar') shared.value = 'changed';
    if (mode === 'undefined removal') Reflect.deleteProperty(original, 'omitted');
    if (mode === 'new key') Object.defineProperty(original, 'new', { value: undefined, enumerable: true });
    if (mode === 'key order') { Reflect.deleteProperty(original, 'first'); original.first = shared; }
    if (mode === 'prototype') Object.setPrototypeOf(shared, null);
    if (mode === 'descriptor') Object.defineProperty(shared, 'value', { writable: false });
    if (mode === 'replacement') original.first = { value: 'ordinary' };
    if (mode === 'alias') original.second = { value: 'ordinary' };
    expect(retained.assertCurrent).toThrow('stale');
  });

test.each(['hidden', 'symbol', 'array property', 'hole', 'length', 'signed zero'] as const)(
  'retained data rejects later %s observations', mode => {
    const original = { values: [0, 1] };
    const retained = retainStrictJudgmentJson(original);
    if (mode === 'hidden') Object.defineProperty(original, 'private', { value: 'private-local-value' });
    if (mode === 'symbol') Object.defineProperty(original, Symbol('private'), { value: 'private-local-value' });
    if (mode === 'array property') Object.defineProperty(original.values, 'extra', { value: 2 });
    if (mode === 'hole') Reflect.deleteProperty(original.values, '0');
    if (mode === 'length') original.values.length = 1;
    if (mode === 'signed zero') original.values[0] = -0;
    expect(retained.assertCurrent).toThrow('stale');
  });

test('new accessors are refused without running any getter or exposing its private error', () => {
  const original = { nested: { value: 'ordinary' } };
  const retained = retainStrictJudgmentJson(original);
  let calls = 0;
  Object.defineProperty(original.nested, 'value', { enumerable: true, get() { calls++; throw new Error('private-local-value'); } });
  expect(retained.assertCurrent).toThrow('stale'); expect(calls).toBe(0);
});

test('strict proxy admission stays local and invokes no proxy traps', () => {
  let calls = 0;
  const proxy = new Proxy({ value: 'private-local-value' }, { ownKeys() { calls++; throw new Error('private-local-value'); } });
  expect(() => retainStrictJudgmentJson({ nested: proxy })).toThrow('malformed');
  expect(calls).toBe(0);
});

test('generic capture retains ignored own slots without changing canonical admission', () => {
  const original = Object.defineProperty({ ordinary: 'value' }, 'hidden', { value: 'private-local-value', writable: true });
  const retained = retainOwnedJson(original);
  expect(retained.snapshot).toEqual(captureOwnedJson(original));
  retained.assertCurrent(); Object.defineProperty(original, 'hidden', { value: 'changed-local-value' });
  expect(retained.assertCurrent).toThrow();
});

test('generic admission retains the existing stable proxy observations without treating them as authority', () => {
  const original = { 0: 'zero', 1: 'one' };
  const proxy = new Proxy(original, { ownKeys() { return ['1', '0']; } });
  const retained = retainOwnedJson(proxy);
  expect(retained.snapshot).toEqual(captureOwnedJson(proxy));
  retained.assertCurrent(); original[0] = 'changed'; expect(retained.assertCurrent).toThrow();
});

test('initial unsupported scalar and cycle rules remain canonical', () => {
  const cycle: { child?: unknown } = {}; cycle.child = cycle;
  for (const input of [NaN, Infinity, cycle, () => undefined, 1n]) {
    expect(() => captureOwnedJson(input)).toThrow();
    expect(() => retainOwnedJson(input)).toThrow();
  }
});

test('strict dense-array and hidden-field admission remain unchanged', () => {
  expect(() => retainStrictJudgmentJson(new Array(2))).toThrow('malformed');
  expect(() => retainStrictJudgmentJson(Object.defineProperty({}, 'hidden', { value: 'private-local-value' }))).toThrow('malformed');
});
