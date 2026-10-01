/**
 * Unit tests for composer-attachments.ts.
 * Pure utility functions, no DOM, no React.
 */
import { describe, expect, test } from 'bun:test';
import {
  dragHasFiles,
  filesFromDrop,
  imageFilesFromPaste,
  isImageFile,
} from './composer-attachments';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake DragEvent with the given types and files. */
function makeDragEvent({
  types = [] as string[],
  files = [] as File[],
} = {}): DragEvent {
  const dataTransfer = {
    types,
    files: Object.assign(files, {
      item: (i: number) => files[i] ?? null,
      [Symbol.iterator]: files[Symbol.iterator].bind(files),
    }),
  };
  return { dataTransfer } as unknown as DragEvent;
}

/** Build a minimal fake ClipboardEvent with the given items. */
function makeClipboardEvent(
  items: { kind: string; type: string; file: File | null }[],
): ClipboardEvent {
  const clipboardItems = items.map((item) => ({
    kind: item.kind,
    type: item.type,
    getAsFile: () => item.file,
  }));
  const clipboardData = {
    items: Object.assign(clipboardItems, {
      [Symbol.iterator]: clipboardItems[Symbol.iterator].bind(clipboardItems),
    }),
  };
  return { clipboardData } as unknown as ClipboardEvent;
}

/** Build a fake File with the given name and MIME type. */
function makeFile(name: string, type: string): File {
  return new File([''], name, { type });
}

// ---------------------------------------------------------------------------
// dragHasFiles
// ---------------------------------------------------------------------------

describe('dragHasFiles', () => {
  test('returns true when dataTransfer.types includes "Files"', () => {
    const event = makeDragEvent({ types: ['text/plain', 'Files'] });
    expect(dragHasFiles(event)).toBe(true);
  });

  test('returns false when dataTransfer.types does not include "Files"', () => {
    const event = makeDragEvent({ types: ['text/plain'] });
    expect(dragHasFiles(event)).toBe(false);
  });

  test('returns false when dataTransfer is null', () => {
    const event = { dataTransfer: null } as unknown as DragEvent;
    expect(dragHasFiles(event)).toBe(false);
  });

  test('returns false for empty types array', () => {
    const event = makeDragEvent({ types: [] });
    expect(dragHasFiles(event)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filesFromDrop
// ---------------------------------------------------------------------------

describe('filesFromDrop', () => {
  test('returns all files from dataTransfer.files', () => {
    const png = makeFile('photo.png', 'image/png');
    const txt = makeFile('note.txt', 'text/plain');
    const event = makeDragEvent({ types: ['Files'], files: [png, txt] });
    const result = filesFromDrop(event);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('photo.png');
    expect(result[1].name).toBe('note.txt');
  });

  test('returns empty array when dataTransfer is null', () => {
    const event = { dataTransfer: null } as unknown as DragEvent;
    expect(filesFromDrop(event)).toEqual([]);
  });

  test('returns empty array when no files dropped', () => {
    const event = makeDragEvent({ types: ['Files'], files: [] });
    expect(filesFromDrop(event)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// imageFilesFromPaste
// ---------------------------------------------------------------------------

describe('imageFilesFromPaste', () => {
  test('returns image files from clipboard items', () => {
    const img = makeFile('screenshot.png', 'image/png');
    const event = makeClipboardEvent([
      { kind: 'file', type: 'image/png', file: img },
    ]);
    const result = imageFilesFromPaste(event);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('screenshot.png');
  });

  test('excludes non-image file items', () => {
    const txt = makeFile('note.txt', 'text/plain');
    const img = makeFile('photo.jpg', 'image/jpeg');
    const event = makeClipboardEvent([
      { kind: 'file', type: 'text/plain', file: txt },
      { kind: 'file', type: 'image/jpeg', file: img },
    ]);
    const result = imageFilesFromPaste(event);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('photo.jpg');
  });

  test('excludes string-kind items', () => {
    const event = makeClipboardEvent([
      { kind: 'string', type: 'text/plain', file: null },
    ]);
    expect(imageFilesFromPaste(event)).toEqual([]);
  });

  test('filters out null getAsFile results', () => {
    const event = makeClipboardEvent([
      { kind: 'file', type: 'image/png', file: null },
    ]);
    expect(imageFilesFromPaste(event)).toEqual([]);
  });

  test('returns empty array when clipboardData is null', () => {
    const event = { clipboardData: null } as unknown as ClipboardEvent;
    expect(imageFilesFromPaste(event)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isImageFile
// ---------------------------------------------------------------------------

describe('isImageFile', () => {
  test('returns true for image/png', () => {
    expect(isImageFile(makeFile('a.png', 'image/png'))).toBe(true);
  });

  test('returns true for image/jpeg', () => {
    expect(isImageFile(makeFile('a.jpg', 'image/jpeg'))).toBe(true);
  });

  test('returns true for image/gif', () => {
    expect(isImageFile(makeFile('a.gif', 'image/gif'))).toBe(true);
  });

  test('returns true for image/webp', () => {
    expect(isImageFile(makeFile('a.webp', 'image/webp'))).toBe(true);
  });

  test('returns false for text/plain', () => {
    expect(isImageFile(makeFile('a.txt', 'text/plain'))).toBe(false);
  });

  test('returns false for application/pdf', () => {
    expect(isImageFile(makeFile('a.pdf', 'application/pdf'))).toBe(false);
  });

  test('returns false for empty MIME type', () => {
    expect(isImageFile(makeFile('a', ''))).toBe(false);
  });
});
