/**
 * terminal-paint-window.ts, the window in which the shell owns the screen.
 *
 * A full-screen app may paint only between two moments: the write that switches
 * the terminal onto this app's screen, and the write that hands the terminal
 * back. main.ts already refused to paint after the second one. It did not
 * refuse before the first, and boot wiring reaches render() there:
 * installVoiceCapture() applies the wake configuration inline, and the
 * listener's first phase change repaints, all synchronously, several
 * statements before the enter sequence is written.
 *
 * That one early frame did two visible things.
 *
 * It painted a complete UI onto the screen the SHELL owns, which is the screen
 * revealed again when the app leaves the alternate one at exit. The user got
 * their prompt back underneath a full copy of the agent, with the scrollback it
 * had overwritten gone.
 *
 * And it left the compositor holding a front buffer that described a screen the
 * app was about to leave. The enter sequence switches to a BLANK alternate
 * screen, so every cell the compositor believed was already painted was in fact
 * absent, and being believed present, it was diffed away and never sent. The
 * surface came up without its header, its header, its status line or
 * its section headings, with characters missing from the middle of words where
 * the two screens happened to agree. Anything that reset the diff, a resize,
 * Ctrl+L, the theme probe's repaint, healed it, which is why it looked like a
 * boot-only glitch that fixed itself.
 *
 * So this module owns both halves as one fact: the window opens by writing the
 * enter sequence and discarding the compositor's idea of the terminal (entering
 * invalidates every cell it thinks it painted), and it closes for good on the
 * way out. `isOpen()` is what render() consults, and it is false at both ends.
 */

export interface TerminalPaintWindowDeps {
  /**
   * Write the bytes that put the terminal into this app's screen and input
   * modes. Called once, by open().
   */
  readonly enter: () => void;
  /**
   * Discard everything the compositor believes is currently on the terminal, so
   * the next frame is painted in full rather than diffed against a screen the
   * app has just left. Called by open(), immediately after enter().
   */
  readonly discardCompositorState: () => void;
}

export interface TerminalPaintWindow {
  /** Enter the terminal and open the window. Repeat calls do nothing. */
  readonly open: () => void;
  /**
   * Close the window permanently. Called before the terminal-restore write, so
   * no frame composed afterwards can reach the screen the shell is getting
   * back. A window that has been closed never reopens.
   */
  readonly close: () => void;
  /** True only while this app owns the screen. */
  readonly isOpen: () => boolean;
}

export function createTerminalPaintWindow(deps: TerminalPaintWindowDeps): TerminalPaintWindow {
  let state: 'before' | 'open' | 'closed' = 'before';

  return {
    open: (): void => {
      if (state !== 'before') return;
      deps.enter();
      deps.discardCompositorState();
      // Flipped last: nothing may paint until both of the above have happened.
      state = 'open';
    },
    close: (): void => {
      state = 'closed';
    },
    isOpen: (): boolean => state === 'open',
  };
}
