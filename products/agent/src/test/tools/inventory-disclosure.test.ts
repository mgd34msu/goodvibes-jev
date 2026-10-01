import { describe, expect, test } from 'bun:test';
import { inventoryDisclosure, withInventoryDisclosure } from '../../tools/inventory-disclosure.ts';

describe('empty inventories explain themselves', () => {
  test('the exact response that cost the owner an email now says why it is empty', () => {
    // Verbatim from the incident transcript: zero rows, fourteen exist, two ready.
    const payload = withInventoryDisclosure(
      { channels: [], returned: 0, total: 14, enabled: 2, ready: 2 },
      {
        subject: 'channels',
        returned: 0,
        total: 14,
        filters: { query: 'email' },
        listAllRoute: 'agent_harness mode:"channels"',
        context: ['2 of them are ready to use.'],
      },
    );

    expect(payload.filtered).toBe(true);
    expect(String(payload.note)).toContain('No channels matched, but 14 exist');
    expect(String(payload.note)).toContain('query="email"');
    expect(String(payload.note)).toContain('2 of them are ready to use.');
    // The sentence that would have changed the answer.
    expect(String(payload.note)).toContain('does not mean the capability is absent');
    expect(payload.listAllRoute).toBe('agent_harness mode:"channels"');
    expect(payload.appliedFilters).toEqual({ query: 'email' });
  });

  test('a truncated list is disclosed too, not only an empty one', () => {
    const disclosure = inventoryDisclosure({
      subject: 'model tools',
      returned: 20,
      total: 76,
      filters: { query: 'mail' },
      listAllRoute: 'agent_harness mode:"tools"',
    });
    expect(disclosure?.note).toContain('Showing 20 of 76 model tools');
  });

  test('a complete list says nothing extra', () => {
    expect(inventoryDisclosure({
      subject: 'channels',
      returned: 14,
      total: 14,
      filters: {},
      listAllRoute: 'agent_harness mode:"channels"',
    })).toBeNull();
  });

  test('an unfiltered empty inventory still explains itself', () => {
    const disclosure = inventoryDisclosure({
      subject: 'channels',
      returned: 0,
      total: 3,
      filters: {},
      listAllRoute: 'agent_harness mode:"channels"',
    });
    expect(disclosure?.note).toContain('partial view');
    expect(disclosure?.appliedFilters).toEqual({});
  });

  test('empty and false filter values are not reported as filters', () => {
    const disclosure = inventoryDisclosure({
      subject: 'channels',
      returned: 0,
      total: 5,
      filters: { query: '   ', includeParameters: false, limit: 200 },
      listAllRoute: 'agent_harness mode:"channels"',
    });
    expect(disclosure?.appliedFilters).toEqual({ limit: 200 });
  });

  test('a payload is returned untouched when there is nothing to disclose', () => {
    const payload = withInventoryDisclosure(
      { channels: ['a'], returned: 1, total: 1 },
      { subject: 'channels', returned: 1, total: 1, filters: {}, listAllRoute: 'x' },
    );
    expect(payload).toEqual({ channels: ['a'], returned: 1, total: 1 });
  });
});
