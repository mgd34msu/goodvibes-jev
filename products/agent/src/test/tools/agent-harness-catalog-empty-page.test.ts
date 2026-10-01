/**
 * A catalog page never comes back empty without saying why.
 *
 * `workspace action:"actions"` answered `{"actions": [], "returned": 0,
 * "total": 463}`: it reported that hundreds of entries exist, named none of
 * them, and never echoed the filter that had excluded them, so a caller whose
 * own `category` argument matched nothing had no way to see that, and the only
 * way forward was to keep guessing. Every catalog now echoes the filters it
 * applied and, when a page is empty while the catalog is not, states what to
 * send instead.
 */
import { describe, test, expect } from 'bun:test';
import { catalogEnvelope, readLimit } from '@/tools/agent-harness-tool-utils.ts';

interface Envelope {
  readonly returned: number;
  readonly total: number;
  readonly note?: string;
  readonly appliedFilters?: Record<string, string>;
  readonly [key: string]: unknown;
}

const envelope = (
  items: readonly unknown[],
  total: number,
  filters: Record<string, string | undefined> = {},
  discovery?: string,
): Envelope => catalogEnvelope('actions', items, total, filters, discovery) as unknown as Envelope;

describe('catalog envelope: an empty page explains itself', () => {
  test('an empty page under a filter names the filter and the way out', () => {
    const result = envelope([], 463, { category: 'actions' }, 'agent_harness mode:"workspace_actions" with no category or query');

    expect(result.returned).toBe(0);
    expect(result.total).toBe(463);
    expect(result.appliedFilters).toEqual({ category: 'actions' });
    expect(result.note).toBeDefined();
    // The note must name the offending argument AND its value.
    expect(result.note).toContain('category="actions"');
    expect(result.note).toContain('463');
    expect(result.note).toContain('workspace_actions');
  });

  test('an empty page with no filter still says the catalog is not empty', () => {
    const result = envelope([], 76, {}, 'agent_harness mode:"tools" with no query');
    expect(result.note).toBeDefined();
    expect(result.note).toContain('76');
  });

  test('multiple applied filters are all echoed', () => {
    const result = envelope([], 463, { category: 'nope', query: 'zzz' });
    expect(result.appliedFilters).toEqual({ category: 'nope', query: 'zzz' });
    expect(result.note).toContain('category="nope"');
    expect(result.note).toContain('query="zzz"');
  });

  test('blank and undefined filter values are not reported as applied', () => {
    const result = envelope([], 10, { category: '', query: undefined, target: '   '.trim() });
    expect(result.appliedFilters).toBeUndefined();
  });
});

describe('catalog envelope: a non-empty page is left alone', () => {
  test('a SHORTENED page says so rather than passing for the whole catalog', () => {
    // This assertion used to require the opposite, that a populated page carry
    // no note, on the reasoning that it speaks for itself. It does not.
    // "Showing 2 of 463" read as a complete answer is the same failure as an
    // empty page read as "no such capability", only slower, and `returned` and
    // `total` sitting two fields apart are easy to miss in a way a sentence is
    // not. Changed deliberately when the browser round's inventory disclosure
    // and this envelope were merged into one shape.
    const result = envelope([{ id: 'a' }, { id: 'b' }], 463, { query: 'a' });
    expect(result.returned).toBe(2);
    expect(result.total).toBe(463);
    expect(result.note).toContain('Showing 2 of 463');
    expect(result.note).toContain('query="a"');
    expect(result.appliedFilters).toEqual({ query: 'a' });
  });

  test('a page holding the whole catalog carries no note', () => {
    // Nothing was withheld, so there is nothing to disclose.
    const result = envelope([{ id: 'a' }, { id: 'b' }], 2, {});
    expect(result.returned).toBe(2);
    expect(result.total).toBe(2);
    expect(result.note).toBeUndefined();
  });

  test('a genuinely empty catalog is not treated as a filter problem', () => {
    // Still not a filter problem, but no longer silent about it. This used to
    // assert `note` was undefined, which left `{"x": [], "returned": 0,
    // "total": 0}` as a complete answer, and that shape is exactly what a model
    // reads as "this platform has none of these, ever". Zero rows and zero
    // total now say so in words, without blaming an argument that changed
    // nothing.
    const result = envelope([], 0, { query: 'a' });
    expect(result.returned).toBe(0);
    expect(result.total).toBe(0);
    expect(result.note).toContain('no actions at all');
    expect(result.note).toContain('no argument emptied this page');
    expect(result.note).not.toContain('query="a"');
  });

  test('the page keeps the field name the caller expects', () => {
    const result = catalogEnvelope('tools', [{ name: 'read' }], 76, {});
    expect(result.tools).toEqual([{ name: 'read' }]);
    expect(result.returned).toBe(1);
  });
});

describe('page-size ceilings', () => {
  test('a surface with a bigger catalog can declare its own ceiling', () => {
    // The shared ceiling suits the small catalogs. A catalog that has outgrown
    // it must be able to raise its own, or its listing silently loses the tail.
    expect(readLimit(1500, 10)).toBe(500);
    expect(readLimit(1500, 10, 2000)).toBe(1500);
    expect(readLimit(9000, 10, 2000)).toBe(2000);
  });

  test('the fallback page size is bounded by the same ceiling', () => {
    expect(readLimit(undefined, 3000, 2000)).toBe(2000);
    expect(readLimit('not a number', 120, 2000)).toBe(120);
  });

  test('still floors at one row and reads numeric strings', () => {
    expect(readLimit(0, 10, 2000)).toBe(1);
    expect(readLimit(-40, 10, 2000)).toBe(1);
    expect(readLimit('750', 10, 2000)).toBe(750);
  });
});
