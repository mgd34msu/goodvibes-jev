import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { captureOwnedJson } from '../gate/judgment-input.js';
import type { McpToolCallOptions } from './client-types.js';

/** Inspect native backend slots without invoking a replacement accessor. */
export function captureMcpBackendMethods(subject: object, keys: readonly string[]): () => void {
  const inspect = () => {
    const chain: object[] = []; let owner: object | null = subject;
    while (owner) {
      if (nodeTypes.isProxy(owner) || chain.length >= 64) throw new Error('MCP backend is unavailable');
      chain.push(owner); owner = Object.getPrototypeOf(owner);
    }
    return { chain, slots: keys.map(key => {
      for (const owner of chain) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (descriptor) {
          if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error('MCP backend method is unavailable');
          return { owner, descriptor };
        }
      }
      throw new Error('MCP backend method is unavailable');
    }) };
  };
  const before = inspect();
  return () => {
    const after = inspect();
    if (before.chain.length !== after.chain.length || before.chain.some((owner, index) => owner !== after.chain[index])) throw new Error('MCP backend changed');
    for (const [index, prior] of before.slots.entries()) {
      const next = after.slots[index];
      if (!next || next.owner !== prior.owner || next.descriptor.value !== prior.descriptor.value
        || next.descriptor.writable !== prior.descriptor.writable || next.descriptor.enumerable !== prior.descriptor.enumerable
        || next.descriptor.configurable !== prior.descriptor.configurable) throw new Error('MCP backend method changed');
    }
  };
}

/** Capture only caller restrictions; this never grants MCP execution. */
export function captureMcpCallRestrictions(options?: McpToolCallOptions) {
  const invalid = (): never => { throw new Error('MCP caller restrictions must be synchronous data properties'); };
  const properties = (): Record<string, PropertyDescriptor> => {
    if (!options) return {};
    if (nodeTypes.isProxy(options)) return invalid();
    const prototype: unknown = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (Object.getOwnPropertySymbols(options).length || Object.values(descriptors).some(value => !('value' in value))) return invalid();
    return descriptors;
  };
  const captured = properties();
  const signal: unknown = captured.signal?.value, current: unknown = captured.assertCurrent?.value;
  const expectedSchema: unknown = captured.expectedSchema?.value;
  const schemaSnapshot: unknown = expectedSchema === undefined ? undefined : captureOwnedJson(expectedSchema, nodeTypes.isProxy);
  if (signal !== undefined && !(signal instanceof AbortSignal)) return invalid();
  if (current !== undefined && (typeof current !== 'function' || nodeTypes.isProxy(current) || nodeTypes.isAsyncFunction(current))) return invalid();
  const assertOptions = () => {
    const now = properties();
    for (const key of ['signal', 'assertCurrent', 'expectedSchema']) {
      const before = captured[key], after = now[key];
      if (before?.value !== after?.value || before?.enumerable !== after?.enumerable
        || before?.configurable !== after?.configurable || before?.writable !== after?.writable) return invalid();
    }
    if (expectedSchema !== undefined && !isDeepStrictEqual(captureOwnedJson(expectedSchema, nodeTypes.isProxy), schemaSnapshot)) return invalid();
  };
  const assertCurrent = () => {
    assertOptions(); signal?.throwIfAborted();
    const result: unknown = typeof current === 'function' ? current() : undefined;
    if (result !== undefined) {
      if (nodeTypes.isPromise(result)) void Promise.resolve(result).then(() => undefined, () => undefined);
      return invalid();
    }
    assertOptions(); signal?.throwIfAborted();
  };
  assertCurrent();
  return { signal, assertCurrent, expectedSchema };
}
