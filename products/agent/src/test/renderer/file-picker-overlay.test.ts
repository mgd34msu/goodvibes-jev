import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { renderFilePickerOverlay } from '../../renderer/file-picker-overlay.ts';
import { FilePickerModal } from '../../input/file-picker.ts';
import { lineToString } from '../setup.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeWorkingDirectory(): string {
  const dir = makeProjectTempDir(`gv-file-picker-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

const workingDirectories: string[] = [];

afterEach(() => {
  while (workingDirectories.length > 0) {
    const dir = workingDirectories.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('renderFilePickerOverlay', () => {
  test('handles wide-character queries and file names without breaking line width', () => {
    const workingDirectory = makeWorkingDirectory();
    workingDirectories.push(workingDirectory);
    const picker = new FilePickerModal({ workingDirectory });
    picker.active = true;
    picker.query = '界🙂query';
    picker.results = ['src/界🙂-component.tsx', 'docs/normal-file.md'];
    picker.selectedIndex = 0;

    const width = 72;
    const lines = renderFilePickerOverlay(picker, width);
    for (const line of lines) {
      expect(line.length).toBe(width);
    }
  });

  test('docks like the composer: a blank row, then the ┃ bar at column 2 beside the fill on every row', () => {
    const workingDirectory = makeWorkingDirectory();
    workingDirectories.push(workingDirectory);
    const picker = new FilePickerModal({ workingDirectory });
    picker.active = true;
    picker.results = ['src/app.ts'];

    const lines = renderFilePickerOverlay(picker, 80, 24);
    expect(lineToString(lines[0]).trim()).toBe('');
    for (const line of lines.slice(1)) expect(line[2]!.char).toBe('┃');
  });

  test('the query row is always live: the typed query shows with the cursor and the match count', () => {
    const workingDirectory = makeWorkingDirectory();
    workingDirectories.push(workingDirectory);
    const picker = new FilePickerModal({ workingDirectory });
    picker.active = true;
    picker.query = 'app';
    picker.results = ['src/app.ts'];

    const header = lineToString(renderFilePickerOverlay(picker, 80, 24)[2]!);
    expect(header).toContain('@app▏');
    expect(header).toContain('1 file');
  });
});
