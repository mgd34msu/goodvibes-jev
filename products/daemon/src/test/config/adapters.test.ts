import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecretsManager as EngineSecretsManager, daemonConfigPath, type ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { readCheckpointGuardSettings, readCheckpointRegistrationSetting } from '../../config/checkpoint-settings.ts';
import { runDaemonConfigMigration } from '../../config/run-daemon-config-migration.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const roots: string[] = [];
const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string { const dir = makeOwnedTempDir('daemon-config-adapter'); roots.push(dir); return dir; }
function raw(checkpoints: unknown): Pick<ConfigManager, 'getRaw'> {
  // Unknown owner-written blocks survive ingestion outside the typed schema.
  return { getRaw: () => ({ checkpoints }) as unknown as ReturnType<ConfigManager['getRaw']> };
}

describe('checkpoint owner settings', () => {
  test('retains explicit boolean choices and a finite positive ceiling', () => {
    expect(readCheckpointGuardSettings(raw({ preferGitRoot: false, allowBroadRoot: true, allowLargeFirstSnapshot: false, maxFirstSnapshotFiles: 25, autoRetention: false })))
      .toEqual({ preferGitRoot: false, allowBroadRoot: true, allowLargeFirstSnapshot: false, maxFirstSnapshotFiles: 25, autoRetention: false });
  });
  test('omits wrong types and invalid bounds so engine defaults remain authoritative', () => {
    for (const value of [null, undefined, [], 'fixture']) expect(readCheckpointGuardSettings(raw(value))).toEqual({});
    for (const value of [0, -1, Infinity, NaN, '25']) {
      expect(readCheckpointGuardSettings(raw({ preferGitRoot: 'false', allowBroadRoot: 1, autoRetention: null, maxFirstSnapshotFiles: value }))).toEqual({});
    }
  });
  test('registration remains off unless the owner explicitly selects the exact guarded enum', () => {
    expect(readCheckpointRegistrationSetting(raw({ unregisteredWorkspaces: 'guarded' }))).toBe('guarded');
    for (const value of [null, undefined, [], {}, { unregisteredWorkspaces: true }, { unregisteredWorkspaces: 'Guarded' }]) {
      expect(readCheckpointRegistrationSetting(raw(value))).toBe('off');
    }
  });
});

describe('daemon config migration adapter', () => {
  test('preserves the historical surface and moves only daemon-owned settings with a receipt', () => {
    expect(GOODVIBES_DAEMON_SURFACE_ROOT).toBe('tui');
    const home = root(); const dir = join(home, '.goodvibes', 'tui'); mkdirSync(dir, { recursive: true });
    const source = join(dir, 'settings.json');
    writeFileSync(source, JSON.stringify({ display: { theme: 'fixture' }, surfaces: { telegram: { enabled: true, botUsername: 'fixture_bot' } } }));
    const first = runDaemonConfigMigration(home);
    expect(first?.migrated).toBe(true); expect(first?.marker.status).toBe('complete');
    expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual({ display: { theme: 'fixture' } });
    const migrated = JSON.parse(readFileSync(daemonConfigPath(home), 'utf8'));
    expect(migrated.surfaces.telegram.botUsername).toBe('fixture_bot');
    expect(first?.marker.moved).toContainEqual({ key: 'surfaces.telegram.botUsername', from: source });
    const before = readFileSync(daemonConfigPath(home), 'utf8');
    expect(runDaemonConfigMigration(home)?.migrated).toBe(false);
    expect(readFileSync(daemonConfigPath(home), 'utf8')).toBe(before);
  });
  test('migration failure remains a visible warning and does not overwrite the failing path', () => {
    const home = join(root(), 'home-file'); writeFileSync(home, 'fixture preserved');
    const warnings: unknown[][] = [];
    const warning = spyOn(logger, 'warn').mockImplementation((...args) => { warnings.push(args); });
    restorers.push(() => warning.mockRestore());
    expect(runDaemonConfigMigration(home)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toBe('daemon-owned config migration failed; continuing with existing config state');
    expect(readFileSync(home, 'utf8')).toBe('fixture preserved');
  });
});

describe('literal reference-shaped secret adapter', () => {
  test('foreign reference syntax and literal-prefix bytes round-trip without resolving another provider', async () => {
    const values = new Map<string, string>();
    const write = spyOn(EngineSecretsManager.prototype, 'set').mockImplementation(async (key, value) => { values.set(key, value); });
    const read = spyOn(EngineSecretsManager.prototype, 'get').mockImplementation(async (key) => values.get(key) ?? null);
    restorers.push(() => read.mockRestore(), () => write.mockRestore());
    const home = root(); const secrets = new SecretsManager({ projectRoot: home, globalHome: home });
    for (const value of ['op://fixture/vault/item', '__GOODVIBES_LITERAL_V1__fixture', 'ordinary fixture']) {
      await secrets.set('FIXTURE_LITERAL', value, { scope: 'user', medium: 'secure' });
      expect(await secrets.get('FIXTURE_LITERAL')).toBe(value);
    }
    expect(await secrets.get('FIXTURE_MISSING')).toBeNull();
    expect(write).toHaveBeenCalledTimes(3);
  });
});
