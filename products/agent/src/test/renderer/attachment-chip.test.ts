/**
 * An attached image is visible in the composer as a chip, not only as the
 * bracketed marker sitting inside the prompt text.
 *
 * The composer received `composerFlags` and used to throw them
 * away, so the sole evidence that a message carried an image was the literal
 * `[IMAGE: img1, clipboard, 12KB]` text in the prompt, which reads as
 * something you typed, not as an attachment the next message will carry.
 */
import { describe, expect, test } from 'bun:test';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';

function textOf(lines: Line[]): string {
  return lines.map(line => line.map(cell => cell.char).join('')).join('\n');
}

function footer(flags: readonly string[] | undefined): string {
  return textOf(buildShellFooter({
    width: 100,
    promptText: 'what is in this picture?',
    promptLineCount: 1,
    usage: { up: 0, down: 0 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'some-model',
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    composerMode: 'prompt',
    composerFlags: flags,
    composerPendingRisk: 'none',
  }).lines);
}

describe('composer attachment chip', () => {
  test('an attached image is announced in plain words', () => {
    expect(footer(['attachments'])).toContain('image attached');
  });

  test('no chip appears when nothing is attached', () => {
    expect(footer([])).not.toContain('image attached');
    expect(footer(undefined)).not.toContain('image attached');
  });

  test('the chip shows alongside other flags without dragging them into view', () => {
    const rendered = footer(['shell', 'attachments']);
    expect(rendered).toContain('image attached');
    // The status line stays compact: the flag list itself is still withheld,
    // as shell-surface.test.ts pins. Only the attachment earns a chip.
    expect(rendered).not.toContain('flags:');
    expect(rendered).not.toContain('shell,attachments');
  });

  test('flags unrelated to attachments render nothing at all', () => {
    const rendered = footer(['approval']);
    expect(rendered).not.toContain('image attached');
    expect(rendered).not.toContain('flags:');
    expect(rendered).not.toContain('approval');
  });
});
