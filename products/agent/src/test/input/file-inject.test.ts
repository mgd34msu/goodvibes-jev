import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'node:fs';
import { FilePickerModal } from '../../input/file-picker.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  const dir = makeProjectTempDir(`gv-inject-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FilePickerModal: inject mode', () => {
  test('open() with injectMode=true sets injectMode flag', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    picker.open(0, true);
    expect(picker.injectMode).toBe(true);
    expect(picker.active).toBe(true);
  });

  test('open() with injectMode=false (default) does not set injectMode', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    picker.open(5);
    expect(picker.injectMode).toBe(false);
  });

  test('close() resets injectMode to false', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    picker.open(0, true);
    picker.close();
    expect(picker.injectMode).toBe(false);
    expect(picker.active).toBe(false);
  });

  test('insertPos is stored correctly', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    picker.open(42, true);
    expect(picker.insertPos).toBe(42);
  });

  test('query is empty after open()', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    picker.open(0, true);
    expect(picker.query).toBe('');
  });

  test('selectedIndex resets to 0 after open()', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    // Mutate then re-open
    picker.open(0);
    picker.selectedIndex = 5;
    picker.open(0, true);
    expect(picker.selectedIndex).toBe(0);
  });
});
