import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { wireShellUiOpeners } from '../../shell/ui-openers.ts';
import { buildTestModelDefinition, createTestManagers } from '../helpers/test-managers.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { getBundledTheme, resolveTheme } from '@goodvibes-jev/engine/sdk/platform/presentation';
import { dirname } from 'node:path';
import { SettingsModal } from '../../input/settings-modal.ts';
import { activeTokens, getActiveThemeMode, getActiveThemeName, listThemeChoices, normalizeThemeName, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { resetTerminalPaletteForTests } from '../../renderer/terminal-palette.ts';

describe('wireShellUiOpeners', () => {
  let commandContext: Record<string, unknown>;
  let input: Record<string, unknown>;
  let conversation: Record<string, unknown>;
  let render: ReturnType<typeof mock>;
  let testManagers = createTestManagers();

  beforeEach(() => {
    testManagers = createTestManagers();
    commandContext = {};
    input = {
      indicatorFocused: false,
      modelPicker: {},
      modalOpened: mock(() => {}),
      openAgentWorkspace: mock(() => {}),
    };
    conversation = {
      log: mock(() => {}),
      setSplashSuppressed: mock(() => {}),
      rebuildHistory: mock(() => {}),
    };
    render = mock(() => {});

    wireShellUiOpeners({
      commandContext: commandContext as never,
      input: input as never,
      conversation: conversation as never,
      configManager: testManagers.configManager,
      providerRegistry: {} as never,
      runtime: {} as never,
      featureFlags: { getAll: () => new Map() } as never,
      mcpRegistry: { listServerSecurity: () => [] } as never,
      subscriptionManager: testManagers.subscriptionManager,
      serviceRegistry: testManagers.serviceRegistry,
      getConfiguredProviderIds: () => [],
      getPinned: async () => [],
      workingDirectory: process.cwd(),
      homeDirectory: process.env['HOME'] ?? process.cwd(),
      render,
    });
  });

  test('theme enum arrows persist and apply through the real settings opener without changing themeMode', () => {
    const cm = testManagers.configManager;
    const modal = new SettingsModal();
    input.settingsModal = modal;
    const repaint = mock(() => {});
    commandContext.clearScreen = repaint;
    cm.set('display.themeMode', 'light');
    setActiveThemeName('goodvibes');
    setActiveThemeMode('light');
    resetTerminalPaletteForTests();
    try {
      (commandContext.openSettingsModal as (target: string) => void)('display.theme');
      const entry = modal.getSelected()!;
      expect(entry.setting.key).toBe('display.theme');
      expect(entry.setting.type).toBe('enum');
      expect(entry.currentValue).toBe('goodvibes');
      expect(entry.isDefault).toBe(true);
      const values = entry.setting.enumValues!;
      expect(values).toHaveLength(13);
      expect([...values].sort()).toEqual([...listThemeChoices().map(choice => choice.name), 'vaporwave'].sort());

      // Enter keeps the dedicated live-preview picker; arrows use the enum.
      modal.activateSelected();
      expect(modal.pendingSettingsPickerAction).toBe('theme');
      expect(cm.get('display.theme')).toBe('goodvibes');
      expect(modal.editingMode).toBe(false);

      let index = values.indexOf('goodvibes');
      for (const direction of ['right', 'left'] as const) {
        for (let i = 0; i < values.length; i++) {
          index = (index + (direction === 'right' ? 1 : values.length - 1)) % values.length;
          const value = values[index]!;
          modal.adjustSelected(direction);
          const active = normalizeThemeName(value);
          expect(cm.get('display.theme')).toBe(value);
          expect(modal.getSelected()!.currentValue).toBe(value);
          expect(getActiveThemeName()).toBe(active);
          expect(activeTokens()).toEqual(resolveTheme(getBundledTheme(active === 'system' ? 'goodvibes' : active)!.json, 'light'));
          expect(cm.get('display.themeMode')).toBe('light');
          expect(getActiveThemeMode()).toBe('light');
          const reloaded = new ConfigManager({ configDir: dirname(cm.getConfigPath()), readOnly: true });
          expect(reloaded.get('display.theme')).toBe(value);
          expect(reloaded.get('display.themeMode')).toBe('light');
        }
      }
      expect(repaint).toHaveBeenCalledTimes(values.length * 2);
      expect(modal.getSelected()!.isDefault).toBe(true);
    } finally {
      modal.close();
      setActiveThemeName('goodvibes');
      setActiveThemeMode('dark');
      resetTerminalPaletteForTests();
    }
  });

  test('openWorkspacePicker opens the Agent workspace home', () => {
    (commandContext.openWorkspacePicker as () => void)();
    expect(input.openAgentWorkspace).toHaveBeenCalledWith(commandContext, 'home');
    expect(conversation.setSplashSuppressed).toHaveBeenCalledWith(false);
    expect(conversation.rebuildHistory).toHaveBeenCalled();
    expect(render).toHaveBeenCalled();
  });

  test('focusPrompt clears indicator focus and rerenders', () => {
    input.indicatorFocused = true;
    (commandContext.focusPrompt as () => void)();
    expect(input.indicatorFocused).toBe(false);
    expect(render).toHaveBeenCalled();
  });

  test('openAgentWorkspace delegates through the shared opener route', () => {
    (commandContext.openAgentWorkspace as () => void)();
    expect(input.openAgentWorkspace).toHaveBeenCalledWith(commandContext, undefined);
    expect(render).toHaveBeenCalled();
  });

  // Fix-everywhere convention: the TUI's picker re-checks each provider's live
  // model list on open (goodvibes-tui ui-openers), and the agent's picker must
  // do exactly the same, a freshly-opened picker reflects models the provider
  // started or stopped serving, without blocking the open.
  describe('live model discovery re-check on picker open', () => {
    let previousPort: ReturnType<typeof installJudgmentPort>;
    let families: ReturnType<typeof fakePort>;
    beforeEach(() => {
      families = fakePort((_name, question) => choiceAnswer(question, 'Other', 0.99));
      previousPort = installJudgmentPort(families.port);
    });
    afterEach(() => { installJudgmentPort(previousPort); });
    function wirePickerWithRegistry(refreshLiveModelDiscovery: ReturnType<typeof mock>, getSelectableModels = () => [] as ReturnType<typeof buildTestModelDefinition>[]): void {
      input = {
        indicatorFocused: false,
        modelPicker: {
          // The picker opens on the cached catalog, then the slow reads land
          // through input/model-picker-open.ts; the stub carries what that reads.
          active: true,
          mode: 'model',
          selectedIndex: 0,
          catalogLoading: false,
          catalogTicket: 0,
          models: [],
          getFilteredModels: () => [],
          getFilteredProviders: () => [],
          clearFilteredCaches: () => {},
          target: 'main',
          getSelectedTargetInfo: () => undefined,
          loadRecentModels: mock(async () => {}),
          setTargetInfos: mock(() => {}),
          openAllModels: mock(() => {}),
        },
        modalOpened: mock(() => {}),
        openAgentWorkspace: mock(() => {}),
      };
      wireShellUiOpeners({
        commandContext: commandContext as never,
        input: input as never,
        conversation: conversation as never,
        configManager: testManagers.configManager,
        providerRegistry: {
          getSelectableModels,
          refreshLiveModelDiscovery,
        } as never,
        runtime: { model: 'm', provider: 'p' } as never,
        featureFlags: {} as never,
        mcpRegistry: {} as never,
        subscriptionManager: testManagers.subscriptionManager,
        serviceRegistry: testManagers.serviceRegistry,
        // A configured provider keeps the picker on the plain catalog path (no
        // synthetic local-fit probing in this unit test).
        getConfiguredProviderIds: () => ['openai'],
        getPinned: async () => [],
        workingDirectory: process.cwd(),
        homeDirectory: process.env['HOME'] ?? process.cwd(),
        render,
      });
    }

    test('openModelPicker triggers the registry live-model re-check hook', async () => {
      const refreshLiveModelDiscovery = mock(async () => []);
      wirePickerWithRegistry(refreshLiveModelDiscovery);
      (commandContext.openModelPicker as () => void)();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(refreshLiveModelDiscovery).toHaveBeenCalledTimes(1);
    });

    test('a changed live list lands in the open picker and repaints before loading finishes', async () => {
      for (const changed of [false, true]) {
        let completeRefresh!: (value: { providerId: string; models: string[]; source: 'live'; added: string[]; removed: string[] }[]) => void;
        const refresh = new Promise<Parameters<typeof completeRefresh>[0]>((resolve) => { completeRefresh = resolve; });
        let catalog: ReturnType<typeof buildTestModelDefinition>[] = [];
        const getSelectableModels = mock(() => catalog);
        wirePickerWithRegistry(mock(() => refresh), getSelectableModels);
        const picker = input.modelPicker as { models: typeof catalog; catalogLoading: boolean };
        const frames: { ids: string[]; loading: boolean }[] = [];
        let loaded!: () => void;
        const done = new Promise<void>((resolve) => { loaded = resolve; });
        render.mockClear();
        render.mockImplementation(() => {
          frames.push({ ids: picker.models.map((model) => model.id), loading: picker.catalogLoading });
          if (!picker.catalogLoading) loaded();
        });
        (commandContext.openModelPicker as () => void)();
        expect(frames).toEqual([{ ids: [], loading: true }]);
        catalog = changed ? [buildTestModelDefinition('openai', 'a')] : [];
        completeRefresh([{ providerId: 'openai', models: catalog.map((model) => model.id), source: 'live', added: changed ? ['a'] : [], removed: [] }]);
        await done;
        expect(getSelectableModels).toHaveBeenCalledTimes(changed ? 2 : 1);
        expect(picker.models).toEqual(catalog);
        expect(families.requests.map((request) => request.state)).toEqual(changed
          ? [{ id: 'a', displayName: 'a', provider: 'openai' }] : []);
        expect(frames).toContainEqual({ ids: changed ? ['a'] : [], loading: true });
        expect(frames.at(-1)).toEqual({ ids: changed ? ['a'] : [], loading: false });
      }
    });

    test('a rejecting re-check never breaks the picker open', async () => {
      const failing = mock(async () => { throw new Error('discovery route down'); });
      wirePickerWithRegistry(failing);
      (commandContext.openModelPicker as () => void)();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(failing).toHaveBeenCalledTimes(1);
      expect((input.modelPicker as { openAllModels: ReturnType<typeof mock> }).openAllModels).toHaveBeenCalled();
    });
  });
});
