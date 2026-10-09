import { installAgentDaemonCredentialsClient } from '../../config/daemon-credential-routing.ts';
import { installAgentDaemonConfigClient } from '../../config/daemon-config-routing.ts';
/**
 * Tests for SettingsModal state class.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isAgentHiddenSettingKey, SettingsModal, SETTINGS_CATEGORIES, SETTINGS_CATEGORY_GROUPS } from '../../input/settings-modal.ts';
import { CROSS_LISTED_SETTING_ROOTS } from '../../input/settings-modal-types.ts';
import { ConfigManager, type ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { modelPickerLaunchForKey } from '../../input/settings-modal-behavior.ts';
import { isSecretConfigKey } from '../../config/secret-config.ts';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef } from '../../config/secret-config.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Move the modal onto the first plain string setting: one edited inline (not
 * a secret, not handed to a model/TTS/timezone/theme picker), unvalidated,
 * with a non-empty current value. Returns false when none exists.
 * (display.theme used to serve here; it is now an enum opening the theme picker.)
 */
function selectPlainStringSetting(modal: SettingsModal): boolean {
  const plain = (key: string, type: string): boolean =>
    type === 'string' && !isSecretConfigKey(key) && !key.startsWith('tts.') && key !== 'daemon.timezone'
    && key !== 'display.theme' && modelPickerLaunchForKey(key) === null;
  for (let pass = 0; pass < SETTINGS_CATEGORIES.length; pass++) {
    const index = modal.currentItems.findIndex((entry) =>
      plain(String(entry.setting.key), entry.setting.type)
      && typeof entry.currentValue === 'string' && entry.currentValue.length > 0
      && entry.setting.validate === undefined);
    if (index >= 0) {
      modal.selectedIndex = index;
      return true;
    }
    modal.nextCategory();
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = makeProjectTempDir(`gv-settings-modal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({ surfaceRoot: 'tui',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-tui'),
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SettingsModal', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let ffm: FeatureFlagManager;
  let modal: SettingsModal;
  let mcpRegistry: McpRegistry;
  let subscriptionManager: SubscriptionManager;
  let serviceRegistry: ServiceRegistry;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = createConfigManager(tmpDir);
    ffm = createFeatureFlagManager();
    modal = new SettingsModal();
    subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
    serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm }),
      subscriptionManager,
    });
    mcpRegistry = {
      listServerSecurity: () => [
        {
          name: 'docs-server',
          connected: true,
          role: 'docs',
          trustMode: 'ask-on-risk',
          allowedPaths: ['/workspace/docs'],
          allowedHosts: [],
          schemaFreshness: 'fresh',
        },
      ],
      setServerTrustMode: () => {},
    } as unknown as McpRegistry;
    mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('starts inactive', () => {
    expect(modal.active).toBe(false);
  });

  test('open() activates modal and loads config groups', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    expect(modal.active).toBe(true);
    expect(modal.categoryIndex).toBe(0);
    expect(modal.selectedIndex).toBe(0);
    expect(modal.focusPane).toBe('categories');
    expect(modal.editingMode).toBe(false);
  });

  test('category rail is grouped into a complete non-duplicated navigation order', () => {
    const grouped = SETTINGS_CATEGORY_GROUPS.flatMap(group => group.categories);
    expect(grouped).toEqual(SETTINGS_CATEGORIES);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(SETTINGS_CATEGORY_GROUPS.map(group => group.label)).toEqual([
      'Agent Experience',
      'Models and Providers',
      'Agent-local state',
      'Channels and Tools',
      'Daemon Runtime',
      'Advanced Runtime',
      'Advanced',
    ]);
  });

  test('open() populates all categories', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const specialCategories = new Set(['flags', 'mcp', 'subscriptions']);
    for (const cat of SETTINGS_CATEGORIES) {
      if (cat === 'flags') {
        expect(modal.flagEntries.length).toBeGreaterThan(0);
        continue;
      }
      if (cat === 'mcp') {
        expect(modal.mcpEntries).toEqual([expect.objectContaining({
          name: 'docs-server',
          connected: true,
          trustMode: 'ask-on-risk',
        })]);
        continue;
      }
      if (cat === 'subscriptions') {
        expect(modal.subscriptionEntries.map((entry) => entry.provider)).toContain('openai');
        continue;
      }
      const expectedKeys: string[] = CONFIG_SCHEMA
        .filter((entry) => !isAgentHiddenSettingKey(entry.key))
        .filter((entry) => entry.key.split('.')[0] === cat)
        .map((entry) => entry.key);
      // payments additionally carries the four synthetic card-material entries.
      // CONFIG_SCHEMA declares none of them on purpose, card material lives
      // write-only in the daemon secret store and config holds only a
      // goodvibes:// reference, so they are injected by the modal from
      // input/payments-config.ts, the only synthetic-entry pattern left in
      // this modal now that display.themeMode is a real CONFIG_SCHEMA key.
      if (cat === 'payments') {
        expectedKeys.push('payments.cardNumber', 'payments.cardExpiry', 'payments.cardCvv', 'payments.cardholderName');
      }
      // A root with no category of its own is listed under the category named
      // in CROSS_LISTED_SETTING_ROOTS rather than being dropped, so that
      // category carries those keys too.
      for (const [root, target] of Object.entries(CROSS_LISTED_SETTING_ROOTS)) {
        if (target !== cat) continue;
        expectedKeys.push(
          ...CONFIG_SCHEMA
            .filter((entry) => !isAgentHiddenSettingKey(entry.key))
            .filter((entry) => entry.key.split('.')[0] === root)
            .map((entry) => entry.key),
        );
      }
      expect(specialCategories.has(cat)).toBe(false);
      expect([...(modal.groups.get(cat)?.map((entry) => String(entry.setting.key)) ?? [])].sort()).toEqual([...expectedKeys].sort());
    }
  });

  test('open() routes every shared config schema key into the workspace', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const visibleKeys = new Set<string>();
    for (const entries of modal.groups.values()) {
      for (const entry of entries) visibleKeys.add(entry.setting.key);
    }
    const missing = CONFIG_SCHEMA.map((entry) => entry.key).filter((key) => !isAgentHiddenSettingKey(key) && !visibleKeys.has(key));
    expect(missing).toEqual([]);
  });

  test('open() routes daemon/runtime settings and shows the danger toggle, hiding only internal plumbing', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const visibleKeys = new Set<string>();
    for (const entries of modal.groups.values()) {
      for (const entry of entries) visibleKeys.add(entry.setting.key);
    }

    for (const key of [
      'danger.httpListener',
      'controlPlane.hostMode',
      'httpListener.hostMode',
      'web.hostMode',
      'service.autostart',
      'runtime.eventBus.maxListeners',
      'network.remoteFetch.allowPrivateHosts',
      'orchestration.recursionEnabled',
      'contract.gateTimeoutMs',
    ]) {
      expect(isAgentHiddenSettingKey(key)).toBe(false);
      expect(visibleKeys.has(key)).toBe(true);
    }
    // Only internal plumbing stays hidden. Hazardous-but-real settings are shown
    // and gated at write time instead, so the owner can see and confirm them.
    for (const key of [
      'ui.wrfcMessages',
    ]) {
      expect(isAgentHiddenSettingKey(key)).toBe(true);
      expect(visibleKeys.has(key)).toBe(false);
    }
  });

  test('relay.* settings are visible AND writable, because they route to their owner', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const relayEntries = modal.groups.get('relay') ?? [];
    const relayKeys = relayEntries.map((entry) => entry.setting.key);
    expect(relayKeys).toContain('relay.enabled');
    expect(relayKeys).toContain('relay.url');
    expect(relayKeys).toContain('relay.requireStepUpForMutations');
    // These used to be locked, on the correct-at-the-time grounds that Agent's
    // copy was an imported snapshot, so toggling relay.enabled here would not
    // start or stop the connected daemon's relay registration. relay.* is now
    // daemon-owned and Agent routes the write to the daemon that acts on it, so
    // the refusal protects against a problem that no longer exists, it only
    // blocks configuring the platform from the surface in front of you.
    for (const entry of relayEntries) {
      expect(entry.locked, `${entry.setting.key} should be writable (it routes to the daemon)`).toBe(false);
    }
  });

  test('danger.* is shown rather than hidden, so the owner can see what is on', () => {
    // It used to be hidden by the `danger.` prefix in AGENT_HIDDEN_SETTING_PREFIXES,
    // which is worse than locking it: a hidden key has nothing to look at, nothing
    // to confirm, and no way to state why it refused. Being visible is what makes
    // the confirmation gate meaningful.
    expect(isAgentHiddenSettingKey('danger.httpListener')).toBe(false);

    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const dangerEntries = modal.groups.get('danger') ?? [];
    const dangerKeys = dangerEntries.map((entry) => entry.setting.key);
    expect(dangerKeys).toContain('danger.httpListener');

    // Visible AND writable. The hazard is handled by the narrow confirmation
    // list, not by a second block here, one hazard, one gate.
    for (const entry of dangerEntries) {
      expect(entry.locked, `${entry.setting.key} should not be blanket-locked`).toBe(false);
    }
  });

  test('every danger.* key in the schema reaches a rendered category', () => {
    // Guards the drop this change had to fix: the modal buckets entries by the
    // key's first segment and silently discards any whose category is not
    // registered, so un-hiding a prefix does nothing on its own.
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const rendered = new Set<string>();
    for (const entries of modal.groups.values()) {
      for (const entry of entries) rendered.add(entry.setting.key);
    }
    const schemaDangerKeys = CONFIG_SCHEMA
      .map((setting) => setting.key)
      .filter((key) => key.startsWith('danger.'));

    expect(schemaDangerKeys.length).toBeGreaterThan(0);
    for (const key of schemaDangerKeys) {
      expect(rendered.has(key), `${key} is in the schema but never rendered`).toBe(true);
    }
  });

  test('behavior.compactionStrategy / telemetry.decisionOtlp* / sandbox.judgment surface with honest, non-empty descriptions', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const byKey = new Map<string, string>();
    for (const entries of modal.groups.values()) {
      for (const entry of entries) byKey.set(entry.setting.key, entry.setting.description);
    }
    for (const key of [
      'behavior.compactionStrategy',
      'telemetry.decisionOtlpEnabled',
      'telemetry.decisionOtlpEndpoint',
      'telemetry.decisionOtlpSignal',
      'sandbox.judgment',
    ]) {
      const description = byKey.get(key);
      expect(description, `${key} should have a settings entry`).toBeTruthy();
      expect(description!.length).toBeGreaterThan(10);
    }
  });

  test('currentCategory returns correct category', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    expect(modal.currentCategory).toBe(SETTINGS_CATEGORIES[0]);
  });

  test('nextCategory cycles through categories', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const initial = modal.categoryIndex;
    modal.nextCategory();
    expect(modal.categoryIndex).toBe((initial + 1) % SETTINGS_CATEGORIES.length);
  });

  test('prevCategory cycles backwards', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.prevCategory();
    expect(modal.categoryIndex).toBe(SETTINGS_CATEGORIES.length - 1);
  });

  test('nextCategory resets selectedIndex to 0', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.moveDown();
    modal.moveDown();
    modal.nextCategory();
    expect(modal.selectedIndex).toBe(0);
  });

  test('moveDown increments selectedIndex', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const before = modal.selectedIndex;
    modal.moveDown();
    expect(modal.selectedIndex).toBe(before + 1);
  });

  test('moveUp wraps around to last item', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.moveUp();
    const len = modal.currentItems.length;
    expect(modal.selectedIndex).toBe(len - 1);
  });

  test('getSelected returns the selected SettingEntry', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const entry = modal.getSelected();
    expect(entry).toEqual(expect.objectContaining({
      currentValue: expect.anything(),
      setting: expect.objectContaining({
        key: expect.any(String),
        description: expect.any(String),
        type: expect.any(String),
      }),
    }));
    expect(entry?.setting.key.length).toBeGreaterThan(0);
  });

  test('activateSelected toggles boolean setting', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    const items = modal.currentItems;
    const boolIdx = items.findIndex((entry) => entry.setting.key === 'display.stream');
    expect(boolIdx).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < boolIdx; i++) modal.moveDown();

    const before = modal.getSelected()!.currentValue as boolean;
    modal.activateSelected();
    const afterEntry = modal.getSelected();
    const after = afterEntry?.currentValue as boolean;
    expect(cm.get('display.stream')).toBe(!before);
    expect(after).toBe(!before);
  });

  test('activateSelected enters editingMode for string setting', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    // Navigate to a plain (inline-edited) string setting
    expect(selectPlainStringSetting(modal)).toBe(true);

    const selected = modal.getSelected();
    expect(selected).toEqual(expect.objectContaining({
      currentValue: expect.any(String),
      setting: expect.objectContaining({ type: 'string' }),
    }));
    modal.activateSelected();
    expect(modal.editingMode).toBe(true);
    expect(modal.editBuffer).toBe(String(selected?.currentValue));
    expect(modal.editBuffer.length).toBeGreaterThan(0);
  });

  test('activateSelected delegates TTS LLM settings to the targeted provider-model picker flow', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.categoryIndex = SETTINGS_CATEGORIES.indexOf('display');
    modal.groups.set('display', [
      {
        setting: { key: 'tts.llmProvider', type: 'string', label: 'TTS LLM provider', description: '' } as never,
        currentValue: '',
        isDefault: true,
      },
      {
        setting: { key: 'tts.llmModel', type: 'string', label: 'TTS LLM model', description: '' } as never,
        currentValue: '',
        isDefault: true,
      },
    ]);

    modal.selectedIndex = 0;
    modal.activateSelected();
    expect(modal.pendingProviderModelPickerTarget).toBe('tts');
    expect(modal.pendingModelPickerTarget).toBeNull();

    modal.pendingProviderModelPickerTarget = null;
    modal.selectedIndex = 1;
    modal.activateSelected();
    expect(modal.pendingModelPickerTarget).toBe('tts');
    expect(modal.pendingProviderModelPickerTarget).toBeNull();
  });

  test('editChar appends to editBuffer', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    expect(selectPlainStringSetting(modal)).toBe(true);
    modal.activateSelected();
    const before = modal.editBuffer;
    modal.editChar('x');
    expect(modal.editBuffer).toBe(before + 'x');
  });

  test('editBackspace removes last char', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    expect(selectPlainStringSetting(modal)).toBe(true);
    modal.activateSelected();
    modal.editBuffer = 'hello';
    modal.editBackspace();
    expect(modal.editBuffer).toBe('hell');
  });

  test('cancelEdit exits editingMode without saving', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    expect(selectPlainStringSetting(modal)).toBe(true);
    const entry = modal.getSelected()!;
    const originalValue = entry.currentValue;
    modal.activateSelected();
    modal.editBuffer = 'something-new';
    modal.cancelEdit();
    expect(modal.editingMode).toBe(false);
    // Value should not have changed
    expect(String(cm.get(entry.setting.key as ConfigKey))).toBe(String(originalValue));
  });

  test('commitEdit saves string value', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    expect(selectPlainStringSetting(modal)).toBe(true);
    modal.activateSelected();
    modal.editBuffer = `${modal.editBuffer}-edited`;
    const editResult = modal.commitEdit();
    expect(editResult).toBe(true);
    expect(modal.editingMode).toBe(false);
  });

  test('activateSelected delegates main provider/model settings to the shared picker flow', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'provider') modal.nextCategory();

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'provider.model');
    modal.activateSelected();
    expect(modal.pendingProviderModelPickerTarget).toBe('main');
    expect(modal.pendingModelPickerTarget).toBeNull();
  });

  test('activateSelected delegates TTS provider and voice settings to external pickers', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'tts') modal.nextCategory();

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'tts.provider');
    modal.activateSelected();
    expect(modal.pendingSettingsPickerAction).toBe('tts-provider');

    modal.pendingSettingsPickerAction = null;
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'tts.voice');
    modal.activateSelected();
    expect(modal.pendingSettingsPickerAction as 'tts-voice' | null).toBe('tts-voice');
  });

  test('resetSelected restores selected config value to its schema default', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'display') modal.nextCategory();

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'display.stream');
    cm.setDynamic('display.stream', false);
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'display.stream');

    const reset = modal.resetSelected();
    expect(reset).toEqual({ key: 'display.stream', value: true });
    expect(cm.get('display.stream')).toBe(true);
    expect(modal.getSelected()?.currentValue).toBe(true);
  });

  test('surfaces category exposes editable Agent-supported channel settings', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();

    const keys = modal.currentItems.map((entry) => entry.setting.key);
    expect(keys).toContain('surfaces.ntfy.enabled');
    expect(keys).toContain('surfaces.ntfy.baseUrl');
    expect(keys).toContain('surfaces.ntfy.topic');
    expect(keys).toContain('surfaces.ntfy.token');
    const copiedSurfacePrefix = ['surfaces.', 'home', 'assistant.'].join('');
    expect(keys.filter((key) => key.startsWith(copiedSurfacePrefix)).length).toBeGreaterThan(0);

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.ntfy.baseUrl');
    modal.activateSelected();
    expect(modal.editingMode).toBe(true);
    modal.editBuffer = 'https://ntfy.example.com';
    expect(modal.commitEdit()).toBe(true);
    expect(cm.get('surfaces.ntfy.baseUrl')).toBe('https://ntfy.example.com');
  });

  test('settings modal stores edited supported channel secrets through goodvibes secret refs', async () => {
    const secrets = new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm });
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets);
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();

    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.ntfy.token');
    modal.activateSelected();
    modal.editBuffer = 'ntfy-token';
    expect(modal.commitEdit()).toBe(true);

    expect(await modal.pendingSecretWrite).toBe(true);
    const secretKey = buildGoodVibesSecretKey('surfaces.ntfy.token');
    expect(cm.get('surfaces.ntfy.token')).toBe(buildGoodVibesSecretRef(secretKey));
    expect(await secrets.get(secretKey)).toBe('ntfy-token');
  });

  test('secret edits wait for storage, reject repeated commits, and publish only on completion', async () => {
    let finish!: () => void;
    const stored = new Promise<void>((resolve) => { finish = resolve; });
    let writes = 0;
    let deletes = 0;
    const secrets = { set: () => { writes++; return stored; }, delete: async () => { deletes++; } };
    const applied: unknown[] = [];
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets,
      { onSettingApplied: (change) => { applied.push(change); } });
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.ntfy.token');
    const previous = cm.get('surfaces.ntfy.token');
    modal.activateSelected();
    modal.editBuffer = 'deferred-token';
    expect(modal.commitEdit()).toBe(true);
    const completion = modal.pendingSecretWrite;
    expect(completion).not.toBeNull();
    expect(cm.get('surfaces.ntfy.token')).toBe(previous);
    expect(applied).toEqual([]);
    expect(modal.lastSettingEffectMessage).toBe('Saving credential…');
    expect(modal.commitEdit()).toBe(false);
    expect(writes).toBe(1);
    expect(modal.resetSelected()).toBeNull();
    expect(deletes).toBe(0);
    expect(cm.get('surfaces.ntfy.token')).toBe(previous);
    expect(modal.lastSettingEffectMessage).toBe('Saving credential…');

    finish();
    expect(await completion).toBe(true);
    expect(cm.get('surfaces.ntfy.token')).toBe(buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.ntfy.token')));
    expect(applied).toHaveLength(1);
    expect(modal.pendingSecretWrite).toBeNull();
    expect(modal.lastSettingEffectMessage).toBe('Credential saved.');
  });

  test('rejected secret storage preserves the reference and surfaces failure without a saved callback', async () => {
    let fail!: (error: Error) => void;
    const stored = new Promise<void>((_resolve, reject) => { fail = reject; });
    const secrets = { set: () => stored, delete: async () => {} };
    let applied = 0;
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets,
      { onSettingApplied: () => { applied++; } });
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.ntfy.token');
    const previous = cm.get('surfaces.ntfy.token');
    modal.activateSelected();
    modal.editBuffer = 'rejected-token';
    expect(modal.commitEdit()).toBe(true);
    const completion = modal.pendingSecretWrite;
    fail(new Error('storage unavailable'));
    expect(await completion).toBe(false);
    expect(cm.get('surfaces.ntfy.token')).toBe(previous);
    expect(applied).toBe(0);
    expect(modal.lastSettingEffectMessage).toMatch(/failed/i);
    expect(modal.pendingSecretWrite).toBeNull();
  });

  test('a secret completion after reopen stays with its original config and callback', async () => {
    let finish!: () => void;
    const stored = new Promise<void>((resolve) => { finish = resolve; });
    const secrets = { set: () => stored, delete: async () => {} };
    let originalApplied = 0;
    let replacementApplied = 0;
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets,
      { onSettingApplied: () => { originalApplied++; } });
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.ntfy.token');
    modal.activateSelected();
    modal.editBuffer = 'original-owner-token';
    expect(modal.commitEdit()).toBe(true);
    const completion = modal.pendingSecretWrite;
    modal.close();
    const replacementRoot = join(tmpDir, 'replacement-owner');
    mkdirSync(replacementRoot, { recursive: true });
    const replacement = createConfigManager(replacementRoot);
    const previous = replacement.get('surfaces.ntfy.token');
    modal.open(replacement, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets,
      { onSettingApplied: () => { replacementApplied++; } });
    finish();
    expect(await completion).toBe(true);
    expect(cm.get('surfaces.ntfy.token')).toBe(buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.ntfy.token')));
    expect(replacement.get('surfaces.ntfy.token')).toBe(previous);
    expect(originalApplied).toBe(1);
    expect(replacementApplied).toBe(0);
    expect(modal.lastSettingEffectMessage).toBeNull();
  });

  test('clearing a secret keeps its reference until deletion completes', async () => {
    let finish!: () => void;
    const cleared = new Promise<void>((resolve) => { finish = resolve; });
    const reference = buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.ntfy.token'));
    cm.setDynamic('surfaces.ntfy.token', reference);
    const secrets = { set: async () => {}, delete: () => cleared };
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets);
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.ntfy.token');
    modal.activateSelected();
    modal.editBuffer = '';
    expect(modal.commitEdit()).toBe(true);
    expect(cm.get('surfaces.ntfy.token')).toBe(reference);
    const completion = modal.pendingSecretWrite;
    finish();
    expect(await completion).toBe(true);
    expect(cm.get('surfaces.ntfy.token')).toBe('');
  });

  test('secret completion rechecks policy instead of publishing after authority becomes unavailable', async () => {
    let finish!: () => void;
    const stored = new Promise<void>((resolve) => { finish = resolve; });
    const secrets = { set: () => stored, delete: async () => {} };
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets);
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.ntfy.token');
    const previous = cm.get('surfaces.ntfy.token');
    modal.activateSelected();
    modal.editBuffer = 'pending-policy-token';
    expect(modal.commitEdit()).toBe(true);
    const completion = modal.pendingSecretWrite;
    const policy = spyOn(cm, 'getHostSettingsSchema').mockImplementation(() => { throw new Error('policy metadata unavailable'); });
    try {
      finish();
      expect(await completion).toBe(false);
      expect(cm.get('surfaces.ntfy.token')).toBe(previous);
      expect(modal.lastSettingEffectMessage).toMatch(/failed/i);
    } finally { policy.mockRestore(); }
  });

  test('secret reference publication waits for its captured connected config owner', async () => {
    let finishStorage!: () => void;
    let finishRoute!: () => void;
    let routeStarted!: () => void;
    const stored = new Promise<void>((resolve) => { finishStorage = resolve; });
    const routed = new Promise<void>((resolve) => { finishRoute = resolve; });
    const started = new Promise<void>((resolve) => { routeStarted = resolve; });
    const writes: unknown[] = [];
    const owner = { ownsKey: () => true, set: async (key: string, value: unknown) => {
      writes.push({ key, value }); routeStarted(); await routed;
    } };
    const secrets = { set: () => stored, delete: async () => {} };
    installAgentDaemonConfigClient(owner as unknown as Parameters<typeof installAgentDaemonConfigClient>[0]);
    try {
      modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets);
      while (modal.currentCategory !== 'surfaces') modal.nextCategory();
      modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.ntfy.token');
      const previous = cm.get('surfaces.ntfy.token');
      modal.activateSelected();
      modal.editBuffer = 'routed-token';
      expect(modal.commitEdit()).toBe(true);
      const completion = modal.pendingSecretWrite;
      installAgentDaemonConfigClient(null);
      expect(writes).toEqual([]);
      finishStorage();
      await started;
      expect(writes).toEqual([{ key: 'surfaces.ntfy.token', value: buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.ntfy.token')) }]);
      expect(cm.get('surfaces.ntfy.token')).toBe(previous);
      finishRoute();
      expect(await completion).toBe(true);
      expect(cm.get('surfaces.ntfy.token')).toBe(previous);
    } finally { installAgentDaemonConfigClient(null); }
  });

  for (const rejects of [false, true]) {
    test(`selected secret reset waits for deletion and reports ${rejects ? 'failure' : 'completion'}`, async () => {
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const removed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      let deletes = 0;
      let applied = 0;
      const reference = buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.ntfy.token'));
      cm.setDynamic('surfaces.ntfy.token', reference);
      const secrets = { set: async () => { throw new Error('reset must delete'); }, delete: () => { deletes++; return removed; } };
      modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets,
        { onSettingApplied: () => { applied++; } });
      while (modal.currentCategory !== 'surfaces') modal.nextCategory();
      modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.ntfy.token');
      expect(modal.resetSelected()).toBeNull();
      const completion = modal.pendingSecretWrite;
      expect(completion).not.toBeNull();
      expect(cm.get('surfaces.ntfy.token')).toBe(reference);
      expect(applied).toBe(0);
      expect(deletes).toBe(1);
      expect(modal.resetSelected()).toBeNull();
      expect(deletes).toBe(1);
      if (rejects) fail(new Error('deletion failed with synthetic-hidden-token'));
      else finish();
      expect(await completion).toBe(!rejects);
      expect(cm.get('surfaces.ntfy.token')).toBe(rejects ? reference : '');
      expect(applied).toBe(rejects ? 0 : 1);
      expect(modal.pendingSecretWrite).toBeNull();
      expect(modal.lastSettingEffectMessage).not.toContain('synthetic-hidden-token');
      if (rejects) expect(modal.lastSettingEffectMessage).toMatch(/failed/i);
    });
  }

  test('a pending selected secret reset finishes against its original owner after reopen', async () => {
    let finish!: () => void;
    const removed = new Promise<void>((resolve) => { finish = resolve; });
    const reference = buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.ntfy.token'));
    cm.setDynamic('surfaces.ntfy.token', reference);
    const secrets = { set: async () => {}, delete: () => removed };
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets);
    while (modal.currentCategory !== 'surfaces') modal.nextCategory();
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.ntfy.token');
    expect(modal.resetSelected()).toBeNull();
    const completion = modal.pendingSecretWrite;
    modal.close();
    const replacementRoot = join(tmpDir, 'reset-replacement-owner');
    mkdirSync(replacementRoot, { recursive: true });
    const replacement = createConfigManager(replacementRoot);
    replacement.setDynamic('surfaces.ntfy.token', reference);
    modal.open(replacement, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets);
    finish();
    expect(await completion).toBe(true);
    expect(cm.get('surfaces.ntfy.token')).toBe('');
    expect(replacement.get('surfaces.ntfy.token')).toBe(reference);
    expect(modal.lastSettingEffectMessage).toBeNull();
  });

  for (const rejects of [false, true]) {
    test(`selected secret reset routes clear to its daemon and waits for ${rejects ? 'refusal' : 'completion'}`, async () => {
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const removed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      let clears = 0;
      const writer = { set: async () => { throw new Error('reset must clear'); },
        clear: () => { clears++; return removed; } };
      const reference = buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.ntfy.token'));
      cm.setDynamic('surfaces.ntfy.token', reference);
      installAgentDaemonCredentialsClient(writer as unknown as Parameters<typeof installAgentDaemonCredentialsClient>[0]);
      try {
        modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
        while (modal.currentCategory !== 'surfaces') modal.nextCategory();
        modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'surfaces.ntfy.token');
        expect(modal.resetSelected()).toBeNull();
        const completion = modal.pendingSecretWrite;
        expect(completion).not.toBeNull();
        expect(clears).toBe(1);
        expect(cm.get('surfaces.ntfy.token')).toBe(reference);
        if (rejects) fail(new Error('synthetic-daemon-clear-refusal'));
        else finish();
        expect(await completion).toBe(!rejects);
        // The remote owner commits its own config; no local fallback is fabricated.
        expect(cm.get('surfaces.ntfy.token')).toBe(reference);
        if (rejects) expect(modal.lastSettingEffectMessage).toMatch(/failed/i);
      } finally { installAgentDaemonCredentialsClient(null); }
    });
  }

  test('close() deactivates modal and clears editing state', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.editingMode = true;
    modal.editBuffer = 'partial';
    modal.close();
    expect(modal.active).toBe(false);
    expect(modal.editingMode).toBe(false);
    expect(modal.editBuffer).toBe('');
  });

  test('navigating categories does not change settings in other categories', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.nextCategory();
    const items = modal.currentItems;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.setting.key.startsWith(modal.currentCategory)).toBe(true);
    }
  });

  test('editingMode blocks category and direction navigation', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    modal.editingMode = true;
    const catBefore = modal.categoryIndex;
    const idxBefore = modal.selectedIndex;
    modal.nextCategory();
    modal.prevCategory();
    modal.moveDown();
    modal.moveUp();
    expect(modal.categoryIndex).toBe(catBefore);
    expect(modal.selectedIndex).toBe(idxBefore);
  });

  test('mcp category loads registered servers', () => {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'mcp') modal.nextCategory();
    expect(modal.mcpEntries.length).toBe(1);
    expect(modal.getSelectedMcp()?.name).toBe('docs-server');
  });

  test('subscriptions category requires confirmation before sign out', () => {
    const manager = subscriptionManager;
    manager.saveSubscription({
      provider: 'openai',
      accessToken: 'token',
      tokenType: 'Bearer',
      authMode: 'oauth',
      overrideAmbientApiKeys: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'subscriptions') modal.nextCategory();
    expect(modal.subscriptionEntries.find((entry) => entry.provider === 'openai')).toEqual(expect.objectContaining({
      provider: 'openai',
      state: 'active',
      tokenType: 'Bearer',
      activeRoute: 'subscription',
      authFreshness: 'healthy',
    }));

    const openaiIndex = modal.subscriptionEntries.findIndex((entry) => entry.provider === 'openai');
    expect(openaiIndex).toBeGreaterThanOrEqual(0);
    modal.selectedIndex = openaiIndex;
    expect(modal.getSelectedSubscription()?.provider).toBe('openai');
    expect(modal.getSelectedSubscription()?.state).toBe('active');

    modal.activateSelected();
    expect(modal.subscriptionLogoutConfirmationTarget).toBe('openai');
    expect(subscriptionManager.get('openai')).toEqual(expect.objectContaining({
      provider: 'openai',
      accessToken: 'token',
      tokenType: 'Bearer',
    }));

    modal.activateSelected();
    expect(subscriptionManager.get('openai')).toBeNull();
  });

  test('mcp trust mode requires explicit allow-all confirmation', () => {
    let updatedMode: string | null = null;
    mcpRegistry = {
      listServerSecurity: () => [
        {
          name: 'docs-server',
          connected: true,
          role: 'docs',
          trustMode: 'ask-on-risk',
          allowedPaths: ['/workspace/docs'],
          allowedHosts: [],
          schemaFreshness: 'fresh',
        },
      ],
      setServerTrustMode: (_name: string, mode: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked') => {
        updatedMode = mode;
      },
    } as unknown as McpRegistry;

    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'mcp') modal.nextCategory();
    modal.activateSelected();
    expect(modal.editingMode).toBe(true);
    modal.editBuffer = 'allow-all';
    expect(modal.commitEdit()).toBe(false);
    expect(modal.mcpAllowAllConfirmationTarget).toBe('docs-server');
    expect(updatedMode as string | null).toBeNull();
    modal.editBuffer = 'ALLOW ALL docs-server';
    expect(modal.commitEdit()).toBe(true);
    expect(updatedMode as string | null).toBe('allow-all');
  });
});
