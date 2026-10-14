import { describe, expect, test } from 'bun:test';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureAsyncHarnessInput } from '../../tools/agent-harness-async-input.ts';
import { captureCatalogSnapshotGuard, type CatalogRankingOptions } from '../../tools/agent-harness-catalog-ranking.ts';

describe('complete asynchronous harness caller lifetime', () => {
  test('keeps the complete original input and forwards only the original restrictions', async () => {
    const controller = new AbortController();
    let currentChecks = 0;
    const retained: { guard: () => void; key: string | undefined }[] = [];
    const options: CatalogRankingOptions = {
      signal: controller.signal,
      assertCurrent: () => { currentChecks++; },
      retainCurrent: (guard, key) => { retained.push({ guard, key }); },
      requirePreservedSource: true,
    };
    const args = { query: 'installed device controls', includeParameters: true, unused: { privateSource: 'complete original source' } };
    Object.defineProperty(args, 'privateMetadata', { value: { owner: 'original source owner' }, enumerable: false });
    const caller = captureAsyncHarnessInput(args, options);
    expect(caller.args).toEqual(args);
    expect(Object.getOwnPropertyDescriptor(caller.args, 'privateMetadata')?.value).toEqual({ owner: 'original source owner' });
    expect(Object.isFrozen(caller.args)).toBe(true);
    expect(Object.isFrozen(caller.args.unused)).toBe(true);
    expect(caller.options.signal).toBe(controller.signal);
    expect(caller.options.requirePreservedSource).toBe(true);
    const source = { installed: { publication: 'original native records' } };
    const sourceGuard = captureCatalogSnapshotGuard(source);
    const assertSource = () => sourceGuard(source);
    caller.options.retainCurrent(assertSource, 'runtime.source');
    await Promise.resolve();
    caller.assertCurrent();
    expect(retained).toEqual([{ guard: assertSource, key: 'runtime.source' }]);
    expect(retained[0]?.guard).not.toBe(caller.assertCurrent);
    expect(currentChecks).toBeGreaterThan(0);
    expect(currentChecks).toBeLessThan(20);
  });

  test('holds changed complete arguments after a real await', async () => {
    const args = { query: 'original target', unused: { privateSource: 'original private evidence' } };
    const caller = captureAsyncHarnessInput(args, {});
    await Promise.resolve();
    args.unused.privateSource = 'changed evidence';
    expect(() => caller.assertCurrent()).toThrow(ToolInputProjectionError);
    expect(caller.args.unused.privateSource).toBe('original private evidence');
  });

  test('holds changed hidden metadata after a real await', async () => {
    const args = { query: 'original target' };
    const metadata = { privateSource: 'original private evidence' };
    Object.defineProperty(args, 'metadata', { value: metadata, enumerable: false });
    const caller = captureAsyncHarnessInput(args, {});
    await Promise.resolve();
    metadata.privateSource = 'changed evidence';
    expect(() => caller.assertCurrent()).toThrow(ToolInputProjectionError);
  });

  test('refuses a hidden source accessor without invoking it', () => {
    let touched = 0;
    const args = { query: 'original target' };
    Object.defineProperty(args, 'metadata', { get() { touched++; return 'private source'; } });
    expect(() => captureAsyncHarnessInput(args, {})).toThrow(ToolInputProjectionError);
    expect(touched).toBe(0);
  });

  test('refuses a proxied input without invoking its traps', () => {
    let touched = 0;
    const args = new Proxy({ query: 'original target' }, {
      ownKeys() { touched++; return ['query']; },
      get() { touched++; return 'changed target'; },
      getPrototypeOf() { touched++; return Object.prototype; },
    });
    expect(() => captureAsyncHarnessInput(args, {})).toThrow(ToolInputProjectionError);
    expect(touched).toBe(0);
  });

  test('holds a source guard after its public read finishes without an outer retain hook', async () => {
    const caller = captureAsyncHarnessInput({ query: 'installed runtime' }, {});
    const record = { id: 'native-record', status: 'ready' };
    const source = { records: [record] };
    const captured = captureCatalogSnapshotGuard(source);
    caller.options.retainCurrent(() => captured(source), 'runtime.source');
    await Promise.resolve();
    record.status = 'retired';
    expect(() => caller.assertCurrent()).toThrow(ToolInputProjectionError);
  });

  test('retains every original source when acquisition keys coincide', async () => {
    const caller = captureAsyncHarnessInput({ query: 'two source projections' }, {});
    const first = { generation: 'first native publication' }, second = { generation: 'second native publication' };
    const firstGuard = captureCatalogSnapshotGuard(first), secondGuard = captureCatalogSnapshotGuard(second);
    caller.options.retainCurrent(() => firstGuard(first), 'runtime.source');
    caller.options.retainCurrent(() => secondGuard(second), 'runtime.source');
    await Promise.resolve();
    first.generation = 'retired original publication';
    expect(() => caller.assertCurrent()).toThrow(ToolInputProjectionError);
  });

  test('holds caller cancellation during a real await', async () => {
    const controller = new AbortController();
    const caller = captureAsyncHarnessInput({ query: 'installed runtime' }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    expect(() => caller.assertCurrent()).toThrow();
  });

  test('uses the original native signal check without invoking a borrowed accessor', () => {
    const controller = new AbortController();
    let touched = 0;
    Object.defineProperty(controller.signal, 'throwIfAborted', { get() { touched++; return () => {}; } });
    const caller = captureAsyncHarnessInput({ query: 'installed runtime' }, { signal: controller.signal });
    caller.assertCurrent();
    controller.abort();
    expect(() => caller.assertCurrent()).toThrow();
    expect(touched).toBe(0);
  });

  test('holds replacement of the original signal after a real await', async () => {
    const original = new AbortController(), replacement = new AbortController();
    const options = { signal: original.signal };
    const caller = captureAsyncHarnessInput({ query: 'installed runtime' }, options);
    await Promise.resolve();
    options.signal = replacement.signal;
    expect(() => caller.assertCurrent()).toThrow(ToolInputProjectionError);
  });

  test('holds original callback replacement without executing the replacement', () => {
    const options = { assertCurrent: () => {} };
    const caller = captureAsyncHarnessInput({ query: 'installed runtime' }, options);
    let touched = 0;
    options.assertCurrent = () => { touched++; };
    expect(() => caller.assertCurrent()).toThrow(ToolInputProjectionError);
    expect(touched).toBe(0);
  });

  test('holds a replacement callback accessor without invoking it', () => {
    const options = { assertCurrent: () => {} };
    const caller = captureAsyncHarnessInput({ query: 'installed runtime' }, options);
    let touched = 0;
    Object.defineProperty(options, 'assertCurrent', { configurable: true, get() { touched++; return () => {}; } });
    expect(() => caller.assertCurrent()).toThrow(ToolInputProjectionError);
    expect(touched).toBe(0);
  });

  test('refuses proxied original callbacks before invoking them', () => {
    let touched = 0;
    const callback = new Proxy(() => {}, { apply() { touched++; } });
    expect(() => captureAsyncHarnessInput({ query: 'installed runtime' }, { assertCurrent: callback })).toThrow(ToolInputProjectionError);
    expect(touched).toBe(0);
  });

  test('holds an already-retired native source through every publication check', () => {
    const retained: (() => void)[] = [];
    const caller = captureAsyncHarnessInput({ query: 'installed runtime' }, { retainCurrent: guard => { retained.push(guard); } });
    const source = { generation: 'original publication' };
    const capture = captureCatalogSnapshotGuard(source);
    source.generation = 'retired publication';
    expect(() => caller.options.retainCurrent(() => capture(source), 'runtime.source')).toThrow(ToolInputProjectionError);
    expect(() => caller.assertCurrent()).toThrow(ToolInputProjectionError);
    expect(retained).toHaveLength(1);
  });

  test('holds an asynchronously returned currentness result', async () => {
    const options = { assertCurrent: async () => {} };
    expect(() => captureAsyncHarnessInput({ query: 'installed runtime' }, options)).toThrow(ToolInputProjectionError);
    await Promise.resolve();
  });

  test('holds an asynchronously returned retention result', async () => {
    const caller = captureAsyncHarnessInput({ query: 'installed runtime' }, { retainCurrent: async () => {} });
    expect(() => caller.options.retainCurrent(() => {}, 'runtime.source')).toThrow(ToolInputProjectionError);
    await Promise.resolve();
  });

  test.each(['argument', 'native', 'cancel', 'registration'] as const)('publication retention keeps every original restriction after a %s change', changed => {
    const retained: (() => void)[] = [], signal = new AbortController();
    const args = { query: 'Inspect setup' }, native = { status: 'original publication' };
    const captured = captureCatalogSnapshotGuard(native);
    const caller = captureAsyncHarnessInput(args, { signal: signal.signal, retainCurrent: guard => {
      retained.push(guard);
      if (changed === 'registration') native.status = 'retired during publication';
    } }, true);
    caller.options.retainCurrent(() => captured(native), 'setup.native');
    expect(retained).toHaveLength(0);
    if (changed === 'registration') {
      expect(() => caller.retainSourceCurrent('setup.plan')).toThrow();
    } else {
      caller.retainSourceCurrent('setup.plan');
      if (changed === 'argument') args.query = 'Changed setup';
      if (changed === 'native') native.status = 'retired publication';
      if (changed === 'cancel') signal.abort();
    }
    expect(retained).toHaveLength(1);
    expect(() => retained[0]!()).toThrow();
    expect(() => caller.assertCurrent()).toThrow();
  });

  test('retains a nested original source without re-entering its parent callback', async () => {
    let outerChecks = 0;
    const outer = captureAsyncHarnessInput({ query: 'device map' }, { assertCurrent: () => { outerChecks++; } });
    const records = { installed: [{ id: 'native-device', status: 'ready' }] };
    const inner = captureAsyncHarnessInput(records, outer.options);
    inner.retainSourceCurrent('device.records');
    await Promise.resolve();
    outer.assertCurrent();
    inner.assertCurrent();
    expect(outerChecks).toBeGreaterThan(0);
    expect(outerChecks).toBeLessThan(40);
    const record = records.installed[0];
    if (!record) throw new Error('The native test record is missing.');
    record.status = 'retired';
    expect(() => outer.assertCurrent()).toThrow(ToolInputProjectionError);
  });

  test('the retained native guard excludes the outer callback while live boundaries still enforce it', () => {
    let outerCurrent = true;
    const outer = captureAsyncHarnessInput({ query: 'device map' }, { assertCurrent: () => {
      if (!outerCurrent) throw new ToolInputProjectionError('held');
    } });
    const inner = captureAsyncHarnessInput({ records: ['original native publication'] }, outer.options);
    inner.retainSourceCurrent('device.records');
    outerCurrent = false;
    expect(() => inner.assertSourceCurrent()).not.toThrow();
    expect(() => inner.assertCurrent()).toThrow(ToolInputProjectionError);
    expect(() => outer.assertCurrent()).toThrow(ToolInputProjectionError);
  });

  test('refuses its own guards and the outer callback in its native retention set', () => {
    const original = () => {};
    const caller = captureAsyncHarnessInput({ query: 'device map' }, { assertCurrent: original });
    expect(() => caller.options.retainCurrent(caller.assertCurrent)).toThrow(ToolInputProjectionError);
    expect(() => caller.options.retainCurrent(caller.assertSourceCurrent)).toThrow(ToolInputProjectionError);
    expect(() => caller.options.retainCurrent(original)).toThrow(ToolInputProjectionError);
    expect(() => caller.assertCurrent()).not.toThrow();
  });

  test('checked native source forwarding uses the original retainer and unchanged key', () => {
    const retained: { guard: () => void; key: string | undefined }[] = [];
    const caller = captureAsyncHarnessInput({ query: 'original device source' }, {
      retainCurrent: (guard, key) => { retained.push({ guard, key }); },
    });
    caller.retainSourceCurrent('device.records');
    expect(retained).toEqual([{ guard: caller.assertSourceCurrent, key: 'device.records' }]);
    expect(() => caller.assertCurrent()).not.toThrow();
  });

  test('checked native source forwarding holds a non-undefined original retainer result', () => {
    const caller = captureAsyncHarnessInput({ query: 'original device source' }, { retainCurrent: () => 'borrowed result' });
    expect(() => caller.retainSourceCurrent('device.records')).toThrow(ToolInputProjectionError);
  });

  test('checked native source forwarding holds a native Promise and consumes its late rejection', async () => {
    let rejectRetention: ((reason: Error) => void) | undefined;
    const pending = new Promise<void>((_resolve, reject) => { rejectRetention = reject; });
    const caller = captureAsyncHarnessInput({ query: 'original device source' }, { retainCurrent: () => pending });
    expect(() => caller.retainSourceCurrent('device.records')).toThrow(ToolInputProjectionError);
    const reject = rejectRetention;
    if (!reject) throw new Error('The native retention promise did not install its rejection callback.');
    reject(new Error('Private source rejection must stay inside the held native restriction.'));
    await Promise.resolve();
  });

  test('checked native source forwarding rechecks the original source after the retainer returns', () => {
    const source = { record: { status: 'original native publication' } };
    const caller = captureAsyncHarnessInput(source, { retainCurrent: () => { source.record.status = 'retired publication'; } });
    expect(() => caller.retainSourceCurrent('device.records')).toThrow(ToolInputProjectionError);
    expect(caller.args.record.status).toBe('original native publication');
  });

  test('holds a new original restriction field after acquisition', () => {
    const options: CatalogRankingOptions = {};
    const caller = captureAsyncHarnessInput({ query: 'installed runtime' }, options);
    Object.defineProperty(options, 'unusedPrivateAuthority', { value: 'caller text cannot grant authority' });
    expect(() => caller.assertCurrent()).toThrow(ToolInputProjectionError);
  });
});
