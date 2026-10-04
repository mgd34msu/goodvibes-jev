import { expect, test } from 'bun:test';
import { renderType } from '../scripts/foundation-io-render.js';

test('finite numeric enums retain literal identity and deterministic unions', () => {
  expect(renderType({ type: 'number', enum: [1] })).toBe('1');
  expect(renderType({ type: 'integer', enum: [10, -2, 1, 10, 0] })).toBe('-2 | 0 | 1 | 10');
  expect(renderType({ type: 'number', enum: [1.5, -0.25, 1.5] })).toBe('-0.25 | 1.5');
  expect(renderType({ type: 'number', enum: [-0, 0] })).toBe('0');
  expect(renderType({ type: 'object', required: ['version'], properties: { version: { type: 'number', enum: [1] } } })).toBe('{ version: 1; }');
});

test('numeric literal array elements and nullable branches preserve grouping', () => {
  expect(renderType({ type: 'array', items: { type: 'number', enum: [2, 1] } })).toBe('readonly (1 | 2)[]');
  expect(renderType({ type: 'array', items: { type: 'integer', enum: [1] } })).toBe('readonly (1)[]');
  expect(renderType({ anyOf: [{ type: 'null' }, { type: 'number', enum: [1, 2] }] })).toBe('null | 1 | 2');
  expect(renderType({ type: 'array', items: { type: 'number' } })).toBe('readonly number[]');
});

test('malformed numeric enums retain their prior broad fallback and unknown schemas still throw', () => {
  for (const type of ['number', 'integer']) {
    for (const enumeration of [[], '1', null, [Infinity], [NaN], [-Infinity], ['1'], [1, '2'], [1, null], [undefined], [{}]]) {
      expect(renderType({ type, enum: enumeration })).toBe('number');
      expect(renderType({ type: 'array', items: { type, enum: enumeration } })).toBe('readonly number[]');
    }
  }
  expect(renderType({ type: 'integer', enum: [1.5] })).toBe('number');
  expect(renderType({ type: 'string', enum: ['b', 'a'] })).toBe('"a" | "b"');
  expect(() => renderType({ enum: [1] })).toThrow('Unsupported schema node');
  expect(() => renderType({ type: 'unknown', enum: [1] })).toThrow('Unsupported schema node');
  expect(() => renderType({ anyOf: [] })).toThrow('Unsupported anyOf shape');
});
