/** Local transcript capture. Never invokes accessors/serialization hooks or applies provider input caps to images/history. */
export function captureTranscriptSnapshot<T>(value: T): T {
  const ancestors = new Set<object>();
  const unsupported = (): never => { throw new Error('Transcript snapshot requires plain data.'); };
  function capture(entry: unknown): unknown {
    if (entry === null || entry === undefined || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : unsupported();
    if (typeof entry !== 'object' || ancestors.has(entry)) return unsupported();
    const array = Array.isArray(entry);
    const prototype: unknown = Object.getPrototypeOf(entry);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return unsupported();
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (Object.getOwnPropertySymbols(descriptors).length || (array && Object.hasOwn(descriptors, 'constructor'))) return unsupported();
    if (Object.values(descriptors).some(descriptor => !('value' in descriptor) || typeof descriptor.value === 'function')) return unsupported();
    const length: unknown = array ? descriptors['length']?.value : 0;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) return unsupported();
    const copy: object = array ? new Array(length) : Object.create(null) as object;
    ancestors.add(entry);
    try {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array ? key === 'length' : !descriptor.enumerable) continue;
        Object.defineProperty(copy, key, { value: capture(descriptor.value), enumerable: true });
      }
      return Object.freeze(copy);
    } finally { ancestors.delete(entry); }
  }
  try { return capture(value) as T; } catch { return unsupported(); }
}
