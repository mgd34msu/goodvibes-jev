import { expect, test } from 'bun:test';
import { captureSourceSpans } from '../sdk/src/platform/security/source-spans.js';

const invalidMessage = 'Invalid source spans';
const range = () => ({ start: 0, end: 1 });

test('captures exact UTF-16 offsets, duplicate occurrences, gaps and adjacent ranges', () => {
  const text = ' 🌻 Keep logs. Keep logs.\n';
  const first = text.indexOf('Keep logs.'), second = text.lastIndexOf('Keep logs.');
  const spans = [
    { start: 1, end: 3 },
    { start: 3, end: 4 },
    { start: first, end: first + 10 },
    { start: second, end: second + 10 },
  ];
  const captured = captureSourceSpans(text, spans);
  expect(captured).toEqual(spans);
  expect(captured.map(span => text.slice(span.start, span.end))).toEqual(['🌻', ' ', 'Keep logs.', 'Keep logs.']);
});

test('permits zero ranges, full-source boundaries and whitespace without adding semantic rules', () => {
  for (const text of ['', 'abc', ' \t\n']) expect(captureSourceSpans(text, [])).toEqual([]);
  for (const text of ['abc', ' \t\n', '🌻']) {
    expect(captureSourceSpans(text, [{ start: 0, end: text.length }])).toEqual([{ start: 0, end: text.length }]);
  }
  expect(() => captureSourceSpans('', [range()])).toThrow(invalidMessage);
});

test('returns a deeply frozen owned copy without freezing or retaining caller objects', () => {
  const spans = [range()];
  const captured = captureSourceSpans('abc', spans);
  expect(captured).not.toBe(spans);
  expect(captured[0]).not.toBe(spans[0]);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.isFrozen(captured[0])).toBe(true);
  expect(Object.isFrozen(spans)).toBe(false);
  expect(Object.isFrozen(spans[0])).toBe(false);
  spans[0]!.end = 3;
  spans.push({ start: 1, end: 2 });
  expect(captured).toEqual([{ start: 0, end: 1 }]);
});

test('rejects either boundary inside a surrogate pair but does not normalize or require grapheme boundaries', () => {
  const text = 'a🌻b';
  for (const span of [{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 1, end: 2 }, { start: 2, end: 3 }]) {
    expect(() => captureSourceSpans(text, [span])).toThrow(invalidMessage);
  }
  const adjacent = [{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 }];
  expect(captureSourceSpans(text, adjacent)).toEqual(adjacent);
  expect(captureSourceSpans('e\u0301', [{ start: 0, end: 1 }, { start: 1, end: 2 }]))
    .toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  for (const loneSurrogate of ['\ud800', '\udfff']) {
    expect(captureSourceSpans(loneSurrogate, [range()])).toEqual([range()]);
  }
});

test('requires sorted, positive, in-bounds, non-overlapping ranges', () => {
  const bad = [
    [{ start: -1, end: 1 }], [{ start: 0, end: 0 }], [{ start: 2, end: 1 }],
    [{ start: 0, end: 4 }], [{ start: 3, end: 4 }],
    [{ start: 1, end: 2 }, { start: 0, end: 1 }],
    [{ start: 0, end: 2 }, { start: 1, end: 3 }],
    [{ start: 0, end: 1 }, { start: 0, end: 1 }],
  ];
  for (const spans of bad) expect(() => captureSourceSpans('abc', spans)).toThrow(invalidMessage);
});

test('requires primitive finite safe integer offsets without coercing values', () => {
  let calls = 0;
  const coercible = { valueOf() { calls++; return 1; }, toString() { calls++; return '1'; } };
  const invalid: unknown[] = [NaN, Infinity, -Infinity, 0.5, -1, Number.MAX_SAFE_INTEGER + 1, '1', 1n, null, undefined, true, Symbol('offset'), coercible];
  for (const value of invalid) {
    expect(() => captureSourceSpans('abc', [{ start: value, end: 3 }])).toThrow(invalidMessage);
    expect(() => captureSourceSpans('abc', [{ start: 0, end: value }])).toThrow(invalidMessage);
  }
  expect(() => captureSourceSpans('abc', [{ start: 0, end: Number.MAX_SAFE_INTEGER }])).toThrow(invalidMessage);
  expect(calls).toBe(0);
});

test('permits exactly 100 ranges and rejects oversized arrays before inspecting entries', () => {
  const spans = Array.from({ length: 100 }, (_, start) => ({ start, end: start + 1 }));
  expect(captureSourceSpans('x'.repeat(100), spans)).toEqual(spans);
  expect(() => captureSourceSpans('x'.repeat(101), [...spans, { start: 100, end: 101 }])).toThrow(invalidMessage);
  let calls = 0;
  const huge = new Array(0xffff_ffff);
  Object.defineProperty(huge, '0', { get() { calls++; return range(); } });
  expect(() => captureSourceSpans('x', huge)).toThrow(invalidMessage);
  expect(calls).toBe(0);
});

test('rejects sparse arrays and missing indexes even when extra keys preserve the key count', () => {
  const disguisedHole = new Array(1);
  Object.defineProperty(disguisedHole, '00', { value: range() });
  const symbolHole = new Array(1);
  Object.defineProperty(symbolHole, Symbol('index'), { value: range() });
  const deleted = [range(), { start: 1, end: 2 }];
  delete deleted[0];
  for (const spans of [new Array(1), disguisedHole, symbolHole, deleted]) {
    expect(() => captureSourceSpans('abc', spans)).toThrow(invalidMessage);
  }
});

test('rejects proxy and revoked proxy arrays or spans without invoking traps', () => {
  let calls = 0;
  const traps: ProxyHandler<object> = {
    get() { calls++; throw new Error('owned proxy trap'); },
    getPrototypeOf() { calls++; throw new Error('owned proxy trap'); },
    ownKeys() { calls++; throw new Error('owned proxy trap'); },
    getOwnPropertyDescriptor() { calls++; throw new Error('owned proxy trap'); },
  };
  const revokedArray = Proxy.revocable([range()], traps), revokedSpan = Proxy.revocable(range(), traps);
  revokedArray.revoke(); revokedSpan.revoke();
  for (const value of [new Proxy([range()], traps), [new Proxy(range(), traps)], revokedArray.proxy, [revokedSpan.proxy]]) {
    expect(() => captureSourceSpans('abc', value)).toThrow(invalidMessage);
  }
  expect(calls).toBe(0);
});

test('rejects accessors on array indexes, required fields and hidden extras without calling them', () => {
  let calls = 0;
  const accessor = { get() { calls++; throw new Error('owned getter'); }, set(_value: unknown) { calls++; } };
  const indexGetter = [range()];
  Object.defineProperty(indexGetter, '0', accessor);
  const startGetter = { end: 1 }; Object.defineProperty(startGetter, 'start', accessor);
  const endGetter = { start: 0 }; Object.defineProperty(endGetter, 'end', accessor);
  const setterOnly = { end: 1 }; Object.defineProperty(setterOnly, 'start', { set(_value: unknown) { calls++; } });
  const hiddenGetter = range(); Object.defineProperty(hiddenGetter, 'hidden', accessor);
  const arrayGetter = [range()]; Object.defineProperty(arrayGetter, 'hidden', accessor);
  for (const value of [indexGetter, [startGetter], [endGetter], [setterOnly], [hiddenGetter], arrayGetter]) {
    expect(() => captureSourceSpans('abc', value)).toThrow(invalidMessage);
  }
  expect(calls).toBe(0);
});

test('captures own non-enumerable data descriptors and null-prototype records', () => {
  const span = Object.create(null) as object;
  Object.defineProperties(span, { start: { value: 0 }, end: { value: 1 } });
  const spans = new Array(1);
  Object.defineProperty(spans, '0', { value: span });
  Object.freeze(spans); Object.freeze(span);
  expect(captureSourceSpans('abc', spans)).toEqual([range()]);
});

test('rejects extra enumerable, hidden and symbol fields instead of projecting them away', () => {
  const hiddenSpan = range(); Object.defineProperty(hiddenSpan, 'text', { value: 'owned extra' });
  const hiddenArray = [range()]; Object.defineProperty(hiddenArray, 'text', { value: 'owned extra' });
  const symbolArray = [range()]; Object.defineProperty(symbolArray, Symbol('extra'), { value: 'owned extra' });
  for (const value of [
    [{ ...range(), text: 'owned extra' }], [{ ...range(), partId: 'input' }], [{ ...range(), sourceRevision: 'owned-v1' }],
    [{ ...range(), [Symbol('extra')]: 'owned extra' }], [hiddenSpan], hiddenArray, symbolArray,
    Object.assign([range()], { extra: 'owned extra' }),
  ]) expect(() => captureSourceSpans('abc', value)).toThrow(invalidMessage);
});

test('requires plain arrays and records, including own start and end fields', () => {
  class Span { start = 0; end = 1; }
  class Spans extends Array<object> {}
  const inherited = Object.create({ start: 0, end: 1 }) as object;
  const inheritedArray = Object.create([range()]) as object;
  const nullArray = Object.setPrototypeOf([range()], null) as object;
  for (const value of [
    null, undefined, false, 1, '[]', {}, { 0: range(), length: 1 }, inheritedArray, nullArray, new Spans(range()),
    [null], [undefined], [[]], [new Date(0)], [new Span()], [inherited], [{}], [{ start: 0 }], [{ end: 1 }],
  ]) expect(() => captureSourceSpans('abc', value)).toThrow(invalidMessage);
});

test('rejects non-string source without coercion and uses one value-free failure', () => {
  let calls = 0;
  const text = { toString() { calls++; return 'owned source'; } };
  for (const value of [undefined, null, 1, text]) {
    expect(() => captureSourceSpans(value as unknown as string, [])).toThrow(invalidMessage);
  }
  expect(calls).toBe(0);
  try {
    captureSourceSpans('owned confidential source', [{ start: 'owned confidential offset', end: 1 }]);
    throw new Error('Expected validation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(invalidMessage);
    expect((error as Error).cause).toBeUndefined();
    expect(Object.keys(error as object)).toEqual([]);
    expect(String(error)).not.toContain('owned confidential');
  }
});
