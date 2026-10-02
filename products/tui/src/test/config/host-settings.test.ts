import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG_SCHEMA, ConfigManager, SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { WebhookNotifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { setManagedSettingLock } from '@goodvibes-jev/engine/sdk/platform/runtime/settings';
import { TuiConfigManager, TUI_NOTIFICATIONS_METADATA_ONLY_KEY as KEY } from '../../config/host-settings.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import { settingContextLines } from '../../renderer/settings-modal-context.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { frameFromLayer, frameText } from '../helpers/surface-frame.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tui-host-settings-')); roots.push(root);
  const workingDir = join(root, 'project'); mkdirSync(workingDir);
  const options = { homeDir: root, workingDir, configDir: join(root, 'config'), surfaceRoot: 'tui' };
  const config = new TuiConfigManager(options);
  const modal = new SettingsModal();
  const open = () => {
    modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) });
    modal.selectTarget(KEY);
  };
  open();
  return { root, options, config, modal, open };
}

test('host registration is isolated and does not write startup consent', () => {
  const { config, options, modal } = fixture();
  expect(config.get(KEY)).toBe(true);
  expect(config.getSchema().filter(row => row.key === KEY)).toHaveLength(1);
  expect(CONFIG_SCHEMA.some(row => row.key === KEY)).toBe(false);
  expect(new ConfigManager(options).getSchema().some(row => row.key === KEY)).toBe(false);
  expect(existsSync(config.getConfigPath())).toBe(false);
  expect(modal.getSelected()?.setting.key).toBe(KEY);
  expect(modal.getSelected()?.currentValue).toBe(true);
  expect(modal.getSelected()?.effectiveSource).toBe('default');
  expect(() => config.setDynamic(KEY, 'false')).toThrow('literal boolean');
});

for (const width of [80, 120]) test(`actual settings renderer exposes host privacy and provenance at ${width} columns`, () => {
  const { modal } = fixture();
  const lines = frameFromLayer(renderSettingsModal(modal, width, 24), width, 24);
  const text = frameText(lines).join('\n');
  expect(text).toContain(KEY);
  expect(text).toContain('source default');
  expect(text).not.toContain('undefined');
  expect(lines).toHaveLength(24);
  for (const line of lines) expect(line).toHaveLength(width);
});

test('ordinary modal activation persists literal opt-in and repeated activation revokes it', () => {
  const { config, modal, open } = fixture();
  modal.activateSelected();
  expect(config.get(KEY)).toBe(false);
  expect(modal.getSelected()?.effectiveSource).toBe('local');
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
  modal.close(); open();
  expect(modal.getSelected()?.currentValue).toBe(false);
  expect(modal.getSelected()?.isDefault).toBe(false);
  modal.activateSelected();
  expect(config.get(KEY)).toBe(true);
});

test('managed host lock remains visible and prevents the ordinary modal toggle', () => {
  const { config, modal, options, open } = fixture();
  setManagedSettingLock(KEY, 'synthetic-policy', 'Restrict synthetic notifications', options.configDir);
  open();
  expect(modal.getSelected()?.locked).toBe(true);
  expect(modal.getSelected()?.lockReason).toContain('Restrict synthetic notifications');
  modal.activateSelected();
  expect(config.get(KEY)).toBe(true);
});

for (const replacement of ['deleted', 'invalid-json', 'malformed-leaf']) test(`actual delivery rereads host privacy after ${replacement} reload`, async () => {
  const { config, modal, open } = fixture();
  const url = 'https://example.com/tui-host-setting-fixture';
  const sent: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) !== url || init?.method !== 'POST') throw new Error('Unexpected synthetic notification request');
    sent.push(String(init.body)); return new Response('ok');
  }, { preconnect() {} }));
  try {
    const notifier = new WebhookNotifier([url], { force: true, metadataOnly: () => config.get(KEY) });
    const send = () => notifier.sendNotification({ kind: 'turn', facts: { outcome: 'completed', subject: 'turn', elapsedMs: 1000, name: 'synthetic-private-host-notice' } });
    await send(); expect(sent.at(-1)).not.toContain('synthetic-private-host-notice');
    modal.activateSelected(); await send(); expect(sent.at(-1)).toContain('synthetic-private-host-notice');
    if (replacement === 'deleted') rmSync(config.getConfigPath());
    else writeFileSync(config.getConfigPath(), replacement === 'invalid-json' ? '{' : JSON.stringify({ behavior: { notificationsMetadataOnly: 'false' } }));
    if (replacement === 'invalid-json') expect(() => config.load()).toThrow();
    else config.load();
    await send(); expect(sent.at(-1)).not.toContain('synthetic-private-host-notice');
    expect(sent).toHaveLength(3);
    open(); expect(modal.getSelected()?.currentValue).toBe(true);
  } finally { fetchSpy.mockRestore(); }
});

test('modal honors explicit project ownership and reset without altering global opt-in', () => {
  const { config, modal, open } = fixture();
  config.set(KEY, false);
  config.setProjectValue(KEY, true);
  open();
  // The public control-plane source classifies values equal to the default as default.
  // Destination ownership is verified from both stored files below.
  expect(modal.getSelected()?.effectiveSource).toBe('default');
  modal.activateSelected();
  expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
  modal.resetSelected();
  expect(config.get(KEY)).toBe(true);
  expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.notificationsMetadataOnly).toBe(true);
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
});

test('an open settings row follows external revocation and close removes its listener', () => {
  const { config, modal, open } = fixture();
  modal.activateSelected();
  expect(modal.getSelected()?.currentValue).toBe(false);
  rmSync(config.getConfigPath()); config.load();
  expect(modal.getSelected()?.currentValue).toBe(true);
  expect(modal.getSelected()?.effectiveSource).toBe('default');
  modal.activateSelected();
  expect(config.get(KEY)).toBe(false);
  modal.close();
  config.set(KEY, true);
  expect(modal.groups.get('behavior')?.find(row => row.setting.key === KEY)?.currentValue).toBe(false);
  open(); expect(modal.getSelected()?.currentValue).toBe(true);
  modal.close();
});

test('a newly imposed managed lock refuses the save and refreshes the host row', () => {
  const { config, modal, options } = fixture();
  setManagedSettingLock(KEY, 'synthetic-policy', 'Policy arrived while settings were open', options.configDir);
  modal.activateSelected();
  expect(modal.lastSettingEffectMessage).toContain('Save failed');
  expect(config.get(KEY)).toBe(true);
  expect(modal.getSelected()?.currentValue).toBe(true);
  expect(modal.getSelected()?.locked).toBe(true);
  expect(modal.getSelected()?.lockReason).toContain('Policy arrived while settings were open');
  expect(existsSync(config.getConfigPath())).toBe(false);
  modal.close();
});

 test('privacy documentation distinguishes the restrictive default from explicit details consent', () => {
  const { modal } = fixture();
  const docs = settingContextLines(modal).join('\n');
  expect(docs).toContain('true: Keep notifications metadata-only (restrictive default).');
  expect(docs).toContain('false: Explicitly permit notification details on supported paths.');
  expect(docs).not.toContain('false: disabled or not allowed');
  modal.close();
});
