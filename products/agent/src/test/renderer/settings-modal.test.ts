import { settingContextLines } from '../../renderer/settings-modal-context.ts';
/**
 * Tests for renderSettingsModal renderer.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SettingsModal, SETTINGS_CATEGORIES } from '../../input/settings-modal.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { layerText, layerTextBlock } from '../helpers/surface-frame.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const W = 120;

function makeTmpDir(): string {
  const dir = makeProjectTempDir(`gv-settings-renderer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({ surfaceRoot: 'tui',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-tui'),
  });
}

describe('renderSettingsModal', () => {
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
    writeFileSync(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'), JSON.stringify({
      version: 1,
      subscriptions: {
        openai: {
          provider: 'openai',
          accessToken: 'token',
          tokenType: 'Bearer',
          authMode: 'oauth',
          overrideAmbientApiKeys: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      pending: {},
    }, null, 2));
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The modal's text (a kit layer drawn over the screen). */
  function render(width = W, height = 40): string {
    return layerTextBlock(renderSettingsModal(modal, width, height));
  }

  test('is a kit modal layer that fits the screen', () => {
    const layer = renderSettingsModal(modal, W, 40);
    expect(layer.dim).toBe(true);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(W);
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(40);
  });

  test('title row reads Settings with the category as a breadcrumb', () => {
    const title = layerText(renderSettingsModal(modal, W, 40))[2]!;
    expect(title).toContain('Settings');
    expect(title).toContain('› Display');
  });

  test('keycap hints name the category keys while the categories have focus', () => {
    const text = render();
    expect(text).toContain('↑↓  category');
    expect(text).toContain('tab  pane');
  });

  test('the search row is always live', () => {
    expect(render()).toContain('Search all settings');
    modal.setSearchQuery('theme');
    const text = render();
    expect(text).toContain('theme▏');
    expect(text).toContain('› Search');
    expect(text).toMatch(/\d+ results?/);
  });

  test('theme setting instructions match the actual preview picker', () => {
    modal.selectTarget('display.theme');
    const context = settingContextLines(modal).join('\n');
    expect(context).toContain('theme picker');
    expect(context).not.toContain('Enter opens inline edit');
    modal.activateSelected();
    expect(modal.pendingSettingsPickerAction).toBe('theme');
    expect(modal.editingMode).toBe(false);
  });

  test('category list shows each category with its count', () => {
    const text = render();
    // Assert the current public schema's count instead of a retired display setting.
    expect(text).toMatch(new RegExp(`Display\\s+${modal.groups.get('display')?.length}`));
  });

  test('category list is grouped and opens with category focus', () => {
    const text = render();
    expect(modal.focusPane).toBe('categories');
    expect(text).toContain('✦ agent experience');
    expect(text).not.toContain('external runtime connection');
    expect(text).not.toContain('delegation compatibility');
  });

  test('category list scrolls to reveal later groups as selection moves down', () => {
    modal.categoryIndex = SETTINGS_CATEGORIES.indexOf('provider');
    expect(render(W, 24)).toContain('models and providers');
    modal.categoryIndex = SETTINGS_CATEGORIES.indexOf('surfaces');
    expect(render(W, 24)).toContain('channels and tools');
  });

  test('exposes daemon runtime settings, including the danger toggle', () => {
    const rendered: string[] = [];
    for (let index = 0; index < SETTINGS_CATEGORIES.length; index += 1) {
      rendered.push(render(W, 40));
      modal.nextCategory();
    }
    const text = rendered.join('\n');
    expect(text).toContain('daemon runtime');
    expect(text).toContain('Control Plane');
    expect(text).toContain('HTTP Listener');
    expect(text).toContain('Service');
    expect(text).toContain('advanced runtime');
    expect(text).toContain('Contracts');
    expect(text).toContain('controlPlane.');
    expect(text).toContain('httpListener.');
    expect(text).toContain('service.');
    expect(text).toContain('contract.');
    expect(text).toContain('orchestration.');
    // Rendered, not hidden. The owner can see whether an inbound listener is on;
    // the confirmation gate is what stands between the Agent and turning it on.
    expect(text).toContain('Danger Zone');
    expect(text).toContain('danger.httpListener');
  });

  test('settings list shows setting names', () => {
    expect(render().toLowerCase()).toMatch(/stream|linenumbers|theme/);
  });

  test('the selected setting carries the gradient once the settings have focus', () => {
    modal.focusSettings();
    const layer = renderSettingsModal(modal, W, 40);
    expect(layer.lines.flat().some((cell) => cell.bg === activeTokens().brand)).toBe(true);
  });

  test('the selected setting explains itself with its source', () => {
    const text = render();
    expect(text).toMatch(/stream|Stream/);
    expect(text).toContain('source ');
  });

  test('selected conflicting setting surfaces conflict provenance', () => {
    const selected = modal.getSelected();
    expect(selected).toEqual(expect.objectContaining({
      setting: expect.objectContaining({ key: expect.any(String) }),
    }));
    selected!.conflict = true;
    modal.groups.set(modal.currentCategory, [selected!]);
    expect(render().toLowerCase()).toContain('conflict');
  });

  test('selected synced setting surfaces synced provenance', () => {
    const selected = modal.getSelected();
    selected!.effectiveSource = 'synced';
    modal.groups.set(modal.currentCategory, [selected!]);
    expect(render()).toContain('source synced');
  });

  test('hints name save and cancel in editing mode', () => {
    modal.editingMode = true;
    const text = render();
    expect(text).toContain('⏎  save');
    expect(text).toContain('esc  cancel edit');
  });

  test('edit cursor shown when in editing mode', () => {
    modal.focusSettings();
    modal.editingMode = true;
    modal.editBuffer = 'test';
    expect(render()).toContain('test▏');
  });

  test('changing category shows different settings', () => {
    modal.nextCategory();
    const text = render();
    expect(text).toContain('› UI');
    expect(text).toMatch(new RegExp(`UI\\s+${modal.groups.get('ui')?.length}`));
  });

  test('mcp category renders server trust editing surface', () => {
    while (modal.currentCategory !== 'mcp') modal.nextCategory();
    const text = render();
    expect(text).toContain('docs-server');
    expect(text).toContain('ask-on-risk');
  });

  test('mcp category renders explicit allow-all confirmation guidance', () => {
    while (modal.currentCategory !== 'mcp') modal.nextCategory();
    modal.editingMode = true;
    modal.mcpAllowAllConfirmationTarget = 'docs-server';
    expect(render()).toContain('ALLOW ALL docs-server');
  });

  test('subscriptions category renders provider override state', () => {
    while (modal.currentCategory !== 'subscriptions') modal.nextCategory();
    modal.subscriptionEntries = [{
      provider: 'openai',
      state: 'active',
      tokenType: 'Bearer',
      oauthConfigured: true,
    }];
    const text = render();
    expect(text).toContain('› Subscriptions');
    expect(text).toContain('openai');
    expect(text).toContain('active');
    expect(text).toContain('ambient key ov');
  });

  test('subscriptions category renders explicit logout confirmation guidance when armed', () => {
    while (modal.currentCategory !== 'subscriptions') modal.nextCategory();
    modal.subscriptionEntries = [{
      provider: 'openai',
      state: 'active',
      tokenType: 'Bearer',
      oauthConfigured: true,
    }];
    modal.subscriptionLogoutConfirmationTarget = 'openai';
    const text = render();
    expect(text).toContain('Press Enter again to sign out openai');
    expect(text).toContain('⏎  sign out');
  });

  test('fits a narrow terminal', () => {
    const layer = renderSettingsModal(modal, 60, 24);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(60);
  });
});
