/**
 * migrateWrfcSettings and its load pass (design 9.2): every `wrfc.*` key and
 * `ui.wrfcMessages` moves to its `contract.*` successor, `wrfc.scoreThreshold`
 * is removed with a receipt saying what replaced it, and ConfigManager.load
 * applies it once, rewriting the file.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../sdk/src/platform/config/manager.js';
import { migrateWrfcSettings, WRFC_SETTING_RENAMES } from '../../sdk/src/platform/config/migrations.js';
import { applyContractSettingsMigrationPass, runLoadMigrationPasses } from '../../sdk/src/platform/config/manager-migration-passes.js';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '../../sdk/src/platform/runtime/feature-announcements.js';
import { readContractConfig } from '../../sdk/src/platform/contract/index.js';

const GATES = [
  { name: 'typecheck', command: 'npx tsc --noEmit', enabled: true },
  { name: 'build', command: 'npm run build', enabled: false },
];

/** A settings file carrying every review-loop key the old products ever wrote. */
function everyWrfcKey(): Record<string, unknown> {
  return {
    wrfc: {
      scoreThreshold: 9.5,
      maxFixAttempts: 3,
      autoCommit: true,
      commitScope: 'all',
      agentHeartbeatTimeoutMs: 45_000,
      transportRetryLimit: 2,
      transportRetryDelayMs: 1500,
      gates: GATES,
    },
    ui: { wrfcMessages: 'panel', systemMessages: 'conversation' },
    display: { theme: 'vaporwave' },
  };
}

function tempDir(label: string): string {
  const dir = join(tmpdir(), `gv-${label}-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('migrateWrfcSettings', () => {
  test('moves every wrfc key and ui.wrfcMessages to its contract successor, values unchanged', () => {
    const result = migrateWrfcSettings(everyWrfcKey());
    expect(result.migrated).toBe(true);
    expect(result.config['contract']).toEqual({
      autoCommit: true,
      commitScope: 'all',
      gates: GATES,
      transportRetryLimit: 2,
      transportRetryDelayMs: 1500,
      heartbeatTimeoutMs: 45_000,
      maxFixRounds: 3,
    });
    expect(result.config['ui']).toEqual({ systemMessages: 'conversation', contractMessages: 'panel' });
    expect(result.config).not.toHaveProperty('wrfc');
    expect(result.config['display']).toEqual({ theme: 'vaporwave' });
    expect(result.moves.map((move) => [move.from, move.to, move.moved])).toEqual(
      WRFC_SETTING_RENAMES.map(([from, to]) => [from, to, true]),
    );
  });

  test('removes wrfc.scoreThreshold and reports the value it had', () => {
    const result = migrateWrfcSettings(everyWrfcKey());
    expect(result.scoreThresholdRemoved).toBe(true);
    expect(result.removedScoreThreshold).toBe(9.5);
    const onlyThreshold = migrateWrfcSettings({ wrfc: { scoreThreshold: 'high' } });
    expect(onlyThreshold.migrated).toBe(true);
    expect(onlyThreshold.scoreThresholdRemoved).toBe(true);
    expect(onlyThreshold.removedScoreThreshold).toBeUndefined();
    expect(onlyThreshold.config).toEqual({});
  });

  test('a value already under the new name is kept and the old key is still removed', () => {
    const result = migrateWrfcSettings({ wrfc: { commitScope: 'all' }, contract: { commitScope: 'off' } });
    expect(result.config).toEqual({ contract: { commitScope: 'off' } });
    expect(result.moves).toEqual([{ from: 'wrfc.commitScope', to: 'contract.commitScope', moved: false }]);
  });

  test('an unknown wrfc key stays where it is, so the settings screen reports it', () => {
    const result = migrateWrfcSettings({ wrfc: { autoCommit: false, maxReviewCycles: 4 } });
    expect(result.config).toEqual({ wrfc: { maxReviewCycles: 4 }, contract: { autoCommit: false } });
  });

  test('does not touch its input, and is idempotent', () => {
    const input = everyWrfcKey();
    const snapshot = structuredClone(input);
    const first = migrateWrfcSettings(input);
    expect(input).toEqual(snapshot);
    const second = migrateWrfcSettings(first.config);
    expect(second.migrated).toBe(false);
    expect(second.config).toBe(first.config);
  });

  test('a file with no review-loop keys, or a malformed wrfc section, is returned untouched', () => {
    const plain = { display: { theme: 'vaporwave' } };
    expect(migrateWrfcSettings(plain)).toEqual({ config: plain, migrated: false, moves: [], scoreThresholdRemoved: false });
    const malformed = { wrfc: 'on' };
    expect(migrateWrfcSettings(malformed).config).toBe(malformed);
  });
});

describe('the contract settings load pass', () => {
  test('rewrites the file and files both receipts', () => {
    const dir = tempDir('contract-pass');
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify(everyWrfcKey()), 'utf-8');
    const receipts: Array<[string, string]> = [];
    const migrated = applyContractSettingsMigrationPass(everyWrfcKey(), path, (id, text) => receipts.push([id, text]));
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(migrated);
    expect(receipts.map(([id]) => id)).toEqual([
      `settings-migration-contract-settings:${path}`,
      `settings-migration-wrfc-score-threshold:${path}`,
    ]);
    const [moves, threshold] = receipts.map(([, text]) => text);
    for (const [from, to] of WRFC_SETTING_RENAMES) expect(moves).toContain(`${from} is now ${to}`);
    expect(threshold).toContain('wrfc.scoreThreshold (it was 9.5)');
    expect(threshold).toContain('a reading per acceptance criterion');
    expect(threshold).toContain('contract.acceptanceStakes');
    expect(`${moves}${threshold}`).not.toContain('—');
  });

  test('a kept new value is named in the receipt as the reason the old one was dropped', () => {
    const receipts: string[] = [];
    applyContractSettingsMigrationPass({ wrfc: { commitScope: 'all' }, contract: { commitScope: 'off' } }, join(tempDir('contract-kept'), 'settings.json'), (_id, text) => receipts.push(text));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain('wrfc.commitScope was dropped because contract.commitScope was already set');
  });

  test('is one of the load passes', () => {
    const migrated = runLoadMigrationPasses(everyWrfcKey(), join(tempDir('contract-passes'), 'settings.json'), () => undefined);
    expect(migrated).not.toHaveProperty('wrfc');
    expect(migrated['contract']).toMatchObject({ maxFixRounds: 3, heartbeatTimeoutMs: 45_000 });
  });
});

describe('ConfigManager.load applies the migration', () => {
  test('the old values resolve under the new keys, the file is rewritten, and the receipts are recorded', () => {
    const configDir = tempDir('contract-load');
    const path = join(configDir, 'settings.json');
    writeFileSync(path, JSON.stringify(everyWrfcKey()), 'utf-8');
    const manager = new ConfigManager({ configDir });

    const config = readContractConfig(manager);
    expect(config.autoCommit).toBe(true);
    expect(config.commitScope).toBe('all');
    expect(config.maxFixRounds).toBe(3);
    expect(config.heartbeatTimeoutMs).toBe(45_000);
    expect(config.transportRetryLimit).toBe(2);
    expect(config.transportRetryDelayMs).toBe(1500);
    expect(config.gates).toEqual(GATES);
    expect(manager.get('ui.contractMessages')).toBe('panel');

    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty('wrfc');
    expect((onDisk['ui'] as Record<string, unknown>)['wrfcMessages']).toBeUndefined();

    const announcements = new FeatureAnnouncementStore(featureAnnouncementsPath(manager));
    expect(announcements.has(`settings-migration-contract-settings:${path}`)).toBe(true);
    expect(announcements.has(`settings-migration-wrfc-score-threshold:${path}`)).toBe(true);
  });
});
