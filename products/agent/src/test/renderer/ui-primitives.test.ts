import { describe, expect, test } from 'bun:test';
import { buildMeterLine, buildSectionHeader } from '../../renderer/polish.ts';
import { lineToString } from '../setup.ts';

describe('ui primitives', () => {
  test('section headers use box-drawing horizontal dividers', () => {
    const line = buildSectionHeader(40, 'Summary', {
      label: '#94a3b8',
      value: '#e2e8f0',
      dim: '#475569',
      info: '#38bdf8',
      good: '#22c55e',
      warn: '#f59e0b',
      bad: '#ef4444',
      empty: '#334155',
      header: '#e2e8f0',
      headerBg: '#0f172a',
      accent: '#cbd5e1',
      selectBg: '#111827',
    });
    expect(lineToString(line)).toContain('Summary');
    expect(lineToString(line)).toContain('─');
  });

  test('meter lines default to block and shade glyphs', () => {
    const line = buildMeterLine(24, 4, 8, { filled: '#22c55e', empty: '#334155' });
    const text = lineToString(line);
    expect(text).toContain('█');
    expect(text).toContain('░');
  });
});
