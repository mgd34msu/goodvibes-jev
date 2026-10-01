import { describe, expect, test } from 'bun:test';
import { readMemoryProvenanceIds } from './memory-provenance';

describe('readMemoryProvenanceIds', () => {
  test('returns [] for undefined metadata', () => {
    expect(readMemoryProvenanceIds(undefined)).toEqual([]);
  });

  test('returns [] for null metadata', () => {
    expect(readMemoryProvenanceIds(null)).toEqual([]);
  });

  test('returns [] for non-object metadata', () => {
    expect(readMemoryProvenanceIds('not an object')).toEqual([]);
    expect(readMemoryProvenanceIds(42)).toEqual([]);
  });

  test('returns [] when metadata.memory is absent', () => {
    expect(readMemoryProvenanceIds({ model: 'sonnet' })).toEqual([]);
  });

  test('returns [] when metadata.memory is not an object', () => {
    expect(readMemoryProvenanceIds({ memory: 'nope' })).toEqual([]);
  });

  test('returns [] when metadata.memory.recordIds is absent', () => {
    expect(readMemoryProvenanceIds({ memory: {} })).toEqual([]);
  });

  test('returns [] when metadata.memory.recordIds is not an array', () => {
    expect(readMemoryProvenanceIds({ memory: { recordIds: 'mem-1' } })).toEqual([]);
  });

  test('returns the ids when metadata.memory.recordIds is a real string array', () => {
    expect(readMemoryProvenanceIds({ memory: { recordIds: ['mem-1', 'mem-2'] } })).toEqual(['mem-1', 'mem-2']);
  });

  test('filters out non-string / empty-string entries defensively, never throwing', () => {
    expect(readMemoryProvenanceIds({ memory: { recordIds: ['mem-1', 42, null, '', 'mem-2'] } })).toEqual(['mem-1', 'mem-2']);
  });

  test('an empty recordIds array returns []', () => {
    expect(readMemoryProvenanceIds({ memory: { recordIds: [] } })).toEqual([]);
  });
});
