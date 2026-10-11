import { isDeepStrictEqual } from 'node:util';
import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';

/** Retain actual method descriptors without invoking replacement accessors. */
export function retainSurfaceMethods(owner: object, keys: readonly string[]): () => void {
  const observations = keys.map(key => {
    const chain: object[] = [];
    let current: object | null = owner;
    while (current) {
      chain.push(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw new ToolInputProjectionError('held');
        return { key, chain, descriptor };
      }
      current = Object.getPrototypeOf(current);
    }
    throw new ToolInputProjectionError('held');
  });
  return () => {
    for (const { key, chain, descriptor } of observations) {
      for (const [index, current] of chain.entries()) {
        if (index < chain.length - 1 && Object.getPrototypeOf(current) !== chain[index + 1]) throw new ToolInputProjectionError('stale');
        const latest = Object.getOwnPropertyDescriptor(current, key);
        if (index < chain.length - 1 ? latest !== undefined : !latest || !('value' in latest)
          || latest.value !== descriptor.value || latest.writable !== descriptor.writable
          || latest.enumerable !== descriptor.enumerable || latest.configurable !== descriptor.configurable) throw new ToolInputProjectionError('stale');
      }
    }
  };
}

/** Private complete readset; these values are never judgment evidence. */
export function retainSurfaceRead(owner: object, keys: readonly string[], read: () => unknown): () => void {
  const methods = retainSurfaceMethods(owner, keys);
  const snapshot = captureStrictJudgmentJson(read());
  const assertCurrent = () => {
    methods();
    if (!isDeepStrictEqual(captureStrictJudgmentJson(read()), snapshot)) throw new ToolInputProjectionError('stale');
    methods();
  };
  assertCurrent();
  return assertCurrent;
}
