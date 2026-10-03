/**
 * Explicit feature enable/disable over the dissolved feature model:
 * domain-key resolution shapes, legacy featureFlags key expansion, the
 * runtime-only CLI overrides, and the onboarding legacy set-config path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import {
  expandLegacyFeatureConfigValue,
  isFeatureEnabledInConfig,
  isLegacyFeatureConfigKey,
  legacyFeatureConfigTargets,
  resolveFeatureEnablementWrite,
} from '../../runtime/feature-enablement.ts';
import { applyRuntimeFeatureOverrides } from '../../cli/config-overrides.ts';
import { applyOnboardingRequest, verifyOnboardingRequest } from '../../runtime/onboarding/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('resolveFeatureEnablementWrite', () => {
  test('boolean bindings write the domain key true/false', () => {
    expect(resolveFeatureEnablementWrite('exec-sandbox', 'enabled')).toEqual({ key: 'sandbox.enabled', value: true });
    expect(resolveFeatureEnablementWrite('exec-sandbox', 'disabled')).toEqual({ key: 'sandbox.enabled', value: false });
    expect(resolveFeatureEnablementWrite('route-binding', 'disabled')).toEqual({ key: 'integrations.routeBinding', value: false });
  });

  test('enum bindings write the canonical enabled value and a schema-honest disabled value', () => {
    expect(resolveFeatureEnablementWrite('permissions-policy-engine', 'enabled')).toEqual({
      key: 'permissions.engine',
      value: 'policy-engine',
    });
    const disabled = resolveFeatureEnablementWrite('permissions-policy-engine', 'disabled');
    expect(disabled.key).toBe('permissions.engine');
    expect(disabled.value).not.toBe('policy-engine');
  });

  test('always-available (constant) features refuse with their real settings keys', () => {
    expect(() => resolveFeatureEnablementWrite('slack-surface', 'disabled')).toThrow('surfaces.slack.enabled');
    expect(() => resolveFeatureEnablementWrite('slack-surface', 'enabled')).toThrow('always available');
  });

  test('unknown ids fail loudly naming the known features', () => {
    expect(() => resolveFeatureEnablementWrite('no-such-feature', 'enabled')).toThrow('Unknown feature "no-such-feature"');
    expect(() => resolveFeatureEnablementWrite('no-such-feature', 'enabled')).toThrow('exec-sandbox');
  });
});

describe('legacy featureFlags key expansion', () => {
  test('recognizes only the legacy namespace', () => {
    expect(isLegacyFeatureConfigKey('featureFlags')).toBe(true);
    expect(isLegacyFeatureConfigKey('featureFlags.exec-sandbox')).toBe(true);
    expect(isLegacyFeatureConfigKey('sandbox.enabled')).toBe(false);
  });

  test('expands a whole-record value into one write per feature', () => {
    const writes = expandLegacyFeatureConfigValue('featureFlags', {
      'exec-sandbox': 'disabled',
      'permissions-policy-engine': 'enabled',
    });
    expect(writes).toEqual([
      { key: 'sandbox.enabled', value: false },
      { key: 'permissions.engine', value: 'policy-engine' },
    ]);
  });

  test('expands a single-feature key and keeps the historical error wording', () => {
    expect(expandLegacyFeatureConfigValue('featureFlags.exec-sandbox', 'disabled')).toEqual([
      { key: 'sandbox.enabled', value: false },
    ]);
    expect(() => expandLegacyFeatureConfigValue('featureFlags', 'nope')).toThrow('featureFlags expects an object value.');
    expect(() => expandLegacyFeatureConfigValue('featureFlags.exec-sandbox', 'sometimes'))
      .toThrow('Config key featureFlags.exec-sandbox expects enabled or disabled.');
    expect(() => expandLegacyFeatureConfigValue('featureFlags', { 'exec-sandbox': 'sometimes' }))
      .toThrow('featureFlags.exec-sandbox expects enabled or disabled.');
  });

  test('reports the feature targets a legacy operation addresses', () => {
    expect(legacyFeatureConfigTargets('featureFlags.exec-sandbox', 'disabled')).toEqual([
      { featureId: 'exec-sandbox', desired: 'disabled' },
    ]);
    expect(legacyFeatureConfigTargets('featureFlags', { 'route-binding': 'enabled' })).toEqual([
      { featureId: 'route-binding', desired: 'enabled' },
    ]);
  });
});

describe('runtime-only CLI feature overrides', () => {
  let root: string;
  let configManager: ConfigManager;

  beforeEach(() => {
    root = makeProjectTempDir('gv-feature-overrides');
    configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      configDir: join(root, 'config'),
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('writes the domain key in memory without persisting to disk', () => {
    expect(configManager.get('sandbox.enabled')).toBe(true);
    const errors = applyRuntimeFeatureOverrides(configManager, {
      enableFeatures: [],
      disableFeatures: ['exec-sandbox'],
    });
    expect(errors).toEqual([]);
    expect(configManager.get('sandbox.enabled')).toBe(false);
    expect(isFeatureEnabledInConfig(configManager, 'exec-sandbox')).toBe(false);

    // Runtime-only: the settings file (if any) never sees the override.
    const settingsPath = join(root, 'config', 'settings.json');
    const persisted = (() => {
      try {
        return JSON.parse(readFileSync(settingsPath, 'utf-8')) as { sandbox?: { enabled?: boolean } };
      } catch {
        return null;
      }
    })();
    if (persisted?.sandbox && 'enabled' in persisted.sandbox) {
      expect(persisted.sandbox.enabled).toBe(true);
    }
  });

  test('enum features get their canonical enabled value', () => {
    const errors = applyRuntimeFeatureOverrides(configManager, {
      enableFeatures: ['permissions-policy-engine'],
      disableFeatures: [],
    });
    expect(errors).toEqual([]);
    expect(configManager.get('permissions.engine')).toBe('policy-engine');
  });

  test('unknown and always-available features return honest errors instead of being swallowed', () => {
    const errors = applyRuntimeFeatureOverrides(configManager, {
      enableFeatures: ['not-a-feature'],
      disableFeatures: ['slack-surface'],
    });
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain('Invalid --enable-feature not-a-feature.');
    expect(errors[0]).toContain('Unknown feature');
    expect(errors[1]).toContain('Invalid --disable-feature slack-surface.');
    expect(errors[1]).toContain('surfaces.slack.enabled');
  });
});

describe('onboarding legacy featureFlags set-config operations', () => {
  let root: string;
  let configManager: ConfigManager;
  let shellPaths: ReturnType<typeof createShellPathService>;

  beforeEach(() => {
    root = makeProjectTempDir('gv-onboarding-features');
    shellPaths = createShellPathService({
      workingDirectory: join(root, 'workspace'),
      homeDirectory: join(root, 'home'),
    });
    configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      homeDir: join(root, 'home'),
      workingDir: join(root, 'workspace'),
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('a legacy single-feature operation applies to the domain key and verifies by derived state', async () => {
    const request = {
      mode: 'edit' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-config' as const,
          key: 'featureFlags.exec-sandbox' as const,
          value: 'disabled',
        },
      ],
    };

    const result = await applyOnboardingRequest({ config: configManager, shellPaths }, request);
    expect(result.ok).toBe(true);
    expect(result.applied[0]?.summary).toContain('sandbox.enabled');
    expect(result.applied[0]?.summary).toContain('legacy featureFlags.exec-sandbox');
    expect(configManager.get('sandbox.enabled')).toBe(false);

    const verification = await verifyOnboardingRequest({ config: configManager, shellPaths }, request);
    const item = verification.items.find((entry) => entry.id === 'config:featureFlags.exec-sandbox');
    expect(item?.status).toBe('pass');
    expect(item?.message).toContain('derived from the domain settings keys');
  });

  test('a legacy whole-record operation applies every entry and fails verification honestly after drift', async () => {
    const request = {
      mode: 'edit' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-config' as const,
          key: 'featureFlags' as const,
          value: { 'exec-sandbox': 'disabled', 'permissions-policy-engine': 'enabled' },
        },
      ],
    };

    const result = await applyOnboardingRequest({ config: configManager, shellPaths }, request);
    expect(result.ok).toBe(true);
    expect(configManager.get('sandbox.enabled')).toBe(false);
    expect(configManager.get('permissions.engine')).toBe('policy-engine');

    // Drift one domain key back and verification must fail, naming the feature.
    configManager.setDynamic('sandbox.enabled', true);
    const verification = await verifyOnboardingRequest({ config: configManager, shellPaths }, request);
    const item = verification.items.find((entry) => entry.id === 'config:featureFlags');
    expect(item?.status).toBe('fail');
    expect(item?.message).toContain('exec-sandbox');
  });

  test('an unknown legacy feature id fails the operation with guidance instead of silently persisting', async () => {
    const request = {
      mode: 'edit' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-config' as const,
          key: 'featureFlags.no-such-feature' as const,
          value: 'enabled',
        },
      ],
    };

    const result = await applyOnboardingRequest({ config: configManager, shellPaths }, request);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain('Unknown feature "no-such-feature"');
  });
});
