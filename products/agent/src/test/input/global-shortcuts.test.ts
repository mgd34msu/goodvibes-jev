import { describe, expect, mock, test } from 'bun:test';
import { handleGlobalShortcutToken, type GlobalShortcutRouteState } from '../../input/handler-shortcuts.ts';

function buildState(overrides: Partial<GlobalShortcutRouteState> = {}): GlobalShortcutRouteState {
  return {
    keybindingsManager: {
      matches: (action: string, token: { logicalName?: string; ctrl?: boolean }) =>
        action === 'workspace-picker' && token.logicalName === 'p' && !!token.ctrl,
      // lookup: O(1) inverted-map equivalent used by the refactored handler.
      lookup: (token: { logicalName?: string; ctrl?: boolean }) =>
        token.logicalName === 'p' && !!token.ctrl ? 'workspace-picker' : null,
    } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    prompt: '',
    cursorPos: 0,
    commandMode: false,
    autocomplete: null,
    historySearch: { open: mock(() => {}) } as unknown as GlobalShortcutRouteState['historySearch'],
    searchManager: { active: false, open: mock(() => {}), close: mock(() => {}) } as unknown as GlobalShortcutRouteState['searchManager'],
    conversationManager: null,
    commandContext: { openWorkspacePicker: mock(() => {}), clearScreen: mock(() => {}), openActivityModal: mock(() => {}) } as unknown as NonNullable<GlobalShortcutRouteState['commandContext']>,
    contentWidth: 80,
    getScrollTop: () => 0,
    getWrappedPromptInfo: () => ({ wrappedLines: [''], segments: [{ rawStart: 0, length: 0 }], cursorWrappedLine: 0 }),
    saveUndoState: mock(() => {}),
    requestRender: mock(() => {}),
    scroll: mock(() => {}),
    ensureInputCursorVisible: mock(() => {}),
    handleCopy: mock(() => {}),
    handleCtrlC: mock(() => {}),
    handleBlockCopy: mock(() => {}),
    handleBookmark: mock(() => {}),
    handleBlockSave: mock(() => {}),
    handleUndo: mock(() => {}),
    handleRedo: mock(() => {}),
    handlePaste: mock(() => {}),
    handleEscape: mock(() => {}),
    cycleAgentWorkspaceCategory: mock(() => {}),
    dismissAgentWorkspace: mock(() => false),
    ...overrides,
  };
}

describe('handleGlobalShortcutToken', () => {
  test('workspace-picker opens the Agent workspace', () => {
    const state = buildState();
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x10', logicalName: 'p', ctrl: true, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(true);
    expect(state.commandContext?.openWorkspacePicker).toHaveBeenCalled();
    expect(state.requestRender).toHaveBeenCalled();
  });

  test('workspace-close dismisses the Agent workspace', () => {
    const state = buildState({
      keybindingsManager: {
        matches: () => false,
        lookup: () => 'workspace-close',
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
      dismissAgentWorkspace: mock(() => true),
    });

    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x18', logicalName: 'x', ctrl: true, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(true);
    expect(state.dismissAgentWorkspace).toHaveBeenCalled();
  });

  test('activity-open (ctrl+o) opens the Activity modal', () => {
    const state = buildState({
      keybindingsManager: {
        matches: () => false,
        lookup: () => 'activity-open',
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    });

    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x0f', logicalName: 'o', ctrl: true, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(true);
    expect(state.commandContext?.openActivityModal).toHaveBeenCalled();
  });

  test('bare escape routes to the escape handler', () => {
    const state = buildState();
    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x1b', logicalName: 'escape', ctrl: false, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(true);
    expect(state.handleEscape).toHaveBeenCalled();
  });

  test('page keys scroll the conversation', () => {
    const state = buildState();

    const pageUpHandled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x1b[5~', logicalName: 'pageup', ctrl: false, shift: false, meta: false },
      24,
    );
    const pageDownHandled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x1b[6~', logicalName: 'pagedown', ctrl: false, shift: false, meta: false },
      24,
    );

    expect(pageUpHandled).toBe(true);
    expect(pageDownHandled).toBe(true);
    expect(state.scroll).toHaveBeenCalledTimes(2);
  });

  test('Ctrl+A moves to line start without invoking build or edit actions', () => {
    const state = buildState({
      prompt: 'hello\nworld',
      cursorPos: 9,
      contentWidth: 80,
      keybindingsManager: {
        matches: () => false,
        lookup: () => 'line-start',
      } as unknown as GlobalShortcutRouteState['keybindingsManager'],
      getWrappedPromptInfo: () => ({
        wrappedLines: ['hello', 'world'],
        segments: [
          { rawStart: 0, length: 5 },
          { rawStart: 6, length: 5 },
        ],
        cursorWrappedLine: 1,
      }),
    });

    const handled = handleGlobalShortcutToken(
      state,
      { type: 'key', name: '\x01', logicalName: 'a', ctrl: true, shift: false, meta: false },
      24,
    );

    expect(handled).toBe(true);
    expect(state.cursorPos).toBe(6);
    expect(state.ensureInputCursorVisible).toHaveBeenCalled();
  });
});
