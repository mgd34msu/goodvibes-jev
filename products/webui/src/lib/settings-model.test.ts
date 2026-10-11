import { describe, expect, test } from 'bun:test';
import {
  buildSettingsModel,
  filterSettingsModel,
  isFeatureEnabled,
  readConfigPath,
  liveLeafKeys,
  OWNED_CONFIG_KEYS,
  type SettingsGroupModel,
} from './settings-model';
import { CONFIG_SCHEMA_ENTRIES, FEATURE_SETTINGS } from './generated/config-schema';
import { isCardMaterialKey } from './card-material';

function groupById(groups: SettingsGroupModel[], id: string): SettingsGroupModel | undefined {
  return groups.find((g) => g.id === id);
}

describe('readConfigPath / liveLeafKeys', () => {
  test('reads nested dotted keys and reports presence', () => {
    const cfg = { surfaces: { slack: { botToken: 'x' } }, display: { theme: 'vaporwave' } };
    expect(readConfigPath(cfg, 'display.theme')).toEqual({ present: true, value: 'vaporwave' });
    expect(readConfigPath(cfg, 'surfaces.slack.botToken')).toEqual({ present: true, value: 'x' });
    expect(readConfigPath(cfg, 'surfaces.slack.missing')).toEqual({ present: false, value: undefined });
    expect(readConfigPath(cfg, 'nope.at.all')).toEqual({ present: false, value: undefined });
  });

  test('flattens leaf keys, treating arrays as leaves', () => {
    const cfg = { a: { b: 1, c: [1, 2] }, d: 'x' };
    expect(liveLeafKeys(cfg).sort()).toEqual(['a.b', 'a.c', 'd']);
  });
});

describe('buildSettingsModel: domain grouping (dissolved feature model)', () => {
  const groups = buildSettingsModel({});

  test('every feature renders exactly once, inside its own domain group', () => {
    for (const feature of FEATURE_SETTINGS) {
      const holders = groups.filter((g) => g.featureUnits.some((u) => u.feature.id === feature.id));
      expect(holders.length).toBe(1);
      expect(holders[0].id).toBe(feature.domain);
    }
  });

  test('no enablement-bucket group survives: every group is a real config namespace', () => {
    expect(groups.some((g) => g.id.startsWith('__'))).toBe(false);
    expect(groups.some((g) => g.label === 'Feature Flags')).toBe(false);
  });

  test('a boolean feature exposes its domain key as the enablement field, not a duplicate row', () => {
    const web = groupById(groups, 'web');
    const unit = web?.featureUnits.find((u) => u.feature.id === 'web-surface');
    expect(unit).toBeDefined();
    expect(unit!.enablementField?.key).toBe('web.enabled');
    expect(unit!.enablementField?.type).toBe('boolean');
    // The enablement key never repeats in the unit's ordinary field list.
    expect(unit!.fields.some((f) => f.key === 'web.enabled')).toBe(false);
    expect(unit!.fields.length).toBeGreaterThan(0);
  });

  test('an enum feature exposes the full schema mode set, including inactive modes', () => {
    const behavior = groupById(groups, 'behavior');
    const unit = behavior?.featureUnits.find((u) => u.feature.id === 'hitl-ux-modes');
    expect(unit).toBeDefined();
    expect(unit!.enablementField?.type).toBe('enum');
    // The real option shape: every schema mode is a choice, "off" included,
    // while enabledValues stays the smaller activation subset.
    expect(unit!.enablementField?.enumValues).toEqual(['off', 'quiet', 'balanced', 'operator']);
    expect(unit!.feature.enablement.enabledValues).toEqual(['quiet', 'balanced', 'operator']);
  });

  test('a constant feature has no separate enablement control; its own keys govern it', () => {
    const surfaces = groupById(groups, 'surfaces');
    const unit = surfaces?.featureUnits.find((u) => u.feature.id === 'slack-surface');
    expect(unit).toBeDefined();
    expect(unit!.enablementField).toBeNull();
    // Its settings keys (the honest switches) render as ordinary typed fields,
    // enablement key first.
    expect(unit!.fields[0]?.key).toBe('surfaces.slack.enabled');
  });

  test('config keys owned by a feature unit never double-list as orphan plain rows', () => {
    for (const group of groups) {
      for (const row of group.plainRows) {
        expect(OWNED_CONFIG_KEYS.has(row.key)).toBe(false);
      }
    }
    const ownedSample = [...OWNED_CONFIG_KEYS][0];
    const underAUnit = groups.some((g) =>
      g.featureUnits.some(
        (u) => u.enablementField?.key === ownedSample || u.fields.some((f) => f.key === ownedSample),
      ),
    );
    expect(underAUnit).toBe(true);
  });
});

describe('buildSettingsModel: enablement state from domain settings keys', () => {
  test('a stock config resolves every feature to its own default, none marked explicit', () => {
    const groups = buildSettingsModel({});
    const units = groups.flatMap((g) => g.featureUnits);
    expect(units.length).toBe(FEATURE_SETTINGS.length);
    for (const unit of units) {
      expect(unit.enabled).toBe(unit.feature.defaultEnabled);
      expect(unit.explicit).toBe(false);
    }
  });

  test('a boolean feature reads its live domain key', () => {
    const groups = buildSettingsModel({ permissions: { simulation: false } });
    const unit = groupById(groups, 'permissions')?.featureUnits.find(
      (u) => u.feature.id === 'permissions-simulation',
    );
    expect(unit?.enabled).toBe(false);
    expect(unit?.explicit).toBe(true);
  });

  test('an enum feature is active only while its key holds an activating mode', () => {
    const off = buildSettingsModel({ behavior: { hitlMode: 'off' } });
    const offUnit = groupById(off, 'behavior')?.featureUnits.find((u) => u.feature.id === 'hitl-ux-modes');
    expect(offUnit?.enabled).toBe(false);
    expect(offUnit?.explicit).toBe(true);

    const quiet = buildSettingsModel({ behavior: { hitlMode: 'quiet' } });
    const quietUnit = groupById(quiet, 'behavior')?.featureUnits.find((u) => u.feature.id === 'hitl-ux-modes');
    expect(quietUnit?.enabled).toBe(true);
  });

  test('isFeatureEnabled applies the enablement shape', () => {
    const boolFeature = FEATURE_SETTINGS.find((f) => f.id === 'web-surface')!;
    expect(isFeatureEnabled(boolFeature, true)).toBe(true);
    expect(isFeatureEnabled(boolFeature, false)).toBe(false);
    expect(isFeatureEnabled(boolFeature, 'true')).toBe(false);

    const enumFeature = FEATURE_SETTINGS.find((f) => f.id === 'hitl-ux-modes')!;
    expect(isFeatureEnabled(enumFeature, 'operator')).toBe(true);
    expect(isFeatureEnabled(enumFeature, 'off')).toBe(false);

    const constantFeature = FEATURE_SETTINGS.find((f) => f.id === 'fetch-sanitization')!;
    expect(isFeatureEnabled(constantFeature, undefined)).toBe(true);
  });
});

describe("buildSettingsModel: honesty for unschema'd live keys", () => {
  test('a live key with no schema entry renders as a raw row, never hidden', () => {
    const groups = buildSettingsModel({ mysteryDomain: { unknownKnob: 'held-by-daemon' } }, new Set(), new Set(['mysteryDomain.unknownKnob']));
    const group = groupById(groups, 'mysteryDomain');
    expect(group).toBeDefined();
    expect(group!.rawRows.some((r) => r.key === 'mysteryDomain.unknownKnob')).toBe(true);
  });

  test("an older daemon's leftover featureFlags record stays visible, without the dead category name", () => {
    const groups = buildSettingsModel({ featureFlags: { 'exec-sandbox': 'enabled' } }, new Set(), new Set(['featureFlags.exec-sandbox']));
    const group = groupById(groups, 'featureFlags');
    expect(group).toBeDefined();
    expect(group!.rawRows.some((r) => r.key === 'featureFlags.exec-sandbox')).toBe(true);
    expect(groups.some((g) => g.label === 'Feature Flags')).toBe(false);
  });

  test('a schema key present in live config renders as a typed field with the live value', () => {
    const groups = buildSettingsModel({ display: { theme: 'cyberpunk' } });
    const display = groupById(groups, 'display');
    const themeField = display?.plainRows.find((f) => f.key === 'display.theme');
    expect(themeField?.present).toBe(true);
    expect(themeField?.liveValue).toBe('cyberpunk');
    const schema = CONFIG_SCHEMA_ENTRIES.find((entry) => entry.key === 'display.theme')!;
    expect(themeField?.type).toBe(schema.type);
    expect(themeField?.enumValues).toEqual(schema.enumValues);
    if (schema.type === 'enum') {
      expect(themeField?.enumValues).toContain('goodvibes');
      expect(themeField?.enumValues).toContain('system');
    }
  });
});

describe('filterSettingsModel', () => {
  const groups = buildSettingsModel({});

  test('narrows to matching fields/units and drops empty groups', () => {
    const filtered = filterSettingsModel(groups, 'sanitizeMode');
    // fetch.sanitizeMode belongs to fetch-sanitization → its unit survives.
    const fetch = groupById(filtered, 'fetch');
    expect(fetch).toBeDefined();
    expect(groupById(filtered, 'display')).toBeUndefined();
  });

  test('matches a feature by its human name', () => {
    const filtered = filterSettingsModel(groups, 'permissions simulation');
    const permissions = groupById(filtered, 'permissions');
    expect(permissions?.featureUnits.some((u) => u.feature.id === 'permissions-simulation')).toBe(true);
  });

  test('matches an enum feature by its enablement key', () => {
    const filtered = filterSettingsModel(groups, 'hitlMode');
    const behavior = groupById(filtered, 'behavior');
    expect(behavior?.featureUnits.some((u) => u.feature.id === 'hitl-ux-modes')).toBe(true);
  });

  test('a whole group survives when its label matches', () => {
    const filtered = filterSettingsModel(groups, 'Display');
    expect(groupById(filtered, 'display')).toBeDefined();
  });

  test('empty query returns the full model unchanged', () => {
    expect(filterSettingsModel(groups, '  ')).toBe(groups);
  });
});

describe('object-typed schema keys (pricing.modelPrices)', () => {
  const livePrices = {
    'openrouter:deepseek/deepseek-chat': { input: 0.14, output: 0.28 },
    'bedrock:us.anthropic.claude-3-5:0': { input: 3, output: 15 },
  };
  const groups = buildSettingsModel({ pricing: { modelPrices: livePrices } });
  const pricing = groupById(groups, 'pricing');

  test('the object key renders as ONE typed field carrying its live object value', () => {
    expect(pricing).toBeDefined();
    const field = pricing!.plainRows.find((f) => f.key === 'pricing.modelPrices');
    expect(field).toBeDefined();
    expect(field!.type).toBe('object');
    expect(field!.present).toBe(true);
    expect(field!.liveValue).toEqual(livePrices);
    expect(field!.description.length).toBeGreaterThan(0);
  });

  test('live entries under the object key never leak into unschema raw rows', () => {
    for (const group of groups) {
      expect(group.rawRows.filter((r) => r.key.startsWith('pricing.modelPrices'))).toEqual([]);
    }
  });

  test('liveLeafKeys honors the stop-set so dotted model ids stay intact', () => {
    const keys = liveLeafKeys(
      { pricing: { modelPrices: livePrices }, display: { theme: 'x' } },
      '',
      new Set(['pricing.modelPrices']),
    );
    expect(keys.sort()).toEqual(['display.theme', 'pricing.modelPrices']);
  });

  test('an absent object key still renders with its schema default', () => {
    const bare = buildSettingsModel({});
    const field = groupById(bare, 'pricing')?.plainRows.find((f) => f.key === 'pricing.modelPrices');
    expect(field).toBeDefined();
    expect(field!.present).toBe(false);
    expect(field!.default).toEqual({});
  });
});

describe('every schema key is reachable in the model', () => {
  const groups = buildSettingsModel({});
  const rendered = groups.flatMap((g) => [
    ...g.plainRows,
    ...g.featureUnits.flatMap((u) => [...(u.enablementField ? [u.enablementField] : []), ...u.fields]),
  ]);

  test('each schema key other than card material renders, with the schema\'s own description', () => {
    // A key two features both own renders under each of them; that is fine.
    const renderedKeys = new Set(rendered.map((field) => field.key));
    const missing: string[] = [];
    for (const entry of CONFIG_SCHEMA_ENTRIES) {
      if (isCardMaterialKey(entry.key)) {
        expect(renderedKeys.has(entry.key), entry.key).toBe(false);
        continue;
      }
      if (!renderedKeys.has(entry.key)) missing.push(entry.key);
      for (const field of rendered.filter((f) => f.key === entry.key)) {
        expect(field.description, entry.key).toBe(entry.description);
      }
    }
    expect(missing).toEqual([]);
  });

  test('a stock config renders no raw rows: every leaf it would carry has a schema entry', () => {
    expect(groups.flatMap((g) => g.rawRows)).toEqual([]);
  });

  test('new surface credential keys are secret-masked', () => {
    for (const key of [
      'surfaces.msteams.appPassword',
      'surfaces.bluebubbles.password',
      'surfaces.mattermost.botToken',
      'surfaces.matrix.accessToken',
    ]) {
      const field = groups
        .flatMap((g) => [...g.plainRows, ...g.featureUnits.flatMap((u) => u.fields)])
        .find((f) => f.key === key);
      expect(field, key).toBeDefined();
      expect(field!.isSecret, key).toBe(true);
    }
  });

  test('secret-store-only-config-keys.ts flags the mail/calendar passwords, not ordinary secret-shaped keys', () => {
    const findField = (key: string) =>
      groups.flatMap((g) => [...g.plainRows, ...g.featureUnits.flatMap((u) => u.fields)]).find((f) => f.key === key);

    for (const key of [
      'surfaces.email.password',
      'surfaces.email.imapPassword',
      'surfaces.calendar.caldavPassword',
    ]) {
      const field = findField(key);
      expect(field, key).toBeDefined();
      expect(field!.isSecret, key).toBe(true);
      expect(field!.secretStoreOnly, key).toBe(true);
    }

    // A secret-shaped key that IS genuinely configurable through config.set
    // (surfaces.slack.botToken supports a literal value) must not be flagged.
    const slackToken = findField('surfaces.slack.botToken');
    expect(slackToken?.secretStoreOnly).toBe(false);
  });
});

describe('voice.local.* and fleet.maxSize (SDK 1.8.0): grouping verification', () => {
  const groups = buildSettingsModel({});

  function groupContaining(key: string): typeof groups[number] | undefined {
    return groups.find((g) => [
      ...g.plainRows.map((f) => f.key),
      ...g.featureUnits.flatMap((u) => [...(u.enablementField ? [u.enablementField.key] : []), ...u.fields.map((f) => f.key)]),
    ].includes(key));
  }

  test('every voice.local.* key groups under the "voice" domain, never misfiled elsewhere', () => {
    for (const key of ['voice.local.sttEngine', 'voice.local.sttBinary', 'voice.local.sttModelPath', 'voice.local.ttsEngine', 'voice.local.ttsBinary', 'voice.local.ttsModelPath']) {
      expect(groupContaining(key)?.id, key).toBe('voice');
    }
  });

  test('fleet.maxSize groups under the "fleet" domain, never misfiled under "orchestration" (its pre-rename namespace)', () => {
    expect(groupContaining('fleet.maxSize')?.id).toBe('fleet');
  });

});

describe('daemonOwned metadata: config-ownership.ts surfaced onto every row', () => {
  test('a surfaces.* field is flagged daemonOwned; a display.* field is not', () => {
    const groups = buildSettingsModel({ surfaces: { slack: { botToken: 'x' } } });
    const slackUnit = groupById(groups, 'surfaces')?.featureUnits.find((u) => u.feature.id === 'slack-surface');
    expect(slackUnit).toBeDefined();
    expect(slackUnit!.fields.every((f) => f.daemonOwned)).toBe(true);
    // The feature unit itself is flagged when every settings key it owns is daemon-owned.
    expect(slackUnit!.daemonOwned).toBe(true);

    const display = groupById(groups, 'display');
    const themeField = display?.plainRows.find((f) => f.key === 'display.theme');
    expect(themeField?.daemonOwned).toBe(false);
  });

  test('a boolean feature whose domain key is daemon-owned (web-surface) flags its enablement field too', () => {
    const groups = buildSettingsModel({});
    const web = groupById(groups, 'web')?.featureUnits.find((u) => u.feature.id === 'web-surface');
    expect(web?.enablementField?.daemonOwned).toBe(true);
    expect(web?.daemonOwned).toBe(true);
  });

  test('a client-owned feature (behavior.hitlMode) is never flagged daemonOwned', () => {
    const groups = buildSettingsModel({});
    const hitl = groupById(groups, 'behavior')?.featureUnits.find((u) => u.feature.id === 'hitl-ux-modes');
    expect(hitl?.enablementField?.daemonOwned).toBe(false);
    expect(hitl?.daemonOwned).toBe(false);
  });

  test('an unschema\'d raw row under a daemon-owned namespace is flagged daemonOwned too', () => {
    const groups = buildSettingsModel({ surfaces: { mysteryBot: { unknownKnob: 'held-by-daemon' } } }, new Set(), new Set(['surfaces.mysteryBot.unknownKnob']));
    const surfaces = groupById(groups, 'surfaces');
    const row = surfaces?.rawRows.find((r) => r.key === 'surfaces.mysteryBot.unknownKnob');
    expect(row).toBeDefined();
    expect(row!.daemonOwned).toBe(true);

    const mysteryGroups = buildSettingsModel({ mysteryDomain: { unknownKnob: 'x' } }, new Set(), new Set(['mysteryDomain.unknownKnob']));
    const mysteryRow = groupById(mysteryGroups, 'mysteryDomain')?.rawRows.find((r) => r.key === 'mysteryDomain.unknownKnob');
    expect(mysteryRow?.daemonOwned).toBe(false);
  });
});

describe('payments.* and daemon.timezone (payment capability round)', () => {
  const groups = buildSettingsModel({});
  const paymentsGroup = groupById(groups, 'payments');
  const daemonGroup = groupById(groups, 'daemon');

  test.each([
    'payments.enabled',
    'payments.defaultCardId',
    'payments.currency',
    'payments.cvvHandling',
    'payments.budget.dailyItem',
    'payments.budget.dailyOverage',
    'payments.budget.perPurchaseCeilingEnabled',
    'payments.budget.perPurchaseCeiling',
    'payments.budget.overageToleranceEnabled',
    'payments.budget.overageToleranceDailyAllowance',
    'payments.shipping.preferredTier',
    'payments.windows.vetoMinutes',
    'payments.windows.approvalMinutes',
    'payments.notifyChannels',
  ])('%s renders as a plain row in the payments group, daemon-owned', (key) => {
    const field = paymentsGroup?.plainRows.find((f) => f.key === key);
    expect(field, key).toBeDefined();
    expect(field!.daemonOwned, key).toBe(true);
  });

  test('daemon.timezone renders in the daemon group, daemon-owned, with a description', () => {
    const field = daemonGroup?.plainRows.find((f) => f.key === 'daemon.timezone');
    expect(field).toBeDefined();
    expect(field!.description.length).toBeGreaterThan(0);
    // Ruled and fixed upstream (SDK config-ownership.ts) after this round's
    // engineering report flagged the omission: daemon.timezone is the one
    // daemon.* key that is NOT a per-installation switch, see
    // config-ownership.test.ts.
    expect(field!.daemonOwned).toBe(true);
  });

  test('payments.currency validates 3-letter ISO-4217 codes via its schema validationHint', () => {
    const field = paymentsGroup?.plainRows.find((f) => f.key === 'payments.currency');
    expect(field?.validationHint?.length ?? 0).toBeGreaterThan(0);
    expect(field?.default).toBe('USD');
  });

  test('the budget/window/enablement defaults match the schema (owner ruling: default to most safe)', () => {
    const byKey = new Map(paymentsGroup?.plainRows.map((f) => [f.key, f]));
    expect(byKey.get('payments.enabled')?.default).toBe(false);
    expect(byKey.get('payments.cvvHandling')?.default).toBe('stored');
    expect(byKey.get('payments.budget.dailyItem')?.default).toBe(0);
    expect(byKey.get('payments.budget.perPurchaseCeilingEnabled')?.default).toBe(true);
    expect(byKey.get('payments.budget.overageToleranceEnabled')?.default).toBe(false);
    expect(byKey.get('payments.windows.vetoMinutes')?.default).toBe(10);
    expect(byKey.get('payments.windows.approvalMinutes')?.default).toBe(60);
  });

  test('the four budget amount keys carry unit: "money" from the schema; nothing else in the payments group does', () => {
    const byKey = new Map(paymentsGroup?.plainRows.map((f) => [f.key, f]));
    expect(byKey.get('payments.budget.dailyItem')?.unit).toBe('money');
    expect(byKey.get('payments.budget.dailyOverage')?.unit).toBe('money');
    expect(byKey.get('payments.budget.perPurchaseCeiling')?.unit).toBe('money');
    expect(byKey.get('payments.budget.overageToleranceDailyAllowance')?.unit).toBe('money');
    expect(byKey.get('payments.windows.vetoMinutes')?.unit).toBeUndefined();
    expect(byKey.get('payments.budget.perPurchaseCeilingEnabled')?.unit).toBeUndefined();
  });

  test('no field anywhere in the model is keyed to card material (cvv/pan/cardNumber)', () => {
    // Belt-and-suspenders: CONFIG_SCHEMA never declares such a key, but a stray
    // one in the LIVE config must still never surface, not as a plain row, not
    // as a feature-owned field, not as a raw row.
    const withStrayCardMaterial = buildSettingsModel({
      payments: {
        cards: { visa: { cvv: '123', pan: '4111111111111111', cardNumber: '4111111111111111' } },
      },
    });
    const everyKey = withStrayCardMaterial.flatMap((g) => [
      ...g.plainRows.map((f) => f.key),
      ...g.rawRows.map((r) => r.key),
      ...g.featureUnits.flatMap((u) => [
        ...(u.enablementField ? [u.enablementField.key] : []),
        ...u.fields.map((f) => f.key),
      ]),
    ]);
    // Every remaining key passes the same card-material test that filtered the
    // stray keys out in the first place, i.e. the filtering is total, nothing
    // isCardMaterialKey would flag survives into the rendered model. (Its own
    // correctness, including that this must NOT flag payments.cvvHandling or
    // payments.defaultCardId, is independently unit-tested in
    // card-material.test.ts.)
    expect(everyKey.some((k) => isCardMaterialKey(k))).toBe(false);
    // payments.defaultCardId (a card REFERENCE, not material) still renders.
    expect(everyKey).toContain('payments.defaultCardId');
    // payments.cvvHandling (the policy setting, not the CVV itself) still renders.
    expect(everyKey).toContain('payments.cvvHandling');
  });
});

/**
 * The realistic leak path, as opposed to the hypothetical one.
 *
 * The existing card-material test above uses a nested `payments.cards.visa.*`
 * shape. What the card-entry surfaces actually write is four FLAT keys under
 * `payments.`, the TUI's /payments card flow and this app's own card panel
 * both land there, and in practice they hold a `goodvibes://secrets/...`
 * reference rather than a value, because the value goes to the daemon secret
 * store. Both halves are asserted here: the keys never render, and a stray raw
 * value under one of them never renders either.
 */
describe('the four flat card keys the entry surfaces write never reach the model', () => {
  const CARD_KEYS = ['payments.cardNumber', 'payments.cardExpiry', 'payments.cardCvv', 'payments.cardholderName'];

  function keysOf(groups: SettingsGroupModel[]): string[] {
    return groups.flatMap((g) => [
      ...g.plainRows.map((f) => f.key),
      ...g.rawRows.map((r) => r.key),
      ...g.featureUnits.flatMap((u) => [
        ...(u.enablementField ? [u.enablementField.key] : []),
        ...u.fields.map((f) => f.key),
      ]),
    ]);
  }

  test('none of the four render, even holding raw values', () => {
    const groups = buildSettingsModel({
      payments: {
        cardNumber: '4000056655665556',
        cardExpiry: '09/29',
        cardCvv: '731',
        cardholderName: 'Jane Q. Fakename',
      },
    });
    const rendered = keysOf(groups);
    for (const key of CARD_KEYS) {
      expect(rendered).not.toContain(key);
    }
  });

  test('no raw card value survives anywhere in the built model', () => {
    const groups = buildSettingsModel({
      payments: {
        cardNumber: '4000056655665556',
        cardCvv: '731',
        cardholderName: 'Jane Q. Fakename',
      },
    });
    const serialized = JSON.stringify(groups);
    expect(serialized).not.toContain('4000056655665556');
    expect(serialized).not.toContain('731');
    expect(serialized).not.toContain('Jane Q. Fakename');
  });

  test('the billing and shipping address fields beside them still render; the filter is scoped, not a blanket', () => {
    const groups = buildSettingsModel({
      payments: { cardNumber: '4000056655665556', billingAddress: { name: 'Jane Q. Fakename' } },
    });
    const rendered = keysOf(groups);
    expect(rendered).toContain('payments.billingAddress.name');
    expect(rendered).toContain('payments.shippingAddress.line1');
    expect(rendered).not.toContain('payments.cardNumber');
  });
});

 test('unknown rows require explicit non-card clearance before value access or rendering', () => {
  const config = { mystery: { label: 'ordinary fixture', rawPan: 'private fixture' } };
  expect(buildSettingsModel(config).flatMap(group => group.rawRows)).toEqual([]);
  const rows = buildSettingsModel(config, new Set(), new Set(['mystery.label'])).flatMap(group => group.rawRows);
  expect(rows.map(row => row.key)).toEqual(['mystery.label']);
  expect(rows[0]?.isSecret).toBe(true);
});
test('secret clearance cannot override a declared card exclusion or substitute for card clearance', () => {
  const config = { payments: { cardNumber: 'never-render' }, unknown: { value: 'still-excluded' } };
  expect(buildSettingsModel(config, new Set(['payments.cardNumber', 'unknown.value']), new Set(['payments.cardNumber'])).flatMap(group => group.rawRows)).toEqual([]);
});
