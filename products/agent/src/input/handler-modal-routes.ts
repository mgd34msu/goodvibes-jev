import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { servingEffortForLevel, toEffortModel } from '../providers/reasoning-effort-surface.ts';
import type { SelectionResult, SelectionAction } from './selection-modal.ts';
import type { CommandContext } from './command-registry.ts';
import { openTtsProviderPicker, openTtsVoicePicker } from './tts-settings-actions.ts';
import { openThemePicker } from './theme-settings-actions.ts';
import { openDaemonTimezonePicker } from './daemon-settings-actions.ts';
import { isTextBackspace } from '@goodvibes-jev/engine/terminal-shell';

type SelectionRouteState = {
  selectionModal: {
    active: boolean;
    query: string;
    allowSearch: boolean;
    customActions: Map<string, SelectionAction>;
    selectedIndex: number;
    getSelected: () => SelectionResult['item'] | null | undefined;
    setQuery: (query: string) => void;
    moveUp: () => void;
    moveDown: () => void;
    close: () => void;
  };
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  getSelectionCallback?: () => ((result: SelectionResult | null) => void) | null;
  setSelectionCallback?: (callback: ((result: SelectionResult | null) => void) | null) => void;
  modalStack: string[];
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleSelectionModalToken(state: SelectionRouteState, token: InputToken): boolean {
  if (!state.selectionModal.active) return false;

  const getPrimaryAction = (selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>> | null | undefined): SelectionAction | null => {
    if (selected?.primaryAction) return selected.primaryAction;
    const enterAction = state.selectionModal.customActions.get('enter');
    return enterAction ?? null;
  };

  const getSpaceAction = (selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>> | null | undefined): SelectionAction | null => {
    if (selected?.primaryAction === 'toggle') return 'toggle';
    const direct = state.selectionModal.customActions.get(' ');
    if (direct) return direct;
    const enterAction = getPrimaryAction(selected);
    if (enterAction === 'toggle') return enterAction;
    return null;
  };

  const dispatchSelectionAction = (
    action: SelectionAction,
    selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>>,
    step?: number,
  ): void => {
    if (action === 'toggle' || action === 'increment' || action === 'decrement') {
      state.selectionCallback?.({ item: selected, action, step });
      return;
    }
    const cb = state.selectionCallback;
    state.selectionCallback = null;
    state.setSelectionCallback?.(null);
    state.selectionModal.close();
    if (state.modalStack.length > 0 && state.modalStack[state.modalStack.length - 1] === 'selection') {
      state.modalStack.pop();
    }
    cb?.({ item: selected, action, step });
    state.selectionCallback = state.getSelectionCallback?.() ?? state.selectionCallback;
  };

  const getAdjustmentStep = (
    selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>> | null | undefined,
    shift: boolean,
  ): number => {
    const baseStep = selected?.adjustStep ?? 1;
    return shift ? baseStep * 10 : baseStep;
  };

  const fireClaimedKey = (key: string): boolean => {
    const action = state.selectionModal.customActions.get(key);
    if (!action) return false;
    const selected = state.selectionModal.getSelected();
    if (selected) dispatchSelectionAction(action, selected);
    return true;
  };

  const fireSpace = (): void => {
    const selected = state.selectionModal.getSelected();
    const action = getSpaceAction(selected);
    if (action && selected && state.selectionCallback) {
      state.selectionCallback({ item: selected, action });
    }
  };

  // The search row is always live (no search mode): printable text goes into
  // the query, except a key the picker claims (a custom action, or Space for
  // a toggle) which fires while the query is empty. Pickers without search
  // only have their claimed keys.
  if (token.type === 'text') {
    const queryEmpty = state.selectionModal.query.length === 0;
    const single = [...token.value].length === 1;
    if (queryEmpty && single && token.value === ' ' && getSpaceAction(state.selectionModal.getSelected())) {
      fireSpace();
    } else if (queryEmpty && single && state.selectionModal.customActions.has(token.value)) {
      fireClaimedKey(token.value);
    } else if (state.selectionModal.allowSearch) {
      state.selectionModal.setQuery(state.selectionModal.query + token.value);
    } else if (single && token.value === ' ') {
      fireSpace();
    }
  } else if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      // ONE Escape always closes the modal, whatever the query holds. Clearing
      // the query is Backspace's job, not Esc's.
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      const selected = state.selectionModal.getSelected();
      if (selected) {
        dispatchSelectionAction(getPrimaryAction(selected) ?? 'select', selected);
      }
    } else if (token.logicalName === 'space') {
      fireSpace();
    } else if (token.logicalName === 'up') {
      state.selectionModal.moveUp();
    } else if (token.logicalName === 'down') {
      state.selectionModal.moveDown();
    } else if (token.logicalName === 'left' || token.logicalName === 'right') {
      const selected = state.selectionModal.getSelected();
      if (selected?.adjustable) {
        dispatchSelectionAction(
          token.logicalName === 'right' ? 'increment' : 'decrement',
          selected,
          getAdjustmentStep(selected, token.shift),
        );
      }
    } else if (isTextBackspace(token.logicalName ?? '')) {
      // The search filter is end-anchored with no cursor, so forward-delete
      // is a no-op here per the delete-key policy.
      if (state.selectionModal.allowSearch && state.selectionModal.query.length > 0) {
        state.selectionModal.setQuery(state.selectionModal.query.slice(0, -1));
      }
    } else if (token.logicalName && [...token.logicalName].length === 1) {
      // A modified letter (a CSI-u chord): fires a claimed action whatever
      // the query holds, it is never typed.
      fireClaimedKey(token.logicalName);
    }
  }

  state.requestRender();
  return true;
}

type BookmarkRouteState = {
  bookmarkModal: {
    active: boolean;
    entries: Array<unknown>;
    moveUp: () => void;
    moveDown: () => void;
    getSelected: () => { key: string } | null;
    close: () => void;
    removeSelected: () => void;
    openSelectedFile: () => void;
    query: string;
    setQuery: (query: string) => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleBookmarkModalToken(state: BookmarkRouteState, token: InputToken): boolean {
  if (!state.bookmarkModal.active) return false;
  const modal = state.bookmarkModal;

  const act = (key: string): boolean => {
    if (key === 'd') {
      modal.removeSelected();
      if (modal.entries.length === 0) modal.close();
      return true;
    }
    if (key === 'o') {
      modal.openSelectedFile();
      return true;
    }
    return false;
  };

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'up') modal.moveUp();
    else if (token.logicalName === 'down') modal.moveDown();
    else if (token.logicalName === 'enter') {
      const entry = modal.getSelected();
      if (entry) state.commandContext?.jumpToBookmark?.(entry.key);
      modal.close();
    } else if (isTextBackspace(token.logicalName ?? '')) {
      if (modal.query.length > 0) modal.setQuery(modal.query.slice(0, -1));
    } else if (token.logicalName) {
      // Modified letters (CSI-u chords) fire their action whatever the query holds.
      act(token.logicalName);
    }
  } else if (token.type === 'text') {
    // The search row is always live: d and o act while it is empty, otherwise they are typed.
    const claimed = modal.query.length === 0 && (token.value === 'd' || token.value === 'o');
    if (claimed) act(token.value);
    else modal.setQuery(modal.query + token.value);
  }

  state.requestRender();
  return true;
}

type SettingsRouteState = {
  settingsModal: {
    active: boolean;
    editingMode: boolean;
    currentCategory: string;
    focusPane?: 'categories' | 'settings';
    commitEdit: () => void;
    toggleSelectedFlag: () => void;
    activateSelected: () => void;
    adjustSelected: (direction: 'left' | 'right', step?: number) => void;
    moveFocusedUp?: () => void;
    moveFocusedDown?: () => void;
    moveUp?: () => void;
    moveDown?: () => void;
    focusCategories?: () => void;
    focusSettings?: () => void;
    toggleFocusPane?: () => void;
    nextCategory: () => void;
    prevCategory?: () => void;
    editBackspace: () => void;
    editChar: (char: string) => void;
    pendingModelPickerTarget: import('./model-picker.ts').ModelPickerTarget | null;
    pendingProviderModelPickerTarget?: import('./model-picker.ts').ModelPickerTarget | null;
    pendingSettingsPickerAction?: 'tts-provider' | 'tts-voice' | 'daemon-timezone' | 'theme' | null;
    resetSelected?: () => { key: string; value: unknown } | null;
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    clearSearch: () => void;
    scrollContext?: (delta: number) => void;
  };
  commandContext?: CommandContext;
  /** Called when the settings modal requests the model picker for a non-main target. */
  openModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget) => void;
  /** Called when the settings modal requests provider selection before model selection. */
  openProviderModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget) => void;
  requestRender: () => void;
  handleEscape: () => void;
};

function syncRuntimeAfterSettingReset(ctx: CommandContext | undefined, key: string, value: unknown): void {
  if (!ctx) return;
  if (key === 'provider.model') ctx.session.runtime.model = String(value);
  if (key === 'provider.reasoningEffort') {
    // config holds the REQUESTED level; the session holds the EFFECTIVE one for
    // whichever model is serving, so the reset value is resolved rather than
    // copied straight across. A context with no reachable provider registry
    // (a surface that routes only through the provider API) stores the reset
    // value unresolved rather than failing the whole reset.
    const serving = ctx.provider?.providerRegistry?.getCurrentModel?.();
    ctx.session.runtime.reasoningEffort = serving
      ? servingEffortForLevel(String(value), toEffortModel(serving)).effective ?? ''
      : String(value);
  }
}

function consumeSettingsPickerRequest(state: SettingsRouteState): void {
  const settingsAction = state.settingsModal.pendingSettingsPickerAction ?? null;
  if (settingsAction !== null) {
    state.settingsModal.pendingSettingsPickerAction = null;
    if (!state.commandContext) return;
    if (settingsAction === 'tts-provider') {
      openTtsProviderPicker(state.commandContext);
      return;
    }
    if (settingsAction === 'daemon-timezone') {
      openDaemonTimezonePicker(state.commandContext);
      return;
    }
    if (settingsAction === 'theme') {
      openThemePicker(state.commandContext);
      return;
    }
    void openTtsVoicePicker(state.commandContext).catch((error: unknown) => {
      state.commandContext?.print(`Unable to list TTS voices: ${error instanceof Error ? error.message : String(error)}`);
      state.requestRender();
    });
    return;
  }

  const providerModelTarget = state.settingsModal.pendingProviderModelPickerTarget ?? null;
  if (providerModelTarget !== null) {
    state.settingsModal.pendingProviderModelPickerTarget = null;
    state.openProviderModelPickerWithTarget?.(providerModelTarget);
    return;
  }
  const pickerTarget = state.settingsModal.pendingModelPickerTarget;
  if (pickerTarget !== null) {
    state.settingsModal.pendingModelPickerTarget = null;
    state.openModelPickerWithTarget?.(pickerTarget);
  }
}

export function handleSettingsModalToken(state: SettingsRouteState, token: InputToken): boolean {
  if (!state.settingsModal.active) return false;

  // The search row is always live: printable text goes to the query. While
  // the query is non-empty the list shows ranked matches across every
  // category; clearing it returns to the category view. Space toggles the
  // selected setting only while the query is empty, and reset is ctrl+r, so
  // every letter can be searched for.
  const modal = state.settingsModal;
  const searching = modal.searchQuery.length > 0;
  const setQuery = (query: string): void => {
    if (query.length === 0) modal.clearSearch();
    else modal.setSearchQuery(query);
  };
  const activate = (): void => {
    if (modal.currentCategory === 'flags' && !searching) modal.toggleSelectedFlag();
    else {
      modal.activateSelected();
      consumeSettingsPickerRequest(state);
    }
  };

  if (token.type === 'key') {
    const focusPane = modal.focusPane ?? 'settings';
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter' || (token.logicalName === 'space' && !modal.editingMode && !searching)) {
      if (modal.editingMode) modal.commitEdit();
      else if (focusPane === 'categories' && !searching) modal.focusSettings?.();
      else activate();
    } else if (token.logicalName === 'space' && searching && !modal.editingMode) {
      setQuery(`${modal.searchQuery} `);
    } else if ((token.logicalName === 'left' || token.logicalName === 'right') && !modal.editingMode && !searching) {
      if (token.logicalName === 'left') modal.focusCategories?.();
      else modal.focusSettings?.();
    } else if (token.logicalName === 'up') {
      if (searching) modal.moveUp?.();
      else if (modal.moveFocusedUp) modal.moveFocusedUp();
      else modal.moveUp?.();
    } else if (token.logicalName === 'down') {
      if (searching) modal.moveDown?.();
      else if (modal.moveFocusedDown) modal.moveFocusedDown();
      else modal.moveDown?.();
    } else if ((token.logicalName === 'pageup' || token.logicalName === 'pagedown') && !modal.editingMode) {
      modal.scrollContext?.(token.logicalName === 'pageup' ? -3 : 3);
    } else if (token.logicalName === 'r' && token.ctrl && !modal.editingMode) {
      const reset = modal.resetSelected?.();
      if (reset) syncRuntimeAfterSettingReset(state.commandContext, reset.key, reset.value);
    } else if (token.logicalName === 'tab' && !searching) {
      if (modal.toggleFocusPane) modal.toggleFocusPane();
      else if (focusPane === 'categories') modal.focusSettings?.();
      else modal.focusCategories?.();
    } else if (isTextBackspace(token.logicalName ?? '')) {
      if (modal.editingMode) modal.editBackspace();
      else if (searching) setQuery(modal.searchQuery.slice(0, -1));
    }
  } else if (token.type === 'text') {
    if (modal.editingMode) {
      // An inline edit takes priority over search: characters go to the edit buffer.
      modal.editChar(token.value);
    } else if (searching) {
      setQuery(modal.searchQuery + token.value);
    } else if (token.value === ' ') {
      if ((modal.focusPane ?? 'settings') === 'categories') modal.focusSettings?.();
      else activate();
    } else if (token.value !== '/') {
      // '/' used to arm search; search is always live, so it is ignored as a first character.
      setQuery(token.value);
    }
  }

  state.requestRender();
  return true;
}

type SessionPickerRouteState = {
  sessionPickerModal: {
    active: boolean;
    loadSelected: (conversationManager: CommandContext['session']['conversationManager']) => void;
    moveUp: () => void;
    moveDown: () => void;
    deleteSelected: () => void;
    query: string;
    setQuery: (query: string) => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleSessionPickerToken(state: SessionPickerRouteState, token: InputToken): boolean {
  if (!state.sessionPickerModal.active) return false;
  const modal = state.sessionPickerModal;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      const conversationManager = state.commandContext?.session.conversationManager;
      if (conversationManager) {
        modal.loadSelected(conversationManager);
      }
    } else if (token.logicalName === 'up') modal.moveUp();
    else if (token.logicalName === 'down') modal.moveDown();
    else if (isTextBackspace(token.logicalName ?? '')) modal.setQuery(modal.query.slice(0, -1));
    else if (token.logicalName === 'd' && !token.ctrl && modal.query.length === 0) modal.deleteSelected();
  } else if (token.type === 'text') {
    // The search row is always live: d asks about deleting while it is empty, otherwise it is typed.
    if (token.value === 'd' && modal.query.length === 0) modal.deleteSelected();
    else modal.setQuery(modal.query + token.value);
  }

  state.requestRender();
  return true;
}

type ProfilePickerRouteState = {
  profilePickerModal: {
    active: boolean;
    loadSelected: (configManager: CommandContext['platform']['configManager']) => void;
    moveUp: () => void;
    moveDown: () => void;
    deleteSelected: () => void;
    saveCurrentAs: (name: string, configManager: CommandContext['platform']['configManager']) => void;
    query: string;
    setQuery: (query: string) => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleProfilePickerToken(state: ProfilePickerRouteState, token: InputToken): boolean {
  if (!state.profilePickerModal.active) return false;
  const modal = state.profilePickerModal;

  const saveCurrent = (): void => {
    if (state.commandContext?.platform.configManager) {
      const name = `profile-${Date.now()}`;
      modal.saveCurrentAs(name, state.commandContext.platform.configManager);
    }
  };
  const act = (key: string): void => {
    if (key === 'd') modal.deleteSelected();
    else if (key === 's') saveCurrent();
  };

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      if (state.commandContext?.platform.configManager) {
        modal.loadSelected(state.commandContext.platform.configManager);
      }
    } else if (token.logicalName === 'up') modal.moveUp();
    else if (token.logicalName === 'down') modal.moveDown();
    else if (isTextBackspace(token.logicalName ?? '')) {
      if (modal.query.length > 0) modal.setQuery(modal.query.slice(0, -1));
    } else if (token.logicalName) act(token.logicalName);
  } else if (token.type === 'text') {
    // The search row is always live: d and s act while it is empty, otherwise they are typed.
    if (modal.query.length === 0 && (token.value === 'd' || token.value === 's')) act(token.value);
    else modal.setQuery(modal.query + token.value);
  }

  state.requestRender();
  return true;
}
