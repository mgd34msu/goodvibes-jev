import { types as nodeTypes } from 'node:util';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogMethods, captureCatalogSnapshot, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';

/** Bind the full original public input and restrictions across async reads.
 * With retainAtPublication, call retainSourceCurrent before publishing the result. */
export function captureAsyncHarnessInput<T>(rawArgs: T, options: CatalogRankingOptions, retainAtPublication = false, initialGuards: readonly (() => void)[] = []) {
  const assertOptions = captureCatalogMethods(options, ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource']);
  assertOptions();
  const keys = Reflect.ownKeys(options);
  const allowed = ['signal', 'sourceOwner', 'assertCurrent', 'retainCurrent', 'requirePreservedSource'];
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) throw new ToolInputProjectionError('invalid');
  const assertKeys = (): void => {
    const current = Reflect.ownKeys(options);
    if (current.length !== keys.length || current.some((key, index) => key !== keys[index])) throw new ToolInputProjectionError('held');
  };
  const outerCurrent = options.assertCurrent, outerRetain = options.retainCurrent, signal = options.signal;
  if ((outerCurrent !== undefined && (typeof outerCurrent !== 'function' || nodeTypes.isProxy(outerCurrent)))
    || (outerRetain !== undefined && (typeof outerRetain !== 'function' || nodeTypes.isProxy(outerRetain)))) throw new ToolInputProjectionError('invalid');
  const nativeGuards = new Set<() => void>(initialGuards);
  const assertInitial = (): void => {
    for (const guard of nativeGuards) {
      if (typeof guard !== 'function' || nodeTypes.isProxy(guard)) throw new ToolInputProjectionError('invalid');
      const result: unknown = guard();
      if (result !== undefined) {
        if (nodeTypes.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
        throw new ToolInputProjectionError('held');
      }
    }
  };
  const throwIfAborted = AbortSignal.prototype.throwIfAborted;
  const checkSignal = (): void => { if (signal) Reflect.apply(throwIfAborted, signal, []); };
  const assertOuter = (): void => {
    assertOptions(); assertKeys(); checkSignal();
    const result: unknown = outerCurrent?.();
    if (result !== undefined) {
      if (nodeTypes.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      throw new ToolInputProjectionError('held');
    }
    assertOptions(); assertKeys(); checkSignal();
  };
  assertInitial(); assertOuter(); assertInitial();
  const input = captureCatalogSnapshot(rawArgs);
  const assertInputCurrent = (): void => {
    assertOptions(); assertKeys(); checkSignal(); input.assertCurrent(rawArgs);
  };
  // This guard may outlive a nested read and enter its parent's retention set.
  // It never invokes the outer callback that visits that same retention set.
  const assertSourceCurrent = (): void => {
    assertInputCurrent();
    for (const guard of nativeGuards) {
      const result: unknown = guard();
      if (result !== undefined) {
        if (nodeTypes.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
        throw new ToolInputProjectionError('held');
      }
    }
    assertInputCurrent();
  };
  // Independent child sources keep caller restrictions without inheriting
  // unrelated sibling observations. The parent still validates all native
  // observations before joining and publishing the child result.
  const assertCallerCurrent = (): void => {
    assertInputCurrent(); assertOuter(); assertInputCurrent();
  };
  const assertCurrent = (): void => {
    assertOuter(); assertSourceCurrent(); assertOuter(); assertSourceCurrent();
  };
  const retainCurrent = (guard: () => void, key?: string): void => {
    assertCurrent();
    if (typeof guard !== 'function' || nodeTypes.isProxy(guard)
      || guard === assertCurrent || guard === assertSourceCurrent || guard === outerCurrent) throw new ToolInputProjectionError('invalid');
    nativeGuards.add(guard);
    const result: unknown = retainAtPublication ? undefined : outerRetain?.(guard, key);
    if (result !== undefined) {
      if (nodeTypes.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      throw new ToolInputProjectionError('held');
    }
    assertCurrent();
  };
  const retainSourceCurrent = (key?: string): void => {
    assertCurrent();
    const result: unknown = outerRetain?.(assertSourceCurrent, key);
    if (result !== undefined) {
      if (nodeTypes.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      throw new ToolInputProjectionError('held');
    }
    assertCurrent();
  };
  assertCurrent();
  return { args: input.captured, assertCurrent, assertCallerCurrent, assertInputCurrent, assertSourceCurrent, retainSourceCurrent, options: { signal, sourceOwner: options.sourceOwner, assertCurrent, retainCurrent,
    ...(options.requirePreservedSource !== undefined ? { requirePreservedSource: options.requirePreservedSource } : {}) } satisfies CatalogRankingOptions };
}
