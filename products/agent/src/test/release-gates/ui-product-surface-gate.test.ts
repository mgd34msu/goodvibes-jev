import { describe, expect, test } from 'bun:test';
import {
  MAX_SETTING_LIMIT,
  countHarnessSettings,
  formatHarnessSettingList,
  listHarnessSettings,
} from '../../agent/harness-control.ts';
import type { ConfigSetting } from '../../config/index.ts';
import { harnessSettingsCatalog } from '../../tools/agent-harness-settings-catalog.ts';
import { ConversationManager } from '../../core/conversation';
import type { CommandContext } from '../../input/command-registry.ts';
import { getOverlayWidthClass } from '@goodvibes-jev/engine/terminal-shell';
import { wireShellUiOpeners } from '../../shell/ui-openers.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { listHarnessKeybindings } from '../../tools/agent-harness-keybinding-metadata.ts';
import {
  listHarnessUiSurfaces,
  totalHarnessUiSurfaces,
} from '../../tools/agent-harness-ui-surface-metadata.ts';

function modelCatalogContext(): CommandContext {
  const noop = () => {};
  return {
    renderRequest: noop,
    print: noop,
    exit: noop,
    executeCommand: async () => true,
    openModelPicker: noop,
    openModelPickerWithTarget: () => true,
    openProviderModelPickerWithTarget: () => true,
    openProviderPicker: noop,
    openReasoningEffortPicker: () => ({ opened: true, model: 'test', levels: ['low', 'medium', 'high'] }),
    openContextInspector: noop,
    openBookmarkModal: noop,
    openProcessModal: noop,
    openConversationSearch: noop,
    openPromptHistorySearch: noop,
    openSlashCommandMode: () => true,
    openFilePicker: () => true,
    openBlockActions: () => true,
    openLiveTail: () => ({ opened: true, processId: 'proc-1', label: 'test process' }),
    openHelpOverlay: noop,
    openSelection: noop,
    openSettingsModal: noop,
    openSessionPicker: noop,
    openProfilePicker: noop,
    openShortcutsOverlay: noop,
    openWorkspacePicker: noop,
    showPanel: noop,
    openMcpWorkspace: noop,
    openAgentWorkspace: noop,
    openSecurityWorkspace: noop,
    openKnowledgeWorkspace: noop,
    openSubscriptionWorkspace: noop,
    workspace: {},
    platform: {},
    session: {},
    provider: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
}

/**
 * A ConfigManager stand-in whose schema is `count` synthetic settings. `key` is
 * cast because ConfigKey is a union of the real key literals, and the path
 * accessors are stubbed because the effective-config view reads them; the cast
 * is confined to the stub, not to anything under test.
 */
function syntheticConfigManager(count: number) {
  const schema: ConfigSetting[] = Array.from({ length: count }, (_value, index) => ({
    key: `synthetic.entry${String(index).padStart(5, '0')}` as ConfigSetting['key'],
    type: 'string',
    default: '',
    description: `Synthetic setting ${index}`,
  }));
  return {
    get: () => undefined,
    getSchema: () => schema,
    getHomeDirectory: () => null,
    getConfigPath: () => '/nonexistent/synthetic-config.json',
    getDaemonTierPath: () => '/nonexistent/synthetic-daemon.json',
  } as unknown as Parameters<typeof harnessSettingsCatalog>[0];
}

function expectNonempty(value: unknown): asserts value is string {
  expect(typeof value).toBe('string');
  expect(String(value).trim()).not.toBe('');
}

describe('UI product surface gate', () => {
  test('supports line-accurate conversation navigation by transcript event family', () => {
    const conversation = new ConversationManager(() => 100);
    conversation.addUserMessage('review the file');
    conversation.addAssistantMessage('Running checks.', {
      toolCalls: [{ id: 'call-1', name: 'exec', arguments: { command: 'git diff --stat' } }],
      model: 'gpt-5.4',
      provider: 'openai',
    });
    conversation.addToolResults([{ callId: 'call-1', success: true, output: '1 file changed' }]);
    conversation.addSystemMessage('[Approval] Waiting for operator input');

    const toolLine = conversation.nextTranscriptEventLine(0, 'tool_result');
    expect(toolLine).toBeGreaterThanOrEqual(0);
    expect(conversation.prevTranscriptEventLine(999, 'tool_result')).toBe(toolLine);
  });

  test('routes panel openers through the Agent workspace path', () => {
    const testManagers = createTestManagers();
    let openedWorkspaceCategory: string | null = null;
    const input = {
      panelFocused: false,
      modalOpened: () => {},
      modelPicker: {} as never,
      openAgentWorkspace: (_ctx: CommandContext, category: string) => { openedWorkspaceCategory = category; },
      openSelection: () => {},
      contextInspectorModal: { open: () => {} },
      bookmarkModal: { open: () => {} },
      helpOverlayActive: false,
      helpScrollOffset: 0,
      shortcutsOverlayActive: false,
      shortcutsScrollOffset: 0,
      profilePickerModal: { open: () => {} },
      settingsModal: { open: () => {} },
      sessionPickerModal: { open: () => {} },
    } as unknown as Parameters<typeof wireShellUiOpeners>[0]['input'];
    const conversation = {
      log: () => {},
      setSplashSuppressed: () => {},
      rebuildHistory: () => {},
    } as never;
    const commandContext = {} as CommandContext;

    wireShellUiOpeners({
      commandContext,
      input,
      conversation,
      configManager: testManagers.configManager,
      providerRegistry: { getSelectableModels: () => [], listModels: () => [] } as never,
      runtime: { model: 'gpt-5.4', provider: 'openai' } as never,
      featureFlags: {} as never,
      mcpRegistry: {} as never,
      subscriptionManager: testManagers.subscriptionManager,
      serviceRegistry: testManagers.serviceRegistry,
      getConfiguredProviderIds: () => [],
      getPinned: async () => [],
      workingDirectory: process.cwd(),
      homeDirectory: process.env['HOME'] ?? process.cwd(),
      render: () => {},
    });

    (commandContext as { openWorkspacePicker?: () => void }).openWorkspacePicker?.();
    expect(openedWorkspaceCategory!).toBe('home');
  });

  test('keeps overlays on shared width bands for narrow, medium, and wide terminals', () => {
    expect(getOverlayWidthClass(70)).toBe('narrow');
    expect(getOverlayWidthClass(100)).toBe('medium');
    expect(getOverlayWidthClass(140)).toBe('wide');
  });

  test('model-facing catalogs cover current user-facing settings, surfaces, and keybindings', () => {
    const context = modelCatalogContext();
    const managers = createTestManagers();

    const surfaces = listHarnessUiSurfaces(context, { includeParameters: true, limit: 500 }) as readonly {
      readonly id?: string;
      readonly summary?: string;
      readonly modelRoute?: string;
      readonly preferredModelRoute?: string;
      readonly policy?: { readonly effect?: string; readonly confirmation?: string; readonly boundary?: string };
    }[];
    expect(surfaces).toHaveLength(totalHarnessUiSurfaces());
    for (const surface of surfaces) {
      expectNonempty(surface.id);
      expectNonempty(surface.summary);
      expect(surface.summary.length).toBeLessThanOrEqual(72);
      expectNonempty(surface.modelRoute);
      expect(surface.modelRoute.length).toBeLessThanOrEqual(72);
      expectNonempty(surface.preferredModelRoute);
      expectNonempty(surface.policy?.effect);
      expect(surface.policy?.confirmation).toContain('confirm:true');
      expectNonempty(surface.policy?.boundary);
    }

    const keybindings = listHarnessKeybindings(context, { limit: 500 }) as {
      readonly keybindings: readonly {
        readonly action?: string;
        readonly description?: string;
        readonly modelOperation?: {
          readonly effect?: string;
          readonly confirmation?: string;
          readonly note?: string;
          readonly preferredMode?: string;
        };
      }[];
      readonly returned: number;
      readonly total: number;
    };
    expect(keybindings.returned).toBe(keybindings.total);
    for (const keybinding of keybindings.keybindings) {
      expectNonempty(keybinding.action);
      expectNonempty(keybinding.description);
      expectNonempty(keybinding.modelOperation?.effect);
      expectNonempty(keybinding.modelOperation?.confirmation);
      expectNonempty(keybinding.modelOperation?.note);
      if (keybinding.modelOperation?.preferredMode) {
        expect([
          'run_keybinding',
          'open_ui_surface',
          'run_command',
          'direct-user-interaction',
        ]).toContain(keybinding.modelOperation.preferredMode);
      }
    }

    // A default listing returns the WHOLE visible catalog, matching how the two
    // catalogs above are checked. The old assertion here was
    // `settings.length <= 500`, which is satisfied by a truncated page: it
    // could only ever pass, including on the day the catalog grew past the
    // page ceiling and the listing started dropping its tail rows.
    const settings = listHarnessSettings(managers.configManager, {}) as readonly {
      readonly key?: string;
      readonly category?: string;
      readonly summary?: string;
      readonly modelRoute?: string;
      readonly visibleInWorkspace?: boolean;
      readonly writable?: boolean;
    }[];
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.length).toBe(countHarnessSettings(managers.configManager, {}));
    // Settings get a wider line budget than surfaces/keybindings/tools: a
    // setting's modelRoute is `settings set|reset key:${key}`, and the key
    // itself is a dotted schema identifier this catalog does not control,
    // unlike a surface/keybinding id, which this codebase names and can keep
    // short. payments.budget.overageToleranceDailyAllowance already produces
    // a 69-character route; 80 leaves room for the next nested key without
    // another gate-test edit.
    const SETTING_LINE_BUDGET = 80;
    for (const setting of settings) {
      expectNonempty(setting.key);
      expectNonempty(setting.category);
      expectNonempty(setting.summary);
      expect(setting.summary.length).toBeLessThanOrEqual(SETTING_LINE_BUDGET);
      expectNonempty(setting.modelRoute);
      expect(setting.modelRoute.length).toBeLessThanOrEqual(SETTING_LINE_BUDGET);
      expect(typeof setting.visibleInWorkspace).toBe('boolean');
      expect(typeof setting.writable).toBe('boolean');
    }
  });

  test('keeps the settings page ceiling well clear of the settings that exist', () => {
    // Not a fixed expected size, the catalog grows every round. The bar is
    // headroom: the ceiling must be at least double the live catalog, so the
    // gate goes red with a wide margin left rather than on the round the
    // catalog finally crosses it.
    const visible = countHarnessSettings(createTestManagers().configManager, {});
    expect(visible).toBeGreaterThan(0);
    expect(MAX_SETTING_LIMIT).toBeGreaterThanOrEqual(visible * 2);
  });

  test('a settings catalog past the page ceiling still reports how many it left out', () => {
    // A catalog deliberately larger than the ceiling, so this holds whatever
    // the real schema currently counts.
    const oversized = MAX_SETTING_LIMIT + 10;
    const configManager = syntheticConfigManager(oversized);

    const page = listHarnessSettings(configManager, {});
    const total = countHarnessSettings(configManager, {});

    expect(total).toBe(oversized);
    expect(page.length).toBe(MAX_SETTING_LIMIT);
    // The page is short; the count that says so must not be the page's own length.
    expect(total).toBeGreaterThan(page.length);
    expect(formatHarnessSettingList(page, total)).toContain(`${page.length} of ${total}`);
  });

  test('the settings tool mode serves a catalog larger than the old 500 ceiling whole', async () => {
    // 640 is above the ceiling this mode used to carry and below the one it
    // carries now, so the page must be complete and must say nothing about
    // being partial. Wired at 500 this returns 500 rows and no explanation.
    const body = await harnessSettingsCatalog(syntheticConfigManager(640), {} as never);
    expect(body.returned).toBe(640);
    expect(body.total).toBe(640);
    expect(body.note).toBeUndefined();
  });

  test('the settings tool mode names what it left out when the catalog outgrows the ceiling', async () => {
    const oversized = MAX_SETTING_LIMIT + 10;
    const body = await harnessSettingsCatalog(syntheticConfigManager(oversized), {} as never);
    expect(body.returned).toBe(MAX_SETTING_LIMIT);
    expect(body.total).toBe(oversized);
    expect(String(body.note)).toContain(`Showing ${MAX_SETTING_LIMIT} of ${oversized} settings`);
    expect(String(body.note)).toContain('not the full catalog');
  });

  test('a complete settings page does not claim to be short', () => {
    const managers = createTestManagers();
    const page = listHarnessSettings(managers.configManager, {});
    const printed = formatHarnessSettingList(page, countHarnessSettings(managers.configManager, {}));
    expect(printed).toContain(`Settings (${page.length})`);
    expect(printed).not.toContain('this page is short');
  });
});
