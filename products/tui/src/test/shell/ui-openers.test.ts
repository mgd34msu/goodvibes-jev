import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { wireShellUiOpeners } from '../../shell/ui-openers.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { getBundledTheme, resolveTheme } from '@goodvibes-jev/engine/sdk/platform/presentation';
import { dirname } from 'node:path';
import { SettingsModal } from '../../input/settings-modal.ts';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { activeTokens, activeThemeMode, getActiveThemeName, listThemeChoices, normalizeThemeName, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { resetTerminalPaletteForTests } from '../../renderer/terminal-palette.ts';
import { makeTestShellViews } from '../helpers/shell-views.ts';
import type { ShellViews } from '../../views/builtin-views.ts';
import type { ViewPanelAdapter } from '../../views/view-panel-adapter.ts';

interface FakeEmbeddingStatus {
  readonly id: string;
  readonly label: string;
  readonly dimensions: number;
  readonly configured: boolean;
  readonly detail?: string;
}

function makeFakeEmbeddingRegistry(options: {
  defaultProviderId?: string;
  statuses?: FakeEmbeddingStatus[];
} = {}) {
  let defaultProviderId = options.defaultProviderId ?? 'hashed-local';
  const statuses = options.statuses ?? [
    { id: 'hashed-local', label: 'Hashed Local Embeddings', dimensions: 384, configured: true },
    { id: 'openai', label: 'OpenAI Embeddings', dimensions: 1536, configured: false, detail: 'Set OPENAI_API_KEY to enable.' },
  ];
  return {
    getDefaultProviderId: mock(() => defaultProviderId),
    setDefaultProvider: mock((id: string) => {
      if (!statuses.some((s) => s.id === id)) throw new Error(`Unknown memory embedding provider: ${id}`);
      defaultProviderId = id;
    }),
    status: mock(async () => statuses),
  };
}

describe('wireShellUiOpeners', () => {
  let commandContext: Record<string, unknown>;
  let input: Record<string, unknown>;
  let views: ShellViews;
  let viewPanelAdapter: ViewPanelAdapter;
  let render: ReturnType<typeof mock>;
  let testManagers = createTestManagers();
  let fakeEmbeddingRegistry = makeFakeEmbeddingRegistry();
  let trustPromptRef: { requestTrustDecision: () => Promise<'trusted' | 'restricted'> };

  beforeEach(() => {
    testManagers = createTestManagers();
    fakeEmbeddingRegistry = makeFakeEmbeddingRegistry();
    commandContext = { print: mock(() => {}) };
    // Keep catalog ownership and late-fill handling real; observing opener calls
    // must not replace the modal's lifecycle with a partial handwritten fixture.
    const modelPicker = new ModelPickerModal(
      testManagers.favoritesStore, testManagers.benchmarkStore, testManagers.providerRegistry,
    );
    spyOn(modelPicker, 'openAllModels');
    spyOn(modelPicker, 'openProviders');
    input = {
      indicatorFocused: false,
      modelPicker,
      modalOpened: mock(() => {}),
      openSelection: mock(() => {}),
      surfaceModals: new SurfaceModalHost(),
    };
    ({ views, viewPanelAdapter } = makeTestShellViews({ configManager: testManagers.configManager }));
    render = mock(() => {});

    wireShellUiOpeners({
      commandContext: commandContext as never,
      input: input as never,
      views,
      viewPanelAdapter,
      configManager: testManagers.configManager,
      providerRegistry: { getSelectableModels: () => [], listModels: () => [] } as never,
      runtime: { model: 'm', provider: 'p' } as never,
      featureFlags: { getAll: () => new Map() } as never,
      mcpRegistry: { listServerSecurity: () => [] } as never,
      subscriptionManager: testManagers.subscriptionManager,
      serviceRegistry: testManagers.serviceRegistry,
      memoryEmbeddingRegistry: fakeEmbeddingRegistry as never,
      workingDirectory: '/tmp/goodvibes-tui-test-workspace',
      homeDirectory: '/tmp/goodvibes-tui-test-home',
      getConfiguredProviderIds: () => [],
      getPinned: async () => [],
      render,
      // wireShellUiOpeners overwrites .requestTrustDecision with the real
      // implementation below, this placeholder just needs to be a valid ref shape.
      trustPromptRef: (trustPromptRef = { requestTrustDecision: async () => 'restricted' as const }),
    });
  });

  test('theme enum arrows persist and apply through the real settings opener without changing themeMode', () => {
    const cm = testManagers.configManager;
    const modal = new SettingsModal();
    input.settingsModal = modal;
    const repaint = mock(() => {});
    commandContext.requestFullRepaint = repaint;
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
          expect(activeThemeMode()).toBe('light');
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

  // Trust-at-consequence-time: wireShellUiOpeners patches trustPromptRef with
  // the real modal-driving implementation. Registration self-records here too
  // when the answer is 'trusted', never for 'restricted'.
  describe('trustPromptRef.requestTrustDecision', () => {
    test('opens a trust-only selection (two items: trusted, restricted)', () => {
      void trustPromptRef.requestTrustDecision();
      expect(input.openSelection).toHaveBeenCalledTimes(1);
      const [title, items] = (input.openSelection as ReturnType<typeof mock>).mock.calls[0] as [string, Array<{ id: string }>, unknown, unknown];
      expect(title).toContain('trust');
      expect(items.map((i) => i.id)).toEqual(['trusted', 'restricted']);
    });

    test('resolves "restricted" and never self-records when the user keeps the workspace restricted', async () => {
      const registerCalls: Array<string | undefined> = [];
      (commandContext as Record<string, unknown>).workspace = {
        workspaceRegistrationManager: {
          evaluate: async () => ({ offerRegister: true }),
          register: async (label?: string) => { registerCalls.push(label); return { registered: true, result: {} }; },
        },
      };
      const decisionPromise = trustPromptRef.requestTrustDecision();
      const callback = (input.openSelection as ReturnType<typeof mock>).mock.calls[0]![3] as (result: unknown) => void;
      callback({ item: { id: 'restricted' }, action: 'select' });
      expect(await decisionPromise).toBe('restricted');
      await Promise.resolve();
      expect(registerCalls).toEqual([]);
    });

    test('resolves "trusted" and self-records (labeled "via TUI") when the user trusts the workspace', async () => {
      const registerCalls: Array<string | undefined> = [];
      (commandContext as Record<string, unknown>).workspace = {
        workspaceRegistrationManager: {
          evaluate: async () => ({ offerRegister: true }),
          register: async (label?: string) => { registerCalls.push(label); return { registered: true, result: {} }; },
        },
      };
      const decisionPromise = trustPromptRef.requestTrustDecision();
      const callback = (input.openSelection as ReturnType<typeof mock>).mock.calls[0]![3] as (result: unknown) => void;
      callback({ item: { id: 'trusted' }, action: 'select' });
      expect(await decisionPromise).toBe('trusted');
      await Promise.resolve();
      await Promise.resolve();
      expect(registerCalls).toEqual(['via TUI']);
    });

    test('Escape/enter-through (null id) defaults to restricted', async () => {
      const decisionPromise = trustPromptRef.requestTrustDecision();
      const callback = (input.openSelection as ReturnType<typeof mock>).mock.calls[0]![3] as (result: unknown) => void;
      callback(null);
      expect(await decisionPromise).toBe('restricted');
    });
  });

  test('openView routes old view names to their modals and reports unknown names', () => {
    const opened: string[] = [];
    commandContext.openAgents = mock(() => { opened.push('agents'); });
    commandContext.openUsage = mock(() => { opened.push('usage'); });
    commandContext.openChanges = mock(() => { opened.push('changes'); });
    commandContext.openNotifications = mock(() => { opened.push('notifications'); });
    const openView = commandContext.openView as (name: string) => boolean;
    expect(openView('fleet')).toBe(true);
    expect(openView('cockpit')).toBe(true);
    expect(openView('tokens')).toBe(true);
    expect(openView('cost')).toBe(true);
    expect(openView('git')).toBe(true);
    expect(openView('review')).toBe(true);
    expect(openView('notifications')).toBe(true);
    expect(openView('no-such-view')).toBe(false);
    expect(opened).toEqual(['agents', 'agents', 'usage', 'usage', 'changes', 'changes', 'notifications']);
  });

  test('the operator API view adapter opens views through openView', () => {
    commandContext.openAgents = mock(() => {});
    expect(viewPanelAdapter.open('agents')).toBe(true);
    expect(commandContext.openAgents).toHaveBeenCalledTimes(1);
    expect(viewPanelAdapter.getRegisteredTypes().map((t) => t.id)).toEqual(['agents', 'usage', 'changes', 'notifications', 'sessions']);
    expect(viewPanelAdapter.getTopPane().panels).toEqual([]);
  });

  test('openOnboardingWizard delegates through the shared opener seam', () => {
    input.openOnboardingWizard = mock(() => {});
    (commandContext.openOnboardingWizard as (mode?: 'new' | 'edit') => void)('new');
    expect(input.openOnboardingWizard).toHaveBeenCalledWith('new');
    expect(render).not.toHaveBeenCalled();
  });

  // openModal resolves the name to a registered config-modal surface on the
  // standalone registry. With no surface registered it stays a safe, honest
  // no-op: an explanatory print, not a throw or a blank modal.
  test('openModal is safe with no real modal registered', () => {
    (commandContext.openModal as (name: string) => void)('providers-modal');
    expect(commandContext.print).toHaveBeenCalledWith("'providers-modal' is not available yet in this build.");
    expect(render).toHaveBeenCalled();
  });

  test('openModal resolves an old name through the registry redirect (accounts opens providers-modal)', () => {
    const open = mock(() => {});
    (input as Record<string, unknown>).configModal = { open };
    const surface = { name: 'providers-modal', title: 'Providers', buildView: () => ({ title: 'Providers', tabs: [] }) };
    views.modalSurfaces.registerModalSurface(surface as never);
    views.modalSurfaces.registerModalRedirect('accounts', 'providers-modal');
    (commandContext.openModal as (name: string) => void)('accounts');
    expect(open).toHaveBeenCalledTimes(1);
    expect((open.mock.calls[0] as unknown[])[0]).toBe(surface);
    expect(input.modalOpened).toHaveBeenCalledWith('config');
  });

  // W6 review (finding 3): the retired 'sessions' front door redirects to the
  // NATIVE session-picker modal ('sessionPicker'), which is NOT a
  // ConfigModalSurface, getModalSurface can never find it, so before the fix
  // the openModal callback printed "'sessionPicker' is not available yet in
  // this build." A small native-modal dispatch, consulted before
  // getModalSurface, now routes it to the real opener.
  test("openModal routes the native 'sessionPicker' target to the session-picker modal, not the honest-print fallback", () => {
    const open = mock(() => {});
    (input as Record<string, unknown>).sessionPickerModal = { open };
    (commandContext.openModal as (name: string) => void)('sessionPicker');
    expect(open).toHaveBeenCalledTimes(1);
    expect(input.modalOpened).toHaveBeenCalledWith('sessionPicker');
    // The native dispatch is consulted before the surface registry, and the
    // old "not available yet" lie is gone.
    expect(commandContext.print).not.toHaveBeenCalledWith("'sessionPicker' is not available yet in this build.");
  });

  test("openView('sessions') opens the session picker (the Hosted group lives there too)", () => {
    const openSessionPicker = mock(() => {});
    commandContext.openSessionPicker = openSessionPicker;
    expect((commandContext.openView as (name: string) => boolean)('sessions')).toBe(true);
    expect(openSessionPicker).toHaveBeenCalledTimes(1);
  });

  describe('embeddings target', () => {
    async function openModelPickerAndFlush(): Promise<void> {
      (commandContext.openModelPicker as () => void)();
      // openModelPicker's body is a fire-and-forget async IIFE (`void (async () => ...)()`);
      // a macrotask tick lets every microtask-based await inside it settle before assertions.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    function getModelPicker(): ModelPickerModal {
      return input.modelPicker as ModelPickerModal;
    }

    test('adds a 5th "embeddings" target with an honest provider + dimensions + configured note', async () => {
      await openModelPickerAndFlush();

      const targets = getModelPicker().targetInfos;
      expect(getModelPicker().active).toBe(true);
      expect(getModelPicker().catalogLoading).toBe(false);
      expect(targets.map((t) => t.target)).toEqual(['main', 'helper', 'tool', 'tts', 'embeddings']);

      const embeddingsTarget = targets.find((t) => t.target === 'embeddings')!;
      expect(embeddingsTarget.label).toBe('Embeddings');
      expect(embeddingsTarget.model).toBe(''); // no phantom model value
      expect(embeddingsTarget.configuredNote).toBe('hashed-local · 384d');
    });

    test('the four existing targets are unchanged', async () => {
      await openModelPickerAndFlush();

      const targets = getModelPicker().targetInfos;
      expect(targets.find((t) => t.target === 'main')?.label).toBe('Main Chat');
      expect(targets.find((t) => t.target === 'helper')?.label).toBe('Helper Model');
      expect(targets.find((t) => t.target === 'tool')?.label).toBe('Tool LLM');
      expect(targets.find((t) => t.target === 'tts')?.label).toBe('TTS LLM');
    });

    test('populates the picker\'s embedding-provider list, showing unconfigured providers honestly', async () => {
      await openModelPickerAndFlush();

      const embeddingProviders = getModelPicker().embeddingProviders;
      expect(embeddingProviders).toHaveLength(2);
      expect(embeddingProviders.find((p) => p.id === 'hashed-local')?.configured).toBe(true);
      expect(embeddingProviders.find((p) => p.id === 'openai')?.configured).toBe(false);
    });

    test('an unregistered persisted default renders honestly instead of a fabricated note', async () => {
      fakeEmbeddingRegistry.getDefaultProviderId.mockReturnValue('vanished-provider');
      await openModelPickerAndFlush();

      const targets = getModelPicker().targetInfos;
      expect(targets.find((t) => t.target === 'embeddings')?.configuredNote).toBe('vanished-provider · unregistered');
    });

    test('closing the real picker prevents a pending embedding probe from repopulating it', async () => {
      let resolveStatus!: (statuses: FakeEmbeddingStatus[]) => void;
      fakeEmbeddingRegistry.status.mockReturnValueOnce(new Promise(resolve => { resolveStatus = resolve; }));
      (commandContext.openModelPicker as () => void)();
      const picker = getModelPicker();
      expect(picker.active).toBe(true);
      expect(picker.catalogLoading).toBe(true);
      picker.close();
      resolveStatus([{ id: 'late-provider', label: 'Late Provider', dimensions: 512, configured: true }]);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(picker.active).toBe(false);
      expect(picker.catalogLoading).toBe(false);
      expect(picker.targetInfos).toEqual([]);
      expect(picker.embeddingProviders).toEqual([]);
    });

    test('completeEmbeddingProviderSelection persists the selection via the registry', () => {
      (commandContext.completeEmbeddingProviderSelection as (id: string) => void)('openai');
      expect(fakeEmbeddingRegistry.setDefaultProvider).toHaveBeenCalledWith('openai');
      expect(render).toHaveBeenCalled();
    });

    test('completeEmbeddingProviderSelection reports an honest error for an unknown provider id', () => {
      const print = mock(() => {});
      commandContext.print = print;
      (commandContext.completeEmbeddingProviderSelection as (id: string) => void)('does-not-exist');
      expect(print).toHaveBeenCalledWith(expect.stringContaining('Failed to set embedding provider'));
    });
  });

  describe('live model discovery re-check on picker open', () => {
    test('openModelPicker triggers the registry live-model re-check hook', async () => {
      const refreshLiveModelDiscovery = mock(async () => []);
      wireShellUiOpeners({
        commandContext: commandContext as never,
        input: input as never,
        views,
        viewPanelAdapter,
        configManager: testManagers.configManager,
        providerRegistry: {
          getSelectableModels: () => [],
          listModels: () => [],
          has: () => false,
          refreshLiveModelDiscovery,
        } as never,
        runtime: { model: 'm', provider: 'p' } as never,
        featureFlags: {} as never,
        mcpRegistry: {} as never,
        subscriptionManager: testManagers.subscriptionManager,
        serviceRegistry: testManagers.serviceRegistry,
        memoryEmbeddingRegistry: fakeEmbeddingRegistry as never,
        workingDirectory: '/tmp/goodvibes-tui-test-workspace',
        homeDirectory: '/tmp/goodvibes-tui-test-home',
        getConfiguredProviderIds: () => [],
        getPinned: async () => [],
        render,
        trustPromptRef: { requestTrustDecision: async () => 'restricted' as const },
      });
      (commandContext.openModelPicker as () => void)();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(refreshLiveModelDiscovery).toHaveBeenCalledTimes(1);
    });
  });

  // providerRegistry.getSelectableModels()/listModels() are catalog-driven,
  // they include every provider id present in the fetched pricing catalog (e.g.
  // 'google', from Gemini catalog entries) regardless of whether that provider
  // id was ever handed to providerRegistry.register()/registerRuntimeProvider().
  // Selecting one of those models used to fail at turn time with
  // ProviderNotFoundError ("Provider 'google' is not registered."). The picker
  // must intersect against providerRegistry.has() so it never offers a model or
  // provider that cannot work.
  describe('unregistered-provider filtering', () => {
    const registeredModel = { id: 'gemini-pro', provider: 'gemini', displayName: 'Gemini Pro' };
    const unregisteredModel = { id: 'gemini-2.5-pro', provider: 'google', displayName: 'Gemini 2.5 Pro (catalog)' };

    function wireWithCatalogMismatch(): void {
      wireShellUiOpeners({
        commandContext: commandContext as never,
        input: input as never,
        views,
        viewPanelAdapter,
        configManager: testManagers.configManager,
        providerRegistry: {
          getSelectableModels: () => [registeredModel, unregisteredModel],
          listModels: () => [registeredModel, unregisteredModel],
          // Only 'gemini' was ever registered; 'google' is catalog-only,
          // proves the mismatch this test guards against.
          has: (id: string) => id === 'gemini',
        } as never,
        runtime: { model: 'm', provider: 'p' } as never,
        featureFlags: {} as never,
        mcpRegistry: {} as never,
        subscriptionManager: testManagers.subscriptionManager,
        serviceRegistry: testManagers.serviceRegistry,
        memoryEmbeddingRegistry: fakeEmbeddingRegistry as never,
        workingDirectory: '/tmp/goodvibes-tui-test-workspace',
        homeDirectory: '/tmp/goodvibes-tui-test-home',
        getConfiguredProviderIds: () => [],
        getPinned: async () => [],
        render,
        trustPromptRef: { requestTrustDecision: async () => 'restricted' as const },
      });
    }

    async function flush(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    test('openModelPicker never hands the flat model list an unregistered provider\'s model', async () => {
      wireWithCatalogMismatch();
      (commandContext.openModelPicker as () => void)();
      await flush();

      const openAllModels = (input.modelPicker as Record<string, unknown>).openAllModels as ReturnType<typeof mock>;
      expect(openAllModels).toHaveBeenCalledTimes(1);
      const passedModels = openAllModels.mock.calls[0]![0] as Array<{ provider: string }>;
      expect(passedModels.map((m) => m.provider)).toEqual(['gemini']);
      expect(passedModels.some((m) => m.provider === 'google')).toBe(false);
    });

    test('openProviderPicker never lists a provider id the runtime has not registered', async () => {
      wireWithCatalogMismatch();
      (commandContext.openProviderPicker as () => void)();
      await flush();

      const openProviders = (input.modelPicker as Record<string, unknown>).openProviders as ReturnType<typeof mock>;
      expect(openProviders).toHaveBeenCalledTimes(1);
      const passedProviders = openProviders.mock.calls[0]![0] as string[];
      expect(passedProviders).toEqual(['gemini']);
      expect(passedProviders).not.toContain('google');
    });
  });
});
