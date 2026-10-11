/** Product-owned OSC 9 opt-in is known locally and never grants notification details. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG_SCHEMA, ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { installJudgmentPort, restoreJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { buildTurnNotificationLine, readNotificationsMetadataOnly } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { TuiConfigManager, readTuiConfigValue, TUI_NOTIFICATIONS_METADATA_ONLY_KEY } from '../../config/host-settings.ts';
import { createTerminalNotifier, TERMINAL_NOTIFY_SIGNALS } from '../../core/terminal-notifier.ts';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';

const KEY = TERMINAL_NOTIFY_SIGNALS['turn-end'].configKey;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(behavior?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'tui-terminal-setting-')); roots.push(root);
  const workingDir = join(root, 'project'); mkdirSync(workingDir);
  const configDir = join(root, 'config'); mkdirSync(configDir);
  if (behavior) writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ behavior }));
  const options = { homeDir: root, workingDir, configDir, surfaceRoot: 'tui' };
  return { options, config: new TuiConfigManager(options) };
}

test('persisted TUI turn-end opt-in is known without an unknown-setting judgment or shared schema mutation', async () => {
  const fake = fakePort(() => { throw new Error('A known TUI setting must not need classification'); });
  const previous = installJudgmentPort(fake.port);
  try {
    const { config, options } = fixture({ terminalNotifyTurnEnd: true });
    await config.announceUnknownSettingForms();
    expect(fake.requests).toHaveLength(0);
    expect(readTuiConfigValue(config, KEY)).toBe(true);
    expect(config.getHostSettingsSchema().filter(row => row.key === KEY)).toHaveLength(1);
    expect(CONFIG_SCHEMA.some(row => String(row.key) === KEY)).toBe(false);
    expect(new ConfigManager(options).getHostSettingsSchema().some(row => row.key === KEY)).toBe(false);
  } finally { restoreJudgmentPort(fake.port, previous); }
});

test('turn-end control has one validated host row, defaults off, and survives a local reload', () => {
  const { config, options } = fixture();
  const handle = config.getHostBooleanSetting(KEY);
  expect(handle.get()).toBe(TERMINAL_NOTIFY_SIGNALS['turn-end'].defaultOn);
  const rows = buildSettingGroups(config).get('behavior')!.filter(row => row.setting.key === KEY);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe('host');
  expect(rows[0]!.currentValue).toBe(false);
  expect(() => Reflect.apply(handle.set, null, ['true'])).toThrow('literal boolean');
  handle.set(true);
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.terminalNotifyTurnEnd).toBe(true);
  expect(new TuiConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(true);
  handle.set(false);
  expect(new TuiConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(false);
});

test('enabling OSC 9 leaves content private until explicit detail consent, and revocation is live', () => {
  const { config } = fixture({ terminalNotifyTurnEnd: true });
  const sent: string[] = [];
  const configGet = (key: string) => readTuiConfigValue(config, key);
  const notifier = createTerminalNotifier({ stdout: { write: text => { sent.push(text); return true; } },
    configGet, focusTracker: { shouldAlertWhenUnfocused: () => true }, isReleased: () => false });
  const notify = () => notifier.notify('turn-end', buildTurnNotificationLine({
    outcome: 'completed', elapsedMs: 1200, name: 'summarize the heron migration notes',
  }, { metadataOnly: readNotificationsMetadataOnly(configGet) }));
  notify();
  expect(sent[0]).toContain('GoodVibes: turn done');
  expect(sent[0]).not.toContain('heron');
  config.getHostBooleanSetting(TUI_NOTIFICATIONS_METADATA_ONLY_KEY).set(false);
  notify();
  expect(sent[1]).toContain('summarize the heron migration notes');
  config.getHostBooleanSetting(TUI_NOTIFICATIONS_METADATA_ONLY_KEY).set(true);
  notify();
  expect(sent[2]).not.toContain('heron');
  expect(sent).toHaveLength(3);
});

test('malformed persisted OSC 9 opt-in falls back to off without changing explicit privacy consent', () => {
  const { config } = fixture({ terminalNotifyTurnEnd: 'true', notificationsMetadataOnly: false });
  expect(readTuiConfigValue(config, KEY)).toBe(false);
  expect(readTuiConfigValue(config, TUI_NOTIFICATIONS_METADATA_ONLY_KEY)).toBe(false);
  expect(config.getIngestionQuarantine().some(entry => entry.key === KEY)).toBe(true);
});
