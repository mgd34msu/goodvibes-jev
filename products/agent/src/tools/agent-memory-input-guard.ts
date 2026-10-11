import { types as nodeTypes } from 'node:util';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { containsSecretLikeText } from '../agent/memory-safety.ts';

/** Screen every original field before repair without invoking caller accessors. */
export function assertAgentMemoryInput(args: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  function inspect(value: unknown, depth: number): void {
    if (++nodes > 20_000 || depth > 64) throw new ToolInputProjectionError('invalid');
    if (typeof value === 'string') {
      if (containsSecretLikeText(value)) throw new ToolInputProjectionError('held');
      return;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (typeof value !== 'object' || nodeTypes.isProxy(value) || ancestors.has(value)) throw new ToolInputProjectionError('invalid');
    const array = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new ToolInputProjectionError('invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length: unknown = array ? descriptors.length?.value : undefined;
    if (array && (typeof length !== 'number' || length > 20_000 || Reflect.ownKeys(descriptors).length !== length + 1)) throw new ToolInputProjectionError('invalid');
    ancestors.add(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new ToolInputProjectionError('invalid');
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) throw new ToolInputProjectionError('invalid');
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || (array && (typeof length !== 'number' || !Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= length))) throw new ToolInputProjectionError('invalid');
      if (containsSecretLikeText(key)) throw new ToolInputProjectionError('held');
      inspect(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  inspect(args, 0);
}
