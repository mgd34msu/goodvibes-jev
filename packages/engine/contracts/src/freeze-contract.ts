import type { OperatorContractManifest } from './types.js';

/** Owns the generated literal; callers must not pass borrowed runtime catalogs. */
export function freezeGeneratedOperatorContract(
  contract: OperatorContractManifest,
): OperatorContractManifest {
  const seen = new Set<object>();
  const nodes: object[] = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value !== 'object') {
      if (typeof value === 'string' || typeof value === 'boolean') return;
      if (typeof value === 'number' && Number.isFinite(value)) return;
      throw new TypeError('Generated operator contract must contain data only.');
    }
    if (seen.has(value)) return;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new TypeError('Generated operator contract must contain plain data only.');
    }
    seen.add(value);
    nodes.push(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) {
        throw new TypeError('Generated operator contract must contain data properties only.');
      }
      const child: unknown = descriptor.value;
      visit(child);
    }
  };
  visit(contract);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node) Object.freeze(node);
  }
  return contract;
}
