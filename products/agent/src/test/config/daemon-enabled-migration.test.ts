/**
 * The once-only reset of a `daemon.enabled: false` that predates the split.
 *
 * The key used to mean "do not run a daemon inside this process". It now means
 * "do not adopt a daemon at all", which disables host discovery entirely, so a
 * value written under the old meaning silently cuts a machine off from the
 * platform. It is reset once, with a receipt, and never again: the whole point
 * of the marker is that a `false` the user writes AFTER the correction is
 * theirs and is kept forever.
 *
 * Everything here runs against real settings files in scratch homes. Nothing
 * touches this machine's own ~/.goodvibes tree.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  daemonEnabledMigrationReceiptPath,
  ensureDaemonEnabledMigrated,
} from '../../config/ensure-daemon-enabled-migrated.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function agentSettingsPath(root: string): string {
  return join(root, '.goodvibes', 'agent', 'settings.json');
}

function writeSettings(root: string, value: unknown): string {
  const path = agentSettingsPath(root);
  mkdirSync(join(root, '.goodvibes', 'agent'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  return path;
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function daemonEnabledOf(path: string): unknown {
  const parsed = readSettings(path);
  const daemon = parsed['daemon'];
  return typeof daemon === 'object' && daemon !== null ? (daemon as Record<string, unknown>)['enabled'] : undefined;
}

describe('ensureDaemonEnabledMigrated', () => {
  test('a stored false is reset once, with a notice that names both meanings', () => {
    const home = makeProjectTempDir('daemon-enabled');
    const path = writeSettings(home, { daemon: { enabled: false }, display: { stream: true } });

    const notice = ensureDaemonEnabledMigrated({ homeDir: home });

    expect(daemonEnabledOf(path)).toBe(true);
    expect(notice).not.toBeNull();
    // The user is told what it used to mean, what it means now, and that the
    // choice is still theirs to make again.
    expect(notice!).toContain('used to mean');
    expect(notice!).toContain('do not look for a daemon at all');
    expect(notice!).toContain('one settings change away');
    // Nothing else in the file is disturbed.
    expect(readSettings(path)['display']).toEqual({ stream: true });
  });

  test('the receipt records the old meaning, the new meaning, and the reset', () => {
    const home = makeProjectTempDir('daemon-enabled');
    writeSettings(home, { daemon: { enabled: false } });
    ensureDaemonEnabledMigrated({ homeDir: home, now: () => new Date('2026-08-06T12:00:00.000Z') });

    const receiptPath = daemonEnabledMigrationReceiptPath(home);
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = readSettings(receiptPath);
    expect(receipt['completed']).toBe(true);
    expect(receipt['key']).toBe('daemon.enabled');
    expect(receipt['migratedAt']).toBe('2026-08-06T12:00:00.000Z');
    expect(String(receipt['oldMeaning'])).toContain('inside this application');
    expect(String(receipt['newMeaning'])).toContain('adopts a session daemon of its own');
    expect(String(receipt['action'])).toContain('Reset daemon.enabled to true once');
    expect(String(receipt['onceOnly'])).toContain('never reset');
    expect(receipt['reset']).toEqual([{ scope: 'user', path: agentSettingsPath(home) }]);
  });

  test('it fires exactly once: a false the user sets AFTER the migration is kept forever', () => {
    const home = makeProjectTempDir('daemon-enabled');
    const path = writeSettings(home, { daemon: { enabled: false } });

    expect(ensureDaemonEnabledMigrated({ homeDir: home })).not.toBeNull();
    expect(daemonEnabledOf(path)).toBe(true);

    // The user deliberately turns it off again.
    writeSettings(home, { daemon: { enabled: false } });

    // Every later launch leaves that choice completely alone.
    for (let launch = 0; launch < 3; launch += 1) {
      expect(ensureDaemonEnabledMigrated({ homeDir: home })).toBeNull();
      expect(daemonEnabledOf(path)).toBe(false);
    }
  });

  test('a machine that never carried the flag still gets the marker, so a later false is never touched', () => {
    const home = makeProjectTempDir('daemon-enabled');
    const path = writeSettings(home, { display: { stream: true } });

    // Nothing to reset, so nothing to announce.
    expect(ensureDaemonEnabledMigrated({ homeDir: home })).toBeNull();
    // But the correction is retired anyway, this is what makes a future
    // false the user's own.
    expect(existsSync(daemonEnabledMigrationReceiptPath(home))).toBe(true);

    writeSettings(home, { daemon: { enabled: false } });
    expect(ensureDaemonEnabledMigrated({ homeDir: home })).toBeNull();
    expect(daemonEnabledOf(path)).toBe(false);
  });

  test('an explicit true is left exactly as it is', () => {
    const home = makeProjectTempDir('daemon-enabled');
    const path = writeSettings(home, { daemon: { enabled: true, connectedHost: { enabled: false } } });
    expect(ensureDaemonEnabledMigrated({ homeDir: home })).toBeNull();
    expect(daemonEnabledOf(path)).toBe(true);
    // The sibling dial setting is not this pass's business.
    expect((readSettings(path)['daemon'] as Record<string, unknown>)['connectedHost']).toEqual({ enabled: false });
  });

  test('a project-scoped false is corrected too, and named in the notice', () => {
    const home = makeProjectTempDir('daemon-enabled');
    const project = makeProjectTempDir('daemon-enabled-project');
    writeSettings(home, { daemon: { enabled: true } });
    const projectPath = writeSettings(project, { daemon: { enabled: false } });

    const notice = ensureDaemonEnabledMigrated({ homeDir: home, workingDir: project });
    expect(daemonEnabledOf(projectPath)).toBe(true);
    expect(notice!).toContain('project settings');
    expect(notice!).toContain(projectPath);
  });

  test('a flat dotted key, the shape a hand-edited file carries, is corrected too', () => {
    const home = makeProjectTempDir('daemon-enabled');
    const path = writeSettings(home, { 'daemon.enabled': false });
    expect(ensureDaemonEnabledMigrated({ homeDir: home })).not.toBeNull();
    expect(readSettings(path)['daemon.enabled']).toBe(true);
  });

  test('a torn receipt counts as already-done, so a deliberate setting is never overwritten', () => {
    const home = makeProjectTempDir('daemon-enabled');
    const path = writeSettings(home, { daemon: { enabled: false } });
    const receiptPath = daemonEnabledMigrationReceiptPath(home);
    mkdirSync(join(home, '.goodvibes', 'agent', 'control-plane'), { recursive: true });
    // The shape an interrupted write leaves behind.
    writeFileSync(receiptPath, '{"completed": tr', 'utf-8');

    expect(ensureDaemonEnabledMigrated({ homeDir: home })).toBeNull();
    // Re-running a correction that cannot be repeated safely is the worse
    // failure, so an unreadable receipt stops it rather than licensing it.
    expect(daemonEnabledOf(path)).toBe(false);
  });

  test('no settings file at all is not an error: the marker is still written', () => {
    const home = makeProjectTempDir('daemon-enabled');
    expect(ensureDaemonEnabledMigrated({ homeDir: home })).toBeNull();
    expect(existsSync(daemonEnabledMigrationReceiptPath(home))).toBe(true);
  });

  test('an unparseable settings file is left alone rather than rewritten', () => {
    const home = makeProjectTempDir('daemon-enabled');
    const path = agentSettingsPath(home);
    mkdirSync(join(home, '.goodvibes', 'agent'), { recursive: true });
    writeFileSync(path, '{ this is not json', 'utf-8');

    expect(ensureDaemonEnabledMigrated({ homeDir: home })).toBeNull();
    expect(readFileSync(path, 'utf-8')).toBe('{ this is not json');
  });
});
