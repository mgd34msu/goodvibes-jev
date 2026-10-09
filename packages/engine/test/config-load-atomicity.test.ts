import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { DEFAULT_CONFIG } from '../sdk/src/platform/config/schema.js';
import { applyRuntimeConfigValue } from '../terminal-shell/src/cli-config-overrides.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(globalFile = false, model?: string) {
  const root = mkdtempSync(join(tmpdir(), 'config-load-atomicity-')); roots.push(root);
  const workingDir = join(root, 'workspace'); mkdirSync(workingDir);
  if (globalFile) write(join(root, 'config', 'settings.json'), { provider: { model: 'synthetic:disk-model' } });
  return new ConfigManager({ configDir: join(root, 'config'), homeDir: join(root, 'home'), workingDir, surfaceRoot: 'tui', ownsDaemonTier: true, model });
}

function write(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value));
}

describe('complete layered configuration reloads', () => {
  test.each(['global', 'project', 'shared', 'daemon'] as const)('a refused %s layer retains the previous complete values and tier ownership', (tier) => {
    const manager = fixture();
    manager.set('judgment.endpoint', 'http://127.0.0.1:9400');
    manager.setProjectValue('judgment.endpoint', 'http://127.0.0.1:9401');
    manager.setProjectValue('permissions.mode', 'plan');
    manager.set('tts.voice', 'synthetic-shared-voice');
    manager.set('surfaces.email.host', 'synthetic-daemon.example.test');
    manager.load();
    const previous = manager.getAll();
    const incarnation = manager.getAutonomousPermissionSnapshot().incarnation;
    const invalidations: unknown[] = [];
    manager.onDidInvalidate(() => invalidations.push({ config: manager.getAll(), incarnation: manager.getAutonomousPermissionSnapshot().incarnation }));

    // Valid earlier layers would replace the local destination and permission
    // mode if a later refusal could leave a partially committed configuration.
    write(manager.getConfigPath(), { judgment: { endpoint: 'https://changed.example.test' } });
    write(manager.getProjectConfigPath()!, {});
    const paths = { global: manager.getConfigPath(), project: manager.getProjectConfigPath()!, shared: manager.getSharedTierPath()!, daemon: manager.getDaemonTierPath()! };
    if (tier === 'daemon') write(paths.shared, {});
    // This existing safety-gate key already refuses on the unmodified schema.
    write(paths[tier], { permissions: { mode: 'synthetic-invalid-mode' } });

    expect(() => manager.load()).toThrow();
    expect(invalidations).toEqual([{ config: previous, incarnation: incarnation + 1 }]);
    expect(manager.getAutonomousPermissionSnapshot().incarnation).toBe(incarnation + 1);
    expect(manager.getAll()).toEqual(previous);
    expect(manager.describeConfigKeySource('tts.voice').tier).toBe('shared');
    expect(manager.describeConfigKeySource('surfaces.email.host').tier).toBe('daemon');
    expect(manager.getIngestionQuarantine().some((notice) => notice.action === 'refused')).toBe(true);

    // A subsequent valid load can commit normally; the failure did not freeze
    // either the accepted values or the last-load ownership sets permanently.
    write(paths[tier], {}); manager.load();
    expect(manager.get('judgment.endpoint')).toBe(tier === 'global' ? DEFAULT_CONFIG.judgment.endpoint : 'https://changed.example.test');
    expect(manager.get('permissions.mode')).toBe(DEFAULT_CONFIG.permissions.mode);
    if (tier === 'shared' || tier === 'daemon') expect(manager.describeConfigKeySource('tts.voice').tier).toBe('default');
    if (tier === 'daemon') expect(manager.describeConfigKeySource('surfaces.email.host').tier).toBe('default');
  });

  test.each([false, true])('a failed reload retains active CLI values, including earlier shared changes %#', (globalFile) => {
    const manager = fixture(globalFile, 'synthetic:cli-model');
    applyRuntimeConfigValue(manager, 'permissions.mode', 'plan');
    manager.set('tts.voice', 'synthetic-original');
    const previous = manager.getAll();
    write(manager.getSharedTierPath()!, { tts: { voice: 'synthetic-changed' } });
    write(manager.getDaemonTierPath()!, { permissions: { mode: 'synthetic-invalid-mode' } });
    expect(() => manager.load()).toThrow();
    expect(manager.getAll()).toEqual(previous);
    expect(manager.get('provider.model')).toBe('synthetic:cli-model');
    expect(manager.get('permissions.mode')).toBe('plan');
  });

  test('successful reload without a global file retains the baseline CLI lifetime', () => {
    const manager = fixture(false, 'synthetic:cli-model');
    applyRuntimeConfigValue(manager, 'permissions.mode', 'plan');
    expect(existsSync(manager.getConfigPath())).toBe(false);
    write(manager.getSharedTierPath()!, { tts: { voice: 'synthetic-shared' } }); manager.load();
    expect(manager.get('provider.model')).toBe('synthetic:cli-model');
    expect(manager.get('permissions.mode')).toBe('plan');
    expect(manager.get('tts.voice')).toBe('synthetic-shared');
  });

  test('a successful reload preserves the existing default/global/project/shared/daemon precedence', () => {
    const manager = fixture();
    write(manager.getConfigPath(), { judgment: { endpoint: 'http://127.0.0.1:9400' }, tts: { voice: 'synthetic-global' }, surfaces: { email: { host: 'global.example.test' } } });
    write(manager.getProjectConfigPath()!, { judgment: { endpoint: 'http://127.0.0.1:9401' }, tts: { voice: 'synthetic-project' }, surfaces: { email: { host: 'project.example.test' } } });
    write(manager.getSharedTierPath()!, { tts: { voice: 'synthetic-shared' } });
    write(manager.getDaemonTierPath()!, { surfaces: { email: { host: 'daemon.example.test' } } });
    manager.load();
    expect(manager.get('judgment.endpoint')).toBe('http://127.0.0.1:9401');
    expect(manager.get('tts.voice')).toBe('synthetic-shared');
    expect(manager.get('surfaces.email.host')).toBe('daemon.example.test');
  });
});
