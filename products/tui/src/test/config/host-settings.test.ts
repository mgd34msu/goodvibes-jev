import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG_SCHEMA, ConfigManager, SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { WebhookNotifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { defaultStore } from '@goodvibes-jev/engine/sdk/platform/runtime/settings';
import { TuiConfigManager, TUI_NOTIFICATIONS_METADATA_ONLY_KEY as KEY } from '../../config/host-settings.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import { handleSettingsModalToken } from '../../input/handler-modal-routes.ts';
import { applyHostSettingValue } from '../../input/settings-modal-mutations.ts';
import { refreshEntryValues, updateEntryForKey } from '../../input/settings-modal-data.ts';
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
  const handle = config.getHostBooleanSetting(KEY);
  let renders = 0;
  const modal = new SettingsModal();
  const open = () => {
    modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) }, undefined, undefined, { requestRender: () => { renders++; } });
    modal.selectTarget(KEY);
  };
  open();
  return { root, options, config, handle, modal, open, renders: () => renders };
}

/** Documented isolated v2 policy fixture: runtime host-lock authoring is not a public API. */
function seedManagedLock(configDir: string, reason: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'settings-sync.json'), JSON.stringify({
    ...defaultStore(), managedLocks: [{ key: KEY, source: 'synthetic-policy', reason, updatedAt: 12 }],
  }));
}

test('host registration is isolated and does not write startup consent', () => {
  const { config, options, modal } = fixture();
  expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
  expect(config.getSchema().some(row => String(row.key) === KEY)).toBe(false);
  expect(config.getHostSettingsSchema().filter(row => row.key === KEY)).toHaveLength(1);
  expect(CONFIG_SCHEMA.some(row => String(row.key) === KEY)).toBe(false);
  expect(new ConfigManager(options).getSchema().some(row => String(row.key) === KEY)).toBe(false);
  expect(existsSync(config.getConfigPath())).toBe(false);
  expect(modal.getSelected()?.setting.key).toBe(KEY);
  expect(modal.getSelected()?.currentValue).toBe(true);
  expect(modal.getSelected()?.effectiveSource).toBe('default');
  expect(() => Reflect.apply(config.getHostBooleanSetting(KEY).set, null, ['false'])).toThrow('literal boolean');
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
  expect(config.getHostBooleanSetting(KEY).get()).toBe(false);
  expect(modal.getSelected()?.effectiveSource).toBe('local');
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
  modal.close(); open();
  expect(modal.getSelected()?.currentValue).toBe(false);
  expect(modal.getSelected()?.isDefault).toBe(false);
  modal.activateSelected();
  expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
});

test('managed host lock remains visible and prevents the ordinary modal toggle', () => {
  const { config, modal, options, open } = fixture();
  seedManagedLock(options.configDir, 'Restrict synthetic notifications');
  open();
  expect(modal.getSelected()?.locked).toBe(true);
  expect(modal.getSelected()?.lockReason).toContain('Restrict synthetic notifications');
  modal.activateSelected();
  expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
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
    const notifier = new WebhookNotifier([url], { force: true, metadataOnly: () => config.getHostBooleanSetting(KEY).get() });
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
  config.getHostBooleanSetting(KEY).set( false);
  config.getHostBooleanSetting(KEY).setProjectValue( true);
  open();
  // The public control-plane source classifies values equal to the default as default.
  // Destination ownership is verified from both stored files below.
  expect(modal.getSelected()?.effectiveSource).toBe('default');
  modal.activateSelected();
  expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
  modal.resetSelected();
  expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
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
  expect(config.getHostBooleanSetting(KEY).get()).toBe(false);
  modal.close();
  config.getHostBooleanSetting(KEY).set( true);
  expect(modal.groups.get('behavior')?.find(row => row.setting.key === KEY)?.currentValue).toBe(false);
  open(); expect(modal.getSelected()?.currentValue).toBe(true);
  modal.close();
});

test('a newly imposed managed lock refuses the save and refreshes the host row', () => {
  const { config, modal, options } = fixture();
  seedManagedLock(options.configDir, 'Policy arrived while settings were open');
  modal.activateSelected();
  expect(modal.lastSettingEffectMessage).toContain('Save failed');
  expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
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

function captureFrame(modal: SettingsModal, name: string, width: number): string {
  const lines = frameFromLayer(renderSettingsModal(modal, width, 28), width, 28);
  const text = frameText(lines).join('\n');
  expect(lines).toHaveLength(28);
  for (const line of lines) expect(line).toHaveLength(width);
  expect(text).not.toContain('undefined');
  const outputDir = process.env.GOODVIBES_TEST_TUI_HOST_FRAMES_DIR;
  if (outputDir) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, `${name}-${width}.txt`), `${text}\n`);
  }
  return text;
}

for (const mode of ['malformed', 'unreadable'] as const) test(`host metadata stays honestly unavailable for ${mode} policy through open, action, and reopen`, () => {
  const { config, handle, modal, options, open } = fixture();
  handle.set(false);
  const policyPath = join(options.configDir, 'settings-sync.json');
  const raw = mode === 'malformed' ? '{synthetic-private-policy-content' : JSON.stringify(defaultStore());
  writeFileSync(policyPath, raw);
  if (mode === 'unreadable') chmodSync(policyPath, 0);
  const settingsBefore = readFileSync(config.getConfigPath(), 'utf8');
  const namesBefore = readdirSync(options.configDir).sort();
  try {
    open();
    expect(modal.getSelected()?.metadataUnavailable).toContain('Editing is disabled');
    expect(modal.getSelected()?.locked).toBeUndefined();
    expect(modal.getSelected()?.effectiveSource).toBeUndefined();
    expect(settingContextLines(modal).join('\n')).toContain('Source: unavailable');
    expect(settingContextLines(modal).join('\n')).not.toContain('synthetic-private-policy-content');
    for (const width of [80, 120]) expect(captureFrame(modal, `unavailable-${mode}`, width)).toContain('unavailable');
    // Merely inspecting settings must not trigger legacy quarantine and make a
    // subsequent host metadata lookup silently claim the policy is missing.
    expect(existsSync(policyPath)).toBe(true);
    expect(readdirSync(options.configDir).sort()).toEqual(namesBefore);
    for (const action of [() => modal.activateSelected(), () => modal.adjustSelected('right'), () => modal.resetSelected()]) {
      action();
      expect(modal.lastSettingEffectMessage).toContain('Save failed');
      expect(handle.get()).toBe(false);
      expect(readFileSync(config.getConfigPath(), 'utf8')).toBe(settingsBefore);
      expect(modal.getSelected()?.metadataUnavailable).toBeDefined();
    }
    modal.close(); open();
    expect(modal.getSelected()?.metadataUnavailable).toBeDefined();
  } finally {
    if (existsSync(policyPath)) chmodSync(policyPath, 0o600);
  }
  expect(readFileSync(policyPath, 'utf8')).toBe(raw);
  expect(readdirSync(options.configDir).sort()).toEqual(namesBefore);
  writeFileSync(policyPath, JSON.stringify(defaultStore()));
  refreshEntryValues(modal.groups, config);
  expect(modal.getSelected()?.metadataUnavailable).toBeUndefined();
  expect(modal.getSelected()?.locked).toBe(false);
  modal.adjustSelected('right');
  expect(handle.get()).toBe(true);
  modal.close();
});

test('metadata failure while open clears stale unlocked provenance without writing', () => {
  const { config, handle, modal, options } = fixture();
  handle.set(false);
  expect(modal.getSelected()?.locked).toBe(false);
  writeFileSync(join(options.configDir, 'settings-sync.json'), '{broken-policy');
  modal.activateSelected();
  expect(handle.get()).toBe(false);
  expect(modal.getSelected()?.locked).toBeUndefined();
  expect(modal.getSelected()?.effectiveSource).toBeUndefined();
  expect(modal.getSelected()?.metadataUnavailable).toBeDefined();
  expect(modal.lastSettingEffectMessage).toContain('metadata is unavailable');
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
  modal.close();
});

for (const action of ['selected', 'category', 'all'] as const) test(`${action} reset uses scoped host set(default) and retains global opt-in`, () => {
  const { config, handle, modal, open, options } = fixture();
  handle.set(false);
  handle.setProjectValue(false);
  open();
  const entry = modal.getSelected()!;
  // Exercise the actual modal reset controls with an isolated selected group;
  // builtin/category reset coverage remains in settings-modal-reset.test.ts.
  modal.groups = new Map([['behavior', [entry]]]);
  try {
    if (action === 'selected') modal.resetSelected();
    else if (action === 'category') {
      modal.initiateResetCategory();
      expect(modal.handleResetConfirmKey('y')).toMatchObject({ result: 'confirmed' });
    } else {
      modal.initiateResetAll();
      expect(modal.handleResetConfirmKey('enter')).toMatchObject({ result: 'confirmed' });
    }
    expect(handle.get()).toBe(true);
    expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
    expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.notificationsMetadataOnly).toBe(true);
    expect(new TuiConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(true);
  } finally { modal.close(); }
});

test('host row refresh, search and directional controls use the validated public host handle', () => {
  const { config, handle, modal } = fixture();
  const acquireHandle = config.getHostBooleanSetting.bind(config);
  const operations: string[] = [];
  const handleSpy = spyOn(config, 'getHostBooleanSetting').mockImplementation(key => {
    const actual = acquireHandle(key);
    return {
      ...actual,
      get: () => { operations.push('get'); return actual.get(); },
      getResolved: () => { operations.push('getResolved'); return actual.getResolved(); },
      set: (value, options) => { operations.push(`set:${value}`); actual.set(value, options); },
    };
  });
  try {
    modal.setSearchQuery('notificationsMetadataOnly');
    expect(modal.getSelected()?.kind).toBe('host');
    modal.adjustSelected('left');
    expect(handle.get()).toBe(false);
    refreshEntryValues(modal.groups, config);
    updateEntryForKey(modal.groups, KEY, config);
    expect(modal.getSelected()?.currentValue).toBe(false);
    modal.adjustSelected('right');
    expect(handle.get()).toBe(true);
    modal.editingMode = true; modal.editBuffer = 'false';
    expect(modal.commitEdit()).toBe(false);
    expect(handle.get()).toBe(true);
    expect(operations).toContain('get');
    expect(operations).toContain('getResolved');
    expect(operations.filter(operation => operation.startsWith('set:'))).toEqual(['set:false', 'set:true']);
  } finally { handleSpy.mockRestore(); modal.close(); }
});

test('host mutation refuses non-booleans without coercion or persistence', () => {
  const { config, handle, modal } = fixture();
  for (const value of ['false', 'true', 0, 1, null, undefined, {}]) {
    const result = applyHostSettingValue({ key: KEY, value, configManager: config, groups: modal.groups, onSettingApplied: null });
    expect(result.changed).toBe(false);
    expect(result.effectMessage).toContain('literal boolean');
    expect(handle.get()).toBe(true);
    expect(existsSync(config.getConfigPath())).toBe(false);
  }
  modal.close();
});

test('open, reopen, close and manager replacement each own exactly their host subscription', () => {
  const one = fixture();
  const two = fixture();
  one.open(); one.open();
  const before = one.renders();
  one.handle.set(false);
  expect(one.renders()).toBe(before + 1);
  one.modal.close();
  one.handle.set(true);
  expect(one.renders()).toBe(before + 1);
  one.open();
  one.handle.set(false);
  expect(one.renders()).toBe(before + 2);
  let replacementRenders = 0;
  one.modal.open(two.config, createFeatureFlagManager(), new SubscriptionManager(join(two.root, 'replacement-subscriptions.json')), { getAll: () => ({}) }, undefined, undefined, { requestRender: () => { replacementRenders++; } });
  one.modal.selectTarget(KEY);
  one.handle.set(true);
  expect(replacementRenders).toBe(0);
  two.handle.set(false);
  expect(replacementRenders).toBe(1);
  expect(one.modal.getSelected()?.currentValue).toBe(false);
  one.modal.close(); two.modal.close();
  two.handle.set(true);
  expect(replacementRenders).toBe(1);
});

test('a bare SDK manager neither exposes a host row nor acquires a host handle', () => {
  const { options, modal, root } = fixture();
  const bare = new ConfigManager(options);
  const handleSpy = spyOn(bare, 'getHostBooleanSetting');
  try {
    modal.open(bare, createFeatureFlagManager(), new SubscriptionManager(join(root, 'bare-subscriptions.json')), { getAll: () => ({}) });
    expect([...modal.groups.values()].flat().some(entry => entry.kind === 'host')).toBe(false);
    expect(handleSpy).not.toHaveBeenCalled();
  } finally { handleSpy.mockRestore(); modal.close(); }
});

for (const state of ['default', 'local', 'locked'] as const) test(`host ${state} state renders bounded truthful frames at 80 and 120 columns`, () => {
  const { handle, modal, options, open } = fixture();
  if (state === 'local') handle.set(false);
  if (state === 'locked') { seedManagedLock(options.configDir, 'Restrictive test policy'); open(); }
  for (const width of [80, 120]) {
    const frame = captureFrame(modal, state, width);
    expect(frame).toContain(KEY);
    expect(frame).toContain(`source ${state === 'local' ? 'local' : 'default'}`);
    if (state === 'locked') expect(frame).toContain('locked');
  }
  modal.close();
});

for (const mode of ['malformed', 'unreadable'] as const) test(`builtin rows remain readable but disabled while shared policy is ${mode}`, () => {
  const { config, handle, modal, options, open } = fixture();
  handle.set(false);
  const policyPath = join(options.configDir, 'settings-sync.json');
  const raw = mode === 'malformed' ? '{broken-policy' : JSON.stringify(defaultStore());
  writeFileSync(policyPath, raw);
  if (mode === 'unreadable') chmodSync(policyPath, 0);
  const namesBefore = readdirSync(options.configDir).sort();
  const settingsBefore = readFileSync(config.getConfigPath(), 'utf8');
  try {
    open();
    modal.selectTarget('display.stream');
    const entry = modal.getSelected()!;
    expect(entry.setting.key).toBe('display.stream');
    expect(entry.kind).not.toBe('host');
    expect(entry.currentValue).toBe(config.get('display.stream'));
    expect(entry.metadataUnavailable).toContain('Editing is disabled');
    expect(entry.locked).toBeUndefined();
    expect(entry.effectiveSource).toBeUndefined();
    expect(settingContextLines(modal).join('\n')).toContain('Source: unavailable');
    for (const width of [80, 120]) expect(captureFrame(modal, `builtin-unavailable-${mode}`, width)).toContain('unavailable');
    modal.activateSelected(); modal.adjustSelected('left'); modal.resetSelected();
    modal.editingMode = true; modal.editBuffer = 'false';
    expect(modal.commitEdit()).toBe(false);
    modal.cancelEdit();
    modal.groups = new Map([['display', [entry]]]);
    modal.initiateResetCategory(); modal.handleResetConfirmKey('y');
    modal.initiateResetAll(); modal.handleResetConfirmKey('enter');
    expect(readFileSync(config.getConfigPath(), 'utf8')).toBe(settingsBefore);
    expect(readdirSync(options.configDir).sort()).toEqual(namesBefore);
  } finally {
    if (existsSync(policyPath)) chmodSync(policyPath, 0o600);
  }
  expect(readFileSync(policyPath, 'utf8')).toBe(raw);
  writeFileSync(policyPath, JSON.stringify(defaultStore()));
  open(); modal.selectTarget('display.stream');
  expect(modal.getSelected()?.metadataUnavailable).toBeUndefined();
  const previous = config.get('display.stream');
  modal.activateSelected();
  expect(config.get('display.stream')).toBe(!previous);
  modal.close();
});

test('builtin Enter preflights newly malformed policy and recovers after policy repair', () => {
  const { config, handle, modal, options } = fixture();
  handle.set(false);
  modal.selectTarget('display.stream');
  expect(modal.getSelected()?.metadataUnavailable).toBeUndefined();
  const previous = config.get('display.stream');
  const settingsBefore = readFileSync(config.getConfigPath(), 'utf8');
  const policyPath = join(options.configDir, 'settings-sync.json');
  writeFileSync(policyPath, '{malformed-after-open');
  const namesBefore = readdirSync(options.configDir).sort();
  modal.activateSelected();
  expect(modal.getSelected()?.metadataUnavailable).toContain('Editing is disabled');
  expect(modal.getSelected()?.locked).toBeUndefined();
  expect(modal.getSelected()?.effectiveSource).toBeUndefined();
  expect(config.get('display.stream')).toBe(previous);
  expect(readFileSync(config.getConfigPath(), 'utf8')).toBe(settingsBefore);
  expect(readFileSync(policyPath, 'utf8')).toBe('{malformed-after-open');
  expect(readdirSync(options.configDir).sort()).toEqual(namesBefore);
  writeFileSync(policyPath, JSON.stringify(defaultStore()));
  modal.activateSelected();
  expect(modal.getSelected()?.metadataUnavailable).toBeUndefined();
  expect(config.get('display.stream')).toBe(!previous);
  modal.close();
});


test('real settings key route toggles, scoped Ctrl+R resets, and Escape closes the host row', () => {
  const { config, handle, modal, open } = fixture();
  handle.set(false); handle.setProjectValue(true); open();
  let renders = 0;
  const state = { settingsModal: modal, requestRender: () => { renders++; }, handleEscape: () => modal.close() };
  const key = (name: string, ctrl = false) => handleSettingsModalToken(state, { type: 'key', name, logicalName: name, ctrl, shift: false, meta: false });
  key('enter');
  expect(handle.get()).toBe(false);
  key('r', true);
  expect(handle.get()).toBe(true);
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
  expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.notificationsMetadataOnly).toBe(true);
  key('escape');
  expect(modal.active).toBe(false);
  expect(renders).toBeGreaterThan(0);
  open();
  expect(modal.getSelected()?.currentValue).toBe(true);
  modal.close();
});
