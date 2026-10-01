/**
 * Ctrl+V with an image on the system clipboard attaches the image.
 *
 * The pieces of this were all present and individually tested, the keybinding
 * (`'paste': [{ key: 'v', ctrl: true }]`), the clipboard read, the marker
 * insertion, and the expansion of that marker into an image ContentPart, but
 * nothing exercised them together through a real keystroke, and in between the
 * pieces the result was being thrown away.
 *
 * `feedInputTokens` snapshots `context.prompt` into the shortcut route state
 * BEFORE dispatching, and copies that state's prompt back afterwards. Paste,
 * undo and redo edit the InputHandler's prompt instead of the route state's,
 * so the copy-back wrote the pre-paste snapshot over the freshly inserted
 * marker. Every keystroke did exactly what it was supposed to and the composer
 * still came out empty, which is why Ctrl+V looked completely dead.
 *
 * These tests drive the raw control byte through `InputHandler.feed` so the
 * whole path is under test, not the middle of it.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager, InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';

const clipboardImage = { data: 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(400), mediaType: 'image/png' };
let imageOnClipboard: { data: string; mediaType: string } | null = clipboardImage;
let textOnClipboard = '';

/** The byte a terminal sends for Ctrl+V. */
const CTRL_V = '\x16';
/** The byte a terminal sends for Ctrl+Z. */
const CTRL_Z = '\x1a';

function makeInput(): InputHandler {
  const handler = new InputHandler(
    () => {}, new SelectionManager(), () => 0, () => 20,
    () => new InfiniteBuffer(), () => {}, () => {}, createDefaultUiRuntimeServices(),
  );
  handler.setContentWidth(80);
  // The composer must never reach for the machine's real clipboard in a test.
  handler.clipboardSource = {
    pasteImageFromClipboard: () => imageOnClipboard,
    pasteFromClipboard: () => textOnClipboard,
  };
  return handler;
}

describe('Ctrl+V with an image on the clipboard', () => {
  beforeEach(() => {
    imageOnClipboard = clipboardImage;
    textOnClipboard = '';
  });

  test('the image marker survives the keystroke and is visible in the composer', () => {
    const input = makeInput();
    expect(input.prompt).toBe('');

    input.feed(CTRL_V);

    // This is the assertion the defect failed: the prompt came back empty.
    expect(input.prompt).not.toBe('');
    expect(input.prompt).toMatch(/^\[IMAGE: img\d+, clipboard, \d+KB\]$/);
    expect(input.cursorPos).toBe(input.prompt.length);
  });

  test('the pasted image is held as a real attachment, not just marker text', () => {
    const input = makeInput();
    input.feed(CTRL_V);

    const attachments = input.getImageAttachments();
    expect(attachments.size).toBe(1);
    const [stored] = [...attachments.values()];
    expect(stored?.mediaType).toBe('image/png');
    expect(stored?.data).toBe(clipboardImage.data);
  });

  test('the attachment reaches the outgoing message as an image part', () => {
    const input = makeInput();
    input.feed(CTRL_V);
    // Type a question alongside the image, the way someone actually would.
    input.feed('what is this?');

    const expanded = input.expandPrompt(input.prompt);
    expect(Array.isArray(expanded)).toBe(true);
    const parts = expanded as { type: string; data?: string; mediaType?: string; text?: string }[];

    const image = parts.find(p => p.type === 'image');
    expect(image).toBeDefined();
    expect(image?.mediaType).toBe('image/png');
    expect(image?.data).toBe(clipboardImage.data);

    const text = parts.filter(p => p.type === 'text').map(p => p.text).join('');
    expect(text).toContain('what is this?');
    // The marker is an editing affordance, not something the model should read.
    expect(text).not.toContain('[IMAGE:');
  });

  test('pasting twice attaches both images', () => {
    const input = makeInput();
    input.feed(CTRL_V);
    input.feed(' and ');
    input.feed(CTRL_V);

    expect(input.getImageAttachments().size).toBe(2);
    const parts = input.expandPrompt(input.prompt) as { type: string }[];
    expect(parts.filter(p => p.type === 'image').length).toBe(2);
  });

  test('cursor position is preserved so typing continues after the marker', () => {
    const input = makeInput();
    input.feed('look: ');
    const beforePaste = input.cursorPos;
    input.feed(CTRL_V);

    expect(input.cursorPos).toBeGreaterThan(beforePaste);
    expect(input.prompt.startsWith('look: [IMAGE:')).toBe(true);

    input.feed('!');
    expect(input.prompt.endsWith(']!')).toBe(true);
  });
});

describe('Ctrl+V with no image on the clipboard', () => {
  beforeEach(() => {
    imageOnClipboard = null;
    textOnClipboard = '';
  });

  test('falls back to clipboard text', () => {
    textOnClipboard = 'pasted words';
    const input = makeInput();
    input.feed(CTRL_V);

    expect(input.prompt).toBe('pasted words');
    expect(input.getImageAttachments().size).toBe(0);
  });

  test('an empty clipboard leaves the composer untouched', () => {
    const input = makeInput();
    input.feed('typed already');
    input.feed(CTRL_V);

    expect(input.prompt).toBe('typed already');
  });
});

describe('the same copy-back path for undo', () => {
  beforeEach(() => {
    imageOnClipboard = null;
    textOnClipboard = '';
  });

  test('Ctrl+Z after a paste actually removes what was pasted', () => {
    textOnClipboard = 'some pasted text';
    const input = makeInput();
    input.feed('keep this ');
    input.feed(CTRL_V);
    expect(input.prompt).toBe('keep this some pasted text');

    input.feed(CTRL_Z);

    // Undo edits the handler's prompt through the same route paste does, so it
    // was silently discarded in exactly the same way.
    expect(input.prompt).toBe('keep this ');
  });
});
