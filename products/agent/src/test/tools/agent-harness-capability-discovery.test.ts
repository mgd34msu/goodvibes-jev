/**
 * What the model can FIND, tested with the queries that failed live.
 *
 * The failure this pins: asked about paying for something, the assistant
 * searched the harness catalogs for "payment", "commerce", "credit card" and
 * "spending limit", got nothing back from any of them, including a settings
 * page reading `{"settings": [], "returned": 0, "total": 0}`, and told the
 * owner the platform has no payment capability. It has thirty-two `payments.*`
 * settings, a `/payments` command with a guided card-entry flow, and a daemon
 * that prices and charges.
 *
 * Three separate defects produced that answer, and each has a test here:
 *  - `total` on a settings page was the count of what MATCHED, so a query
 *    nothing matched said zero settings exist;
 *  - a match was a single contiguous substring of the whole query, so any
 *    phrase of more than one word matched nothing anywhere;
 *  - the catalogs indexed only their own vocabulary, so the words a person uses
 *    for a domain reached none of its keys.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/sdk/platform/config';
import { createTestManagers } from '../helpers/test-managers.ts';
import { harnessSettingsCatalog } from '../../tools/agent-harness-settings-catalog.ts';
import { listHarnessModes } from '../../tools/agent-harness-mode-catalog.ts';
import { searchHarnessCommands } from '../../tools/agent-harness-command-catalog.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerPaymentCardCommands } from '../../input/commands/payment-card-intake.ts';
import { SETTING_DOMAIN_VOCABULARY } from '../../config/settings-search-vocabulary.ts';
import { searchCatalog } from '../../tools/agent-harness-catalog-search.ts';

interface SettingsPage {
  readonly settings: readonly { readonly key: string }[];
  readonly returned: number;
  readonly total: number;
  readonly note?: string;
  readonly queryMatch?: string;
  readonly relatedCommands?: readonly { readonly command: string; readonly why: string }[];
}

async function settingsPage(query: string, extra: Record<string, unknown> = {}): Promise<SettingsPage> {
  const managers = createTestManagers();
  return await harnessSettingsCatalog(
    managers.configManager,
    { query, ...extra } as never,
  ) as unknown as SettingsPage;
}

const rankingOptions = () => ({ sourceOwner: ordinaryResearchOwner() });
afterAll(cleanupResearchScreeningFixtures);

async function modeIds(query: string): Promise<readonly string[]> {
  const page = await listHarnessModes({ query, limit: 20 }, rankingOptions()) as { readonly modes: readonly { readonly id: string }[] };
  return page.modes.map((mode) => mode.id);
}

async function commandNames(query: string): Promise<readonly string[]> {
  const registry = new CommandRegistry();
  registerPaymentCardCommands(registry);
  return (await searchHarnessCommands(registry, { query }, rankingOptions())).matches.map((command) => String(command.name));
}

describe('capability discovery: the settings catalog answers in plain words', () => {
  test('"payment" returns the payments section instead of nothing', async () => {
    const page = await settingsPage('payment');
    expect(page.returned).toBeGreaterThan(0);
    const keys = page.settings.map((setting) => setting.key);
    expect(keys.filter((key) => key.startsWith('payments.')).length).toBeGreaterThan(0);
    expect(keys).toContain('payments.enabled');
  });

  test('"spending limit" reaches payments.budget.*: no key or description says that phrase', async () => {
    const page = await settingsPage('spending limit');
    const keys = page.settings.map((setting) => setting.key);
    expect(keys.filter((key) => key.startsWith('payments.budget.')).length).toBeGreaterThan(0);
    expect(keys).toContain('payments.budget.dailyItem');
    // The whole phrase was found (in the domain vocabulary), so these are not
    // near misses and must not be labelled as such.
    expect(page.queryMatch).toBeUndefined();
  });

  test('"credit card" reaches the card and billing keys', async () => {
    const keys = (await settingsPage('credit card')).settings.map((setting) => setting.key);
    expect(keys).toContain('payments.defaultCardId');
    expect(keys.filter((key) => key.startsWith('payments.billingAddress.')).length).toBeGreaterThan(0);
  });

  test('a payments page names /payments card, which no setting can do', async () => {
    const page = await settingsPage('payment');
    const related = page.relatedCommands ?? [];
    expect(related.map((entry) => entry.command)).toContain('/payments card');
    expect(related[0]!.why).toContain('masked prompt');
  });

  test('total is the size of the catalog, never the size of the match', async () => {
    const visible = CONFIG_SCHEMA.length;

    const matched = await settingsPage('payment');
    expect(matched.total).toBe(visible);
    expect(matched.returned).toBeLessThan(matched.total);

    // The live shape: a query nothing matches. `total: 0` here is what was read
    // as "this platform has no settings at all".
    const missed = await settingsPage('zzz-no-such-setting-anywhere');
    expect(missed.returned).toBe(0);
    expect(missed.total).toBe(visible);
    expect(missed.total).toBeGreaterThan(0);
    expect(missed.note).toBeDefined();
    expect(missed.note).toContain('zzz-no-such-setting-anywhere');
    // and it points at the other surfaces a capability could be on.
    expect(missed.note).toContain('another surface');
    expect(missed.note).toContain('"commands"');
  });

  test('a page that matched only single words says so', async () => {
    const page = await settingsPage('where do my packages go');
    expect(page.returned).toBeGreaterThan(0);
    expect(page.queryMatch).toBe('relaxed');
    expect(page.note).toContain('near misses');
  });

  test('every vocabulary domain is a real CONFIG_SCHEMA domain', () => {
    const domains = new Set(CONFIG_SCHEMA.map((setting) => setting.key.split('.')[0]));
    for (const domain of Object.keys(SETTING_DOMAIN_VOCABULARY)) {
      expect(domains.has(domain)).toBe(true);
    }
  });
});

describe('capability discovery: modes and commands', () => {
  // These explicit local fixtures test metadata survival through canonical ranking.
  const readings: Readonly<Record<string, readonly string[]>> = {
    payment: ['settings', 'payments'],
    'credit card': ['settings', 'payments'],
    'spending limit': ['settings'],
    card: ['payments'],
  };
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    previous = installJudgmentPort(fakePort((_name, _question, rawState) => {
      const state = rawState as unknown as { query: string; candidate: { name: string } };
      return noulAnswer(readings[state.query]?.includes(state.candidate.name) ? 0.95 : 0.01);
    }).port);
  });
  afterEach(() => { installJudgmentPort(previous); });
  test('the settings mode is surfaced by the scripted domain readings', async () => {
    expect(await modeIds('payment')).toContain('settings');
    expect(await modeIds('credit card')).toContain('settings');
    expect(await modeIds('spending limit')).toContain('settings');
  });

  test('the /payments command is surfaced by the scripted task readings', async () => {
    expect(await commandNames('payment')).toContain('payments');
    expect(await commandNames('card')).toContain('payments');
    expect(await commandNames('credit card')).toContain('payments');
  });
});

describe('capability discovery: the shared match rule', () => {
  const entries = ['payments budget daily item amount', 'voice wake word threshold'] as const;
  const text = (entry: string): string => entry;

  test('an exact phrase and an all-words query both match strictly', () => {
    expect(searchCatalog(entries, 'wake word', text)).toEqual({ matches: ['voice wake word threshold'], relaxed: false });
    expect(searchCatalog(entries, 'amount budget', text)).toEqual({ matches: ['payments budget daily item amount'], relaxed: false });
  });

  test('a phrase that matches nothing falls back to single words, and says it did', () => {
    const found = searchCatalog(entries, 'daily spending budget', text);
    expect(found.matches).toEqual(['payments budget daily item amount']);
    expect(found.relaxed).toBe(true);
  });

  test('a one-word query never relaxes, however it is punctuated', () => {
    expect(searchCatalog(entries, 'zzz-no-such-thing', text)).toEqual({ matches: [], relaxed: false });
    expect(searchCatalog(entries, 'nonexistent', text)).toEqual({ matches: [], relaxed: false });
  });

  test('an empty query is every entry, and is not a relaxed match', () => {
    expect(searchCatalog(entries, '  ', text)).toEqual({ matches: entries, relaxed: false });
  });
});
