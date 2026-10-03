/**
 * terminal-escapes, the raw control sequences main.ts writes to enter/leave the
 * TUI's terminal mode (alt screen, mouse, cursor, keyboard-extension, paste, and
 * focus reporting). Extracted as plain constants so callers share one definition
 * and the entry file stays within the source-file line-count gate.
 *
 * ALT_SCREEN_ENTER / ALT_SCREEN_EXIT / MOUSE_* / CURSOR_* / KEYBOARD_EXT_* /
 * PASTE_* / CLEAR_VIEWPORT_HOME: re-exported byte-for-byte from
 * @goodvibes-jev/engine/terminal-shell's TERMINAL_ESCAPES so this app and the TUI
 * cannot drift on the bytes (mechanical swap from a previously-inlined local
 * copy, see main.ts history and the package's terminal-lifecycle module docs).
 *
 * There used to be a local CLEAR_SCREEN constant here that appended ESC[3J
 * (scrollback erase) after ESC[2J. That sequence must never be written by this
 * app: 3J wipes the user's PRIMARY-screen scrollback on several emulators even
 * when issued mid-session or from the alt screen, and main.ts's exit teardown
 * was doing exactly that. CLEAR_VIEWPORT_HOME (2J + cursor-home, no 3J) is the
 * only clear this app ever writes now, for both the entry-time paint and the
 * no-alt-screen restore path.
 *
 * FOCUS_ENABLE / FOCUS_DISABLE (DECSET ?1004) are the shared home for the OS
 * window-focus reporting mode consumed by the focus-tracker: the focus-mode
 * module (shell/terminal-focus-mode.ts) imports FOCUS_ENABLE from here rather
 * than redefining it. The terminal-shell package does not define these, so
 * they stay local literals.
 */

import { TERMINAL_ESCAPES } from '@goodvibes-jev/engine/terminal-shell';

export const ALT_SCREEN_ENTER = TERMINAL_ESCAPES.ALT_SCREEN_ENTER;
export const ALT_SCREEN_EXIT = TERMINAL_ESCAPES.ALT_SCREEN_EXIT;
export const MOUSE_ENABLE = TERMINAL_ESCAPES.MOUSE_ENABLE;
export const MOUSE_DISABLE = TERMINAL_ESCAPES.MOUSE_DISABLE;
export const CURSOR_HIDE = TERMINAL_ESCAPES.CURSOR_HIDE;
export const CURSOR_SHOW = TERMINAL_ESCAPES.CURSOR_SHOW;
export const KEYBOARD_EXT_ENABLE = TERMINAL_ESCAPES.KEYBOARD_EXT_ENABLE;
export const KEYBOARD_EXT_DISABLE = TERMINAL_ESCAPES.KEYBOARD_EXT_DISABLE;
export const PASTE_ENABLE = TERMINAL_ESCAPES.PASTE_ENABLE;
export const PASTE_DISABLE = TERMINAL_ESCAPES.PASTE_DISABLE;
/** Clear viewport + home the cursor, WITHOUT ESC[3J. Never wipes scrollback. */
export const CLEAR_VIEWPORT_HOME = TERMINAL_ESCAPES.CLEAR_VIEWPORT_HOME;

export const FOCUS_ENABLE = '\x1b[?1004h';
export const FOCUS_DISABLE = '\x1b[?1004l';

/**
 * The bytes main.ts writes to enter terminal mode: alt screen (unless
 * disabled), clear + home (no 3J), cursor hidden, then the input modes.
 */
export function buildEnterSequence(noAltScreen: boolean): string {
  return (noAltScreen ? '' : ALT_SCREEN_ENTER)
    + CLEAR_VIEWPORT_HOME
    + CURSOR_HIDE
    + MOUSE_ENABLE
    + KEYBOARD_EXT_ENABLE
    + PASTE_ENABLE
    + FOCUS_ENABLE;
}

/**
 * The bytes main.ts writes to restore the terminal on exit: input modes off,
 * then the screen switch, then cursor-show LAST so visibility applies to the
 * screen the shell prompt actually lands on.
 *
 * Alt-screen path: just leave the alt screen, 1049l restores the primary
 * screen and cursor exactly as they were at launch. Clearing first is
 * pointless (the alt screen is discarded) and actively harmful (3J wipes the
 * primary scrollback even when issued from the alt screen).
 *
 * No-alt path: the compositor painted over the primary screen, so clear the
 * viewport and home the cursor, but WITHOUT 3J, the user's scrollback is
 * theirs.
 */
export function buildExitSequence(noAltScreen: boolean): string {
  const exitScreen = noAltScreen ? CLEAR_VIEWPORT_HOME : ALT_SCREEN_EXIT;
  return PASTE_DISABLE + KEYBOARD_EXT_DISABLE + MOUSE_DISABLE + FOCUS_DISABLE
    + exitScreen + CURSOR_SHOW;
}
