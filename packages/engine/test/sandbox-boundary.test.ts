/**
 * Coverage-gap smoke test, platform/runtime/sandbox
 * Verifies sandbox boundary functions return correct observable shapes
 * when called with realistic inputs. Local host execution is the only
 * sandbox backend.
 */

import { describe, expect, test } from 'bun:test';
import {
  getSandboxConfigSnapshot,
  detectSandboxHostStatus,
  listSandboxProfiles,
  listSandboxPresets,
  getSandboxPreset,
  isRunningInWsl,
  renderSandboxReview,
} from '../sdk/src/platform/runtime/sandbox/manager.js';
import {
  buildSandboxLaunchPlan,
  probeSandboxBackends,
} from '../sdk/src/platform/runtime/sandbox/backend.js';

const sandboxConfig = {
  'sandbox.replIsolation': 'shared-vm',
  'sandbox.mcpIsolation': 'hybrid',
  'sandbox.windowsMode': 'require-wsl',
  'sandbox.vmBackend': 'local',
} as const;

function makeConfigManager() {
  return {
    get: (key: string) => sandboxConfig[key as keyof typeof sandboxConfig],
  };
}

describe('platform/runtime/sandbox: behavior smoke', () => {
  test('isRunningInWsl returns a boolean', () => {
    expect(typeof isRunningInWsl()).toBe('boolean');
  });

  test('getSandboxConfigSnapshot returns a frozen snapshot from config values', () => {
    const config = getSandboxConfigSnapshot(makeConfigManager());
    expect(Object.isFrozen(config)).toBe(true);
    expect(config).toEqual({
      replIsolation: 'shared-vm',
      mcpIsolation: 'hybrid',
      windowsMode: 'require-wsl',
      vmBackend: 'local',
    });
  });

  test('detectSandboxHostStatus returns frozen host readiness details', () => {
    const status = detectSandboxHostStatus();
    expect(Object.isFrozen(status)).toBe(true);
    expect(status.platform).toBe(process.platform);
    expect(status.windows).toBe(process.platform === 'win32');
    expect(status.runningInWsl).toBe(isRunningInWsl());
    expect(status.recommendedBackend).toBe('local');
    expect(Array.isArray(status.warnings)).toBe(true);
  });

  test('listSandboxProfiles returns a non-empty array, each profile has id/label/kind/isolation', () => {
    const profiles = listSandboxProfiles(makeConfigManager());
    expect(profiles).toBeInstanceOf(Array);
    expect(profiles.length).toBeGreaterThan(0);
    const first = profiles[0] as unknown as Record<string, unknown>;
    expect(typeof first.id).toBe('string');
    expect(typeof first.label).toBe('string');
    expect(typeof first.kind).toBe('string');
    expect(typeof first.isolation).toBe('string');
  });

  test('every preset uses the local backend and carries only the four sandbox settings', () => {
    const presets = listSandboxPresets();
    expect(presets.map((preset) => preset.id)).toEqual([
      'secure-balanced',
      'secure-isolated',
      'shared-performance',
      'windows-basic',
    ]);
    for (const preset of presets) {
      expect(preset.config.vmBackend).toBe('local');
      expect(Object.keys(preset.config).sort()).toEqual(['mcpIsolation', 'replIsolation', 'vmBackend', 'windowsMode']);
    }
  });

  test('getSandboxPreset returns the preset for secure-balanced with id and label', () => {
    const preset = getSandboxPreset('secure-balanced');
    expect(preset).not.toBeNull();
    expect(preset?.id).toBe('secure-balanced');
    expect(typeof preset?.label).toBe('string');
  });

  test('getSandboxPreset returns null for an unknown preset id', () => {
    expect(getSandboxPreset('non-existent-preset-xyz')).toBeNull();
  });

  test('the backend probe reports local as the one available backend with no warnings', () => {
    const probe = probeSandboxBackends(makeConfigManager());
    expect(probe.requestedBackend).toBe('local');
    expect(probe.resolvedBackend).toBe('local');
    expect(probe.backends.map((backend) => [backend.id, backend.available])).toEqual([['local', true]]);
    expect(probe.warnings).toEqual([]);
  });

  test('launch planning builds a host shell plan rooted at the resolved workspace', () => {
    const profile = listSandboxProfiles(makeConfigManager())[0]!;
    const plan = buildSandboxLaunchPlan(profile, 'Smoke', '.');
    expect(plan.backend).toBe('local');
    expect(plan.workspaceRoot).toBe(process.cwd());
    expect(plan.args).toEqual(['-lc', `echo "goodvibes sandbox ${profile.id}: Smoke"`]);
    expect(plan.summary).toBe([plan.command, ...plan.args].join(' '));
  });

  test('the review names the local backend and no QEMU settings', () => {
    const review = renderSandboxReview(makeConfigManager());
    expect(review).toContain('  vm backend: local');
    expect(review).toContain('  resolved backend: local');
    expect(review.toLowerCase()).not.toContain('qemu');
  });
});
