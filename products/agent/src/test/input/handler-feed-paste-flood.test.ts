/**
 * Integration tests, the paste-flood guard and the OS-focus tracker as
 * wired into feedInputTokens (handler-feed.ts). The guard sits above
 * command-mode's key-driven dispatch (handleCommandModeToken), never the
 * composer's free-text capture (handlePromptTextToken), which stays exempt:
 * the composer absorbs pasted or typed text by plain insertion.
 * These tests drive the real handler.feed() -> InputTokenizer ->
 * feedInputTokens path end to end, the same path production stdin data takes.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { spyOn } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { AutocompleteEngine } from '../../input/autocomplete.ts';

function makeCommandContext(printed: string[]): CommandContext {
  const conversationManager = { log: () => {} } as never;
  return {
    session: { conversationManager, runtime: {} as never },
    provider: { providerRegistry: {} as never },
    workspace: {},
    platform: { config: {} as never, configManager: {} as never },
    ops: {},
    extensions: { toolRegistry: {} as never, mcpRegistry: {} as never },
    renderRequest: () => {},
    submitInput: () => {},
    executeCommand: async () => false,
    cancelGeneration: () => {},
    clearScreen: () => {},
    requestPermission: async () => ({ approved: false } as never),
    completeModelSelection: () => {},
    jumpToBookmark: () => {},
    scrollToLine: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  } as unknown as CommandContext;
}

function makeInput(printed: string[]): InputHandler {
  const sel = new SelectionManager();
  const history = new InfiniteBuffer();
  const ih = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());
  ih.setContentWidth(40);
  const registry = new CommandRegistry();
  registry.register({ name: 'help', description: 'help', handler: async () => {} });
  ih.setCommandRegistry(registry, makeCommandContext(printed));
  return ih;
}

describe('feedInputTokens: the composer\'s free-text capture is NEVER guarded (product parity with the TUI\'s own unguarded composer)', () => {
  test('a >8-char command string fed in one call is not truncated: no false-positive flood (regression coverage)', () => {
    const printed: string[] = [];
    const ih = makeInput(printed);
    ih.feed('/config display.stream');
    expect(ih.prompt).toBe('/config display.stream');
    expect(printed.some((line) => line.includes('flood'))).toBe(false);
  });

  test('20 ordinary chat characters fed one at a time (rapid, same millisecond) are never guarded: plain text insertion is unconditionally exempt', () => {
    const printed: string[] = [];
    const ih = makeInput(printed);
    let realNow: typeof Date.now | undefined;
    try {
      let clock = 5_000_000;
      realNow = Date.now;
      Date.now = () => clock;
      for (let i = 0; i < 20; i++) {
        clock = 5_000_000 + i;
        ih.feed('a');
      }
    } finally {
      if (realNow) Date.now = realNow;
    }
    expect(ih.prompt).toBe('a'.repeat(20));
    expect(printed.some((line) => line.includes('flood'))).toBe(false);
  });
});

describe('feedInputTokens: command-mode key-dispatch flood guard', () => {
  let realNow: typeof Date.now;
  let clock = 1_000_000;

  beforeEach(() => {
    realNow = Date.now;
    Date.now = () => clock;
  });

  afterEach(() => {
    Date.now = realNow;
  });

  test('a 20-key burst while commandMode is armed is guarded: at most 8 land, and the notice is honest (never silent)', () => {
    const printed: string[] = [];
    const ih = makeInput(printed);
    ih.feed('/help'); // arms commandMode; autocomplete becomes active, never closes on 'up'/'down'
    expect(ih.commandMode).toBe(true);

    const moveUpSpy = spyOn(AutocompleteEngine.prototype, 'moveUp');
    for (let i = 0; i < 20; i++) {
      clock = 1_000_000 + i; // 1ms apart, far beyond sustained human typing
      ih.feed('\x1b[A'); // up arrow, commandMode's autocomplete navigation, never closes commandMode
    }
    expect(ih.commandMode).toBe(true); // never force-closed by the flood
    expect(moveUpSpy.mock.calls.length).toBeLessThanOrEqual(8);
    expect(moveUpSpy.mock.calls.length).toBeGreaterThan(0);
    expect(printed.some((line) => line.includes('flood detected'))).toBe(true);
    moveUpSpy.mockRestore();
  });

  test('6 rapid command-mode keys under the threshold all dispatch: normal autocomplete navigation is unaffected', () => {
    const printed: string[] = [];
    const ih = makeInput(printed);
    ih.feed('/help');
    const moveUpSpy = spyOn(AutocompleteEngine.prototype, 'moveUp');
    for (let i = 0; i < 6; i++) {
      clock = 2_000_000 + i;
      ih.feed('\x1b[A');
    }
    expect(moveUpSpy.mock.calls.length).toBe(6);
    expect(printed.some((line) => line.includes('flood'))).toBe(false);
    moveUpSpy.mockRestore();
  });

  test('key tokens outside commandMode (ordinary composer navigation) are never guarded: no new friction in the default interaction mode', () => {
    const printed: string[] = [];
    const ih = makeInput(printed);
    ih.feed('hello world'); // plain chat text, commandMode stays false
    expect(ih.commandMode).toBe(false);
    for (let i = 0; i < 20; i++) {
      clock = 3_000_000 + i;
      ih.feed('\x1b[D'); // left arrow, plain composer cursor movement, not command-mode dispatch
    }
    expect(printed.some((line) => line.includes('flood'))).toBe(false);
  });

  test('the burst clears after a quiet gap and reports how many keystrokes it suppressed', () => {
    const printed: string[] = [];
    const ih = makeInput(printed);
    ih.feed('/help');
    for (let i = 0; i < 15; i++) {
      clock = 4_000_000 + i;
      ih.feed('\x1b[A');
    }
    expect(printed.some((line) => line.includes('flood detected'))).toBe(true);
    // A quiet gap (> PASTE_FLOOD_WINDOW_MS since the last qualifying token) clears it.
    clock = 4_000_000 + 15 + 200;
    ih.feed('\x1b[A');
    expect(printed.some((line) => /flood cleared: suppressed \d+ keystroke/.test(line))).toBe(true);
  });
});

describe('feedInputTokens: OS focus tokens', () => {
  test('a focus-in/focus-out escape sequence updates the shared FocusTracker and never reaches the composer', () => {
    const printed: string[] = [];
    const ih = makeInput(printed);
    ih.feed('\x1b[O'); // focus-out (CSI ?1004h reporting)
    expect(ih.uiServices.platform.focusTracker.isFocused()).toBe(false);
    expect(ih.prompt).toBe(''); // never dispatched as text/keys

    ih.feed('\x1b[I'); // focus-in
    expect(ih.uiServices.platform.focusTracker.isFocused()).toBe(true);
    expect(ih.prompt).toBe('');
  });
});
