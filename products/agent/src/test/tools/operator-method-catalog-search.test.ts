import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';
import {
  describeHarnessOperatorMethod,
  operatorMethodSummary,
} from '../../tools/agent-harness-operator-methods.ts';

interface MethodRow {
  readonly id: string;
  readonly category: string;
  readonly judgment?: { readonly reading: { readonly verdict: string }; readonly probability: number };
}

async function page(args: Parameters<typeof operatorMethodSummary>[0]): Promise<{
  readonly methods: readonly MethodRow[];
  readonly returned: number;
  readonly total: number;
  readonly note?: string;
  readonly queryMatch?: string;
  readonly appliedFilters?: Record<string, string>;
}> {
  return await operatorMethodSummary(args, rankingOptions()) as never;
}

// Explicit local readings preserve coverage of the catalog's metadata and envelopes.
const methodReadings: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  google: {
    'calendar.events.list': 0.98, 'calendar.events.create': 0.97, 'calendar.ics.import': 0.96,
    'email.inbox.list': 0.95, 'email.send': 0.94, 'accounts.snapshot': 0.93, 'profile.read': 0.92,
  },
  'icalendar uid': { 'calendar.events.get': 0.95 },
  'calendar export': { 'calendar.ics.export': 0.95 },
  'calendar zzzznotathing': { 'calendar.events.list': 0.5 },
  zzzznotathing: {},
};
const rankingOptions = () => ({ sourceOwner: ordinaryResearchOwner() });
let previous: ReturnType<typeof installJudgmentPort>;
let reader: ReturnType<typeof fakePort>;
beforeEach(() => {
  reader = fakePort((_name, _question, rawState) => {
    const state = rawState as unknown as { query: string; candidate: { name: string } };
    return noulAnswer(methodReadings[state.query]?.[state.candidate.name] ?? 0.01);
  });
  previous = installJudgmentPort(reader.port);
});
afterEach(() => { installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);

describe('operator method catalog: canonical readings', () => {
  test('scripted google readings preserve calendar, mail, and account metadata', async () => {
    const result = await page({ query: 'google' });

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

  test('the canonical reader receives the contract description alongside the title', async () => {
    const result = await page({ query: 'icalendar uid' });
    expect(result.methods.map((method) => method.id)).toContain('calendar.events.get');
    const request = reader.requests.find((request) => (request.state as unknown as { candidate: { name: string } }).candidate.name === 'calendar.events.get');
    expect((request?.state as unknown as { candidate: { description: string } }).candidate.description.toLowerCase()).toContain('icalendar uid');
    expect(request?.context?.battery).toBe('engine.tools.registry-rank');
  });

  test('a phrase query follows its explicit catalog reading', async () => {
    const result = await page({ query: 'calendar export' });
    expect(result.methods.map((method) => method.id)).toContain('calendar.ics.export');
  });

  test('an uncertain reading is retained without becoming a relaxed lexical match', async () => {
    const result = await page({ query: 'calendar zzzznotathing' });

    expect(result.returned).toBe(1);
    expect(result.queryMatch).toBeUndefined();
    expect(result.note).not.toContain('near misses');
    expect(result.methods[0]).toMatchObject({
      id: 'calendar.events.list', judgment: { probability: 0.5, reading: { verdict: 'uncertain' } },
    });
  });

  test('a nonsense query says plainly that nothing matched, out of how many, and how to see them all', async () => {
    const result = await page({ query: 'zzzznotathing' });

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

  test('an empty query matches everything, and a page cut short by the default limit says so', async () => {
    const result = await page({});
    // The default page size is 200; the catalog is larger. The page must not
    // read as the complete catalog, that is the failure the envelope exists
    // for, and it is why `total` is the catalog's size rather than the match
    // count.
    expect(result.returned).toBe(200);
    expect(result.total).toBeGreaterThan(400);
    expect(result.note).toContain(`Showing 200 of ${result.total} methods`);

    // Raising the limit reaches the whole catalog, with no filter applied.
    const everything = await page({ limit: 500 });
    expect(everything.returned).toBe(everything.total);
  });

  test('an exact method id still resolves by id, ahead of any search', async () => {
    const resolution = await describeHarnessOperatorMethod({ methodId: 'calendar.events.list' });
    expect(resolution.status).toBe('found');
    expect(reader.requests).toHaveLength(0);
  });

  test('a plain-word lookup that matches many reports them as candidates instead of "Unknown operator method"', async () => {
    const resolution = await describeHarnessOperatorMethod({ query: 'google' }, rankingOptions());
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') return;
    expect(resolution.candidates.length).toBeGreaterThan(1);
  });

  test('an unresolvable lookup names the catalog size and the route that lists it', async () => {
    const resolution = await describeHarnessOperatorMethod({ query: 'zzzznotathing' }, rankingOptions());
    expect(resolution.status).toBe('missing_lookup');
    if (resolution.status !== 'missing_lookup') return;
    expect(resolution.usage).toContain('cataloged methods was selected by the catalog reading');
    expect(resolution.usage).toContain('host action:"methods" with no query');
  });
});
