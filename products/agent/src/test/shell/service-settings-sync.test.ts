import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  AGENT_EXTERNAL_HOST_SERVICE_MESSAGE,
  syncServiceSettingToPlatform,
} from '../../shell/service-settings-sync.ts';

describe('syncServiceSettingToPlatform', () => {
  let root = '';

  beforeEach(() => {
    const testRoot = join(import.meta.dir, '../../../.tmp-tests');
    mkdirSync(testRoot, { recursive: true });
    root = mkdtempSync(join(testRoot, 'gv-agent-service-sync-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function createConfig(): ConfigManager {
    return new ConfigManager({
      surfaceRoot: 'agent',
      workingDir: root,
      homeDir: root,
      configDir: join(root, '.goodvibes', 'agent'),
    });
  }

  test('blocks and reverts connected-host lifecycle changes', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', true);

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.enabled', previousValue: false, value: true },
    );

    expect(configManager.get('service.enabled')).toBe(false);
    expect(result).toEqual({
      handled: true,
      action: 'connected-host-blocked',
      message: AGENT_EXTERNAL_HOST_SERVICE_MESSAGE,
      error: 'connected_host_lifecycle_external',
    });
    expect(result.message).toContain('connected GoodVibes host');
    expect(result.message).toContain('host lifecycle outside Agent');
  });

  test('does not rewrite unchanged service settings', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.autostart', false);

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: false, value: false },
    );

    expect(configManager.get('service.autostart')).toBe(false);
    expect(result).toEqual({
      handled: true,
      action: 'unchanged',
      message: 'Connected-host setting unchanged',
    });
  });

  test('ignores non-service settings', () => {
    const configManager = createConfig();
    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'display.stream', previousValue: true, value: false },
    );

    expect(result.handled).toBe(false);
  });
});
