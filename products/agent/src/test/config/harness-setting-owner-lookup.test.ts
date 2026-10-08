import { describe, expect, mock, test } from 'bun:test';
import type { ConfigKey, ConfigSetting, ConfigValue, EffectiveConfigView } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveHarnessSetting, type HarnessSettingLookupArgs, type HarnessSettingResolvedBy } from '../../agent/harness-control.ts';

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
  test.each(lookups)('%s returns the remote owner value rather than the local mirror', (resolvedBy, args) => {
    const { config, view, get, describe } = fixture();
    const result = resolveHarnessSetting(config, args, view);

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

  test.each(lookups)('%s preserves unavailable ownership rather than reporting a stale value', (resolvedBy, args) => {
    const { config, view, get } = fixture([row()], true);
    const result = resolveHarnessSetting(config, args, view);

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

  test.each(lookups)('%s keeps the manual no-view lookup compatible', (_resolvedBy, args) => {
    const { config, get } = fixture();
    const result = resolveHarnessSetting(config, args);
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

  test('multiple strict search matches stay ambiguous without reading values', () => {
    const { config, view, get, describe } = fixture([row(), row('surfaces.discord.botToken')]);
    const result = resolveHarnessSetting(config, { query: 'synthetic unique owner lookup' }, view);
    expect(result?.status).toBe('ambiguous');
    if (result?.status !== 'ambiguous') throw new Error('expected candidates');
    expect(result.candidates.map((entry) => entry.key)).toEqual([KEY, 'surfaces.discord.botToken']);
    expect(get).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
  });

  test('a single relaxed match stays a candidate and absent input stays unresolved', () => {
    const { config, view, get, describe } = fixture();
    const result = resolveHarnessSetting(config, { query: 'synthetic nonexistentword' }, view);
    expect(result?.status).toBe('ambiguous');
    if (result?.status !== 'ambiguous') throw new Error('expected candidate');
    expect(result.candidates.map((entry) => entry.key)).toEqual([KEY]);
    expect(resolveHarnessSetting(config, { query: 'nonexistentword' }, view)).toBeNull();
    expect(resolveHarnessSetting(config, {}, view)).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
  });
});
