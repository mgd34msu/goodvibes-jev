/**
 * Regression tests for Agent settings boundaries around copied service-hosting
 * config. GoodVibes Agent connects to a GoodVibes host owned outside this product; the settings
 * workspace must not expose controls that imply it owns daemon, listener,
 * browser host, raw network, service, or WRFC lifecycle.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { SettingsModal, SETTINGS_CATEGORIES, isAgentHiddenSettingKey } from '../../input/settings-modal.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeTmpDir(): string {
  const dir = makeProjectTempDir(`gv-agent-settings-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({
    surfaceRoot: 'tui',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-tui'),
  });
}

function lineText(line: unknown): string {
  if (!Array.isArray(line)) return '';
  return line.map((span: { text?: string; char?: string }) => span.text ?? span.char ?? '').join('');
}

const emptyMcpRegistry: McpRegistry = {
  listServerSecurity: () => [],
  setServerTrustMode: () => {},
} as unknown as McpRegistry;

describe('SettingsModal: Agent service-hosting boundaries', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let ffm: FeatureFlagManager;
  let modal: SettingsModal;
  let subscriptionManager: SubscriptionManager;
  let serviceRegistry: ServiceRegistry;

  function openSettings(): void {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, emptyMcpRegistry);
  }

  function visibleKeys(): Set<string> {
    const keys = new Set<string>();
    for (const entries of modal.groups.values()) {
      for (const entry of entries) keys.add(entry.setting.key);
    }
    return keys;
  }

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
    mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('service-hosting and network categories are registered for Agent settings', () => {
    expect(SETTINGS_CATEGORIES).toContain('network');
    expect(SETTINGS_CATEGORIES).toContain('controlPlane');
    expect(SETTINGS_CATEGORIES).toContain('httpListener');
    expect(SETTINGS_CATEGORIES).toContain('web');
    expect(SETTINGS_CATEGORIES).toContain('service');
    expect(SETTINGS_CATEGORIES).toContain('runtime');
    // `danger` is a registered category now. It was deliberately absent, which
    // meant danger.httpListener was dropped on the floor by open() even once the
    // hidden-prefix was lifted, the modal buckets by the key's first segment.
    expect(SETTINGS_CATEGORIES).toContain('danger');
    expect(SETTINGS_CATEGORIES).toContain('contract');
    expect(SETTINGS_CATEGORIES).toContain('orchestration');
  });

  test('only the internal WRFC message setting is policy-hidden', () => {
    // Hiding is reserved for keys with nothing for the owner to decide. Anything
    // hazardous is shown and gated instead, so the refusal can name the key and
    // say why, `danger.httpListener` moved from this list to that treatment.
    for (const key of [
      'ui.wrfcMessages',
    ]) {
      expect(isAgentHiddenSettingKey(key)).toBe(true);
    }
    for (const key of [
      'danger.httpListener',
      'controlPlane.hostMode',
      'controlPlane.port',
      'httpListener.hostMode',
      'service.autostart',
      'network.outboundTls.mode',
      'runtime.eventBus.maxListeners',
      'orchestration.recursionEnabled',
      'contract.gateTimeoutMs',
    ]) {
      expect(isAgentHiddenSettingKey(key)).toBe(false);
    }
  });

  test('open() populates daemon runtime keys, including the visible danger toggle', () => {
    openSettings();
    const keys = visibleKeys();
    for (const key of [
      'danger.httpListener',
      'controlPlane.hostMode',
      'httpListener.hostMode',
      'web.hostMode',
      'service.autostart',
      'network.outboundTls.mode',
      'runtime.eventBus.maxListeners',
      'orchestration.recursionEnabled',
      'contract.gateTimeoutMs',
    ]) {
      expect(keys.has(key)).toBe(true);
    }
    for (const key of [
      'ui.wrfcMessages',
    ]) {
      expect(keys.has(key)).toBe(false);
    }
  });

  test('selectTarget navigates to daemon runtime keys and to the danger toggle, but not to hidden keys', () => {
    openSettings();
    modal.selectTarget('controlPlane.port');
    expect(modal.getSelected()?.setting.key).toBe('controlPlane.port');

    // Reachable by navigation, because it is a real setting the owner may need
    // to inspect or change, the confirmation gate is what protects the write.
    modal.selectTarget('danger.httpListener');
    expect(modal.getSelected()?.setting.key).toBe('danger.httpListener');

    const before = modal.getSelected()?.setting.key;
    modal.selectTarget('ui.wrfcMessages');
    expect(modal.getSelected()?.setting.key).toBe(before);
  });

  test('the danger toggle renders once navigated to, rather than being suppressed', () => {
    // This used to assert the workspace never mentions danger settings. It only
    // ever passed because the default view opens on another category, so it
    // proved nothing about suppression, and it now states the wrong intent.
    // What matters is that selecting the key actually renders it.
    openSettings();
    modal.selectTarget('danger.httpListener');
    const text = renderSettingsModal(modal, 120, 30).lines.map(lineText).join('\n');
    expect(text).toContain('danger.httpListener');
  });

  // The deprecated danger.daemon alias (and the settings-modal override-note
  // machinery it drove, SettingEntry.overrideNote, buildSettingOverrideNote)
  // was removed from the schema; see
  // docs/decisions/2026-07-05-daemon-by-default.md in the SDK. daemon.enabled
  // is now the single source of truth for this setting, so there is no longer
  // a precedence case for the modal to explain.
});
