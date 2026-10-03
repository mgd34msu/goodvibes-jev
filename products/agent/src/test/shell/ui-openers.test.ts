import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { wireShellUiOpeners } from '../../shell/ui-openers.ts';
import { createTestManagers } from '../helpers/test-managers.ts';

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
      featureFlags: {} as never,
      mcpRegistry: {} as never,
      subscriptionManager: testManagers.subscriptionManager,
      serviceRegistry: testManagers.serviceRegistry,
      getConfiguredProviderIds: () => [],
      getPinned: async () => [],
      workingDirectory: process.cwd(),
      homeDirectory: process.env['HOME'] ?? process.cwd(),
      render,
    });
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
    function wirePickerWithRegistry(refreshLiveModelDiscovery: ReturnType<typeof mock>): void {
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
          getSelectableModels: () => [],
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

    test('a re-check that changes any provider list re-renders once more than an unchanged one', async () => {
      const rendersFor = async (added: string[]): Promise<number> => {
        render.mockClear();
        wirePickerWithRegistry(mock(async () => [{ providerId: 'openai', models: ['a'], source: 'live' as const, added, removed: [] }]));
        (commandContext.openModelPicker as () => void)();
        expect(render.mock.calls.length).toBe(1); // the picker is on screen before any read resolves
        await new Promise((resolve) => setTimeout(resolve, 10));
        return render.mock.calls.length;
      };
      const unchanged = await rendersFor([]);
      const changed = await rendersFor(['a']);
      expect(changed).toBe(unchanged + 1); // the refreshed list lands in the open picker
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
