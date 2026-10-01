import { JudgmentInputError } from '../../../gate/judgment-input.js';

/** Inspect only structural scope before selecting records for full capture. */
export function gapRecordField(record: unknown, key: string): unknown {
  if (record === undefined || record === null) return undefined;
  if (typeof record !== 'object' || Array.isArray(record)) throw new JudgmentInputError('unsupported-input');
  const prototype: unknown = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) throw new JudgmentInputError('unsupported-input');
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor) || typeof descriptor.value === 'function') throw new JudgmentInputError('unsupported-input');
  return descriptor.value;
}

/** Own structural records before projection without privacy-scanning opaque IDs.
 * Preserve data descriptors, including hidden selected fields, and never invoke
 * array species, iterators, getters or serialization hooks while capturing them.
 */
export function snapshotGapRecord<T>(input: T): T {
  let count = 0, chars = 0, slots = 0;
  const ancestors = new Set<object>();
  const unsupported = (): never => { throw new JudgmentInputError('unsupported-input'); };
  function capture(value: unknown, depth: number): unknown {
    if (++count > 20_000 || depth > 64) return unsupported();
    if (typeof value === 'string') { chars += value.length; if (chars > 1_000_000) return unsupported(); return value; }
    if (value === undefined || value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : unsupported();
    if (typeof value !== 'object' || ancestors.has(value)) return unsupported();
    const array = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return unsupported();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(descriptors).length || (array && Object.hasOwn(descriptors, 'constructor'))
      || Object.values(descriptors).some((descriptor) => !('value' in descriptor) || typeof descriptor.value === 'function')) return unsupported();
    const length: unknown = array ? descriptors['length']?.value : 0;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || (slots += length) > 20_000) return unsupported();
    const copy: object = array ? new Array(length) : Object.create(null) as object;
    ancestors.add(value);
    try {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array && key === 'length') continue;
        // Context arrays are lists, not bags with unprojected extra fields.
        if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return unsupported();
        Object.defineProperty(copy, key, { value: capture(descriptor.value, depth + 1), enumerable: true });
      }
      if (array && Object.keys(copy).length !== length) return unsupported();
      return Object.freeze(copy);
    } finally { ancestors.delete(value); }
  }
  return capture(input, 0) as T;
}
