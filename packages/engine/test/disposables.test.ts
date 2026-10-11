import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { trackDisposables } from './_helpers/disposables.ts';

const registry = trackDisposables();
const seen: string[] = [];

test('returns registered instances and drains method disposers in reverse order after each test', () => {
  const value = { disposed: false, dispose() { this.disposed = true; seen.push('dispose'); } };
  expect(registry.add(value)).toBe(value);
  const withStop = registry.add({ stopped: false, stop() { this.stopped = true; seen.push('stop'); } });
  const withClose = registry.add({ closed: false, close() { this.closed = true; seen.push('close'); } });
  expect(value.disposed).toBe(false);
  expect(withStop.stopped).toBe(false);
  expect(withClose.closed).toBe(false);
  expect(registry.size).toBe(3);
});
test('the preceding test has drained through its actual afterEach hook', () => {
  expect(registry.size).toBe(0);
  expect(seen).toEqual(['close', 'stop', 'dispose']);
});
test('explicit disposers, bare callbacks, symbol fallback and method priority are preserved', async () => {
  const log: string[] = [];
  registry.add({ dispose() { log.push('wrong'); } }, () => { log.push('explicit'); });
  registry.defer(() => { log.push('defer'); });
  registry.add(() => { log.push('bare'); });
  registry.add({ [Symbol.dispose]() { log.push('symbol'); } });
  registry.add({ destroy() { log.push('destroy'); }, shutdown() { log.push('wrong'); } });
  registry.add({ shutdown() { log.push('shutdown'); } });
  expect(log).toEqual([]);
  await registry.flush();
  await registry.flush();
  expect(log).toEqual(['shutdown', 'destroy', 'symbol', 'bare', 'defer', 'explicit']);
  expect(log).not.toContain('wrong');
});
test('rejects non-disposable values without registering them', () => {
  expect(() => registry.add({})).toThrow(/no dispose\/stop\/close\/destroy\/shutdown method/);
  expect(registry.size).toBe(0);
});
test('drains through multiple failures and reports every failure once', async () => {
  let disposed = 0;
  registry.defer(() => { throw new Error('first'); });
  registry.defer(async () => { disposed++; });
  registry.defer(() => { throw new Error('second'); });
  await expect(registry.flush()).rejects.toThrow(/2 item\(s\):\n  deferred cleanup: second\n  deferred cleanup: first/);
  expect(disposed).toBe(1);
  expect(registry.size).toBe(0);
  await registry.flush();
});

describe('each-scope final teardown backstop', () => {
  const local = trackDisposables();
  let count = 0;
  // Registered after local's hook: represents cleanup scheduling more cleanup.
  afterEach(() => { local.defer(() => { count++; }); });
  test('leaves the final hook registration for the file-end backstop', () => {
    expect(count).toBe(0);
  });
  afterAll(() => {
    expect(count).toBe(1);
    expect(local.size).toBe(0);
  });
});

describe('all-scope owns shared fixtures until the file finishes', () => {
  const local = trackDisposables({ scope: 'all' });
  let disposed = false;
  beforeAll(() => local.defer(() => { disposed = true; }));
  test('shared fixture is alive during the first test', () => { expect(disposed).toBe(false); });
  test('shared fixture survives the first afterEach', () => { expect(disposed).toBe(false); });
  afterAll(() => {
    expect(disposed).toBe(true);
    expect(local.size).toBe(0);
  });
});
