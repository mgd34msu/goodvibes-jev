/**
 * operator-method-catalog-search.test.ts
 *
 * `host action:"methods" query:"google"` answered
 * `{ methods: [], returned: 0, total: 434 }` in a live session, repeatedly, and
 * the model went on to guess method ids from memory. The catalog was matching
 * the caller's whole phrase as one contiguous substring against a haystack that
 * held a collapsed label and several hundred words of harness boilerplate, but
 * not the contract's own description, and not one plain word anybody would use
 * for a family of methods.
 *
 * These pin the three things that changed: what is searched, how it is matched,
 * and what an empty page says for itself.
 */

import { describe, expect, test } from 'bun:test';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import {
  describeHarnessOperatorMethod,
  operatorMethodSummary,
} from '../../tools/agent-harness-operator-methods.ts';
import { OPERATOR_METHOD_CATEGORY_VOCABULARY } from '../../tools/agent-harness-operator-method-vocabulary.ts';

interface MethodRow {
  readonly id: string;
  readonly category: string;
}

function page(args: Parameters<typeof operatorMethodSummary>[0]): {
  readonly methods: readonly MethodRow[];
  readonly returned: number;
  readonly total: number;
  readonly note?: string;
  readonly queryMatch?: string;
  readonly appliedFilters?: Record<string, string>;
} {
  return operatorMethodSummary(args) as never;
}

describe('operator method catalog: plain-word search', () => {
  test('"google" surfaces the calendar and mail methods it is actually the connector for, plus the account posture', () => {
    const result = page({ query: 'google' });

    expect(result.returned).toBeGreaterThan(0);
    const ids = new Set(result.methods.map((method) => method.id));

    // The five calendar methods: the daemon's calendar connector is
    // Google-backed, and their own descriptions only ever say "CalDAV".
    expect(ids.has('calendar.events.list')).toBe(true);
    expect(ids.has('calendar.events.create')).toBe(true);
    expect(ids.has('calendar.ics.import')).toBe(true);

    // The mailbox: the inbound reader authenticates to Gmail when Google
    // credentials have been adopted.
    expect(ids.has('email.inbox.list')).toBe(true);
    expect(ids.has('email.send')).toBe(true);

    // Where a connected Google account's posture is actually reported.
    expect(ids.has('accounts.snapshot')).toBe(true);

    // And the profile family, which is what a connect-an-account flow ends up
    // reading and writing about the owner.
    expect(ids.has('profile.read')).toBe(true);

    // The whole catalog is still reported, so a partial page cannot read as
    // the complete one.
    expect(result.total).toBeGreaterThan(result.returned);
    expect(result.note).toContain(`of ${result.total} methods`);
  });

  test('the contract\'s DESCRIPTION is searchable, not just its title', () => {
    // "iCalendar UID" appears only in calendar.events.get's description; its
    // title is "Get Calendar Event", so a label-only haystack could not see it.
    const result = page({ query: 'icalendar uid' });
    expect(result.methods.map((method) => method.id)).toContain('calendar.events.get');
  });

  test('a phrase whose words are scattered across a method still matches', () => {
    // Neither ordering appears contiguously anywhere; every word does.
    const result = page({ query: 'calendar export' });
    expect(result.methods.map((method) => method.id)).toContain('calendar.ics.export');
  });

  test('a multi-word query that matches nothing whole falls back to single words, and says the match was loose', () => {
    const result = page({ query: 'calendar zzzznotathing' });

    expect(result.returned).toBeGreaterThan(0);
    expect(result.queryMatch).toBe('relaxed');
    expect(result.note).toContain('near misses');
    expect(result.methods.map((method) => method.id)).toContain('calendar.events.list');
  });

  test('a nonsense query says plainly that nothing matched, out of how many, and how to see them all', () => {
    const result = page({ query: 'zzzznotathing' });

    expect(result.returned).toBe(0);
    expect(result.methods).toEqual([]);
    // The catalog's own size, not the match count, an empty page that also
    // says total:0 is what got read as "this platform cannot do that".
    expect(result.total).toBeGreaterThan(400);
    expect(result.note).toContain('No methods matched');
    expect(result.note).toContain(`${result.total} methods exist`);
    expect(result.note).toContain('host action:"methods" with no query');
    expect(result.appliedFilters).toEqual({ query: 'zzzznotathing' });
  });

  test('an empty query matches everything, and a page cut short by the default limit says so', () => {
    const result = page({});
    // The default page size is 200; the catalog is larger. The page must not
    // read as the complete catalog, that is the failure the envelope exists
    // for, and it is why `total` is the catalog's size rather than the match
    // count.
    expect(result.returned).toBe(200);
    expect(result.total).toBeGreaterThan(400);
    expect(result.note).toContain(`Showing 200 of ${result.total} methods`);

    // Raising the limit reaches the whole catalog, with no filter applied.
    const everything = page({ limit: 500 });
    expect(everything.returned).toBe(everything.total);
  });

  test('an exact method id still resolves by id, ahead of any search', () => {
    const resolution = describeHarnessOperatorMethod({ methodId: 'calendar.events.list' });
    expect(resolution.status).toBe('found');
  });

  test('a plain-word lookup that matches many reports them as candidates instead of "Unknown operator method"', () => {
    const resolution = describeHarnessOperatorMethod({ query: 'google' });
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') return;
    expect(resolution.candidates.length).toBeGreaterThan(1);
  });

  test('an unresolvable lookup names the catalog size and the route that lists it', () => {
    const resolution = describeHarnessOperatorMethod({ query: 'zzzznotathing' });
    expect(resolution.status).toBe('missing_lookup');
    if (resolution.status !== 'missing_lookup') return;
    expect(resolution.usage).toContain('cataloged methods matched that');
    expect(resolution.usage).toContain('host action:"methods" with no query');
  });
});

describe('operator method search vocabulary', () => {
  test('every category it names exists in the live operator contract', () => {
    const contract = getOperatorContract() as { operator?: { methods?: readonly { category?: string }[] } };
    const live = new Set(
      (contract.operator?.methods ?? [])
        .map((method) => method.category)
        .filter((category): category is string => typeof category === 'string'),
    );

    const unknown = Object.keys(OPERATOR_METHOD_CATEGORY_VOCABULARY).filter((category) => !live.has(category));
    expect(unknown).toEqual([]);
  });

  test('no category is given an empty alias list', () => {
    for (const [category, aliases] of Object.entries(OPERATOR_METHOD_CATEGORY_VOCABULARY)) {
      expect(aliases.length, `${category} has no aliases`).toBeGreaterThan(0);
    }
  });
});
