import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { handleSelectionModalToken } from '../../input/handler-modal-routes.ts';
import { handleModelPickerToken } from '../../input/handler-picker-routes.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { CacheHitTracker } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ProviderCapabilityRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { FavoritesStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createLaunchTolerantProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

interface PickerHarness {
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly providerRegistry: ProviderRegistry;
  cleanup(): void;
}

function createPickerHarness(): PickerHarness {
  const rootDir = makeProjectTempDir('gv-modal-search-focus');
  const configDir = join(rootDir, 'config');
  const dataDir = join(rootDir, 'provider-data');
  const subscriptionsPath = join(rootDir, 'subscriptions.json');
  const servicesPath = join(rootDir, 'services.json');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const secretsManager = new SecretsManager({ projectRoot: rootDir, globalHome: rootDir });
  const subscriptionManager = new SubscriptionManager(subscriptionsPath);
  const serviceRegistry = new ServiceRegistry(servicesPath, {
    secretsManager,
    subscriptionManager,
  });
  const favoritesStore = new FavoritesStore({ dir: dataDir });
  const benchmarkStore = new BenchmarkStore({ dir: dataDir });
  writeFileSync(favoritesStore.getPath(), JSON.stringify({ pinned: [], history: [] }, null, 2));
  writeFileSync(
    benchmarkStore.getCachePath(),
    JSON.stringify({ version: 1 as const, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }, null, 2),
  );
  benchmarkStore.initBenchmarks();

  const providerRegistry = createLaunchTolerantProviderRegistry({
    configManager: new ConfigManager({ surfaceRoot: 'tui',
      configDir,
      workingDir: rootDir,
      homeDir: rootDir,
    }),
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    capabilityRegistry: new ProviderCapabilityRegistry(),
    cacheHitTracker: new CacheHitTracker(),
    favoritesStore,
    benchmarkStore,
  });

  return {
    favoritesStore,
    benchmarkStore,
    providerRegistry,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

let harness: PickerHarness;

beforeEach(() => {
  harness = createPickerHarness();
});

afterEach(() => {
  harness?.cleanup();
});

describe('modal search focus routing', () => {
  test('selection modal: a claimed action letter fires while the query is empty; once typing, it is a character', () => {
    const modal = new SelectionModal();
    const customActions = new Map([['d', 'delete' as const]]);
    modal.open('Pick', [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ], { allowSearch: true, customActions });

    let result: { item: { id: string }; action: string } | null = null;
    const state = {
      selectionModal: modal,
      selectionCallback: (value: typeof result) => { result = value; },
      modalStack: [],
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleSelectionModalToken(state, { type: 'text', value: 'd' });
    expect(result).toEqual(expect.objectContaining({ action: 'delete' }));

    result = null;
    modal.open('Pick', [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ], { allowSearch: true, customActions });
    handleSelectionModalToken(state, { type: 'text', value: 't' });
    handleSelectionModalToken(state, { type: 'text', value: 'd' });
    expect(result).toBeNull();
    expect(modal.query).toBe('td');
  });

  test('selection modal: up/down always move the selection (there is no search mode to enter)', () => {
    const modal = new SelectionModal();
    modal.open('Pick', [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ], { allowSearch: true });

    const state = {
      selectionModal: modal,
      selectionCallback: null,
      modalStack: [],
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleSelectionModalToken(state, { type: 'key', name: 'down', logicalName: 'down', ctrl: false, shift: false, meta: false });
    expect(modal.selectedIndex).toBe(1);
    handleSelectionModalToken(state, { type: 'key', name: 'up', logicalName: 'up', ctrl: false, shift: false, meta: false });
    expect(modal.selectedIndex).toBe(0);
    handleSelectionModalToken(state, { type: 'key', name: 'up', logicalName: 'up', ctrl: false, shift: false, meta: false });
    expect(modal.selectedIndex).toBe(1); // wraps
  });

  test('model picker: letters always search, ctrl+g cycles the grouping', () => {
    const picker = new ModelPickerModal(harness.favoritesStore, harness.benchmarkStore, harness.providerRegistry);
    picker.openAllModels([
      {
        id: 'gpt-1',
        provider: 'openai',
        registryKey: 'openai:gpt-1',
        displayName: 'GPT 1',
        description: '',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
        tier: 'premium',
      },
    ], 'gpt-1');

    const state = {
      modelPicker: picker,
      modalStack: [],
      commandContext: undefined,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    expect(picker.groupBy).toBe('provider');
    handleModelPickerToken(state, { type: 'text', value: 'g' });
    expect(picker.groupBy).toBe('provider');
    expect(picker.query).toBe('g');

    handleModelPickerToken(state, { type: 'key', name: 'g', logicalName: 'g', ctrl: true, shift: false, meta: false });
    expect(picker.groupBy).toBe('family');
    expect(picker.query).toBe('g');
  });

  test('model picker uses left and right to switch model targets', () => {
    const picker = new ModelPickerModal(harness.favoritesStore, harness.benchmarkStore, harness.providerRegistry);
    picker.openAllModels([
      {
        id: 'gpt-1',
        provider: 'openai',
        registryKey: 'openai:gpt-1',
        displayName: 'GPT 1',
        description: '',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
        tier: 'premium',
      },
    ], 'gpt-1');

    const state = {
      modelPicker: picker,
      modalStack: [],
      commandContext: undefined,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    picker.setTargetInfos([
      { target: 'main', label: 'Main Chat', description: '', provider: 'openai', model: 'openai:gpt-1', enabled: true, inherited: false },
      { target: 'helper', label: 'Helper Model', description: '', provider: 'openai', model: 'openai:gpt-1', enabled: true, inherited: true },
    ]);
    const target = () => picker.target;
    const first = target();
    handleModelPickerToken(state, { type: 'key', name: 'right', logicalName: 'right', ctrl: false, shift: false, meta: false });
    const second = target();
    expect(second).not.toBe(first);
    handleModelPickerToken(state, { type: 'key', name: 'left', logicalName: 'left', ctrl: false, shift: false, meta: false });
    expect(target()).toBe(first);
    expect(picker.focusPane).toBe('items');
  });

  test('model picker exposes capability, availability, and benchmark filters as ctrl chords', () => {
    const picker = new ModelPickerModal(harness.favoritesStore, harness.benchmarkStore, harness.providerRegistry);
    picker.openAllModels([
      {
        id: 'gpt-1',
        provider: 'openai',
        registryKey: 'openai:gpt-1',
        displayName: 'GPT 1',
        description: '',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
        contextWindow: 8192,
        selectable: true,
        tier: 'premium',
      },
    ], 'gpt-1');

    const state = {
      modelPicker: picker,
      modalStack: [],
      commandContext: undefined,
      getViewportHeight: () => 30,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleModelPickerToken(state, { type: 'key', name: 'k', logicalName: 'k', ctrl: true, shift: false, meta: false });
    expect(picker.capabilityFilter).toBe('reasoning');

    handleModelPickerToken(state, { type: 'key', name: 'a', logicalName: 'a', ctrl: true, shift: false, meta: false });
    expect(picker.availableOnly).toBe(false);

    handleModelPickerToken(state, { type: 'key', name: 'b', logicalName: 'b', ctrl: true, shift: false, meta: false });
    expect(picker.benchmarkSort).toBe('composite');
    expect(picker.query).toBe('');
  });
});
