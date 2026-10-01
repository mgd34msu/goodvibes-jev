import { describe, expect, test } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { lineToString } from '../setup.ts';
import { activeTokens } from '../../renderer/theme.ts';

describe('UIFactory header', () => {
  test('is one row branded as GoodVibes Agent, with no rule row under it', () => {
    const header = UIFactory.createHeader(80, 'gpt-test', undefined, '1.2.3');
    expect(header).toHaveLength(1);
    const text = lineToString(header[0] ?? []);
    expect(text).toContain('GoodVibes Agent');
    expect(text).toContain('v1.2.3');
    expect(text).not.toContain('━');
  });

  test('the wordmark runs the theme gradient from brand to brandEnd', () => {
    const [row] = UIFactory.createHeader(80, 'gpt-test', undefined, '1.2.3');
    const t = activeTokens();
    const hex = (c: string): string => (c.startsWith('#') ? c.toLowerCase() : `#${c.split(';').map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`);
    expect(hex(row![1]!.fg)).toBe(hex(t.brand));
    expect(hex(row![15]!.fg)).toBe(hex(t.brandEnd));
    expect(row![1]!.bold).toBe(true);
  });

  test('the serving model ends at width-2 and the title sits after the version', () => {
    const [row] = UIFactory.createHeader(80, 'gpt-test', 'Trip planning', '1.2.3');
    const text = lineToString(row ?? []);
    expect(text.trimEnd().length).toBe(79);
    expect(text.trimEnd().endsWith('gpt-test')).toBe(true);
    expect(text).toContain('Trip planning');
  });

  test('a long title gives way to the model', () => {
    const [row] = UIFactory.createHeader(50, 'gpt-test', 'An extremely long session title that cannot possibly fit', '1.2.3');
    expect(lineToString(row ?? []).trimEnd().endsWith('gpt-test')).toBe(true);
  });
});
