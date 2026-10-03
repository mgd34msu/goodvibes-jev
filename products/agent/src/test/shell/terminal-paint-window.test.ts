/**
 * terminal-paint-window.test.ts
 *
 * The agent booted into a garbled surface, no header, no header rule, no
 * sidebar divider, no '◆ Recent' heading, characters missing from the middle of
 * words, and after /quit the shell got its screen back with a full copy of the
 * agent's UI painted on it and its own scrollback gone. Captured at 192x52 in
 * tmux against the compiled 2.0.9 binary; both symptoms came from ONE frame
 * painted a few milliseconds too early.
 *
 * main.ts wires installVoiceCapture() several statements before it writes the
 * enter sequence, and that call reaches the wake listener's first phase change
 *, and so render(), synchronously, while the app is still on the screen the
 * SHELL owns. Those bytes landed on the primary screen (revealed again at exit),
 * and they left the compositor holding a front buffer describing a screen the
 * app was about to leave, so every later frame was diffed against a screen that
 * was no longer on the terminal and the matching cells were never sent.
 *
 * These tests pin the fix without a terminal: the paint window's contract, and
 * the compositor mechanism that made a stale front buffer visible as garble.
 */

import { describe, expect, test } from 'bun:test';
import { createTerminalPaintWindow } from '../../shell/terminal-paint-window.ts';
import { Compositor } from '../../renderer/compositor.ts';
import { createStyledCell } from '@goodvibes-jev/engine/sdk/platform/types';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CompositeRequest } from '../../renderer/compositor.ts';

function makeWindow() {
  const calls: string[] = [];
  const window = createTerminalPaintWindow({
    enter: () => { calls.push('enter'); },
    discardCompositorState: () => { calls.push('discard'); },
  });
  return { window, calls };
}

describe('the paint window is shut at both ends of the session', () => {
  test('nothing may paint before the terminal has been entered', () => {
    const { window } = makeWindow();
    expect(window.isOpen()).toBe(false);
  });

  test('opening enters the terminal and only then admits frames', () => {
    const { window, calls } = makeWindow();
    window.open();
    expect(calls).toEqual(['enter', 'discard']);
    expect(window.isOpen()).toBe(true);
  });

  test('opening discards the compositor state, because entering invalidates every cell it believes it painted', () => {
    const { window, calls } = makeWindow();
    window.open();
    // After the enter write, never before: the discard belongs to the new screen.
    expect(calls.indexOf('discard')).toBeGreaterThan(calls.indexOf('enter'));
  });

  test('opening twice enters once', () => {
    const { window, calls } = makeWindow();
    window.open();
    window.open();
    expect(calls).toEqual(['enter', 'discard']);
  });

  test('closing shuts the window for good: a late frame cannot follow the terminal-restore write', () => {
    const { window, calls } = makeWindow();
    window.open();
    window.close();
    expect(window.isOpen()).toBe(false);
    window.open();
    expect(window.isOpen()).toBe(false);
    expect(calls).toEqual(['enter', 'discard']);
  });

  test('closing before the window ever opened stays closed', () => {
    const { window, calls } = makeWindow();
    window.close();
    window.open();
    expect(window.isOpen()).toBe(false);
    expect(calls).toEqual([]);
  });
});

const WIDTH = 40;
const HEIGHT = 10;

function makeLine(char: string): Line {
  return Array.from({ length: WIDTH }, () => createStyledCell(char));
}

function makeFrame(): CompositeRequest {
  return {
    width: WIDTH,
    height: HEIGHT,
    header: [makeLine('H')],
    viewport: Array.from({ length: 8 }, () => makeLine('.')),
    footer: [makeLine('F')],
  };
}

function makeRecordingCompositor() {
  const writes: string[] = [];
  const stream = { write: (data: string) => { writes.push(data); return true; } };
  return { compositor: new Compositor(stream as unknown as NodeJS.WriteStream), writes };
}

describe('why an early frame showed up as garble', () => {
  test('a frame composited before the screen switch makes the next frame omit everything unchanged', () => {
    const { compositor, writes } = makeRecordingCompositor();

    // The early frame, the one the wake listener triggered. It lands on the
    // screen the shell owns.
    compositor.composite(makeFrame());
    expect(writes.join('')).toContain('H');
    expect(writes.join('')).toContain('F');

    // The enter sequence switches to a blank alternate screen. Without a
    // discard, the compositor still believes the frame above is on the terminal.
    writes.length = 0;
    compositor.composite(makeFrame());
    const onTheNewScreen = writes.join('');

    // The defect, in bytes: the header and footer the user should see are not
    // sent at all, because they were diffed away against a screen that is no
    // longer there.
    expect(onTheNewScreen).not.toContain('H');
    expect(onTheNewScreen).not.toContain('F');
  });

  test('discarding the compositor state on entry restores a full first paint', () => {
    const { compositor, writes } = makeRecordingCompositor();

    compositor.composite(makeFrame());
    // What the paint window now does at the moment of entry.
    compositor.resetDiff();

    writes.length = 0;
    compositor.composite(makeFrame());
    const firstFrameOnTheNewScreen = writes.join('');

    expect(firstFrameOnTheNewScreen).toContain('H');
    expect(firstFrameOnTheNewScreen).toContain('F');
    expect(firstFrameOnTheNewScreen).toContain('.');
  });
});
