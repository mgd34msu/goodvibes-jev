/**
 * Tests for the sign-in row and local-rec commit guards in handleModelPickerToken.
 *
 * Covers:
 *   (a) Selecting the sign-in row on Enter invokes openProviderPicker, closes
 *       the picker, and does NOT call completeModelSelection.
 *   (b) Selecting a local fit recommendation on Enter does NOT call
 *       completeModelSelection (the synthetic id must never become the active model).
 */
import { describe, expect, test } from 'bun:test';
import { handleModelPickerToken } from '../../input/handler-picker-routes.ts';
import { buildLocalFitRecommendations, buildSignInRow } from '../../input/model-picker-local-fit.ts';
import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelPickerModal } from '../../input/model-picker.ts';

const STUB_PROFILE = {
  totalRamBytes: 16 * 1024 ** 3,
  availableRamBytes: 10 * 1024 ** 3,
  gpus: [] as [],
  cpuCores: 8,
};

function enterToken() {
  return { type: 'key' as const, name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false };
}

/**
 * Build a minimal ModelPickerRouteState stub with the given model pre-selected.
 * Returns the state and a capture map of calls made to commandContext methods.
 */
function makePickerState(selectedModel: ModelDefinition) {
  const calls: {
    completeModelSelection: ModelDefinition[];
    openProviderPicker: number;
    print: string[];
  } = { completeModelSelection: [], openProviderPicker: 0, print: [] };

  let pickerActive = true;
  const modalStack: string[] = ['modelPicker'];

  const modelPicker = {
    active: true,
    mode: 'model' as const,
    target: 'main' as const,
    previousMode: undefined as string | undefined,
    focusPane: 'items' as const,
    selectedIndex: 0,
    query: '',
    searchFocused: false,
    pendingModel: null as ModelDefinition | null,
    effortLevels: [] as string[],
    contextCapQuery: '',
    contextCapPendingModel: null as ModelDefinition | null,
    getSelected: () => selectedModel,
    close: () => { pickerActive = false; modelPicker.active = false; },
    clearQuery: () => {},
    blurSearch: () => {},
    showEffortPicker: () => {},
    moveUp: () => {},
    moveDown: () => {},
    focusSearch: () => {},
    focusItems: () => {},
    focusTargets: () => {},
    moveTarget: () => {},
    canFocusSearch: () => false,
    cycleGroupBy: () => {},
    setCategoryFilter: () => {},
    toggleAvailableOnly: () => {},
    cycleBenchmarkSort: () => {},
    setCapabilityFilter: () => {},
    enterContextCapMode: () => {},
    appendChar: () => {},
    deleteChar: () => {},
    deleteContextCapChar: () => {},
    appendContextCapChar: () => {},
    getFilteredProviders: () => [] as string[],
    isLocalModel: () => false,
    showModelsForProvider: () => {},
    categoryFilter: 'all' as const,
    capabilityFilter: 'none' as const,
    groupBy: 'none' as string,
    availableOnly: false,
    benchmarkSort: 'none' as string,
    scrollOffset: 0,
    getItemCount: () => 1,
  };

  const commandContext = {
    session: {
      runtime: {
        reasoningEffort: 'medium' as const,
      },
    },
    completeModelSelection: (args: { model: ModelDefinition }) => {
      calls.completeModelSelection.push(args.model);
    },
    openProviderPicker: () => {
      calls.openProviderPicker += 1;
    },
    print: (msg: string) => {
      calls.print.push(msg);
    },
  };

  const state = {
    modelPicker: modelPicker as unknown as ModelPickerModal,
    modalStack,
    commandContext: commandContext as never,
    getViewportHeight: () => 40,
    requestRender: () => {},
    handleEscape: () => {},
  };

  return { state, calls, get pickerActive() { return pickerActive; } };
}

describe('handleModelPickerToken: sign-in row on Enter', () => {
  test('invokes openProviderPicker when the sign-in row is selected', () => {
    const signInRow = buildSignInRow();
    const { state, calls } = makePickerState(signInRow);

    const handled = handleModelPickerToken(state, enterToken());

    expect(handled).toBe(true);
    expect(calls.openProviderPicker).toBe(1);
  });

  test('does NOT call completeModelSelection when the sign-in row is selected', () => {
    const signInRow = buildSignInRow();
    const { state, calls } = makePickerState(signInRow);

    handleModelPickerToken(state, enterToken());

    expect(calls.completeModelSelection).toHaveLength(0);
  });

  test('closes the model picker when the sign-in row is selected', () => {
    const signInRow = buildSignInRow();
    const { state } = makePickerState(signInRow);

    handleModelPickerToken(state, enterToken());

    // modelPicker.close() sets pickerActive = false
    expect(state.modelPicker.active).toBe(false);
  });

  test('pops modelPicker from modal stack when sign-in row is selected', () => {
    const signInRow = buildSignInRow();
    const { state } = makePickerState(signInRow);

    handleModelPickerToken(state, enterToken());

    expect(state.modalStack).not.toContain('modelPicker');
  });
});

describe('handleModelPickerToken: local fit recommendation on Enter', () => {
  test('does NOT call completeModelSelection when a local rec is selected', () => {
    const recs = buildLocalFitRecommendations(STUB_PROFILE);
    const localRec = recs[0]!;
    const { state, calls } = makePickerState(localRec);

    handleModelPickerToken(state, enterToken());

    expect(calls.completeModelSelection).toHaveLength(0);
  });

  test('closes the model picker when a local rec is selected', () => {
    const recs = buildLocalFitRecommendations(STUB_PROFILE);
    const localRec = recs[0]!;
    const { state } = makePickerState(localRec);

    handleModelPickerToken(state, enterToken());

    expect(state.modelPicker.active).toBe(false);
  });

  test('prints a plain-language install guide when a local rec is selected', () => {
    const recs = buildLocalFitRecommendations(STUB_PROFILE);
    const localRec = recs[0]!;
    const { state, calls } = makePickerState(localRec);

    handleModelPickerToken(state, enterToken());

    expect(calls.print.length).toBeGreaterThan(0);
    const message = calls.print.join('\n');
    expect(message).toContain('not installed');
  });

  test('does NOT invoke openProviderPicker when a local rec is selected', () => {
    const recs = buildLocalFitRecommendations(STUB_PROFILE);
    const localRec = recs[1]!; // 7B rec
    const { state, calls } = makePickerState(localRec);

    handleModelPickerToken(state, enterToken());

    expect(calls.openProviderPicker).toBe(0);
  });
});
