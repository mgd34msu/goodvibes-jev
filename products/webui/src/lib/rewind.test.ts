import { describe, expect, test } from 'bun:test';
import { turnAnchorsFromMessages } from './rewind';

describe('turnAnchorsFromMessages', () => {
  test('collects distinct turns newest-first with the first non-empty body as label', () => {
    const anchors = turnAnchorsFromMessages([
      { turnId: 't-1', role: 'user', body: 'add a feature' },
      { turnId: 't-1', role: 'assistant', body: 'done' },
      { turnId: 't-2', role: 'user', content: 'now fix the bug' },
      { turnId: 't-2', role: 'assistant', content: 'fixed' },
    ]);
    expect(anchors).toEqual([
      { turnId: 't-2', label: 'now fix the bug' },
      { turnId: 't-1', label: 'add a feature' },
    ]);
  });

  test('skips messages with no turnId (they cannot anchor a rewind)', () => {
    const anchors = turnAnchorsFromMessages([
      { role: 'system', body: 'boot' },
      { turnId: 't-9', role: 'user', body: 'go' },
    ]);
    expect(anchors).toEqual([{ turnId: 't-9', label: 'go' }]);
  });

  test('fills a turn label from a later message when the first in the turn had no body', () => {
    const anchors = turnAnchorsFromMessages([
      { turnId: 't-1', role: 'tool' },
      { turnId: 't-1', role: 'user', text: 'the real prompt' },
    ]);
    expect(anchors).toEqual([{ turnId: 't-1', label: 'the real prompt' }]);
  });

  test('truncates a long label', () => {
    const long = 'x'.repeat(200);
    const [anchor] = turnAnchorsFromMessages([{ turnId: 't-1', body: long }]);
    expect(anchor.label.length).toBeLessThanOrEqual(80);
    expect(anchor.label.endsWith('…')).toBe(true);
  });

  test('caps the number of anchors returned', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ turnId: `t-${i}`, body: `turn ${i}` }));
    expect(turnAnchorsFromMessages(items, 5)).toHaveLength(5);
  });
});
