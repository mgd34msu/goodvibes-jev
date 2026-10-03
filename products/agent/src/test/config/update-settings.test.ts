/**
 * `update.*` settings reader: the launch-time self-update is a real
 * configurable feature, `update.autoUpdateAtLaunch: false` is the explicit
 * persisted off switch (default ON lives in the consumer), and the check
 * timeout is user-tunable within clamped bounds.
 */
import { describe, expect, test } from 'bun:test';
import { readUpdateSettings } from '../../config/update-settings.ts';

function managerWith(raw: unknown) {
  return { getRaw: () => raw } as Parameters<typeof readUpdateSettings>[0];
}

describe('readUpdateSettings', () => {
  test('returns only the keys the user actually set', () => {
    expect(readUpdateSettings(managerWith({}))).toEqual({});
    expect(readUpdateSettings(managerWith({ update: { autoUpdateAtLaunch: false } }))).toEqual({ autoUpdateAtLaunch: false });
    expect(readUpdateSettings(managerWith({ update: { autoUpdateAtLaunch: true, launchCheckTimeoutMs: 4000 } })))
      .toEqual({ autoUpdateAtLaunch: true, launchCheckTimeoutMs: 4000 });
  });

  test('clamps the timeout to its documented bounds', () => {
    expect(readUpdateSettings(managerWith({ update: { launchCheckTimeoutMs: 1 } }))).toEqual({ launchCheckTimeoutMs: 250 });
    expect(readUpdateSettings(managerWith({ update: { launchCheckTimeoutMs: 600_000 } }))).toEqual({ launchCheckTimeoutMs: 30_000 });
  });

  test('a malformed block degrades to defaults, never a crash', () => {
    expect(readUpdateSettings(managerWith({ update: 'yes please' }))).toEqual({});
    expect(readUpdateSettings(managerWith({ update: ['x'] }))).toEqual({});
    expect(readUpdateSettings(managerWith({ update: { autoUpdateAtLaunch: 'no', launchCheckTimeoutMs: -5 } }))).toEqual({});
  });
});
