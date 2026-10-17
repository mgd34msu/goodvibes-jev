import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileUndoManager } from '../sdk/src/platform/state/file-undo.js';

test('undo removes a newly created file and redo restores its contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'file-undo-'));
  try {
    const path = join(root, 'created.txt');
    const manager = new FileUndoManager();
    writeFileSync(path, 'created content');
    manager.snapshot({ path, beforeContent: null, afterContent: 'created content', tool: 'write' });
    expect(manager.undo()?.path).toBe(path);
    expect(existsSync(path)).toBe(false);
    expect(manager.redo()?.path).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('created content');
    manager.undo();
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
