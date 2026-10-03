import { describe, expect, test } from 'bun:test';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { readCheckpointGuardSettings, readCheckpointRegistrationSetting } from '../../config/checkpoint-settings.ts';

function configManagerWithRaw(raw: Record<string, unknown>): Pick<ConfigManager, 'getRaw'> {
  return { getRaw: () => raw } as unknown as Pick<ConfigManager, 'getRaw'>;
}

describe('readCheckpointRegistrationSetting', () => {
  test('defaults to "off" with no checkpoints block', () => {
    expect(readCheckpointRegistrationSetting(configManagerWithRaw({}))).toBe('off');
  });

  test('defaults to "off" when the checkpoints block omits the key', () => {
    expect(readCheckpointRegistrationSetting(configManagerWithRaw({ checkpoints: { preferGitRoot: true } }))).toBe('off');
  });

  test('reads "guarded" when explicitly set', () => {
    expect(readCheckpointRegistrationSetting(configManagerWithRaw({ checkpoints: { unregisteredWorkspaces: 'guarded' } }))).toBe('guarded');
  });

  test('an unrecognized value reads as "off", never guessed', () => {
    expect(readCheckpointRegistrationSetting(configManagerWithRaw({ checkpoints: { unregisteredWorkspaces: 'allow' } }))).toBe('off');
  });

  test('a non-object checkpoints block reads as "off"', () => {
    expect(readCheckpointRegistrationSetting(configManagerWithRaw({ checkpoints: 'nope' }))).toBe('off');
    expect(readCheckpointRegistrationSetting(configManagerWithRaw({ checkpoints: null }))).toBe('off');
  });

  test('does not leak unregisteredWorkspaces into the SDK guard-settings passthrough', () => {
    const raw = { checkpoints: { unregisteredWorkspaces: 'guarded', preferGitRoot: false } };
    const guardSettings = readCheckpointGuardSettings(configManagerWithRaw(raw));
    expect(guardSettings).not.toHaveProperty('unregisteredWorkspaces');
    expect(guardSettings.preferGitRoot).toBe(false);
  });
});
