/**
 * Pins for buildEnterSequence / buildExitSequence, main.ts's terminal
 * enter/restore sequencing. Mirrors goodvibes-tui's
 * src/test/runtime/process-lifecycle-restore.test.ts pins: the exit teardown
 * must never wipe the user's scrollback (ESC[3J) and must show the cursor
 * only AFTER the screen switch, so it applies to the screen the shell prompt
 * lands on.
 *
 * Regression context: main.ts's exit path used to write CLEAR_SCREEN (which
 * included ESC[3J) both standalone (no-alt-screen path) and ahead of the
 * alt-screen exit, and wrote CURSOR_SHOW before the screen switch instead of
 * after it.
 */
import { describe, expect, test } from 'bun:test';
import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_EXIT,
  CLEAR_VIEWPORT_HOME,
  CURSOR_HIDE,
  CURSOR_SHOW,
  FOCUS_DISABLE,
  FOCUS_ENABLE,
  KEYBOARD_EXT_DISABLE,
  KEYBOARD_EXT_ENABLE,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  PASTE_DISABLE,
  PASTE_ENABLE,
  buildEnterSequence,
  buildExitSequence,
} from '../../renderer/terminal-escapes.ts';

describe('buildExitSequence', () => {
  test('alt-screen path: leaves the alt screen, shows the cursor AFTER the switch, never touches scrollback', () => {
    const out = buildExitSequence(false);

    expect(out).toContain(ALT_SCREEN_EXIT);
    expect(out).not.toContain('\x1b[3J'); // never wipe the user's scrollback
    expect(out).not.toContain(CLEAR_VIEWPORT_HOME); // no pointless-and-harmful clear before leaving the alt screen
    expect(out.indexOf(CURSOR_SHOW)).toBeGreaterThan(out.indexOf(ALT_SCREEN_EXIT));
    for (const seq of [PASTE_DISABLE, KEYBOARD_EXT_DISABLE, MOUSE_DISABLE, FOCUS_DISABLE]) {
      expect(out).toContain(seq);
    }
  });

  test('no-alt-screen path: clears the painted-over screen without 3J and without an alt-screen exit', () => {
    const out = buildExitSequence(true);

    expect(out).toContain(CLEAR_VIEWPORT_HOME);
    expect(out).toContain('\x1b[2J\x1b[H');
    expect(out).not.toContain('\x1b[3J');
    expect(out).not.toContain(ALT_SCREEN_EXIT);
    expect(out.indexOf(CURSOR_SHOW)).toBeGreaterThan(out.indexOf(CLEAR_VIEWPORT_HOME));
  });

  test('cursor-show is always the last thing written', () => {
    expect(buildExitSequence(false).endsWith(CURSOR_SHOW)).toBe(true);
    expect(buildExitSequence(true).endsWith(CURSOR_SHOW)).toBe(true);
  });
});

describe('buildEnterSequence', () => {
  test('alt-screen path: enters the alt screen, clears without 3J, hides the cursor, enables input modes', () => {
    const out = buildEnterSequence(false);

    expect(out).toContain(ALT_SCREEN_ENTER);
    expect(out).toContain(CLEAR_VIEWPORT_HOME);
    expect(out).not.toContain('\x1b[3J'); // scrollback is never wiped, even at entry
    for (const seq of [CURSOR_HIDE, MOUSE_ENABLE, KEYBOARD_EXT_ENABLE, PASTE_ENABLE, FOCUS_ENABLE]) {
      expect(out).toContain(seq);
    }
  });

  test('no-alt-screen path: skips the alt-screen enter sequence', () => {
    const out = buildEnterSequence(true);

    expect(out).not.toContain(ALT_SCREEN_ENTER);
    expect(out).not.toContain('\x1b[3J');
    expect(out).toContain(CLEAR_VIEWPORT_HOME);
  });
});

describe('CLEAR_VIEWPORT_HOME', () => {
  test('is exactly 2J + cursor-home: never 3J', () => {
    expect(CLEAR_VIEWPORT_HOME).toBe('\x1b[2J\x1b[H');
  });
});
