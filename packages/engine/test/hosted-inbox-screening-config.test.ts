import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_SCHEMA,
  ConfigError,
  ConfigManager,
  DEFAULT_CONFIG,
  configKeyScope,
  daemonConfigPath,
  isValidConfigKey,
  screenSettingsForIngestion,
  type ConfigValue,
  type HostedInboxScreening,
} from '../sdk/src/platform/config/index.js';
import { getFeatureFlagConfig } from '../sdk/src/platform/runtime/feature-flags/flag-config-map.js';
import { SurfaceRegistry } from '../sdk/src/platform/channels/surface-registry.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), 'gv-hosted-inbox-schema-'));
  roots.push(homeDir);
  return { homeDir, manager: new ConfigManager({ homeDir, surfaceRoot: 'agent' }) };
}

const invalidChoices: { value: unknown }[] = [
  true,
  null,
  'enabled',
  'local',
  'abacus-typesafe-zero-retention',
  ['abacus-typesafe-provider-managed'],
  { value: 'abacus-typesafe-provider-managed' },
].map((value) => ({ value }));

describe('hosted inbox screening configuration boundary', () => {
  test('public schema defaults to disabled and states the actual raw-text permission and retention limit', () => {
    const choice: HostedInboxScreening = DEFAULT_CONFIG.surfaces.hostedInboxScreening;
    const value: ConfigValue<'surfaces.hostedInboxScreening'> = choice;
    expect(value).toBe('disabled');
    const setting = CONFIG_SCHEMA.find((entry) => entry.key === 'surfaces.hostedInboxScreening');
    if (!setting) throw new Error('Hosted inbox screening is missing from the public schema');
    expect(setting.type).toBe('enum');
    expect(setting.enumValues).toEqual(['disabled', 'abacus-typesafe-provider-managed']);
    expect(setting.description).toContain('raw text');
    expect(setting.description).toContain('Discord bot one-to-one DMs');
    expect(setting.description).toContain('enabled Slack/email inboxes');
    expect(setting.description).toContain('Abacus route-llm and TypeSafe Jev');
    expect(setting.description).toContain('Providers manage retention; zero retention is unverified');
    expect(isValidConfigKey('surfaces.hostedInboxScreening')).toBe(true);
    expect(configKeyScope('surfaces.hostedInboxScreening')).toBe('daemon');
  });

  test('an explicit choice persists in the native daemon tier and disabling changes its incarnation', () => {
    const { homeDir, manager } = fixture();
    expect(manager.get('surfaces.hostedInboxScreening')).toBe('disabled');
    const beforeEnable = manager.getConfigurationIncarnation();
    manager.set('surfaces.hostedInboxScreening', 'abacus-typesafe-provider-managed');
    expect(manager.getConfigurationIncarnation()).toBeGreaterThan(beforeEnable);
    const daemonReader = new ConfigManager({ homeDir, surfaceRoot: 'tui' });
    expect(daemonReader.get('surfaces.hostedInboxScreening')).toBe('abacus-typesafe-provider-managed');
    expect(daemonReader.describeConfigKeySource('surfaces.hostedInboxScreening').tier).toBe('daemon');
    expect(readFileSync(daemonConfigPath(homeDir), 'utf8')).toContain('abacus-typesafe-provider-managed');
    const beforeDisable = manager.getConfigurationIncarnation();
    manager.set('surfaces.hostedInboxScreening', 'disabled');
    expect(manager.getConfigurationIncarnation()).toBeGreaterThan(beforeDisable);
    expect(new ConfigManager({ homeDir, surfaceRoot: 'webui' }).get('surfaces.hostedInboxScreening')).toBe('disabled');
  });

  test('screening consent preserves terminal availability and does not enable inbox adapters', () => {
    const { manager } = fixture();
    manager.set('surfaces.hostedInboxScreening', 'abacus-typesafe-provider-managed');
    const surfaces = new SurfaceRegistry(manager).syncConfiguredSurfaces();
    expect(surfaces.find((surface) => surface.kind === 'tui')?.enabled).toBe(true);
    expect(surfaces.find((surface) => surface.kind === 'slack')?.enabled).toBe(false);
    expect(surfaces.find((surface) => surface.kind === 'discord')?.enabled).toBe(false);
  });

  test.each(invalidChoices)('unknown choice $value cannot prepare or publish permission', ({ value }) => {
    const { homeDir, manager } = fixture();
    manager.set('surfaces.hostedInboxScreening', 'disabled');
    const original = readFileSync(daemonConfigPath(homeDir));
    expect(() => manager.validateDynamic('surfaces.hostedInboxScreening', value)).toThrow(ConfigError);
    expect(() => manager.prepareSettingMutationPlan([
      { operation: 'set', key: 'surfaces.hostedInboxScreening', value },
    ])).toThrow(ConfigError);
    expect(() => manager.setDynamic('surfaces.hostedInboxScreening', value)).toThrow(ConfigError);
    expect(manager.get('surfaces.hostedInboxScreening')).toBe('disabled');
    expect(readFileSync(daemonConfigPath(homeDir)).equals(original)).toBe(true);
  });

  test.each(invalidChoices)('malformed stored choice $value is removed before the disabled default is merged', ({ value }) => {
    const result = screenSettingsForIngestion({ surfaces: { hostedInboxScreening: value } }, 'isolated-settings.json');
    expect(result.config).toEqual({});
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({ key: 'surfaces.hostedInboxScreening', action: 'skipped' });
    expect(result.unknownKeys).toEqual([]);
    expect(DEFAULT_CONFIG.surfaces.hostedInboxScreening).toBe('disabled');
  });

  test('Slack inbox identity is an explicit daemon-owned string, separate from enabling the adapter', () => {
    const { homeDir, manager } = fixture();
    expect(manager.get('surfaces.slack.inboxUserId')).toBe('');
    manager.set('surfaces.slack.enabled', true);
    expect(manager.get('surfaces.slack.inboxUserId')).toBe('');
    manager.set('surfaces.slack.inboxUserId', 'U012EXPLICIT');
    const reader = new ConfigManager({ homeDir, surfaceRoot: 'webui' });
    const expected: ConfigValue<'surfaces.slack.inboxUserId'> = reader.get('surfaces.slack.inboxUserId');
    expect(expected).toBe('U012EXPLICIT');
    expect(configKeyScope('surfaces.slack.inboxUserId')).toBe('daemon');
    expect(getFeatureFlagConfig('slack-surface').configKeys).toContain('surfaces.slack.inboxUserId');
    expect(reader.get('surfaces.hostedInboxScreening')).toBe('disabled');
    expect(() => manager.validateDynamic('surfaces.slack.inboxUserId', 123)).toThrow(ConfigError);
    expect(() => manager.setDynamic('surfaces.slack.inboxUserId', { userId: 'U012EXPLICIT' })).toThrow(ConfigError);
    expect(manager.get('surfaces.slack.inboxUserId')).toBe('U012EXPLICIT');
  });
});
