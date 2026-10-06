import { types as nodeTypes } from 'node:util';

const invalid = (): never => { throw new Error('Invalid source spans'); };

function splitsSurrogate(text: string, offset: number): boolean {
  const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

/**
 * Capture ordered, non-overlapping UTF-16 ranges into the exact, unchanged text.
 * This checks structure only; source identity, revision and meaning belong to the caller.
 * All input reads use own data descriptors, including non-enumerable properties.
 */
export function captureSourceSpans(text: string, value: unknown): readonly { start: number; end: number }[] {
  if (typeof text !== 'string' || value === null || typeof value !== 'object' || nodeTypes.isProxy(value)
    || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length: unknown = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
  // Check the bound before enumerating or walking a potentially enormous sparse array.
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 100
    || Reflect.ownKeys(value).length !== length + 1) return invalid();

  const captured: { start: number; end: number }[] = [];
  let previousEnd = 0;
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return invalid();
    const span: unknown = descriptor.value;
    if (span === null || typeof span !== 'object' || nodeTypes.isProxy(span)) return invalid();
    const prototype: unknown = Object.getPrototypeOf(span);
    if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(span).length !== 2) return invalid();
    const startDescriptor = Object.getOwnPropertyDescriptor(span, 'start');
    const endDescriptor = Object.getOwnPropertyDescriptor(span, 'end');
    if (!startDescriptor || !('value' in startDescriptor) || !endDescriptor || !('value' in endDescriptor)) return invalid();
    const start: unknown = startDescriptor.value, end: unknown = endDescriptor.value;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < previousEnd || end <= start || end > text.length
      || splitsSurrogate(text, start) || splitsSurrogate(text, end)) return invalid();
    captured.push(Object.freeze({ start, end }));
    previousEnd = end;
  }
  return Object.freeze(captured);
}
