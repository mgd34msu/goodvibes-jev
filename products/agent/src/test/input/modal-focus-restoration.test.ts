import { describe, expect, test } from 'bun:test';
import { handleEscape, modalOpened } from '../../input/handler-modal-stack.ts';

function buildState() {
  return {
    helpOverlayActive: false,
    shortcutsOverlayActive: false,
    commandMode: false,
    modalStack: [] as string[],
    modalReturnFocus: 'prompt' as 'prompt' | 'indicator',
    indicatorFocused: false,
    prompt: '',
    cursorPos: 0,
    helpScrollOffset: 0,
    shortcutsScrollOffset: 0,
    requestRender: () => {},
    saveUndoState: () => {},
    cancelGeneration: undefined,
    selectionCallback: null,
    bookmarkModal: { active: false, open: function () { this.active = true; }, close: function () { this.active = false; } },
    liveTailModal: { active: false, open: () => {}, close: () => {} },
    settingsModal: { active: false, editingMode: false, cancelEdit: () => {}, open: () => {}, close: () => {} },
    sessionPickerModal: { active: false, open: () => {}, close: () => {} },
    profilePickerModal: { active: false, open: () => {}, close: () => {} },
    contextInspectorModal: { active: false, open: function () { this.active = true; }, close: function () { this.active = false; } },
    processModal: { active: false, open: function () { this.active = true; }, close: function () { this.active = false; } },
    modelPicker: { active: false, open: () => {}, close: () => {} },
    filePicker: { active: false, open: () => {}, close: () => {} },
    blockActionsMenu: { active: false, open: () => {}, close: () => {} },
    selectionModal: { active: false, open: () => {}, close: () => {} },
    autocompleteReset: () => {},
    autocompleteUpdate: (_query: string) => {},
  };
}

describe('modal focus restoration', () => {
  test('records prompt focus when the first modal opens from copied panel focus', () => {
    const state = buildState();
    state.helpOverlayActive = true;
    modalOpened(state, 'help');
    expect(state.modalReturnFocus).toBe('prompt');
  });

  test('returns to prompt focus when the last modal closes after copied panel focus', () => {
    const state = buildState();
    state.helpOverlayActive = true;
    modalOpened(state, 'help');
    const result = handleEscape(state);
    expect(result.indicatorFocused).toBe(false);
  });

  test('restores indicator focus when the last modal closes', () => {
    const state = buildState();
    state.indicatorFocused = true;
    state.processModal.active = true;
    modalOpened(state, 'process');
    const result = handleEscape(state);
    expect(result.indicatorFocused).toBe(true);
  });


  test('reopens command modal with the command list active again', () => {
    let autocompleteQuery = 'unchanged';
    const state = buildState();
    state.commandMode = true;
    modalOpened(state, 'command');
    state.commandMode = false;
    state.processModal.active = true;
    modalOpened(state, 'process');
    state.autocompleteUpdate = (query: string) => {
      autocompleteQuery = query;
    };

    const result = handleEscape(state);

    expect(state.modalStack).toEqual(['command']);
    expect(result.commandMode).toBe(true);
    expect(result.prompt).toBe('/');
    expect(result.cursorPos).toBe(1);
    expect(autocompleteQuery).toBe('');
  });

  test('escape closes only the top modal and reopens the previous modal', () => {
    const state = buildState();
    state.processModal.active = true;
    modalOpened(state, 'process');
    modalOpened(state, 'contextInspector');
    state.processModal.active = false;
    state.contextInspectorModal.active = true;

    const result = handleEscape(state);

    expect(state.modalStack).toEqual(['process']);
    expect(state.contextInspectorModal.active).toBe(false);
    expect(state.processModal.active).toBe(true);
    expect(result.indicatorFocused).toBe(false);
  });
});
