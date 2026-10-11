import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ConfigKey, ConfigSetting, ConfigValue, EffectiveConfigView } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveHarnessSetting, resolveHarnessSettingAsync, type HarnessSettingLookupArgs, type HarnessSettingResolvedBy } from '../../agent/harness-control.ts';

let probability = 0.99;
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { probability = 0.99; previous = installJudgmentPort(fakePort(() => noulAnswer(probability)).port); });
afterEach(() => { installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);
const reading = () => ({ sourceOwner: ordinaryResearchOwner() });

const KEY = 'surfaces.telegram.botUsername';
const REMOTE_VALUE = 'synthetic_remote_owner';
const LOCAL_VALUE = 'synthetic_stale_mirror';
const STORE = 'the connected host';

function row(key: ConfigKey = KEY, description = 'Synthetic unique owner lookup'): ConfigSetting {
  return { key, type: 'string', default: '', description };
}

function fixture(rows: ConfigSetting[] = [row()], unavailable = false) {
  // Every fixture row is string-valued; retain ConfigManager's generic getter
  // signature while deliberately supplying the conflicting local mirror.
  const get = mock(<K extends ConfigKey>(_key: K): ConfigValue<K> => LOCAL_VALUE as ConfigValue<K>);
  const describe = mock((key: string): ReturnType<EffectiveConfigView['describe']> => ({
    key,
    scope: 'daemon' as const,
    source: 'daemon' as const,
    status: unavailable ? 'unavailable' as const : 'ok' as const,
    ...(unavailable ? { error: 'synthetic owner unavailable' } : { value: REMOTE_VALUE }),
    store: STORE,
    reason: 'daemon-owned',
  }));
  const view: EffectiveConfigView = {
    get: (key) => describe(key).value,
    describe,
    unavailable: new Set(unavailable ? [KEY] : []),
    daemonError: unavailable ? 'synthetic owner unavailable' : null,
    daemonBaseUrl: STORE,
  };
  return { config: { get, getSchema: () => rows }, view, get, describe };
}

const lookups: Array<[HarnessSettingResolvedBy, HarnessSettingLookupArgs]> = [
  ['key', { key: KEY }],
  ['case-insensitive-key', { target: KEY.toUpperCase() }],
  ['search', { query: 'synthetic unique owner lookup' }],
];

describe('harness lookup keeps its owning-runtime view at every resolution', () => {
  test.each(lookups)('%s returns the remote owner value rather than the local mirror', async (resolvedBy, args) => {
    const { config, view, get, describe } = fixture();
    const result = await resolveHarnessSettingAsync(config, args, view, reading());

    expect(result?.status).toBe('found');
    if (result?.status !== 'found') throw new Error('expected a setting');
    expect(result.lookup.resolvedBy).toBe(resolvedBy);
    expect(result.setting.lookup).toEqual(result.lookup);
    expect(result.setting.key).toBe(KEY);
    expect(result.setting.value).toBe(REMOTE_VALUE);
    expect(result.setting.valueSource).toBe('daemon');
    expect(result.setting.valueStore).toBe(STORE);
    expect(result.setting.valueUnavailable).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(describe).toHaveBeenCalledWith(KEY);
  });

  test.each(lookups)('%s preserves unavailable ownership rather than reporting a stale value', async (resolvedBy, args) => {
    const { config, view, get } = fixture([row()], true);
    const result = await resolveHarnessSettingAsync(config, args, view, reading());

    expect(result?.status).toBe('found');
    if (result?.status !== 'found') throw new Error('expected a setting');
    expect(result.lookup.resolvedBy).toBe(resolvedBy);
    expect(result.setting.value).toBeUndefined();
    expect(result.setting.valueUnavailable).toBe(true);
    expect(result.setting.configured).toBe(false);
    expect(result.setting.valueSource).toBe('daemon');
    expect(result.setting.valueStore).toBe(STORE);
    expect(get).not.toHaveBeenCalled();
  });

  test.each(lookups)('%s keeps the manual no-view lookup compatible', async (_resolvedBy, args) => {
    const { config, get } = fixture();
    const result = await resolveHarnessSettingAsync(config, args, undefined, reading());
    expect(result?.status).toBe('found');
    if (result?.status !== 'found') throw new Error('expected a setting');
    expect(result.setting.value).toBe(LOCAL_VALUE);
    expect(result.setting.valueStore).toBeUndefined();
    expect(get).toHaveBeenCalledWith(KEY);
  });

  test('case-insensitive collisions stay ambiguous without reading either value', () => {
    const { config, view, get, describe } = fixture([row(), row(KEY.toUpperCase() as ConfigKey)]);
    const result = resolveHarnessSetting(config, { key: 'Surfaces.Telegram.BotUsername' }, view);
    expect(result?.status).toBe('ambiguous');
    if (result?.status !== 'ambiguous') throw new Error('expected candidates');
    expect(result.candidates.map((entry) => entry.key)).toEqual([KEY, KEY.toUpperCase()]);
    expect(get).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
  });

  test('multiple positive readings stay ambiguous without reading values', async () => {
    const { config, view, get, describe } = fixture([row(), row('surfaces.discord.botToken')]);
    const result = await resolveHarnessSettingAsync(config, { query: 'synthetic unique owner lookup' }, view, reading());
    expect(result?.status).toBe('ambiguous');
    if (result?.status !== 'ambiguous') throw new Error('expected candidates');
    expect(result.candidates.map((entry) => entry.key)).toEqual([KEY, 'surfaces.discord.botToken']);
    expect(get).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
  });

  test('an uncertain reading stays a candidate and negative evidence stays unresolved', async () => {
    probability = 0.5;
    const { config, view, get, describe } = fixture();
    const result = await resolveHarnessSettingAsync(config, { query: 'synthetic nonexistentword' }, view, reading());
    expect(result?.status).toBe('ambiguous');
    if (result?.status !== 'ambiguous') throw new Error('expected candidate');
    expect(result.candidates.map((entry) => entry.key)).toEqual([KEY]);
    probability = 0.01;
    expect(await resolveHarnessSettingAsync(config, { query: 'nonexistentword' }, view, reading())).toBeNull();
    expect(() => resolveHarnessSetting(config, { query: 'synthetic unique owner lookup' }, view)).toThrow('asynchronous protected settings reader');
    expect(resolveHarnessSetting(config, {}, view)).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
  });
});
